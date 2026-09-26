/**
 * Loopback OpenAI-compatible endpoint. The pi-ai provider points here; the
 * shim applies the Comate wire quirks (forced streaming, string
 * `tool_choice`, Comate-shaped headers) and forwards to the real upstream.
 * It binds 127.0.0.1 only and never serves another interface.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 入站加固的四重校验（Host 必须回环、Origin 必须回环、chat POST 必须
 *     JSON、bearer 必须匹配进程内随机 secret）、常量时间比对、
 *     随机端口绑定、body 上限、上游错误分类到 HTTP 状态码的映射，
 *     均由该项目（转引自 corrinehu/dsh-workbuddy-connect，MIT）设计并验证。
 * 改动：安全相关代码不做「改善」，原样沿用，仅替换上游类型与命名。
 * v0.4.2：**出口**（`writeOpenAIError`）统一过 `safeMessage` 脱敏。之前只有低频的
 *   `check.ts` 有这层，常驻的聊天数据路径反而没有；上游正文里回显一条 Cookie 或
 *   Bearer 就会原样交给 pi-ai。
 *
 * @module dsh-connect-comate/shim
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { ComateCredentialStore } from './auth.ts'
import type { ComateAssetUploader } from './assets.ts'
import type { ComateCatalog } from './catalog.ts'
import { emptyImageStats, emptyUploadStats, uploadChatImages } from './multimodal.ts'
import { safeMessage } from './redact.ts'
import { applyTitleBudgetFix, applyTitleReasoningFix } from './title-fix.ts'
import { prepareChatBody, ComateUpstreamClient, type UpstreamErrorKind } from './upstream.ts'

/** Minimal logger surface the plugin context already provides. */
export interface ShimLogger {
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** What the plugin needs from a running shim. */
export interface ComateShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string
  /**
   * The per-process shared secret the plugin's own client must carry as
   * `Authorization: Bearer <token>`. Lives only in memory; the adapter
   * resolves this instead of the upstream apiKey, because the shim resolves
   * the real credential itself via the store.
   */
  token(): string
  /** Stop serving and destroy open connections. */
  close(): Promise<void>
}

/** Constructor dependencies. */
export interface ComateShimOptions {
  store: ComateCredentialStore
  client: Pick<ComateUpstreamClient, 'chatStream'>
  catalog: ComateCatalog
  /**
   * 把 inline base64 图片换成可抓取 URL 的上传器。不传则不外置：图片以 base64
   * 原样发出（本机 5 个多模态模型里有 4 个吃 base64，`mimo-v2.5` 不吃）。
   */
  uploader?: ComateAssetUploader
  logger?: ShimLogger
}

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

/**
 * Loopback hostnames the shim's own in-process client uses.
 *
 * Exported because the read-only catalog route applies the SAME inbound checks:
 * one vocabulary for "what counts as this machine" beats two copies that can
 * drift apart.
 */
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
export function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon)
  return hostname
}

/**
 * The request's Host header must name the loopback interface. A DNS-rebinding
 * page (attacker domain re-resolved to 127.0.0.1) sends its own domain in
 * Host, so this check drops those before any routing happens.
 */
export function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/**
 * A browser-sent Origin (present header) must be loopback. Non-browser
 * clients (the plugin's own fetch calls) send no Origin at all and pass.
 */
export function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
export function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  not_found: 502,
  server: 502,
  client: 400,
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/**
 * Write one OpenAI-shaped error, redacting the message on the way out.
 *
 * 这里是**唯一**的错误出口：调用方给的是上游原文（`result.message`）、是
 * `String(error)`、还是我们自己写死的常量，都在这一处过筛。放在出口而不是每个
 * 调用点，是因为「记得脱敏」是件靠不住的事——上游正文里回显一条 `Cookie` 或一个
 * Bearer，就够把真凭据交给 pi-ai 与浏览器面板；漏掉一个分支的代价，比在这里多跑
 * 一次正则大得多。写死的常量过一遍无害（规则对 `[redacted]` 幂等）。
 */
function writeOpenAIError(res: ServerResponse, status: number, kind: string, message: string): void {
  writeJson(res, status, { error: { message: safeMessage(message), type: kind, code: kind } })
}

/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Start the loopback endpoint. Requests must carry the shim's shared secret;
 * the loopback bind alone is not a trust boundary.
 */
