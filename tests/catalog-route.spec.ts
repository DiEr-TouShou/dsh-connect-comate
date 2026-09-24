import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  COMATE_CATALOG_PATH,
  COMATE_CHECK_PATH,
  COMATE_REFRESH_PATH,
  type ComateCheckOutcome,
  type ComatePersistedModel,
} from '../src/bridge.ts'
import { registerComateStatusRoute, type ComateCheckInput } from '../src/web-status.ts'

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

const MODELS: ComatePersistedModel[] = [
  { id: 'a', name: 'A', multimodal: false, contextWindow: 1_000_000 },
]

const JSON_HEADERS = { host: '127.0.0.1:3080', 'content-type': 'application/json' }

interface Registration {
  kind: string
  path: string
  handler: RouteHandler
  dispose: () => void
  disposed: boolean
}

interface HarnessOptions {
  withWebServer?: boolean
  models?: readonly ComatePersistedModel[]
  signedIn?: boolean
  providerRegistered?: boolean
  /** Runs inside the injected refresh action, before the snapshot is taken. */
  onRefresh?: () => void
  check?: (input: ComateCheckInput) => Promise<ComateCheckOutcome>
  modelsThrow?: boolean
  refreshThrow?: boolean
  checkThrow?: boolean
}

interface Harness {
  registrations: Registration[]
  /** Every input the check action received, in order. */
  checkInputs: ComateCheckInput[]
  /** How many times the refresh action ran. */
  refreshCalls: number
  /** The live directory the status reader answers with; tests may replace it. */
  directory: { current: readonly ComatePersistedModel[] }
  request: (
    path: string,
    method: string,
    headers?: Record<string, string | undefined>,
    body?: string,
  ) => Promise<{ status: number; body: unknown }>
}

/** A request stub that is also an async iterable, as `readJsonBody` requires. */
function fakeRequest(
  method: string,
  headers: Record<string, string | undefined>,
  body: string,
): IncomingMessage {
  const buffer = Buffer.from(body, 'utf8')
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (buffer.length > 0) yield buffer
    },
  } as unknown as IncomingMessage
}

/**
 * A context stub covering the seats the route registration touches: `inject`
 * (which only fires for a deployment that actually provides the service) and
 * `effect` (which must receive each route disposer).
 */
function harness(options: HarnessOptions = {}): Harness {
  const registrations: Registration[] = []
  const checkInputs: ComateCheckInput[] = []
  const directory = { current: options.models ?? MODELS }
  let refreshCalls = 0
  // The route registers its disposers on the INJECTED child fiber (the one that
  // is alive exactly as long as the web server service is), not on the plugin's
  // own context.
  const childEffect = (fn: () => unknown): unknown => { fn(); return {} }
  const ctx = {
    inject: (deps: string[], callback: (child: unknown) => void) => {
      if (options.withWebServer === false || !deps.includes('webServer')) return
      callback({
        effect: childEffect,
        webServer: {
          register: (route: { kind: string; path: string; handler: RouteHandler }) => {
            const registration: Registration = {
              ...route,
              disposed: false,
              dispose: () => { registration.disposed = true },
            }
            registrations.push(registration)
            return registration.dispose
          },
        },
      })
    },
    effect: (fn: () => unknown) => { fn(); return {} },
  }

  registerComateStatusRoute(
    ctx as unknown as Context,
    {
      models: () => {
        if (options.modelsThrow === true) throw new Error('discovery exploded')
        return directory.current
      },
      signedIn: () => options.signedIn ?? true,
      providerRegistered: () => options.providerRegistered ?? true,
    },
    {
      refresh: async () => {
        refreshCalls += 1
        if (options.refreshThrow === true) throw new Error('refresh exploded')
        options.onRefresh?.()
      },
      check: async (input) => {
        checkInputs.push(input)
        if (options.checkThrow === true) throw new Error('check exploded')
        return options.check === undefined ? { ok: true, model: 'a' } : await options.check(input)
      },
    },
  )

  return {
    registrations,
    checkInputs,
    directory,
    get refreshCalls() { return refreshCalls },
    async request(path, method, headers = {}, body = '') {
      const registration = registrations.find(entry => entry.path === path)
      if (registration === undefined) throw new Error(`no route registered for ${path}`)
      let status = 0
      let payload = ''
      const res = {
        writeHead: (code: number) => { status = code },
        end: (value?: string) => { payload = value ?? '' },
      } as unknown as ServerResponse
      await registration.handler(fakeRequest(method, headers, body), res)
      return { status, body: payload === '' ? undefined : JSON.parse(payload) as unknown }
    },
  }
}

/**
 * These routes are the only network surface the plugin exposes, and two of them
 * are actions rather than reads. So the inbound gates, the response shapes, and
 * the delegation to the injected actions each get their own assertions.
 */
