/**
 * 方案 B 真机验证：A+B 组合全链路。
 * shim 应同时（1）把标题请求预算提到 1024、（2）注入 reasoning_effort: off。
 * 断言全部 7 个报告模型出标题；mimo 系是 B 的功劳（A 救不了它）。
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PKG_DIR = join(process.cwd(), '..')
const pkg = await import(pathToFileURL(join(PKG_DIR, 'dsh-connect-comate', 'lib/index.js')).href)
const { ComateCatalog, ComateCredentialStore, ComatePresignUploader, ComateUpstreamClient, createComateShim } = pkg

const { readWpsSid } = await import(pathToFileURL(join(process.cwd(), 'scripts/live-profile.mjs')).href)

const store = new ComateCredentialStore()
store.setWpsSid(readWpsSid())
const credential = await store.current()
if (credential === undefined) { console.error('FAIL 拿不到凭据'); process.exit(1) }

const catalog = new ComateCatalog()
catalog.set(credential.models)

const warnings = []
const shim = createComateShim({
  store,
  client: new ComateUpstreamClient(),
  catalog,
  uploader: new ComatePresignUploader(),
  logger: { warn: (...a) => warnings.push(a.map(String).join(' ')), error: (...a) => warnings.push(a.map(String).join(' ')) },
})
await shim.ready
console.log(`shim: ${shim.baseUrl()}`)

const SYSTEM = [
  'Create a concise title for an AI coding-assistant session from the supplied human messages.',
  'Return only the title on one line, in plain text, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes.',
  'Aim for about 5 words in non-CJK languages or 10 CJK characters.',
].join('\n')
const USER_TEXT = 'Generate the session title from this JSON array of human messages:\n[{"seq":10,"text":"测试模型连接状态"}]'

const MODELS = [
  '600085158/deepseek/deepseek-v4-pro//public',
  '600085158/deepseek/deepseek-v4.1-flash//public',
  '600085158/minimax/MiniMax-M3//public',
  '600085158/xiaomi/mimo-v2.5-pro//public',
  '600085158/xiaomi/mimo-v2.5//public',
  '600085158/zhipu/glm-5.2//public',
  '600085158/zhipu/glm-5.3//public',
]

async function collect(res) {
  let text = ''
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const p = line.slice(5).trim()
      if (p === '[DONE]') continue
      let ev; try { ev = JSON.parse(p) } catch { continue }
      const c = ev.choices?.[0]
      if (typeof c?.delta?.content === 'string') text += c.delta.content
    }
  }
  return text
}

let failures = 0
for (const model of MODELS) {
  warnings.length = 0
  const body = JSON.stringify({
    model,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: USER_TEXT }],
    stream: true,
    max_tokens: 64,
  })
  const t0 = Date.now()
  const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
    body,
    signal: AbortSignal.timeout(120_000),
  })
  if (res.status !== 200) {
    console.log(`FAIL ${model.split('/')[2]}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`)
    failures++
    continue
  }
  const text = await collect(res)
  const raised = warnings.some(w => w.includes('title request budget raised 64 -> 1024'))
  const off = warnings.some(w => w.includes('reasoning disabled'))
  const name = model.split('/')[2]
  const ok = text.length > 0 && raised && off
  if (!ok) failures++
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(18)} text=${JSON.stringify(text).slice(0, 26).padEnd(28)}`
    + ` budget=${raised} off=${off} ${Date.now() - t0}ms`,
  )
  if (!ok) console.log(`      warnings: ${warnings.join(' | ') || '(none)'}`)
}

console.log(failures === 0 ? '\nPASS 全部通过' : `\nFAIL ${failures} 个失败`)
process.exit(failures === 0 ? 0 : 1)
