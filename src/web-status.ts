/**
 * Read-only host route the browser card reads the discovered model directory
 * from, plus the sign-in state that goes with it.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 「宿主状态经 `ctx.inject(['webServer'], …)` 暴露成只读路由、Host 与
 *     Origin 双重回环校验、响应只回最小文档」这一形态由该项目的
 *     `web-status.ts` 设计并验证。
 * 改动：只暴露模型目录与登录态；**绝不回传 wps_sid**，也没有任何写入口。
 *
 * ## 为什么目录不走 settings
 *
 * 0.1.5 上宿主可以把发现的目录 `scope.update({lastCatalog})` 写进设置文档；
 * 0.1.7 上同一个写入的目标是**用户手写的 `cordis.patch.yml`**——宿主每次发现
 * 目录变化都去重写它，会破坏该文件的注释与格式。因此这条通道改成只读 GET：
 * 宿主只发布内存里的发现结果，卡片按需读取，落盘的事只发生在用户真的点保存时。
 *
 * @module dsh-connect-comate/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { COMATE_CATALOG_PATH, type ComatePersistedModel } from './bridge.ts'
import { hostIsLoopback, originIsLoopback } from './shim.ts'

/** Host state the route answers with. */
export interface ComateCatalogDeps {
  /** Model directory discovered from the local Comate config, already filtered by the saved selection. */
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

/** The route's response body. Deliberately contains no credential of any kind. */
export interface ComateCatalogAnswer {
  signedIn: boolean
  providerRegistered: boolean
  models: readonly ComatePersistedModel[]
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
 * Register the catalog route for as long as the composing deployment provides a
 * web server.
 *
 * `ctx.inject` is the right shape rather than `ctx.get`: an Electron/file-IPC
 * deployment has no `webServer` at all, and there the callback simply never runs
 * — the card then shows "no model directory yet" while model serving is
 * unaffected, because the adapter's catalog comes from the local Comate config
 * and never from this route.
 *
 * @param ctx - the plugin's context.
 * @param deps - live readers over the host's discovery state.
 */
export function registerComateStatusRoute(ctx: Context, deps: ComateCatalogDeps): void {
  ctx.inject(['webServer'], (webCtx) => {
    const dispose = webCtx.webServer.register({
      kind: 'exact',
      path: COMATE_CATALOG_PATH,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') {
          json(res, 405, { error: 'method not allowed' })
          return
        }
        // Two independent gates: Host catches a DNS-rebinding page (its own
        // domain in Host, resolved to 127.0.0.1), Origin catches a cross-site
        // browser fetch. A non-browser client sends no Origin and passes the
        // second gate only because it already passed the first.
        if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
          json(res, 403, { error: 'origin-not-trusted' })
          return
        }
        try {
          json(res, 200, {
            signedIn: deps.signedIn(),
            providerRegistered: deps.providerRegistered(),
            models: [...deps.models()],
          })
        } catch {
          // Discovery is in-memory bookkeeping, but a throwing reader must not
          // take the whole web server down; answer a plain failure instead.
          json(res, 500, { error: 'catalog unavailable' })
        }
      },
    })
    // Route patterns are a composition-level contract: a duplicate (kind, path)
    // registration THROWS. Since the profile reloads patches live, an
    // undisposed route would break the next apply(), so the disposer is tied to
    // this fiber rather than left to garbage collection.
    webCtx.effect(() => dispose, 'dsh-connect-comate: catalog route')
  })
}
