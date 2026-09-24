/**
 * Host routes the browser card talks to: one read-only status route and two
 * actions (refresh the model directory, test the connection).
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 「宿主状态经 `ctx.inject(['webServer'], …)` 暴露成路由、Host 与 Origin
 *     双重回环校验、响应只回最小文档」这一形态由该项目的 `web-status.ts`
 *   设计并验证。
 * 改动：本插件只暴露**只读**路由。`__refresh` 只重读本机 config 并刷新内存快照，
 *   `__check` 只发一次最小请求；两者都不写任何文件，也不回传任何凭据。
 *
 * ## 为什么目录不走 settings
 *
 * 0.1.5 上宿主可以把发现的目录 `scope.update({lastCatalog})` 写进设置文档；
 * 0.1.7 上同一个写入的目标是**用户手写的 `cordis.patch.yml`**——宿主每次发现
 * 目录变化都去重写它，会破坏该文件的注释与格式。因此这条通道改成只读路由：
 * 宿主只发布内存里的发现结果，卡片按需读取，落盘的事只发生在用户真的点保存时。
 *
 * @module dsh-connect-comate/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  COMATE_CATALOG_PATH,
  COMATE_CHECK_PATH,
  COMATE_REFRESH_PATH,
  type ComateCatalogAnswer,
  type ComatePersistedModel,
} from './bridge.ts'
import type { ComateCheckOutcome } from './check.ts'
import { hostIsLoopback, isJsonContentType, originIsLoopback } from './shim.ts'

/**
 * The status answer's shape lives in `./bridge.ts` (dependency free) because the
 * card parses it; re-exported here as this module's own API.
 */
export type { ComateCatalogAnswer } from './bridge.ts'

/** Request-body ceiling for the action routes; a sid is a few dozen bytes. */
const ACTION_BODY_LIMIT = 8 * 1024

/** Host state the status route answers with. */
export interface ComateCatalogDeps {
  /** Model directory discovered from the local Comate config. */
  models: () => readonly ComatePersistedModel[]
  /** Whether a locally signed-in Comate credential resolved. */
  signedIn: () => boolean
  /**
   * Whether the `comate` provider actually landed in the harness registry.
   *
   * Registration happens after the loopback listener is up, so it is the one
   * step whose failure is otherwise invisible from outside: `apply()` has already
   * returned, the card renders, and only a log line records that no model can be
   * selected. Reporting it here is what turns that silent half-mount into
   * something the user (and `curl`) can see.
   */
  providerRegistered: () => boolean
}

/** Input of one connection probe; every field is an optional draft override. */
export interface ComateCheckInput {
  /** Unsaved sid to probe with; absent keeps the saved one. */
  wpsSid?: string
  /** Unsaved cookie-only choice to probe with; absent keeps the saved one. */
  cookieOnly?: boolean
  /** Model to probe; absent uses the card's default pick. */
  model?: string
}

/**
 * The work the action routes delegate.
 *
 * Kept as an injected port rather than imported directly so this module stays a
 * guard-and-serialize shell: the routes can be exercised with stub actions, and
 * the host's discovery state has exactly one owner.
 */
export interface ComateActionDeps {
  /**
   * Re-read the local Comate config and republish the directory.
   * Must not reject: the host's own discovery already answers a signed-out
   * machine with an empty directory, so a refresh always has a true snapshot.
   */
  refresh: () => Promise<void>
  /** Probe the connection with the given (possibly draft) inputs. */
  check: (input: ComateCheckInput) => Promise<ComateCheckOutcome>
}

/** Write one JSON response with an explicit length so the socket can be reused. */
function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // The answer reflects live in-memory state; a cached copy would go stale
    // exactly when the user is watching the card after a save.
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/**
 * Apply every inbound gate, or report the refusal.
 *
 * Two independent origin gates: Host catches a DNS-rebinding page (its own
 * domain in Host, resolved to 127.0.0.1), Origin catches a cross-site browser
 * fetch. A non-browser client sends no Origin and passes the second gate only
 * because it already passed the first. POSTs additionally demand a JSON content
 * type — the same simple-request CSRF drop the shim applies to chat POSTs, since
 * a form-encoded cross-site post cannot set it.
 */
