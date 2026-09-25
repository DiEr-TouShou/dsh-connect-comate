/**
 * 真机验收（默认跳过）：输出上限**真的到了线上**，而且上游**真的执行了**它。
 *
 * 默认套件必须无网，所以用 `WPS_COMATE_LIVE=1` 显式开关；凭据取 `WPS_COMATE_SID`，
 * 或退回 DSH profile 的 `cordis.patch.yml` 里手填的 sid——**路径解析在
 * `scripts/live-profile.mjs`**（本文件与另两个真机脚本共用，那里没有任何用户名，
 * 换台机器不用改源码）。
 *
 * 跑法：
 *   WPS_COMATE_LIVE=1 npx vitest run tests/max-tokens-live.spec.ts
 *
 * ## 为什么必须打真网关
 *
 * 上限这一路上有三个只能靠真请求才能证伪的环节：
 *
 *   1. **字段名**。pi-ai 按 `compat.maxTokensField` 决定写 `max_tokens` 还是
 *      `max_completion_tokens`；本插件的 baseUrl 是回环、provider 是 `comate`，
 *      pi-ai 的 detectCompat() 认不出家族。声明写错的表现是**请求成功、上限无效**，
 *      纯单测看不出来。所以这里直接看 shim 转出去的 body 里是哪个字段。
 *   2. **上游是否执行**。字段对了但网关不认，同样是静默失效。断言 `finish.reason`
 *      必须是 `length`（`max_tokens: 16` 配「数到 200」的题面，被截断是唯一可能）。
 *   3. **`0` = 不设上限**。这是本插件「0 为无限制」那一半的**唯一**证据：同一题面
 *      下不限长必须能真的数到 100 以上、且 `reason` 不是 `length`。
 *   4. **逐模型解析**。上限现在按模型算，所以还有一条只能靠真请求证伪的断言：
 *      同一个路由上两个模型各带各的上限，harness 从 `resolveModel()` 读到的
 *      `defaultMaxTokens` 必须一个是一个不是，而那个「不是」的模型发出去时
 *      出站 body 里**不能**出现 `max_tokens`（缺席是逐模型的：它不能被邻居连累）。
 *
 * 走的是真的 `PiAiAdapter` → 真 shim（真 HTTP 回环）→ 真网关，只有上游客户端被
 * 包一层以便读取转出去的 body——即被测链路完整、观测点唯一。
 */
import { describe, expect, it } from 'vitest'
import { readWpsSid } from '../scripts/live-profile.mjs'
import { COMATE_PROVIDER, createComateAdapter } from '../src/adapter.ts'
import { ComateCredentialStore, type ComateCredential } from '../src/auth.ts'
import { COMATE_DEFAULT_MAX_TOKENS } from '../src/bridge.ts'
import { ComateCatalog } from '../src/catalog.ts'
import { COMATE_UNLIMITED_MAX_TOKENS } from '../src/max-tokens.ts'
import { createComateShim } from '../src/shim.ts'
import { ComateUpstreamClient } from '../src/upstream.ts'

/** 题面故意长到远超任何小上限，让「被截断」成为唯一可能。 */
const PROMPT = 'Count from 1 to 200, one number per line, no commentary.'

