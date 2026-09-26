/**
 * 真机验收（默认跳过）：手动打开的思考档位**真的到了线上**，而且上游**真的照做**。
 *
 * 默认套件必须无网，所以用 `WPS_COMATE_LIVE=1` 显式开关；凭据取 `WPS_COMATE_SID`，
 * 或退回 DSH profile 的 `cordis.patch.yml` 里手填的 sid——**路径解析在
 * `scripts/live-profile.mjs`**（本文件与另两个真机脚本共用，那里没有任何用户名，
 * 换台机器不用改源码）。
 *
 * 跑法：
 *   WPS_COMATE_LIVE=1 npx vitest run tests/thinking-levels-live.spec.ts
 *
 * ## 为什么必须打真网关
 *
 * 这一路上有三个只能靠真请求才能证伪的环节：
 *
 *   1. **`off` 的到达方式**。harness 把「选择器里选 Off」折成**不发档位**
 *      （`dsh-llm-pi-ai` `profileOptions()`：`reasoning === "off"` → 整个
 *      `reasoning` 选项缺席），于是 pi-ai 只能走「未指定档位」那一支去读
 *      `thinkingLevelMap.off`。声明写错的表现是**请求成功、Off 无效**，纯单测
 *      看不出来——单测只能证明「我们声明了什么」，不能证明「选择器选 Off 时它被读到」。
 *   2. **上游是否执行**。字段对了但网关不认，同样是静默失效。所以这里断言的是
 *      **流回来的 reasoning 长度**：开 `off` 之后必须归零，而对照组必须**不**归零
 *      （否则「归零」可能只是这个模型本来就不思考）。
 *   3. **上游的例外与反例**。`glm-5.3` / `glm-5.3-flash` 即使收到 `off` 也照常思考，
 *      而 OpenAI 词汇表里的 `none` 被接受却无效——卡片文案里写死了这两句，所以它们
 *      必须各是一条真机断言，而不是一句广告词。
 *
 * 走的是真的 `PiAiAdapter` → 真 shim（真 HTTP 回环）→ 真网关，只有上游客户端被
 * 包一层以便读取转出去的 body——即被测链路完整、观测点唯一。
 */
import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import { readWpsSid } from '../scripts/live-profile.mjs'
import { COMATE_PROVIDER, createComateAdapter } from '../src/adapter.ts'
import { ComateCredentialStore, type ComateCredential } from '../src/auth.ts'
import { type ComateExtraThinkingLevel } from '../src/bridge.ts'
import { ComateCatalog } from '../src/catalog.ts'
import { createComateShim } from '../src/shim.ts'
import { ComateUpstreamClient } from '../src/upstream.ts'

/** 题面故意要求先推理：一眼能答的题会让「思考长度」失去区分度。 */
const PROMPT = 'A bat and a ball cost $1.10 together. The bat costs $1.00 more than the ball. '
  + 'How much does the ball cost? Think it through, then answer with the number only.'

/** 关思考这条路要有对照组才成立，所以先找一个「本来就会思考」的模型。 */
const BASELINE_PROBES = 3

/** 展开用的空对象：`exactOptionalPropertyTypes` 下不能写 `reasoning: undefined`。 */
const EMPTY: Record<string, never> = {}

/** One request through the whole chain, plus what it put on the wire. */
interface Attempt {
  /** The JSON body the shim handed to the upstream client. */
  body: Record<string, unknown>
  /** Concatenated visible text deltas. */
  text: string
  /** Concatenated reasoning deltas — the user-visible thinking, in characters. */
  reasoningChars: number
}

/** 凭据 + 目录：两条用例共用的两个真机输入。 */
async function liveInputs(): Promise<{ store: ComateCredentialStore; catalog: ComateCatalog; modelIds: string[] }> {
  const store = new ComateCredentialStore({ wpsSid: readWpsSid() })
  const credential = await store.current()
  expect(credential, '拿不到凭据（config.json 缺失或不可读）').toBeDefined()
  const catalog = new ComateCatalog()
  catalog.set(credential!.models.map(model => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    llmTypes: model.llmTypes ?? [],
  })))
  const modelIds = credential!.models.map(model => model.id)
  expect(modelIds.length, '模型目录是空的').toBeGreaterThan(0)
  return { store, catalog, modelIds }
}

/**
 * 唯一被包的一层：读转出去的 body。其余（路由、鉴权、SSE、pi-ai 的出站拼装）
 * 全是产品代码。
 */
