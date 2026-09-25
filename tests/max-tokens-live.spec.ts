/**
 * 真机验收（默认跳过）：输出上限**真的到了线上**，而且上游**真的执行了**它。
 *
 * 默认套件必须无网，所以用 `WPS_COMATE_LIVE=1` 显式开关；凭据取 `WPS_COMATE_SID`，
 * 或退回桌面端 `cordis.patch.yml` 里手填的 sid。
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
 *
 * 走的是真的 `PiAiAdapter` → 真 shim（真 HTTP 回环）→ 真网关，只有上游客户端被
 * 包一层以便读取转出去的 body——即被测链路完整、观测点唯一。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { COMATE_PROVIDER, createComateAdapter } from '../src/adapter.ts'
import { ComateCredentialStore, type ComateCredential } from '../src/auth.ts'
import { ComateCatalog } from '../src/catalog.ts'
import { COMATE_UNLIMITED_MAX_TOKENS } from '../src/max-tokens.ts'
import { createComateShim } from '../src/shim.ts'
import { ComateUpstreamClient } from '../src/upstream.ts'

/** 手填的 wps_sid：桌面端 config 里是占位字面量，真会话只在 profile 的 patch 里。 */
function readSid(): string {
  const fromEnv = process.env['WPS_COMATE_SID']
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()
  const patch = readFileSync('C:/Users/ASUS/.dsh/profiles/desktop/cordis.patch.yml', 'utf8')
  const match = /wpsSid:\s*(\S+)/.exec(patch)
  if (match === null) throw new Error('no wpsSid in cordis.patch.yml and no WPS_COMATE_SID')
  return match[1]!.replace(/^['"]|['"]$/g, '')
}

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

describe.skipIf(process.env['WPS_COMATE_LIVE'] !== '1')('live: 输出上限', () => {
  it('把上限写成 max_tokens 并让上游执行它，0 则真的不设上限', { timeout: 300_000 }, async () => {
    const store = new ComateCredentialStore({ wpsSid: readSid() })
    const credential = await store.current()
    expect(credential, '拿不到凭据（config.json 缺失或不可读）').toBeDefined()
    const modelId = credential!.models[0]?.id
    expect(modelId, '模型目录是空的').toBeDefined()

    const catalog = new ComateCatalog()
    catalog.set(credential!.models.map(model => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      llmTypes: model.llmTypes ?? [],
    })))

    // 唯一被包的一层：读转出去的 body，其余（路由、鉴权、SSE、pi-ai 的出站拼装）
    // 全是产品代码。
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

    const comate = createComateAdapter({ shim, catalog })

    /** Drive one request with an explicit per-request cap. */
    const ask = async (maxTokens: number): Promise<Attempt> => {
      let text = ''
      let reason: { kind: string } | undefined
      for await (const chunk of comate.adapter.stream({
        provider: COMATE_PROVIDER,
        model: modelId!,
        messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
        maxTokens,
      })) {
        if (chunk.type === 'text-delta') text += chunk.text
        if (chunk.type === 'finish') reason = chunk.reason
      }
      const raw = bodies.pop()
      expect(raw, 'shim 没有把请求转给上游').toBeDefined()
      return { body: JSON.parse(raw!) as Record<string, unknown>, text, reason }
    }

    try {
      // 1) 小上限：字段名必须是 max_tokens，且上游真的截断。
      const capped = await ask(16)
      expect(capped.body['max_tokens'], `出站 body 的字段不对：${JSON.stringify(Object.keys(capped.body))}`)
        .toBe(16)
      expect(capped.body['max_completion_tokens']).toBeUndefined()
      expect(capped.reason?.kind, `被截断时 reason 应为 max-tokens，实得 ${JSON.stringify(capped.reason)}`)
        .toBe('max-tokens')

      // 2) 0 = 不设上限：字段根本不出现，同一题面必须真的数到 100 以上。
      const uncapped = await ask(COMATE_UNLIMITED_MAX_TOKENS)
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
})
