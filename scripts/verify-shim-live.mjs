/**
 * 真机验收（**走完整 HTTP 链路**）：把插件当成真机那样跑起来——真的 shim 监听
 * 127.0.0.1、真的凭据（桌面端 config.json + cordis.patch.yml 里的 wpsSid）、真的
 * 上游网关——然后按 pi-ai 的请求形状 POST 一个带图的消息，看模型是否真的答出图里
 * 的两个颜色。
 *
 * 为什么还要这一层（`tests/multimodal-live.spec.ts` 已经测过图片链路）：
 *
 *   那个测试直接调 `prepareChatBody` / `uploadChatImages`，验的是**函数**；真机上
 *   出问题的那次请求是 DSH → pi-ai → shim(HTTP) → adapter → 上游，中间隔着 shim 的
 *   路由、鉴权、body 读取。层与层之间的接缝，只有真的打一次 HTTP 才算数。
 *
 * 同时它验的是**产物**而不是源码：默认 import 已安装的那份 `lib/`（可用
 * `COMATE_PKG_DIR` 换目录）。源码绿 ≠ 产物绿，0.3.2 就是这么翻车的。
 *
 * 跑法（需要登录态，默认不在 CI 里跑）：
 *   node scripts/verify-shim-live.mjs
 *   COMATE_PKG_DIR=C:/Users/ASUS/.dsh/profiles/desktop/node_modules/dsh-connect-comate \
 *     node scripts/verify-shim-live.mjs
 *
 * 判定：图片必须**答出左红右蓝**（只断言「有正文」会放过「我读不到这张图」），且
 * shim 的图片计数必须是 `externalized=1 upload_failed=0`——出站是 URL 而不是 inline
 * base64，才是这次修复真正要钉住的东西。
 */
import { deflateSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = resolve(process.env.COMATE_PKG_DIR ?? join(HERE, '..'))
const MODELS = (process.env.COMATE_LIVE_MODELS ?? 'mimo-v2.5').split(',').map(s => s.trim()).filter(Boolean)

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

/** 左半红、右半蓝的 PNG（不引依赖）。纯色图会被不看图也蒙对的回答骗过。 */
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

const IMAGE_DATA_URL = `data:image/png;base64,${halfAndHalfPng(96).toString('base64')}`

/** 手填的 wps_sid：桌面端 config 里是占位字面量，真会话只在 profile 的 patch 里。 */
function readSid() {
  const fromEnv = process.env.WPS_COMATE_SID
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()
  const patch = readFileSync('C:/Users/ASUS/.dsh/profiles/desktop/cordis.patch.yml', 'utf8')
  const match = /wpsSid:\s*(\S+)/.exec(patch)
  if (match === null) throw new Error('no wpsSid in cordis.patch.yml and no WPS_COMATE_SID')
  return match[1].replace(/^['"]|['"]$/g, '')
}

/** 真机上失败的那次请求形状：图片来自 read_image 工具结果，放在 tool 消息里。 */
function toolImageBody(modelId) {
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
          { type: 'image_url', image_url: { url: IMAGE_DATA_URL } },
        ],
      },
    ],
  })
}

async function collect(response) {
  const raw = await response.text()
  let text = ''
  let error = ''
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload)
      if (parsed.error !== undefined) error = JSON.stringify(parsed.error)
      const delta = parsed.choices?.[0]?.delta
      if (typeof delta?.content === 'string') text += delta.content
    } catch { /* keep-alive 或注释行 */ }
  }
  return { text, error }
}

const pkg = await import(pathToFileURL(join(PKG_DIR, 'lib/index.js')).href)
const {
  ComateCatalog, ComateCredentialStore, ComatePresignUploader, ComateUpstreamClient, createComateShim,
} = pkg

console.log(`package   : ${PKG_DIR}`)
console.log(`version   : ${pkg.COMATE_CONNECT_VERSION}`)

const store = new ComateCredentialStore()
store.setWpsSid(readSid())
const credential = await store.current()
if (credential === undefined) {
  console.error('FAIL 拿不到凭据（config.json 缺失或不可读）')
  process.exit(1)
}
console.log(`gateway   : ${credential.baseUrl}`)
console.log(`cookie    : ${credential.cookie === undefined ? 'absent' : 'present'}`)

const catalog = new ComateCatalog()
catalog.set(credential.models.map(m => ({
  id: m.id,
  name: m.name,
  contextWindow: m.contextWindow,
  llmTypes: m.llmTypes,
})))

const warnings = []
const shim = createComateShim({
  store,
  client: new ComateUpstreamClient(),
  catalog,
  uploader: new ComatePresignUploader(),
  logger: { warn: (...args) => warnings.push(args.map(String).join(' ')), error: (...a) => warnings.push(a.map(String).join(' ')) },
})
await shim.ready
console.log(`shim      : ${shim.baseUrl()}\n`)

let failures = 0
for (const name of MODELS) {
  const model = credential.models.find(candidate => candidate.name === name)
  if (model === undefined) {
    console.log(`FAIL ${name}: 模型目录里没有这个模型`)
    failures++
    continue
  }
  warnings.length = 0
  const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
    body: toolImageBody(model.id),
    signal: AbortSignal.timeout(120_000),
  })
  if (response.status !== 200) {
    console.log(`FAIL ${name}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
    failures++
    continue
  }
  const { text, error } = await collect(response)
  const counted = warnings.join(' ')
  const problems = []
  if (error !== '') problems.push(`上游错误事件: ${error.slice(0, 200)}`)
  if (!/red|红/i.test(text)) problems.push(`没答出红色（回答=${text.slice(0, 120)}）`)
  if (!/blue|蓝/i.test(text)) problems.push(`没答出蓝色（回答=${text.slice(0, 120)}）`)
  if (!/externalized=1/.test(counted)) problems.push(`shim 没记到外置（计数: ${counted || '(无)'}）`)
  if (!/upload_failed=0/.test(counted)) problems.push(`上传失败（计数: ${counted || '(无)'}）`)
  if (problems.length > 0) {
    console.log(`FAIL ${name}: ${problems.join('; ')}`)
    failures++
  } else {
    console.log(`ok   ${name}: ${text.replace(/\s+/g, ' ').slice(0, 70)}`)
  }
}

await shim.close()
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${MODELS.length - failures}/${MODELS.length}`)
process.exit(failures === 0 ? 0 : 1)