async function liveShim(store: ComateCredentialStore, catalog: ComateCatalog) {
  const upstream = new ComateUpstreamClient()
  const bodies: string[] = []
  const warnings: string[] = []
  const shim = createComateShim({
    store,
    catalog,
    client: {
      chatStream: async (credential: ComateCredential, bodyJson: string, signal?: AbortSignal) => {
        bodies.push(bodyJson)
        return await upstream.chatStream(credential, bodyJson, signal)
      },
    },
    logger: {
      warn: (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) },
      error: (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) },
    },
  })
  await shim.ready
  return { shim, bodies, warnings }
}

/**
 * 走一次完整请求，并交回它真正写上线的那份 body。
 *
 * `effort` 用 harness 的拼法传：**选择器里选 Off 时它是 `undefined`**（见文件头
 * 第 1 条），所以这条用例里没有一处把 `'off'` 当参数传下去——那正是这个功能唯一
 * 值得钉住的地方。
 */
async function ask(
  comate: ReturnType<typeof createComateAdapter>,
  modelId: string,
  effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined,
  bodies: string[],
): Promise<Attempt> {
  let text = ''
  let reasoningChars = 0
  for await (const chunk of comate.adapter.stream({
    provider: COMATE_PROVIDER,
    model: modelId,
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
    ...(effort === undefined ? EMPTY : { reasoningEffort: ReasoningEffortId(effort) }),
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'reasoning-delta') reasoningChars += chunk.text.length
  }
  const raw = bodies.pop()
  expect(raw, 'shim 没有把请求转给上游').toBeDefined()
  return { body: JSON.parse(raw!) as Record<string, unknown>, text, reasoningChars }
}

/**
 * 裸上游探针（不经 shim / 适配器）：读一次请求真实的 `reasoning_content` 长度。
 *
 * 只在验「上游自己」的行为时用（`none` 不是本插件声明过的档位，适配器根本发不出
 * 它），其余用例一律走完整链路。
 */
async function probeUpstream(modelId: string, patch: Record<string, unknown>): Promise<number> {
  const credential = await new ComateCredentialStore({ wpsSid: readWpsSid() }).current()
  expect(credential, '拿不到凭据（config.json 缺失或不可读）').toBeDefined()
  const client = new ComateUpstreamClient()
  const body = {
    model: modelId,
    stream: true,
    messages: [{ role: 'user', content: PROMPT }],
    max_tokens: 1024,
    ...patch,
  }
  const result = await client.chatStream(credential!, JSON.stringify(body))
  if (!result.ok) throw new Error(`上游拒绝了这次请求（HTTP ${String(result.status)}，${result.kind}）`)
  const raw = await result.response.text()
  let reasoningChars = 0
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload) as { choices?: { delta?: Record<string, unknown> }[] }
      const delta = parsed.choices?.[0]?.delta ?? {}
      if (typeof delta['reasoning_content'] === 'string') reasoningChars += delta['reasoning_content'].length
    } catch { /* 非 JSON 行（注释/心跳）不算思考 */ }
  }
  return reasoningChars
}