function refuse(req: IncomingMessage, method: 'GET' | 'POST'): { status: number; error: string } | undefined {
  if (req.method !== method) return { status: 405, error: 'method not allowed' }
  if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
    return { status: 403, error: 'origin-not-trusted' }
  }
  if (method === 'POST' && !isJsonContentType(req)) {
    return { status: 415, error: 'expected application/json' }
  }
  return undefined
}

/** Read a bounded JSON body; an empty body reads as ``. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > ACTION_BODY_LIMIT) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text === '' ? {} : JSON.parse(text)
}

/** Narrow an untrusted body to the probe's optional draft fields. */
function toCheckInput(body: unknown): ComateCheckInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return {}
  const raw = body as Record<string, unknown>
  const input: ComateCheckInput = {}
  if (typeof raw['wpsSid'] === 'string') input.wpsSid = raw['wpsSid']
  if (typeof raw['cookieOnly'] === 'boolean') input.cookieOnly = raw['cookieOnly']
  if (typeof raw['model'] === 'string' && raw['model'].trim() !== '') input.model = raw['model'].trim()
  return input
}

/**
 * Register the status and action routes for as long as the composing deployment
 * provides a web server.
 *
 * `ctx.inject` is the right shape rather than `ctx.get`: an Electron/file-IPC
 * deployment has no `webServer` at all, and there the callback simply never runs
 * — the card then shows "no model directory yet" and its buttons report the
 * action is unavailable, while model serving is unaffected, because the
 * adapter's catalog comes from the local Comate config and never from these
 * routes.
 *
 * @param ctx - the plugin's context.
 * @param deps - live readers over the host's discovery state.
 * @param actions - the two actions the card can trigger.
 */
export function registerComateStatusRoute(
  ctx: Context,
  deps: ComateCatalogDeps,
  actions: ComateActionDeps,
): void {
  ctx.inject(['webServer'], (webCtx) => {
    /** The current status answer, shared by the GET and the refresh route. */
    const snapshot = (): ComateCatalogAnswer => ({
      signedIn: deps.signedIn(),
      providerRegistered: deps.providerRegistered(),
      models: [...deps.models()],
    })

    const routes: Array<{ path: string; method: 'GET' | 'POST'; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }> = [
      {
        path: COMATE_CATALOG_PATH,
        method: 'GET',
        handler: (req, res) => {
          const denied = refuse(req, 'GET')
          if (denied !== undefined) {
            json(res, denied.status, { error: denied.error })
            return
          }
          try {
            json(res, 200, snapshot())
          } catch {
            // Discovery is in-memory bookkeeping, but a throwing reader must not
            // take the whole web server down; answer a plain failure instead.
            json(res, 500, { error: 'catalog unavailable' })
          }
        },
      },
      {
        path: COMATE_REFRESH_PATH,
        method: 'POST',
        handler: async (req, res) => {
          const denied = refuse(req, 'POST')
          if (denied !== undefined) {
            json(res, denied.status, { error: denied.error })
            return
          }
          try {
            // Drain the (usually empty) body first: answering before the request
            // has been read can reset the connection under some clients.
            await readJsonBody(req)
            await actions.refresh()
            json(res, 200, snapshot())
          } catch {
            json(res, 500, { error: 'refresh failed' })
          }
        },
      },
      {
        path: COMATE_CHECK_PATH,
        method: 'POST',
        handler: async (req, res) => {
          const denied = refuse(req, 'POST')
          if (denied !== undefined) {
            json(res, denied.status, { error: denied.error })
            return
          }
          let input: ComateCheckInput
          try {
            input = toCheckInput(await readJsonBody(req))
          } catch {
            json(res, 400, { error: 'invalid JSON body' })
            return
          }
          try {
            // A failed probe is a normal answer, not a route error: the card
            // renders `{ok:false}` with its reason.
            json(res, 200, await actions.check(input))
          } catch {
            json(res, 500, { error: 'check failed' })
          }
        },
      },
    ]

    for (const route of routes) {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: route.path,
        handler: route.handler,
      })
      // Route patterns are a composition-level contract: a duplicate (kind, path)
      // registration THROWS. Since the profile reloads patches live, an
      // undisposed route would break the next apply(), so every disposer is tied
      // to this fiber rather than left to garbage collection.
      webCtx.effect(() => dispose, `dsh-connect-comate: ${route.path}`)
    }
  })
}
