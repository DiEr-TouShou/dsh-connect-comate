/**
 * 图片外置：把请求体里的 inline base64 图片换成模型后端能直接抓取的 URL。
 *
 * 为什么需要它（本机实测，2026-09-25，`llmproxy/v1/user/chat/completions`，
 * 96×96 纯色 PNG，手填 wps_sid 凭据；同一张图按形状各发一次，只看模型是否答对
 * 颜色）：
 *
 * | 模型 | `image_url:{url:'data:image/png;base64,…'}` | `image_url:{url:'https://…'}` |
 * | --- | --- | --- |
 * | deepseek-v4.1-flash / MiniMax-M3 / kimi-k3 / glm-5.3-flash | 答对 | 答对 |
 * | mimo-v2.5 | 200 + SSE `请求参数值有误(unsupported message.content type=image)` | 答对 |
 *
 * 即 **URL 载荷 5/5 通用，inline base64 对 mimo 必失败**；而 mimo 的网关路由本身
 * 是多模态的（响应 id 前缀 `llm-multimodal-xiaomi-mimo-v2.5`），所以这不是能力
 * 缺失，是它的后端不收 inline 字节、只自己去抓 URL。位置也不是原因：图片放在
 * user 消息、tool 消息（`read_image` 工具结果的真实形状）、或从 tool 提到 user，
 * 三种都试过，mimo 一律在 ~205ms（远快于模型推理）被拒。
 *
 * 于是这里复刻桌面端那三步，接口取自 `binaries/agents/default-agent/tools/
 * video-generation/video-upload.js` 的 presign 分支（同一套 assets 接口）：
 *
 *   Step1 `POST <assetBase>/assets/presign-upload`   → 预签名 PUT URL + relative_key
 *   Step2 `PUT  <upload_url>`                        → 字节直传对象存储
 *   Step3 `POST <assetBase>/assets/presign-download` → 临时下载 URL（给模型后端抓）
 *
 * 凭据只用 `Cookie: wps_sid=…`（与桌面端一致，实测可用）。拿不到 cookie、或三步中
 * 任何一步失败，都**返回 undefined**，调用方保留 base64 原样发出：本机 5 个模型里
 * 有 4 个吃 base64，退回去不会比现状更糟，而多模态功能也不会因为一次上传抖动而整体
 * 挂掉。
 *
 * @module dsh-connect-comate/assets
 */

import { createHash } from 'node:crypto'
import type { ComateCredential } from './auth.ts'

/** 覆盖资产接口地址（私有化部署/排障用）。 */
export const COMATE_ASSET_BASE_ENV = 'WPS_COMATE_ASSET_BASE'

/** 资产接口挂在网关同源的 `/api/comate/v1` 下。 */
export const COMATE_ASSET_PATH = '/api/comate/v1'

/** 下载 URL 上读不到有效期时的保守默认值。 */
const DEFAULT_DOWNLOAD_TTL_MS = 5 * 60_000

/** 提前量：有效期剩余不足这个数就重新预签名，避免 URL 在模型抓取途中过期。 */
const DOWNLOAD_TTL_MARGIN_MS = 30_000

/** presign 接口超时；上传走独立（更长）超时。 */
const PRESIGN_TIMEOUT_MS = 20_000
const UPLOAD_TIMEOUT_MS = 60_000

/** 上传一张图片并换回可抓取 URL 的能力。 */
export interface ComateAssetUploader {
  /**
   * @param dataUrl - `data:image/<type>;base64,<payload>`。
   * @param credential - 当前凭据；只有带 cookie 时才能上传。
   * @returns 模型后端可抓取的 URL；无法上传时 undefined（调用方保留 base64）。
   */
  upload(dataUrl: string, credential: ComateCredential): Promise<string | undefined>
}

/** 缓存的资产：`relative_key` 长期有效，下载 URL 有有效期。 */
interface CachedAsset {
  relativeKey: string
  url: string
  expiresAt: number
}

/** presign-upload 的响应体（只声明用到的字段）。 */
interface PresignUploadData {
  upload_url?: unknown
  method?: unknown
  headers?: unknown
  relative_key?: unknown
}

