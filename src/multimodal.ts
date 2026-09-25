/**
 * Comate multimodal wire fixes: the image shapes the gateway silently
 * mishandles, corrected before the body leaves the shim.
 *
 * 依据：本机实测（2026-09，`llmproxy/v1/user/chat/completions`，
 * `deepseek-v4.1-flash`，96×96 纯色 PNG，手填 wps_sid 凭据）。同一张图按四种
 * 形状各发一次，只看模型是否答对颜色：
 *
 * | 发送形状 | 实测结果 |
 * | --- | --- |
 * | `image_url: { url: 'data:image/png;base64,<真 base64>' }` | HTTP 200，答对颜色，响应 id 前缀 `llm-multimodal-` |
 * | `image_url: 'data:image/png;base64,<真 base64>'`（裸字符串） | HTTP 200，答 `Unknown` —— 图片被静默丢弃 |
 * | `data:image/png;base64,https://…`（假 base64 前缀套 URL） | HTTP 200，**正文为空** —— 静默失败 |
 * | `data:image/svg+xml;base64,…` | HTTP 200，**正文为空** —— 静默失败 |
 *
 * 结论：**真 base64 直接被网关接受**，所以插件不需要复刻桌面端的图片上传链
 * （`assets/presign-upload` → ks3 PUT → `presign-download`）。本模块只做三件
 * 事，每一件都是「把静默失败变成能用的请求」：
 *
 *   1. 裸字符串 `image_url` 归一成上游认的对象形状（字符串形式会被无声丢弃）；
 *   2. 假 base64 前缀剥回真实 URL（与桌面端
 *      `sidecar-v2/dist/multimodal/fake-base64-image-url.js` 同一正则思路）；
 *   3. 网关不认的媒体类型（桌面端 `SUPPORTED_IMAGE_MIME_TYPES` 里没有 svg）
 *      替换成一条文字说明——直接丢掉会得到空正文，替换成文字至少让模型和用户
 *      知道发生了什么，而不是收到一个没有理由的空回答。
 *
 * 反向代理的边界：**不做**图片上传/预签名。将来若网关改成只认 URL，再补那一环；
 * 现在补它是没有证据支撑的复杂度。
 *
 * @module dsh-connect-comate/multimodal
 */

/**
 * Image media types the Comate pipeline handles.
 *
 * 抄自桌面端 `sidecar-v2/dist/multimodal/model-image-support.js` 的
 * `SUPPORTED_IMAGE_MIME_TYPES`（实测该集合之外的类型会得到空正文，
 * 例如 svg）。
 */
export const SUPPORTED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/x-icon',
  'image/avif',
])

/**
 * `data:image/<type>;base64,<http(s) URL>` — a base64 prefix wrapped around a
 * URL, i.e. a *fake* data URL. The payload after `base64,` is the real source.
 */
export const FAKE_BASE64_IMAGE_URL_RE = /^data:image\/[^;,\s]+(?:;[^,]*)*;base64,(https?:\/\/.*)$/i

/** `data:<mime>;<params>,<payload>`, with the mime and payload split out. */
const DATA_URL_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)((?:;[^,]*)*),([\s\S]*)$/i

/** What one pass over the body found and changed. */
export interface ImageSanitizeStats {
  /** Image content parts seen. */
  seen: number
  /** Parts emitted in a different shape than they arrived (string→object, `input_image`→`image_url`). */
  repaired: number
  /** Fake `data:image/*;base64,<url>` prefixes stripped back to the URL. */
  stripped: number
  /** Parts replaced by a text notice (unsupported type, empty or unusable source). */
  dropped: number
}

/** A zeroed stats record. */
export function emptyImageStats(): ImageSanitizeStats {
  return { seen: 0, repaired: 0, stripped: 0, dropped: 0 }
}

/** The verdict on one image source string. */
interface ImageSourceVerdict {
  /** The source to send, when usable. */
  url?: string
  /** Why it was rejected, when not. */
  reason?: string
  /** Whether a fake base64 prefix was removed to get here. */
  stripped?: boolean
}

