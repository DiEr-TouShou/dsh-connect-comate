/**
 * 原始证据采集器（不是回归闸）：`reasoning_effort` 各取值在真网关上的行为。
 *
 * 与 `thinking-levels-live.spec.ts` 的分工：那个走完整适配器、断言「插件现在是对的」；
 * 这个**绕开适配器**直接打上游，只把观察结果打出来（`SHAPE` / `EFFORT` 行），是 0.4.1-rc.4
 * 那些表格数字的出处。改档位映射之前先跑它，别拿旧结论当事实——这次就是这么发现
 * 「三个 glm 都忽略 off」只对了两个。
 *
 * 代价：第二个用例是 10 模型 × 6 档位 × 2 轮 = 120 次请求，默认跳过，要手动开：
 *
 * ```sh
 * WPS_COMATE_LIVE=1 npx vitest run tests/thinking-probe-live.spec.ts
 * ```
 */
import { describe, it } from 'vitest'
import { readWpsSid } from '../scripts/live-profile.mjs'
import { ComateCredentialStore } from '../src/auth.ts'
import { ComateUpstreamClient } from '../src/upstream.ts'

const PROMPT = 'What is 17 + 25? Answer with the number only.'
/** 展开用的空对象。 */
const EMPTY: Record<string, never> = {}
const HARD = 'A bat and a ball cost $1.10. The bat costs $1.00 more than the ball. '
  + 'How much does the ball cost? Think it through, then answer.'

interface Shape {
  label: string
  patch: Record<string, unknown>
}

const SHAPES: Shape[] = [
  { label: 'baseline', patch: EMPTY },
  { label: 'effort=none', patch: { reasoning_effort: 'none' } },
  { label: 'effort=off', patch: { reasoning_effort: 'off' } },
  { label: 'effort=disabled', patch: { reasoning_effort: 'disabled' } },
  { label: 'effort=false', patch: { reasoning_effort: false } },
  { label: 'reasoning:{effort:none}', patch: { reasoning: { effort: 'none' } } },
  { label: 'reasoning:{effort:off}', patch: { reasoning: { effort: 'off' } } },
  { label: 'thinking:{type:disabled}', patch: { thinking: { type: 'disabled' } } },
  { label: 'enable_thinking:false', patch: { enable_thinking: false } },
]

const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

async function probe(
  client: ComateUpstreamClient,
  credential: NonNullable<Awaited<ReturnType<ComateCredentialStore['current']>>>,
  model: string,
  patch: Record<string, unknown>,
  prompt: string,
): Promise<{ status: number; reasoningChars: number; text: string; excerpt: string }> {
  const body: Record<string, unknown> = {
    model,
    stream: true,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1024,
    ...patch,
  }
  const result = await client.chatStream(credential, JSON.stringify(body))
  if (!result.ok) {
    return { status: result.status, reasoningChars: -1, text: '', excerpt: result.message.slice(0, 200) }
  }
  const raw = await result.response.text()
  let reasoning = ''
  let text = ''
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload) as { choices?: { delta?: Record<string, unknown> }[] }
      const delta = parsed.choices?.[0]?.delta ?? {}
      if (typeof delta['reasoning_content'] === 'string') reasoning += delta['reasoning_content']
      if (typeof delta['content'] === 'string') text += delta['content']
    } catch { /* 非 JSON 行 */ }
  }
  return { status: 200, reasoningChars: reasoning.length, text, excerpt: '' }
}

describe.skipIf(process.env['WPS_COMATE_LIVE'] !== '1')('probe: reasoning_effort', () => {
  it('关思考的各种写法', { timeout: 600_000 }, async () => {
    const store = new ComateCredentialStore({ wpsSid: readWpsSid() })
    const credential = await store.current()
    const client = new ComateUpstreamClient()
    for (const model of credential!.models.map(m => m.id)) {
      for (const shape of SHAPES) {
        const observed = await probe(client, credential!, model, shape.patch, PROMPT)
        console.log(`SHAPE ${JSON.stringify({ model, shape: shape.label, ...observed })}`)
      }
    }
  })

  it('各强度档位在同一道题上的思考长度', { timeout: 900_000 }, async () => {
    const store = new ComateCredentialStore({ wpsSid: readWpsSid() })
    const credential = await store.current()
    const client = new ComateUpstreamClient()
    for (const model of credential!.models.map(m => m.id)) {
      for (const effort of EFFORTS) {
        // 同一档位跑两次：单次样本区分不了「档位差异」和「采样噪声」。
        const runs: number[] = []
        for (let round = 0; round < 2; round += 1) {
          const observed = await probe(client, credential!, model, { reasoning_effort: effort }, HARD)
          runs.push(observed.reasoningChars)
        }
        console.log(`EFFORT ${JSON.stringify({ model, effort, reasoningChars: runs })}`)
      }
    }
  })
})