/** One request through the whole chain, plus what it put on the wire. */
interface Attempt {
  /** The JSON body the shim handed to the upstream client. */
  body: Record<string, unknown>
  /** Concatenated text deltas. */
  text: string
  /** Why the model stopped, as the adapter reported it (`{ kind }`). */
  reason: { kind: string } | undefined
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

/** 展开用的空对象：`exactOptionalPropertyTypes` 下不能写 `maxTokens: undefined`。 */
const EMPTY: Record<string, never> = {}

/** 走一次完整请求，并交回它真正写上线的那份 body。 */
async function ask(
  comate: ReturnType<typeof createComateAdapter>,
  modelId: string,
  maxTokens: number | undefined,
  bodies: string[],
): Promise<Attempt> {
  let text = ''
  let reason: { kind: string } | undefined
  for await (const chunk of comate.adapter.stream({
    provider: COMATE_PROVIDER,
    model: modelId,
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
    ...(maxTokens === undefined ? EMPTY : { maxTokens }),
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish') reason = chunk.reason
  }
  const raw = bodies.pop()
  expect(raw, 'shim 没有把请求转给上游').toBeDefined()
  return { body: JSON.parse(raw!) as Record<string, unknown>, text, reason }
}

describe.skipIf(process.env['WPS_COMATE_LIVE'] !== '1')('live: 输出上限', () => {
  it('把上限写成 max_tokens 并让上游执行它，0 则真的不设上限', { timeout: 300_000 }, async () => {
    const { store, catalog, modelIds } = await liveInputs()
    const modelId = modelIds[0]!

    const { shim, bodies, warnings } = await liveShim(store, catalog)
    const comate = createComateAdapter({ shim, catalog })

    try {
      // 1) 小上限：字段名必须是 max_tokens，且上游真的截断。
      const capped = await ask(comate, modelId, 16, bodies)
      expect(capped.body['max_tokens'], `出站 body 的字段不对：${JSON.stringify(Object.keys(capped.body))}`)
        .toBe(16)
      expect(capped.body['max_completion_tokens']).toBeUndefined()
      expect(capped.reason?.kind, `被截断时 reason 应为 max-tokens，实得 ${JSON.stringify(capped.reason)}`)
        .toBe('max-tokens')

      // 2) 0 = 不设上限：字段根本不出现，同一题面必须真的数到 100 以上。
      const uncapped = await ask(comate, modelId, COMATE_UNLIMITED_MAX_TOKENS, bodies)
      expect('max_tokens' in uncapped.body, '0 不该在出站 body 里留下 max_tokens').toBe(false)
      expect(uncapped.reason?.kind).not.toBe('max-tokens')
      expect(uncapped.text, `不限长却没数到 100：${uncapped.text.slice(0, 200)}`).toContain('100')
      expect(uncapped.text.length).toBeGreaterThan(capped.text.length)

      // 出站形状是这两次请求唯一该有的差别；归一化/外置都不该被触发。
      expect(warnings).toEqual([])
    } finally {
      await shim.close()
    }
  })

  it('每个模型各用各的上限：同一路由上一个被截断、一个不限，互不干扰', { timeout: 300_000 }, async () => {
    const { store, catalog, modelIds } = await liveInputs()
    const freeId = modelIds[0]!
    const cappedId = modelIds[1]
    expect(cappedId, '这条用例需要两个模型才成立').toBeDefined()
    expect(cappedId).not.toBe(freeId)

    // 卡片里存的就是这张表：设过的模型有键，留空的模型**没有键**（跟随全局默认值）。
    const caps: Record<string, number> = { [cappedId!]: 16, [freeId]: COMATE_UNLIMITED_MAX_TOKENS }
    const { shim, bodies, warnings } = await liveShim(store, catalog)
    const comate = createComateAdapter({
      shim,
      catalog,
      maxOutputTokens: (modelId: string) => caps[modelId] ?? COMATE_DEFAULT_MAX_TOKENS,
    })

    try {
      // harness 真正读的那个字段：逐模型解析的结果要落在各自的 defaultMaxTokens 上，
      // 不设上限的那个必须**整条缺席**——缺席才不会在请求里被物化成 max_tokens。
      const cappedInfo = await comate.adapter.resolveModel(COMATE_PROVIDER, cappedId!)
      const freeInfo = await comate.adapter.resolveModel(COMATE_PROVIDER, freeId)
      expect(cappedInfo.defaultMaxTokens).toBe(16)
      expect(freeInfo.defaultMaxTokens).toBeUndefined()

      // 真发一次「harness 会物化出的那个值」（`resolveCallWithInfo` 取的就是它）。
      const capped = await ask(comate, cappedId!, cappedInfo.defaultMaxTokens, bodies)
      expect(capped.body['max_tokens'], `出站 body 的字段不对：${JSON.stringify(Object.keys(capped.body))}`)
        .toBe(16)
      expect(capped.reason?.kind, `被截断时 reason 应为 max-tokens，实得 ${JSON.stringify(capped.reason)}`)
        .toBe('max-tokens')

      // 邻居不受影响：同一次装配、同一个路由，另一个模型照旧不设上限。
      // （不限长在这里用 0 表达，与上面那条用例同一个约定：0 → 出站不留字段。）
      const free = await ask(comate, freeId, freeInfo.defaultMaxTokens ?? COMATE_UNLIMITED_MAX_TOKENS, bodies)
      expect('max_tokens' in free.body, '不设上限的模型不该被邻居的条目连累').toBe(false)
      expect(free.reason?.kind).not.toBe('max-tokens')
      expect(free.text, `不限长却没数到 100：${free.text.slice(0, 200)}`).toContain('100')
      expect(warnings).toEqual([])
    } finally {
      await shim.close()
    }
  })
})
