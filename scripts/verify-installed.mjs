/**
 * 安装产物验收：直接 import **已构建的 lib/**（不是 src/），跑 5 模型图片矩阵。
 *
 * 为什么单开一个脚本：源码树跑绿 ≠ 安装产物跑绿。0.3.2 就是这么翻车的——单测里
 * `llm_types` 是字符串、真机是 JSON 数组，128 例全绿而功能在产物里是废的。所以
 * 每次覆盖安装后，除了 `dsh-connect-comate check`，还应该跑一次这个。
 *
 * 用法：
 *   WPS_COMATE_SID=<sid> node scripts/verify-installed.mjs
 *   COMATE_PLUGIN_DIR="<插件安装目录>" WPS_COMATE_SID=<sid> node scripts/verify-installed.mjs
 *
 * 默认目录是桌面端 profile 的安装位置；`WPS_COMATE_SID` 必须给（命令行没有宿主
 * 注入的设置，插件读不到卡片里那个 sid，不给就是 HTTP 401）。
 *
 * 退出码 0 = 5/5 通过。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { deflateSync } from 'node:zlib'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// `homedir()` 而不是 `USERPROFILE`：后者只在 Windows 上有，别的平台上会拼出一个
// 相对 cwd 的假路径，报错也看不出是认路认错了。
const pluginDir = process.env['COMATE_PLUGIN_DIR']
  ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-connect-comate')
const entry = join(pluginDir, 'lib', 'index.js')
if (!existsSync(entry)) {
  console.error(`找不到安装产物：${entry}\n用 COMATE_PLUGIN_DIR 指定插件安装目录。`)
  process.exit(2)
}
const lib = await import(pathToFileURL(entry).href)

// ---------- 一张左红右蓝的 PNG（不引依赖）：两色才能分辨「真看到」还是「蒙的」 ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function halfAndHalfPng(size) {
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

/** 真机上出过问题的形状：图片来自 read_image 工具结果，放在 tool 消息里。 */
const body = (modelId, imageUrl) => JSON.stringify({
  model: modelId,
  stream: true,
  max_tokens: 400,
  messages: [
    { role: 'user', content: 'What are the two colors in this image? Give the left half color and the right half color.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_image', arguments: '{"file_path":"half.png"}' } }],
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

console.log(`installed version: ${lib.COMATE_CONNECT_VERSION}  (${entry})`)

const store = new lib.ComateCredentialStore({ wpsSid: process.env['WPS_COMATE_SID'] })
const credential = await store.current()
if (credential === undefined) {
  console.error('没有可用凭据：命令行读不到卡片里的 sid，请给 WPS_COMATE_SID。')
  process.exit(2)
}
const client = new lib.ComateUpstreamClient()

// 上传器：同一张图两次，第二次必须命中缓存（不重传字节）。
const uploader = new lib.ComatePresignUploader()
const first = await uploader.upload(PNG_B64, credential)
const second = await uploader.upload(PNG_B64, credential)
console.log(`uploader: ${first === undefined ? 'FAILED' : 'ok'} cached=${first === second}`)
if (first === undefined) process.exit(1)

let failures = 0
for (const name of ['deepseek-v4.1-flash', 'MiniMax-M3', 'kimi-k3', 'glm-5.3-flash', 'mimo-v2.5']) {
  const model = credential.models.find((candidate) => candidate.name === name)
  if (model === undefined) {
    console.log(`${name}: NOT FOUND in catalog`)
    failures++
    continue
  }
  const stats = lib.emptyUploadStats()
  const prepared = await lib.uploadChatImages(
    lib.prepareChatBody(body(model.id, PNG_B64), lib.emptyImageStats()),
    uploader,
    credential,
    stats,
  )
  const wire = JSON.stringify(JSON.parse(prepared).messages[2].content)
  const payload = wire.includes('data:image') ? 'base64' : 'url'
  if (payload !== 'url') {
    console.log(`${name}: ERR 出站仍是 inline base64，外置没生效`)
    failures++
    continue
  }
  const started = Date.now()
  const result = await client.chatStream(credential, prepared, AbortSignal.timeout(120_000))
  if (!result.ok) {
    console.log(`${name}: ERR HTTP ${result.status} [${payload}]`)
    failures++
    continue
  }
  const raw = await result.response.text()
  let text = ''
  let error = ''
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    const event = line.slice(5).trim()
    if (event === '' || event === '[DONE]') continue
    try {
      const parsed = JSON.parse(event)
      if (parsed.error !== undefined) error = JSON.stringify(parsed.error)
      const delta = parsed.choices?.[0]?.delta
      if (typeof delta?.content === 'string') text += delta.content
    } catch { /* keep-alive */ }
  }
  // 两个颜色都答出来才算「真的看到了图」：只查「有正文」会放过「我读不到这张图」。
  const sawRed = /red|红/i.test(text)
  const sawBlue = /blue|蓝/i.test(text)
  if (error !== '' || !sawRed || !sawBlue) {
    failures++
    console.log(`${name}: ERR ${(error || `没答全两色：${text.replace(/\s+/g, ' ').slice(0, 90)}`)} [ext=${stats.externalized} fail=${stats.failed} ${payload}]`)
    continue
  }
  console.log(`${name}: OK "${text.replace(/\s+/g, ' ').slice(0, 60)}" [ext=${stats.externalized} fail=${stats.failed} payload=${payload}] ${Date.now() - started}ms`)
}

console.log(failures === 0 ? 'RESULT: 5/5 OK' : `RESULT: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
