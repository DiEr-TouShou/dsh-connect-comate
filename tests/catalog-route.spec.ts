import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { COMATE_CATALOG_PATH, type ComatePersistedModel } from '../src/bridge.ts'
import { registerComateStatusRoute } from '../src/web-status.ts'

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

const MODELS: ComatePersistedModel[] = [
  { id: 'a', name: 'A', multimodal: false, contextWindow: 1_000_000 },
]

interface Registration {
  kind: string
  path: string
  handler: RouteHandler
  /** The disposer the plugin is expected to tie to its fiber. */
  dispose: () => void
  disposed: boolean
}

/**
 * A context stub covering the seats the route registration touches: `inject`
 * (which only fires for a deployment that actually provides the service) and
 * `effect` (which must receive the route disposer).
 */
function harness(options: { withWebServer?: boolean } = {}): {
  registrations: Registration[]
  request: (method: string, headers: Record<string, string | undefined>) => Promise<{ status: number; body: unknown }>
} {
  const registrations: Registration[] = []
  // The route registers its disposer on the INJECTED child fiber (the one that
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
  registerComateStatusRoute(ctx as unknown as Context, {
    models: () => MODELS,
    signedIn: () => true,
    providerRegistered: () => true,
  })
  return {
    registrations,
    async request(method, headers) {
      const registration = registrations[0]
      if (registration === undefined) throw new Error('no route was registered')
      let status = 0
      let payload = ''
      const res = {
        writeHead: (code: number) => { status = code },
        end: (body?: string) => { payload = body ?? '' },
      } as unknown as ServerResponse
      await registration.handler({ method, headers } as unknown as IncomingMessage, res)
      return { status, body: payload === '' ? undefined : JSON.parse(payload) as unknown }
    },
  }
}

/**
 * The directory route is the ONLY host→card channel for discovered models: on
 * 0.1.7 the host deliberately does not write the directory back into settings,
 * because a settings write targets the user's own `cordis.patch.yml`.
 *
 * It is therefore also the plugin's only network surface, which is why the
 * inbound gates, the response shape, and the teardown all get assertions.
 */
describe('registerComateStatusRoute', () => {
  it('registers an exact route on the catalog path', () => {
    const h = harness()
    expect(h.registrations).toHaveLength(1)
    expect(h.registrations[0]?.path).toBe(COMATE_CATALOG_PATH)
    expect(h.registrations[0]?.kind).toBe('exact')
  })

  it('answers a loopback GET with the sign-in state, the provider state, and the directory', async () => {
    const h = harness()
    const answer = await h.request('GET', { host: '127.0.0.1:3080' })
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({ signedIn: true, providerRegistered: true, models: MODELS })
  })

  it('reports the provider half as not registered while it is still landing', async () => {
    // Registration happens only after the loopback listener is up. Without this
    // field a failure there looks identical to success from outside: apply() has
    // returned, the card renders, and no model can be selected.
    let handler: RouteHandler | undefined
    const ctx = {
      inject: (deps: string[], callback: (child: unknown) => void) => {
        if (deps.includes('webServer')) {
          callback({
            effect: (fn: () => unknown) => { fn(); return {} },
            webServer: {
              register: (route: { handler: RouteHandler }) => { handler = route.handler; return () => {} },
            },
          })
        }
      },
      effect: (fn: () => unknown) => { fn(); return {} },
    }
    registerComateStatusRoute(ctx as unknown as Context, {
      models: () => [],
      signedIn: () => false,
      providerRegistered: () => false,
    })
    let payload = ''
    const res = {
      writeHead: () => {},
      end: (body?: string) => { payload = body ?? '' },
    } as unknown as ServerResponse
    await handler?.({ method: 'GET', headers: { host: '127.0.0.1:3080' } } as unknown as IncomingMessage, res)
    expect(JSON.parse(payload)).toEqual({ signedIn: false, providerRegistered: false, models: [] })
  })

  it('accepts a non-browser client that sends no Origin', async () => {
    const h = harness()
    expect((await h.request('GET', { host: 'localhost:3080' })).status).toBe(200)
  })

  it('rejects a method other than GET', async () => {
    const h = harness()
    expect((await h.request('POST', { host: '127.0.0.1:3080' })).status).toBe(405)
  })

  it('rejects a cross-site browser fetch', async () => {
    const h = harness()
    const headers = { host: '127.0.0.1:3080', origin: 'https://evil.example' }
    expect((await h.request('GET', headers)).status).toBe(403)
  })

  it('rejects a DNS-rebinding page that names its own domain in Host', async () => {
    const h = harness()
    expect((await h.request('GET', { host: 'evil.example' })).status).toBe(403)
  })

  it('never carries a credential', async () => {
    const h = harness()
    const answer = await h.request('GET', { host: '127.0.0.1:3080' })
    const serialized = JSON.stringify(answer.body)
    expect(serialized).not.toContain('wpsSid')
    expect(serialized).not.toContain('wps_sid')
  })

  it('does nothing when the deployment provides no web server', () => {
    const h = harness({ withWebServer: false })
    expect(h.registrations).toHaveLength(0)
  })

  it('ties the route disposer to the fiber', () => {
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
    registerComateStatusRoute(ctx as unknown as Context, {
      models: () => [],
      signedIn: () => false,
      providerRegistered: () => false,
    })
    expect(effects).toHaveLength(1)
  })

  it('answers a plain failure when discovery throws', async () => {
    let handler: RouteHandler | undefined
    const ctx = {
      inject: (deps: string[], callback: (child: unknown) => void) => {
        if (deps.includes('webServer')) {
          callback({
            effect: (fn: () => unknown) => { fn(); return {} },
            webServer: {
              register: (route: { handler: RouteHandler }) => { handler = route.handler; return () => {} },
            },
          })
        }
      },
      effect: (fn: () => unknown) => { fn(); return {} },
    }
    registerComateStatusRoute(ctx as unknown as Context, {
      models: () => { throw new Error('discovery exploded') },
      signedIn: () => true,
      providerRegistered: () => true,
    })
    let status = 0
    let payload = ''
    const res = {
      writeHead: (code: number) => { status = code },
      end: (body?: string) => { payload = body ?? '' },
    } as unknown as ServerResponse
    await handler?.({ method: 'GET', headers: { host: '127.0.0.1:3080' } } as unknown as IncomingMessage, res)
    expect(status).toBe(500)
    // The internal failure must not travel to the browser.
    expect(payload).not.toContain('discovery exploded')
  })

  it('registers the route through ctx.inject rather than ctx.get', () => {
    // An Electron/file-IPC deployment has no web server at all; the callback
    // simply never runs there, and model serving is unaffected because the
    // adapter's catalog comes from the local Comate config, not this route.
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
    registerComateStatusRoute(ctx as unknown as Context, {
      models: () => [],
      signedIn: () => false,
      providerRegistered: () => false,
    })
    expect(inject).toHaveBeenCalledWith(['webServer'])
  })
})