describe('registerComateStatusRoute', () => {
  it('registers an exact route for each of the three paths', () => {
    const h = harness()
    expect(h.registrations.map(r => r.path).sort()).toEqual(
      [COMATE_CATALOG_PATH, COMATE_CHECK_PATH, COMATE_REFRESH_PATH].sort(),
    )
    expect(h.registrations.every(r => r.kind === 'exact')).toBe(true)
  })

  describe('GET __catalog', () => {
    it('answers a loopback GET with the sign-in state, the provider state, and the directory', async () => {
      const h = harness()
      const answer = await h.request(COMATE_CATALOG_PATH, 'GET', { host: '127.0.0.1:3080' })
      expect(answer.status).toBe(200)
      expect(answer.body).toEqual({ signedIn: true, providerRegistered: true, models: MODELS })
    })

    it('reports the provider half as not registered while it is still landing', async () => {
      // Registration happens only after the loopback listener is up. Without this
      // field a failure there looks identical to success from outside: apply() has
      // returned, the card renders, and no model can be selected.
      const h = harness({ providerRegistered: false, signedIn: false, models: [] })
      const answer = await h.request(COMATE_CATALOG_PATH, 'GET', { host: '127.0.0.1:3080' })
      expect(answer.body).toEqual({ signedIn: false, providerRegistered: false, models: [] })
    })

    it('accepts a non-browser client that sends no Origin', async () => {
      const h = harness()
      expect((await h.request(COMATE_CATALOG_PATH, 'GET', { host: 'localhost:3080' })).status).toBe(200)
    })

    it('rejects a method other than GET', async () => {
      const h = harness()
      expect((await h.request(COMATE_CATALOG_PATH, 'POST', JSON_HEADERS)).status).toBe(405)
    })

    it('answers a plain failure when discovery throws', async () => {
      const h = harness({ modelsThrow: true })
      const answer = await h.request(COMATE_CATALOG_PATH, 'GET', { host: '127.0.0.1:3080' })
      expect(answer.status).toBe(500)
      expect(JSON.stringify(answer.body)).not.toContain('discovery exploded')
    })
  })

  describe('POST __refresh', () => {
    it('runs the injected refresh once and answers the POST-refresh snapshot', async () => {
      const refreshed: ComatePersistedModel[] = [
        { id: 'b', name: 'B', multimodal: true, contextWindow: 200_000 },
      ]
      // A live directory proves the answer is read AFTER the refresh ran, not
      // captured before it.
      const h = harness({ onRefresh: () => { h.directory.current = refreshed } })

      const answer = await h.request(COMATE_REFRESH_PATH, 'POST', JSON_HEADERS)

      expect(answer.status).toBe(200)
      expect(h.refreshCalls).toBe(1)
      expect(answer.body).toEqual({ signedIn: true, providerRegistered: true, models: refreshed })
    })

    it('accepts an empty body', async () => {
      const h = harness()
      expect((await h.request(COMATE_REFRESH_PATH, 'POST', JSON_HEADERS)).status).toBe(200)
      expect(h.refreshCalls).toBe(1)
    })

    it('rejects GET', async () => {
      const h = harness()
      expect((await h.request(COMATE_REFRESH_PATH, 'GET', { host: '127.0.0.1:3080' })).status).toBe(405)
      expect(h.refreshCalls).toBe(0)
    })

    it('rejects a POST that is not JSON-typed', async () => {
      // A cross-site form post cannot set this content type, so the check is the
      // same simple-request CSRF drop the shim applies to chat POSTs.
      const h = harness()
      const answer = await h.request(COMATE_REFRESH_PATH, 'POST', {
        host: '127.0.0.1:3080',
        'content-type': 'application/x-www-form-urlencoded',
      })
      expect(answer.status).toBe(415)
      expect(h.refreshCalls).toBe(0)
    })

    it('answers a plain failure when the refresh throws', async () => {
      const h = harness({ refreshThrow: true })
      const answer = await h.request(COMATE_REFRESH_PATH, 'POST', JSON_HEADERS)
      expect(answer.status).toBe(500)
      expect(JSON.stringify(answer.body)).not.toContain('refresh exploded')
    })
  })

  describe('POST __check', () => {
    it('passes the draft credential fields through to the action', async () => {
      const h = harness({ check: async () => ({ ok: true, model: 'a' }) })
      const answer = await h.request(
        COMATE_CHECK_PATH,
        'POST',
        JSON_HEADERS,
        JSON.stringify({ wpsSid: 'draft-sid', cookieOnly: true, model: 'a' }),
      )
      expect(answer.status).toBe(200)
      expect(h.checkInputs).toEqual([{ wpsSid: 'draft-sid', cookieOnly: true, model: 'a' }])
    })

    it('reads an empty body as an empty input', async () => {
      const h = harness()
      await h.request(COMATE_CHECK_PATH, 'POST', JSON_HEADERS)
      expect(h.checkInputs).toEqual([{}])
    })

    it('drops fields of the wrong type instead of forwarding them', async () => {
      const h = harness()
      await h.request(
        COMATE_CHECK_PATH,
        'POST',
        JSON_HEADERS,
        JSON.stringify({ wpsSid: 42, cookieOnly: 'yes', model: '   ' }),
      )
      expect(h.checkInputs).toEqual([{}])
    })

    it('rejects a malformed JSON body with 400, not 500', async () => {
      const h = harness()
      const answer = await h.request(COMATE_CHECK_PATH, 'POST', JSON_HEADERS, '{not json')
      expect(answer.status).toBe(400)
      expect(h.checkInputs).toEqual([])
    })

    it('answers a failed probe as 200 with the reason in the body', async () => {
      // A probe that cannot run is a normal answer, not a route error: the card
      // renders it next to the button.
      const h = harness({ check: async () => ({ ok: false, reason: 'no-credential' }) })
      const answer = await h.request(COMATE_CHECK_PATH, 'POST', JSON_HEADERS)
      expect(answer.status).toBe(200)
      expect(answer.body).toEqual({ ok: false, reason: 'no-credential' })
    })

    it('answers a plain failure when the action throws', async () => {
      const h = harness({ checkThrow: true })
      const answer = await h.request(COMATE_CHECK_PATH, 'POST', JSON_HEADERS)
      expect(answer.status).toBe(500)
      expect(JSON.stringify(answer.body)).not.toContain('check exploded')
    })
  })

  describe('inbound gates and teardown', () => {
    it('rejects a cross-site browser fetch on every route', async () => {
      const h = harness()
      const origin = 'https://evil.example'
      expect((await h.request(COMATE_CATALOG_PATH, 'GET', { host: '127.0.0.1:3080', origin })).status).toBe(403)
      expect((await h.request(COMATE_REFRESH_PATH, 'POST', { ...JSON_HEADERS, origin })).status).toBe(403)
      expect((await h.request(COMATE_CHECK_PATH, 'POST', { ...JSON_HEADERS, origin })).status).toBe(403)
    })

    it('rejects a DNS-rebinding page that names its own domain in Host', async () => {
      const h = harness()
      expect((await h.request(COMATE_CATALOG_PATH, 'GET', { host: 'evil.example' })).status).toBe(403)
      expect((await h.request(COMATE_CHECK_PATH, 'POST', { ...JSON_HEADERS, host: 'evil.example' })).status).toBe(403)
    })

    it('never echoes a credential back', async () => {
      const h = harness({ check: async () => ({ ok: false, reason: 'no-credential' }) })
      const answer = await h.request(
        COMATE_CHECK_PATH,
        'POST',
        JSON_HEADERS,
        JSON.stringify({ wpsSid: 'super-secret-sid' }),
      )
      const serialized = JSON.stringify(answer.body)
      expect(serialized).not.toContain('super-secret-sid')
      expect(serialized).not.toContain('wpsSid')
      expect(serialized).not.toContain('wps_sid')
    })

    it('does nothing when the deployment provides no web server', () => {
      const h = harness({ withWebServer: false })
      expect(h.registrations).toHaveLength(0)
    })

    it('ties every route disposer to the fiber', () => {
      // Route patterns are a composition-level contract: a duplicate (kind, path)
      // registration THROWS, and the profile reloads patches live — so an
      // undisposed route would break the next apply().
      const effects: Array<() => unknown> = []
      const ctx = {
        inject: (deps: string[], callback: (child: unknown) => void) => {
          if (deps.includes('webServer')) {
            callback({
              effect: (fn: () => unknown) => { effects.push(fn); fn(); return {} },
              webServer: { register: () => () => {} },
            })
          }
        },
        effect: (fn: () => unknown) => { fn(); return {} },
      }
      registerComateStatusRoute(
        ctx as unknown as Context,
        { models: () => [], signedIn: () => false, providerRegistered: () => false },
        { refresh: async () => {}, check: async () => ({ ok: false }) },
      )
      expect(effects).toHaveLength(3)
    })

    it('registers through ctx.inject rather than ctx.get', () => {
      // An Electron/file-IPC deployment has no web server at all; the callback
      // simply never runs there, and model serving is unaffected because the
      // adapter's catalog comes from the local Comate config, not these routes.
      const inject = vi.fn()
      const ctx = {
        inject: (deps: string[], callback: (child: unknown) => void) => {
          inject(deps)
          callback({
            effect: (fn: () => unknown) => { fn(); return {} },
            webServer: { register: () => () => {} },
          })
        },
        effect: (fn: () => unknown) => { fn(); return {} },
      }
      registerComateStatusRoute(
        ctx as unknown as Context,
        { models: () => [], signedIn: () => false, providerRegistered: () => false },
        { refresh: async () => {}, check: async () => ({ ok: false }) },
      )
      expect(inject).toHaveBeenCalledWith(['webServer'])
    })
  })
})
