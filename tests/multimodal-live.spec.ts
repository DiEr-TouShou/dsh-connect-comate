/**
 * 真机验收测试（默认跳过）：走插件自己的完整链路
 * （`prepareChatBody` → `uploadChatImages` → 真 presign 上传 → 上游），复刻真机上
 * 出问题的那次请求形状——图片来自 `read_image` 工具结果、放在 tool 消息里。
 *
 * 默认套件必须无网（`vitest run` 不该依赖登录态），所以这里用 `WPS_COMATE_LIVE=1`
 * 显式开关；凭据取 `WPS_COMATE_SID`，或退回 DSH profile 的 `cordis.patch.yml` 里
 * 手填的 sid——路径解析在 `scripts/live-profile.mjs`（与另两个真机脚本共用，
 * 那里没有任何用户名，换台机器不用改源码）。
 *
 * 跑法：
 *   WPS_COMATE_LIVE=1 npx vitest run tests/multimodal-live.spec.ts
 *
 * ## 为什么图是「左红右蓝」而不是纯色
 *
 * 纯色图 + 「主色是什么」这种问法，模型**不看图也可能蒙对**，更糟的是它会答
 * 「我读不到这张图」——两种都算「有正文」。第一版验收就栽在这里：安装产物矩阵里
 * MiniMax 回了「I attempted to read the image file …, but …」，脚本却判它通过。
 * 现在用两色图并要求分别答出左右半边，断言**两个颜色都出现**：取不到图的模型
 * 会明确失败，而不是留下一条看似正常的话。
 *
 * 验收线（2026-09-25 实测通过，源码树与安装产物各跑一次）：5 个多模态模型全部
 * 答出左红右蓝，出站载荷是上传后的 URL 而不是 inline base64（`ext=1 fail=0`）。
 * 其中 `mimo-v2.5` 是修复前唯一失败的模型：发 base64 时上游回
 * `unsupported message.content type=image`（同一张图换成 URL 即正常）。
 */
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { readWpsSid } from '../scripts/live-profile.mjs'
import { ComateCredentialStore } from '../src/auth.ts'
import { ComatePresignUploader } from '../src/assets.ts'
import { emptyImageStats, emptyUploadStats, uploadChatImages } from '../src/multimodal.ts'
import { ComateUpstreamClient, prepareChatBody } from '../src/upstream.ts'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** 左半红、右半蓝的 PNG（不引依赖）。 */
function halfAndHalfPng(size: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(size * (1 + size * 3))
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3)
    for (let x = 0; x < size; x++) {
      const left = x < size / 2
      raw[row + 1 + x * 3] = left ? 255 : 0
      raw[row + 2 + x * 3] = 0
      raw[row + 3 + x * 3] = left ? 0 : 255
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const PNG_B64 = `data:image/png;base64,${halfAndHalfPng(96).toString('base64')}`

/** 真机上失败的那次请求形状：图片来自 read_image 工具结果，放在 tool 消息里。 */
function toolImageBody(modelId: string, imageUrl: string): string {
  return JSON.stringify({
    model: modelId,
    stream: true,
    max_tokens: 400,
    messages: [
      { role: 'user', content: 'What are the two colors in this image? Give the left half color and the right half color.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'c1',
          type: 'function',
          function: { name: 'read_image', arguments: '{"file_path":"half.png"}' },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'c1',
        content: [
          { type: 'text', text: '<path>half.png</path>\n<type>image</type>' },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
  })
}

/** 读 SSE，拼出正文与错误。 */
async function collect(response: Response): Promise<{ text: string; error: string }> {
  const raw = await response.text()
  let text = ''
  let error = ''
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload) as {
        error?: unknown
        choices?: { delta?: { content?: string } }[]
      }
      if (parsed.error !== undefined) error = JSON.stringify(parsed.error)
      const delta = parsed.choices?.[0]?.delta
      if (typeof delta?.content === 'string') text += delta.content
    } catch { /* keep-alive 或注释行 */ }
  }
  return { text, error }
}

describe.skipIf(process.env['WPS_COMATE_LIVE'] !== '1')('live: 5 模型图片矩阵', () => {
  it('五个多模态模型都真的看到了图（左红右蓝），且出站是 URL', { timeout: 600_000 }, async () => {
    const store = new ComateCredentialStore({ wpsSid: readWpsSid() })
    const credential = await store.current()
    expect(credential).toBeDefined()
    const client = new ComateUpstreamClient()

    // 上传器自身：同一张图两次，第二次命中缓存（不重传字节）。
    const uploader = new ComatePresignUploader()
    const first = await uploader.upload(PNG_B64, credential!)
    const second = await uploader.upload(PNG_B64, credential!)
    expect(first, '上传失败：资产接口没通，后面的外置无从谈起').toBeDefined()
    expect(second).toBe(first)

    for (const name of ['deepseek-v4.1-flash', 'MiniMax-M3', 'kimi-k3', 'glm-5.3-flash', 'mimo-v2.5']) {
      const model = credential!.models.find((candidate) => candidate.name === name)
      expect(model, `模型目录里没有 ${name}`).toBeDefined()

      const stats = emptyUploadStats()
      const prepared = await uploadChatImages(
        prepareChatBody(toolImageBody(model!.id, PNG_B64), emptyImageStats()),
        uploader,
        credential,
        stats,
      )
      const sent = JSON.parse(prepared) as { messages: { content: unknown }[] }
      const wire = JSON.stringify(sent.messages[2]?.content)
      expect(wire, `${name}: 出站仍是 inline base64，外置没生效`).not.toContain('data:image')
      expect(stats).toEqual({ externalized: 1, failed: 0 })

      const result = await client.chatStream(credential!, prepared, AbortSignal.timeout(120_000))
      expect(result.ok, `${name}: 上游拒绝（HTTP ${result.ok ? '' : result.status}）`).toBe(true)
      if (!result.ok) continue
      const { text, error } = await collect(result.response)

      expect(error, `${name}: 上游回错误事件`).toBe('')
      // 两色都答出来才算「真的看到了图」——只断言「有正文」会放过
      // 「我读不到这张图」这类话（第一版验收就这么误判过 MiniMax）。
      expect(text, `${name}: 没答出红色（回答=${text.slice(0, 120)}）`).toMatch(/red|红/i)
      expect(text, `${name}: 没答出蓝色（回答=${text.slice(0, 120)}）`).toMatch(/blue|蓝/i)
      process.stdout.write(`  ✓ ${name}: ${text.replace(/\s+/g, ' ').slice(0, 70)}\n`)
    }
  })
})