describe.skipIf(process.env['WPS_COMATE_LIVE'] !== '1')('live: 思考档位', () => {
  it('打开 off 之后，「不发档位」这条路上游真的收到了 reasoning_effort=off 且真的不思考', { timeout: 300_000 }, async () => {
    const { store, catalog, modelIds } = await liveInputs()

    // 同一个模型、同一道题，只差「off 有没有被打开」——对照组是这条用例的骨架：
    // 没有它，「开 off 后 reasoning 归零」也可能只是这个模型本来就不思考。
    const off = await liveShim(store, catalog)
    const on = await liveShim(store, catalog)
    const offAdapter = createComateAdapter({ shim: off.shim, catalog })
    const onAdapter = createComateAdapter({ shim: on.shim, catalog, extraThinkingLevels: () => ['off'] })

    try {
      // 本目录里确实有不思考的模型（kimi-k3 在这道题上基线就是 0），拿它当对照组
      // 会让「归零」变成一句空话，所以先从前几个模型里挑一个真的会思考的。
      let modelId: string | undefined
      for (const candidate of modelIds.slice(0, BASELINE_PROBES)) {
        const attempt = await ask(offAdapter, candidate, undefined, off.bodies)
        expect('reasoning_effort' in attempt.body, '没打开 off 时不该声明档位').toBe(false)
        if (attempt.reasoningChars > 0) {
          modelId = candidate
          break
        }
      }
      expect(modelId, `前 ${BASELINE_PROBES} 个模型都不思考，这道用例失去对照组`).toBeDefined()

      // 选择器里那一行：开 off 之后它才存在，而且 harness 报的是 `off` 这个 id。
      // 顺序是 pi-ai 的 `EXTENDED_THINKING_LEVELS` 顺序，`off` 在最前（不是卡片顺序）。
      const before = await offAdapter.adapter.resolveModel(COMATE_PROVIDER, modelId!)
      const after = await onAdapter.adapter.resolveModel(COMATE_PROVIDER, modelId!)
      expect(before.reasoning?.efforts.map(effort => String(effort.id)), '没打开 off 时选择器里不该有它')
        .toEqual(['minimal', 'low', 'medium', 'high'])
      expect(after.reasoning?.efforts.map(effort => String(effort.id)))
        .toEqual(['off', 'minimal', 'low', 'medium', 'high'])

      // 打开 off 之后：同一个请求形状（仍不点名任何档位），出站 body 多出
      // reasoning_effort=off，思考归零。
      const silenced = await ask(onAdapter, modelId!, undefined, on.bodies)
      expect(silenced.body['reasoning_effort'], `出站 body 的字段不对：${JSON.stringify(Object.keys(silenced.body))}`)
        .toBe('off')
      expect(silenced.reasoningChars, 'off 没有真的关掉思考').toBe(0)
      expect(silenced.text.length, '关掉思考不该让正文也空掉').toBeGreaterThan(0)

      // 出站形状是这两次请求唯一该有的差别；归一化/外置都不该被触发。
      expect([...off.warnings, ...on.warnings]).toEqual([])
    } finally {
      await off.shim.close()
      await on.shim.close()
    }
  })

  it('xhigh / max 上游接受且仍在思考，而 glm-5.3 即使收到 off 也照常思考', { timeout: 300_000 }, async () => {
    const { store, catalog, modelIds } = await liveInputs()
    const modelId = modelIds[0]!
    const glmId = modelIds.find(id => /glm-5\.3/.test(id))

    const levels: ComateExtraThinkingLevel[] = ['off', 'xhigh', 'max']
    const { shim, bodies, warnings } = await liveShim(store, catalog)
    const comate = createComateAdapter({ shim, catalog, extraThinkingLevels: () => levels })

    try {
      const info = await comate.adapter.resolveModel(COMATE_PROVIDER, modelId)
      expect(info.reasoning?.efforts.map(effort => String(effort.id)))
        .toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

      // 显式点名 xhigh / max：harness 把它们原样交给 pi-ai，出站必须是同名档位，
      // 而且不能把思考关掉（网关把不认识的档位当成「别思考」是最可能的翻车方式）。
      for (const effort of ['xhigh', 'max'] as const) {
        const attempt = await ask(comate, modelId, effort, bodies)
        expect(attempt.body['reasoning_effort'], `点名 ${effort} 时出站的值不对`).toBe(effort)
        expect(attempt.reasoningChars, `${effort} 把思考关掉了，与「只是别名」的说法不符`).toBeGreaterThan(0)
      }

      // 卡片文案里写死了这句：glm-5.3 是上游的例外，off 对它们无效。它是文案的
      // 依据，所以必须跟着一起验——不然那句话迟早变成没人复核的传言。
      // （换台机器不一定有 glm-5.3，那就明说这句没被验证，而不是默默放过。）
      if (glmId === undefined) {
        console.log('SKIP glm 例外：本目录里没有 glm-5.3，卡片文案里那句需要重新取证')
      } else {
        const glm = await ask(comate, glmId, undefined, bodies)
        expect(glm.body['reasoning_effort'], 'glm 的请求形状与别的模型一致（off 照样发出去）').toBe('off')
        expect(glm.reasoningChars, 'glm-5.3 的行为变了：文案里那句「忽略 off」需要改写').toBeGreaterThan(0)
      }

      expect(warnings).toEqual([])
    } finally {
      await shim.close()
    }
  })

  it('none 不是 off：同一个模型上 off 归零，none 照常思考', { timeout: 300_000 }, async () => {
    const { modelIds } = await liveInputs()

    // `none` 是 OpenAI 词汇表里「不思考」的正式值，也是卡片文案专门提醒过的那句
    // 「接受却忽略」。它不是一个声明过的档位，适配器根本发不出它，所以这条只能走
    // 裸上游——要钉的本来也就是**上游**的行为。
    // 用 off 先证明这个模型会被关掉，none 才有区分度：否则「none 还在思考」可能
    // 只是这个模型本来就不受控。
    for (const candidate of modelIds.slice(0, BASELINE_PROBES)) {
      if (await probeUpstream(candidate, { reasoning_effort: 'off' }) !== 0) continue
      const withNone = await probeUpstream(candidate, { reasoning_effort: 'none' })
      expect(withNone, `${candidate}：off 能关掉思考，none 却也能——文案里那句「none 被忽略」需要改写`)
        .toBeGreaterThan(0)
      return
    }
    expect.unreachable(`前 ${BASELINE_PROBES} 个模型都不受 off 影响，这条用例失去区分度`)
  })
})