export function createComateShim(options: ComateShimOptions): ComateShim {
  const { store, client, catalog, uploader } = options
  const logger = options.logger

  // Per-process shared secret. Lives only in memory; the adapter resolves it
  // as the OpenAI apiKey, which pi-ai sends as `Authorization: Bearer ...`.
  // The shim never forwards it upstream — the real credential comes from the
  // store. A local attacker who can hit the port still cannot forge this.
  const SHARED_SECRET = randomBytes(32).toString('base64url')

  /** Constant-time bearer check; absent or mismatched bearers are rejected. */
  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const presented = match[1] as string
    const expected = SHARED_SECRET
    const a = Buffer.from(presented)
    const b = Buffer.from(expected)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })

  server.listen(0, '127.0.0.1')

  const baseUrl = (): string => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('comate shim has no listening address')
    }
    return `http://127.0.0.1:${address.port}`
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
        return
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
        return
      }
      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        writeJson(res, 200, {
          object: 'list',
          data: catalog.current().map(model => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: 'comate',
          })),
        })
        return
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        await chatCompletions(req, res)
        return
      }
      writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
    } catch (error: unknown) {
      if (!res.headersSent) {
        writeOpenAIError(res, 500, 'internal', String(error))
      } else {
        res.end()
      }
    }
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }
    let credential
    try {
      credential = await store.resolve()
    } catch (error: unknown) {
      writeOpenAIError(res, 401, 'not_signed_in', String(error))
      return
    }

    const raw = (await readBody(req)).toString('utf8')
    const controller = new AbortController()
    req.on('close', () => controller.abort())

    const imageStats = emptyImageStats()
    const uploadStats = emptyUploadStats()
    // 两遍，顺序不能倒：先归一化（同步、纯）把图片收成「对象形状 + 真 base64」一种
    // 形式，再外置（异步、有网）把它换成可抓取 URL。
    let prepared = prepareChatBody(raw, imageStats)
    // DSH 标题请求固定 max_tokens=64，对推理模型是总预算、思考就会吃光（空正文 →
    // 标题静默失败）。识别标题请求做两件事：预算提到 1024（方案 A，mimo 系除外——
    // 它的思考随预算膨胀），再注入 reasoning_effort=off 关掉思考（方案 B，glm-5.3
    // 不吃 off 只认预算，两者互为兜底）。未命中一字不动。
    const titleFix = applyTitleBudgetFix(prepared)
    if (titleFix.matched && titleFix.before !== undefined && titleFix.after !== undefined) {
      logger?.warn(
        `dsh-connect-comate: title request budget raised ${titleFix.before} -> ${titleFix.after}`,
      )
    }
    prepared = titleFix.body
    const titleReasoning = applyTitleReasoningFix(prepared)
    if (titleReasoning.injected) {
      logger?.warn('dsh-connect-comate: title request reasoning disabled (reasoning_effort: off)')
    }
    prepared = titleReasoning.body
    try {
      prepared = await uploadChatImages(prepared, uploader, credential, uploadStats)
    } catch (error: unknown) {
      // 外置只是优化路径，任何意外都不该让请求失败：退回 base64 继续发。
      // 消息过脱敏：上传链的异常文本可能夹着上游回显的 `Cookie`。
      logger?.warn('dsh-connect-comate: image externalization failed, sending inline images', safeMessage(error))
    }
    // 只在真的改动了图片时才发声：网关对裸字符串/假 base64/svg 会返回 200 + 空
    // 正文，日志是事后唯一能看出「那次空回答是怎么回事」的地方。
    if (
      imageStats.stripped > 0 || imageStats.dropped > 0
      || uploadStats.externalized > 0 || uploadStats.failed > 0
    ) {
      logger?.warn(
        `dsh-connect-comate: image content handled (seen=${imageStats.seen},`
        + ` repaired=${imageStats.repaired}, stripped=${imageStats.stripped},`
        + ` dropped=${imageStats.dropped}, externalized=${uploadStats.externalized},`
        + ` upload_failed=${uploadStats.failed})`,
      )
    }

    const result = await client.chatStream(credential, prepared, controller.signal)

    if (!result.ok) {
      writeOpenAIError(
        res,
        KIND_STATUS[result.kind],
        result.kind,
        // 不再在这里 `slice`：截断要发生在脱敏**之后**（`safeMessage` 自己做），
        // 先截再抹的话，一个跨在截断点上的令牌会被切掉一半而认不出来——半个真
        // 凭据也是凭据。
        `comate upstream ${result.kind} (http ${result.status}): ${result.message}`,
      )
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    let sawDone = false
    const body = Readable.fromWeb(result.response.body as Parameters<typeof Readable.fromWeb>[0])
    body.on('data', (chunk: Buffer) => {
      if (chunk.includes('[DONE]')) sawDone = true
    })
    body.on('error', (error: unknown) => {
      logger?.warn('dsh-connect-comate: upstream stream failed mid-flight', safeMessage(error))
      if (!sawDone && res.writable) res.end('data: [DONE]\n\n')
    })
    body.pipe(res)
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(() => resolve())
      server.closeAllConnections()
      server.once('error', reject)
    }),
  }
}