/** 解析资产接口地址：env 覆盖优先，否则取网关同源。 */
export function resolveAssetBase(baseUrl: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env[COMATE_ASSET_BASE_ENV]
  if (typeof override === 'string' && override.trim() !== '') return override.trim().replace(/\/+$/, '')
  try {
    return `${new URL(baseUrl).origin}${COMATE_ASSET_PATH}`
  } catch {
    return undefined
  }
}

/** 解出 `data:image/<type>;base64,<payload>` 的字节；不是真 base64 图片时 undefined。 */
export function decodeImageDataUrl(dataUrl: string): { mime: string; bytes: Buffer } | undefined {
  const match = /^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,([\s\S]*)$/i.exec(dataUrl.trim())
  if (match === null) return undefined
  const payload = (match[2] as string).replace(/\s+/g, '')
  if (payload === '') return undefined
  const bytes = Buffer.from(payload, 'base64')
  if (bytes.length === 0) return undefined
  return { mime: (match[1] as string).toLowerCase(), bytes }
}

/** 从预签名 URL 的查询串读有效期（ks3 用 `X-Amz-Expires` 秒数，部分实现用 `Expires` 时间戳）。 */
export function downloadUrlExpiry(url: string, now: number = Date.now()): number {
  try {
    const params = new URL(url).searchParams
    const expires = params.get('X-Amz-Expires')
    if (expires !== null) {
      const seconds = Number(expires)
      if (Number.isFinite(seconds) && seconds > 0) return now + seconds * 1000
    }
    const absolute = params.get('Expires')
    if (absolute !== null) {
      const epoch = Number(absolute)
      if (Number.isFinite(epoch) && epoch > 0) return epoch * 1000
    }
  } catch {
    /* 解析失败按默认 TTL 处理 */
  }
  return now + DEFAULT_DOWNLOAD_TTL_MS
}

/** 按 mime 猜一个文件名（relative_key 由服务端生成，这里只是给接口一个像样的入参）。 */
function filenameFor(mime: string): string {
  const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ?? 'png'
  return `image.${ext === '' ? 'png' : ext}`
}

/** `data:` URL 的 base64 部分只保留图片本体的前缀（日志里不出现字节）。 */
function shortHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12)
}

/**
 * 桌面端同款 presign 上传器。
 *
 * 按内容 sha256 缓存 `relative_key`：同一张图（多轮对话里每轮都会重发）只上传
 * 一次；下载 URL 按有效期复用，过期才重新预签名。**刻意不接调用方的
 * AbortSignal**：上传结果会被后续请求复用，让一个断开的请求取消共享上传会让
 * 另一个正在等同一张图的请求一起失败。每次上传有自己的超时上限。
 */
export class ComatePresignUploader implements ComateAssetUploader {
  private readonly cache = new Map<string, Promise<CachedAsset | undefined>>()
  private readonly env: NodeJS.ProcessEnv
  private readonly fetchImpl: typeof fetch