/**
 * Decide what (if anything) to send for one image source.
 *
 * Pure: no logging, no mutation, so the table in the module doc is directly
 * assertable in tests.
 */
export function sanitizeImageSource(source: string): ImageSourceVerdict {
  const trimmed = source.trim()
  if (trimmed === '') return { reason: 'empty image source' }
  const fake = FAKE_BASE64_IMAGE_URL_RE.exec(trimmed)
  if (fake !== null) {
    const url = (fake[1] as string).trim()
    return url === '' ? { reason: 'empty image source' } : { url, stripped: true }
  }
  const data = DATA_URL_RE.exec(trimmed)
  if (data !== null) {
    const mime = (data[1] as string).toLowerCase()
    if ((data[3] as string).trim() === '') return { reason: 'empty image source' }
    return SUPPORTED_IMAGE_MIME_TYPES.has(mime)
      ? { url: trimmed }
      : { reason: `unsupported media type ${mime}` }
  }
  if (/^https?:\/\//i.test(trimmed)) return { url: trimmed }
  return { reason: 'not an http(s) URL or image data URL' }
}

/** Content part types that carry an image on this wire. */
function isImagePart(part: unknown): boolean {
  if (typeof part !== 'object' || part === null || Array.isArray(part)) return false
  const type = (part as Record<string, unknown>)['type']
  return type === 'image_url' || type === 'input_image'
}

/** The source string of an image part, in either the string or object spelling. */
function imageSourceOf(part: Record<string, unknown>): string | undefined {
  const value = part['image_url']
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const url = (value as Record<string, unknown>)['url']
    if (typeof url === 'string') return url
  }
  const data = part['data']
  return typeof data === 'string' ? data : undefined
}

/** The text part that stands in for an image we refuse to send. */
function omittedNotice(reason: string): Record<string, unknown> {
  return { type: 'text', text: `[image omitted: ${reason}]` }
}

/**
 * Rewrite every image content part of a chat body into the shape the Comate
 * gateway actually honours. Mutates `body` in place; stats are accumulated into
 * the passed record so the caller can log what happened.
 *
 * @param body - a parsed chat-completions body.
 * @param stats - accumulator; defaults to a throwaway record.
 * @returns the same stats record.
 */
export function normalizeChatImages(
  body: Record<string, unknown>,
  stats: ImageSanitizeStats = emptyImageStats(),
): ImageSanitizeStats {
  const messages = body['messages']
  if (!Array.isArray(messages)) return stats
  for (const entry of messages) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const message = entry as Record<string, unknown>
    const content = message['content']
    if (!Array.isArray(content)) continue
    const next: unknown[] = []
    for (const part of content) {
      if (!isImagePart(part)) {
        next.push(part)
        continue
      }
      stats.seen += 1
      const record = part as Record<string, unknown>
      const source = imageSourceOf(record)
      const verdict: ImageSourceVerdict = source === undefined
        ? { reason: 'missing image source' }
        : sanitizeImageSource(source)
      if (verdict.url === undefined) {
        stats.dropped += 1
        next.push(omittedNotice(verdict.reason ?? 'unusable image source'))
        continue
      }
      if (verdict.stripped === true) stats.stripped += 1
      const alreadyObject = typeof record['image_url'] === 'object' && record['image_url'] !== null
      const urlChanged = source !== verdict.url
      if (record['type'] !== 'image_url' || !alreadyObject || urlChanged) stats.repaired += 1
      // Preserve sibling keys (`detail`, and anything a client added) while
      // replacing the source and dropping the `data` spelling.
      const carried: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(record)) {
        if (key !== 'data' && key !== 'image_url' && key !== 'type') carried[key] = value
      }
      next.push({
        ...carried,
        type: 'image_url',
        image_url: { ...alreadyObject ? record['image_url'] as Record<string, unknown> : {}, url: verdict.url },
      })
    }
    message['content'] = next
  }
  return stats
}
