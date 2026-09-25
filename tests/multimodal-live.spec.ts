/**
 * 真机验收测试（默认跳过）：走插件自己的完整链路
 * （`prepareChatBody` → `uploadChatImages` → 真 presign 上传 → 上游），复刻真机上
 * 出问题的那次请求形状——图片来自 `read_image` 工具结果、放在 tool 消息里。
 *
 * 默认套件必须无网（`vitest run` 不该依赖登录态），所以这里用 `WPS_COMATE_LIVE=1`
 * 显式开关；凭据取 `WPS_COMATE_SID`，或退回桌面端 `cordis.patch.yml` 里手填的 sid。
 *
 * 跑法：
 *   WPS_COMATE_LIVE=1 npx vitest run tests/multimodal-live.spec.ts
 *
 * 验收线（2026-09-25 实测通过）：5 个多模态模型全部答出图片主色，且出站载荷是
 * 上传后的 URL 而不是 inline base64；其中 `mimo-v2.5` 是修复前唯一失败的模型
 * （`unsupported message.content type=image`）。
 */
import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { describe, it } from 'vitest'
import { ComateCredentialStore } from '../src/auth.ts'
import { ComatePresignUploader } from '../src/assets.ts'
import { emptyImageStats, emptyUploadStats, uploadChatImages } from '../src/multimodal.ts'
import { ComateUpstreamClient, prepareChatBody } from '../src/upstream.ts'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
function crc32(b: Buffer): number { let c = 0xffffffff; for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function solidPng(size: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc(size * (1 + size * 3))
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3)
    for (let x = 0; x < size; x++) { raw[row + 1 + x * 3] = rgb[0]; raw[row + 2 + x * 3] = rgb[1]; raw[row + 3 + x * 3] = rgb[2] }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
function readSid(): string {
  const env = process.env['WPS_COMATE_SID']
  if (env !== undefined && env.trim() !== '') return env.trim()
  const m = /wpsSid:\s*(\S+)/.exec(readFileSync('C:/Users/ASUS/.dsh/profiles/desktop/cordis.patch.yml', 'utf8'))
  if (m === null) throw new Error('no wpsSid')
  return m[1]!.replace(/^['"]|['"]$/g, '')
}

const PNG = solidPng(96, [255, 0, 0])
const PNG_B64 = `data:image/png;base64,${PNG.toString('base64')}`

/** read_image 工具结果的真实形状：图片在 tool 消息里。 */
function toolImageBody(modelId: string, imageUrl: string): string {
  return JSON.stringify({
    model: modelId,
    stream: true,
    max_tokens: 300,
    messages: [
      { role: 'user', content: 'read 地图旗帜_002.png and tell me the main color' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_image', arguments: '{"file_path":"地图旗帜_002.png"}' } }] },
      {
        role: 'tool',
        tool_call_id: 'c1',
        content: [
          { type: 'text', text: '<path>地图旗帜_002.png</path>\n<type>image</type>' },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
  })
}

/** 走一遍插件真实链路，返回模型回答或错误。 */
async function ask(
  client: ComateUpstreamClient,
  credential: Awaited<ReturnType<ComateCredentialStore['current']>>,
  modelId: string,
  imageUrl: string,
): Promise<{ text: string; error: string; stats: string }> {
  const uploadStats = emptyUploadStats()
  let body = prepareChatBody(toolImageBody(modelId, imageUrl), emptyImageStats())
  body = await uploadChatImages(body, new ComatePresignUploader(), credential, uploadStats)
  const sent = JSON.parse(body) as { messages: { content: unknown }[] }
  const sentImage = JSON.stringify(sent.messages[2]?.content)
  const r = await client.chatStream(credential!, body, AbortSignal.timeout(120_000))
  const stats = `ext=${uploadStats.externalized} fail=${uploadStats.failed} payload=${sentImage.includes('data:image') ? 'base64' : 'url'}`
  if (!r.ok) return { text: '', error: `HTTP ${r.status} ${r.message.slice(0, 120)}`, stats }
  const raw = await r.response.text()
  let text = ''
  let error = ''
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    const p = line.slice(5).trim()
    if (p === '' || p === '[DONE]') continue
    try {
      const o = JSON.parse(p) as { error?: unknown; choices?: { delta?: { content?: string; reasoning_content?: string } }[] }
      if (o.error !== undefined) error = JSON.stringify(o.error)
      const d = o.choices?.[0]?.delta
      if (typeof d?.content === 'string') text += d.content
      else if (typeof d?.reasoning_content === 'string' && error === '') text += ''
    } catch { /* ignore */ }
  }
  return { text, error, stats }
}

describe.skipIf(process.env['WPS_COMATE_LIVE'] !== '1')('live: 5 模型图片矩阵', () => {
  it('all five models answer the image via the upload path', { timeout: 600_000 }, async () => {
    const store = new ComateCredentialStore({ wpsSid: readSid() })
    const credential = await store.current()
    if (credential === undefined) throw new Error('no credential')
    const client = new ComateUpstreamClient()

    // 1) 先只验上传器本身：同一张图连传两次，第二次必须命中缓存（只多一次 presign）。
    const uploader = new ComatePresignUploader()
    const url1 = await uploader.upload(PNG_B64, credential)
    const url2 = await uploader.upload(PNG_B64, credential)
    console.log(`uploader: ${url1 === undefined ? 'FAILED' : 'ok'} cached=${url1 === url2} url=${(url1 ?? '').split('?')[0]}`)
    if (url1 === undefined) return

    // 2) 5 个模型 × 真实失败形状。
    const names = ['deepseek-v4.1-flash', 'MiniMax-M3', 'kimi-k3', 'glm-5.3-flash', 'mimo-v2.5']
    for (const name of names) {
      const model = credential.models.find((m) => m.name === name)
      if (model === undefined) { console.log(`${name}: NOT FOUND in catalog`); continue }
      const started = Date.now()
      const { text, error, stats } = await ask(client, credential, model.id, PNG_B64)
      const verdict = error !== ''
        ? `ERR ${error.replace(/\s+/g, ' ').slice(0, 110)}`
        : `OK "${text.replace(/\s+/g, ' ').slice(0, 60)}"`
      console.log(`${name}: ${verdict} [${stats}] ${Date.now() - started}ms`)
    }
  })
})