  constructor(options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}) {
    this.env = options.env ?? process.env
    this.fetchImpl = options.fetch ?? fetch
  }

  async upload(dataUrl: string, credential: ComateCredential): Promise<string | undefined> {
    const decoded = decodeImageDataUrl(dataUrl)
    if (decoded === undefined) return undefined
    const cookie = credential.cookie
    if (cookie === undefined || cookie.trim() === '') return undefined
    const base = resolveAssetBase(credential.baseUrl, this.env)
    if (base === undefined) return undefined

    const hash = createHash('sha256').update(decoded.bytes).digest('hex')
    let pending = this.cache.get(hash)
    if (pending === undefined) {
      pending = this.uploadOnce(base, cookie, decoded)
      this.cache.set(hash, pending)
    }
    const asset = await pending
    if (asset === undefined) {
      // 失败不留在缓存里，下一轮还有机会。
      this.cache.delete(hash)
      return undefined
    }
    return this.freshUrl(base, cookie, asset)
  }

  /** 三步走：presign-upload → PUT → presign-download。 */
  private async uploadOnce(
    base: string,
    cookie: string,
    decoded: { mime: string; bytes: Buffer },
  ): Promise<CachedAsset | undefined> {
    const presign = await this.presignUpload(base, cookie, decoded.mime)
    if (presign === undefined) return undefined
    if (!await this.putBytes(presign, decoded)) return undefined
    const download = await this.presignDownload(base, cookie, presign.relativeKey)
    if (download === undefined) return undefined
    return { relativeKey: presign.relativeKey, url: download.url, expiresAt: download.expiresAt }
  }

  /** 复用未过期的下载 URL，过期则只重新预签名（不重传字节）。 */
  private async freshUrl(base: string, cookie: string, asset: CachedAsset): Promise<string | undefined> {
    if (Date.now() + DOWNLOAD_TTL_MARGIN_MS < asset.expiresAt) return asset.url
    const download = await this.presignDownload(base, cookie, asset.relativeKey)
    if (download === undefined) {
      // 重新预签名失败：宁可给一个可能还活着的旧 URL，也不要退回对 mimo 必失败的
      // base64。旧 URL 是否真的过期，由模型后端抓取时的结果说话。
      return asset.url
    }
    asset.url = download.url
    asset.expiresAt = download.expiresAt
    return asset.url
  }

  /** Step1：要一个预签名 PUT URL。 */
  private async presignUpload(
    base: string,
    cookie: string,
    mime: string,
  ): Promise<{ uploadUrl: string; method: string; headers: Record<string, string>; relativeKey: string } | undefined> {
    const response = await this.postJson(
      `${base}/assets/presign-upload`,
      cookie,
      { filename: filenameFor(mime), content_type: mime },
      PRESIGN_TIMEOUT_MS,
    )
    if (response === undefined) return undefined
    const data = (response as { data?: PresignUploadData }).data
    if (data === undefined || data === null) return undefined
    const uploadUrl = typeof data.upload_url === 'string' ? data.upload_url : ''
    const relativeKey = typeof data.relative_key === 'string' ? data.relative_key : ''
    if (uploadUrl === '' || relativeKey === '') return undefined
    const method = typeof data.method === 'string' && data.method.trim() !== '' ? data.method.trim() : 'PUT'
    const headers = isPlainObject(data.headers)
      ? Object.fromEntries(Object.entries(data.headers).map(([k, v]) => [k, String(v)]))
      : {}
    return { uploadUrl, method, headers, relativeKey }
  }

  /** Step2：把字节直传对象存储。 */
  private async putBytes(
    presign: { uploadUrl: string; method: string; headers: Record<string, string> },
    decoded: { mime: string; bytes: Buffer },
  ): Promise<boolean> {
    const headers: Record<string, string> = { ...presign.headers, 'Content-Length': String(decoded.bytes.length) }
    if (Object.keys(headers).every((key) => key.toLowerCase() !== 'content-type')) {
      headers['Content-Type'] = decoded.mime
    }
    try {
      const response = await this.fetchImpl(presign.uploadUrl, {
        method: presign.method.toUpperCase(),
        headers,
        body: decoded.bytes,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      })
      return response.ok
    } catch {
      return false
    }
  }

  /** Step3：把 relative_key 换成临时下载 URL。 */
  private async presignDownload(
    base: string,
    cookie: string,
    relativeKey: string,
  ): Promise<{ url: string; expiresAt: number } | undefined> {
    const response = await this.postJson(
      `${base}/assets/presign-download`,
      cookie,
      { relative_keys: [relativeKey] },
      PRESIGN_TIMEOUT_MS,
    )
    if (response === undefined) return undefined
    const items = (response as { data?: { items?: unknown } }).data?.items
    if (!Array.isArray(items)) return undefined
    const first = items[0]
    const url = isPlainObject(first) && typeof first['download_url'] === 'string' ? first['download_url'] : ''
    if (url === '') return undefined
    return { url, expiresAt: downloadUrlExpiry(url) }
  }

  /** POST JSON + `Cookie`；成功且 `code === 0` 才返回解析后的响应体。 */
  private async postJson(
    url: string,
    cookie: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cookie': cookie },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) return undefined
      const parsed: unknown = await response.json()
      if (!isPlainObject(parsed)) return undefined
      return parsed['code'] === 0 ? parsed : undefined
    } catch {
      return undefined
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
