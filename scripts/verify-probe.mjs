/**
 * 探测验收（**针对已构建的产物**）：把四种上游回答喂给产物里的 `runComateCheck`，
 * 看它到底报成功还是失败。
 *
 * 为什么单开一个脚本：
 *
 *   1. 验的是**产物**而不是源码（默认 import 已装的 `lib/`，可用 `COMATE_PKG_DIR`
 *      换目录）。源码绿 ≠ 产物绿。
 *   2. 它**不需要登录态**：上游是本地桩，所以任何机器上都能跑。「假成功」是个判断
 *      错误，不该只在有账号的机器上才被检查。
 *   3. 每条用例都带**看门狗**：旧实现没有总超时，上游连状态行都不回时会**永远挂着**。
 *      没有看门狗的话，反向对照跑旧产物不是变红，而是卡死。
 *
 * 七条用例：干净往返 / 空正文 / 流内 error / 只回状态行后挂起 / 有事件但流不结束 /
 * 上游根本不应答 / 上游拒绝。判定是「`ok` 的取值对不对」**且**「分段事实
 * accepted/completed/content 对不对」——只判 ok 会漏掉「凭据通过但探测没跑完」这一档。
 *
 * 跑法：
 *   node scripts/verify-probe.mjs
 *   COMATE_PKG_DIR="<插件安装目录>" node scripts/verify-probe.mjs
 *
 * 退出码 0 = 7/7 通过。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = resolve(process.env.COMATE_PKG_DIR ?? join(HERE, '..'))
const ENTRY = join(PKG_DIR, 'lib', 'index.js')
if (!existsSync(ENTRY)) {
  console.error(`找不到产物：${ENTRY}\n用 COMATE_PKG_DIR 指定插件目录。`)
  process.exit(2)
}
const lib = await import(pathToFileURL(ENTRY).href)

/** 合成凭据：探测只把它交给桩，桩不回显。 */
const CREDENTIAL = {
  baseUrl: 'https://comate.wps.cn/llmproxy/v1/user',
  apiKey: 'placeholder-key',
  cookie: 'wps_sid=placeholder',
  authHeader: true,
  models: [{ id: 'model-a', name: 'A', contextWindow: 1_000_000 }],
  configFile: 'C:/fake/config.json',
}

/** 每条用例的看门狗上限：旧产物会挂在这里。 */
const WATCHDOG_MS = 4_000
/** 交给产物的总预算；给得短，用例才跑得快。 */
const PROBE_MS = 200

console.log(`package : ${PKG_DIR}`)
console.log(`version : ${lib.COMATE_CONNECT_VERSION}\n`)

/** 一个 SSE 帧，正文是一段助手文本。 */
const frame = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`

/** 一个 200 响应，body 是脚本化的 SSE 流；`hang` 让它在脚本用完后继续挂着。 */
function okResponse(chunks, { hang = false } = {}) {
  const encoder = new TextEncoder()
  let index = 0
  const stream = new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        const chunk = chunks[index++]
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
        return
      }
      if (hang) return new Promise(() => {})
      controller.close()
    },
  })
  return { ok: true, response: new Response(stream, { status: 200 }) }
}

let failures = 0
let total = 0

/**
 * 一条用例：跑一次探测，逐项比对期望。
 *
 * @param name - 用例名。
 * @param options - `result` 是桩要返回的上游结果（默认桩）；`client` 换成自定义桩，
 *   用来造「永远不应答」；`expect` 是期望的字段取值（只比列出的字段）。
 */
async function probeCase(name, { result, client, expect }) {
  total++
  let outcome
  let watchdog
  try {
    outcome = await Promise.race([
      lib.runComateCheck({
        credential: CREDENTIAL,
        client: client ?? { chatStream: async () => result },
        model: 'model-a',
        timeoutMs: PROBE_MS,
      }),
      new Promise((resolveWatchdog) => {
        watchdog = setTimeout(() => resolveWatchdog('WATCHDOG'), WATCHDOG_MS)
      }),
    ])
  } catch (error) {
    console.log(`FAIL ${name}: 探测本身抛错 ${String(error)}`)
    failures++
    return
  } finally {
    clearTimeout(watchdog)
  }
  if (outcome === 'WATCHDOG') {
    console.log(`FAIL ${name}: 看门狗超时（${WATCHDOG_MS}ms）——探测没有返回`)
    failures++
    return
  }
  const problems = []
  for (const [key, want] of Object.entries(expect)) {
    if (outcome[key] !== want) problems.push(`${key} 期望 ${want}，实际 ${outcome[key]}`)
  }
  if (problems.length > 0) {
    console.log(`FAIL ${name}: ${problems.join('; ')}`)
    console.log(`     实际结果：${JSON.stringify(outcome)}`)
    failures++
  } else {
    console.log(`ok   ${name}`)
  }
}

await probeCase(
  'clean round trip',
  {
    result: okResponse([
      frame('pong'),
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ]),
    expect: { ok: true, accepted: true, completed: true, content: true },
  },
)

// 旧实现：拿到 2xx 就 cancel body 返回 ok → 这里会 FAIL（ok 期望 false，实际 true）。
await probeCase('empty 200 body', { result: okResponse([]), expect: { ok: false, accepted: false } })

// 旧实现：同上。网关真实的未登录形状（HTTP 200 + 流内 error）。
await probeCase(
  'error inside a 200 stream',
  {
    result: okResponse([
      `data: ${JSON.stringify({ error: { message: '未登录，请先登录', type: 'authentication_error', code: 'not_login' } })}\n\n`,
    ]),
    expect: { ok: false, accepted: false, kind: 'session_dead' },
  },
)

// 旧实现：同上（它连 body 都不读，所以立刻回 ok:true，而不是挂着）。
await probeCase('status line then silence', {
  result: okResponse([], { hang: true }),
  expect: { ok: false, accepted: false },
})

// 这一档是新增的区分：凭据确实通过了，但往返没有跑完，不能算成功。
await probeCase('events then silence', {
  result: okResponse([frame('pong')], { hang: true }),
  expect: { ok: false, accepted: true, content: true },
})

// 旧实现没有总超时 → 这里会由看门狗判 FAIL（而不是让脚本卡死）。
await probeCase('upstream never answers', {
  client: { chatStream: () => new Promise(() => {}) },
  // `accepted` is absent on purpose: nothing was ever answered, so there is
  // nothing to say about the credential either way.
  expect: { ok: false, status: 0, kind: 'server' },
})

// 回归：上游非 2xx 的拒绝路径不该被这次改造动到。
await probeCase(
  'upstream refusal',
  {
    result: { ok: false, status: 402, kind: 'hard_credit', message: '积分不足' },
    expect: { ok: false, status: 402, kind: 'hard_credit' },
  },
)

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${total - failures}/${total}`)
process.exit(failures === 0 ? 0 : 1)
