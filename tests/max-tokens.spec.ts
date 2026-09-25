/**
 * 输出上限：解析规则，以及**真的接上**了 harness 的那条缝。
 *
 * 两件事必须分开验，因为它们坏掉的方式完全不同：
 *
 *   1. **解析**（纯函数）：env > 卡片 > 32000；`0` = 不设上限；非法值当作「没写」
 *      并留痕。这一层坏了，表现为「设了不生效」或「清空变成 0」。
 *   2. **接线**：解析结果必须到得了 harness 真正读的那个值——
 *      profile 的 `configuredMaxTokens` → `LlmResolvedModelInfo.defaultMaxTokens`
 *      → harness 物化 `config.maxTokens` → pi-ai 写 `max_tokens`。这一层坏了，
 *      表现为「卡片存进去了、模型描述符里也有数，但请求里根本没有 `max_tokens`」
 *      ——正是 0.3.3 之前那个「32000 只在 UI 上好看」的状态。
 *
 * 第 2 条刻意用**真的** `PiAiAdapter` 走 `resolveModel()`，而不是断言我们自己的
 * 中间对象：`defaultMaxTokens` 是 harness 唯一会读的字段名，只有从这个入口拿到的
 * 值才算证据（对象里多一个字段、少一个字段，这里都看得出来）。
 */
import { describe, expect, it } from 'vitest'
import { COMATE_PROVIDER, comatePiModel, createComateAdapter } from '../src/adapter.ts'
import { COMATE_DEFAULT_MAX_TOKENS } from '../src/bridge.ts'
import { ComateCatalog } from '../src/catalog.ts'
import {
  COMATE_MAX_TOKENS_ENV,
  COMATE_UNLIMITED_MAX_TOKENS,
  comateConfiguredMaxTokens,
  comateModelMaxTokens,
  parseMaxOutputTokens,
  resolveMaxOutputTokens,
} from '../src/max-tokens.ts'
import type { ComateShim } from '../src/shim.ts'

const MODEL_ID = 'test/model-chat//public'
const CONTEXT_WINDOW = 200_000
const MODEL = { id: MODEL_ID, name: 'model-chat', contextWindow: CONTEXT_WINDOW, llmTypes: ['llm-chat'] }

/** One env carrying (or not carrying) the override. */
function env(value?: string): NodeJS.ProcessEnv {
  if (value === undefined) return {}
  return { [COMATE_MAX_TOKENS_ENV]: value }
}

describe('parseMaxOutputTokens', () => {
  it('reads a positive integer as a cap', () => {
    expect(parseMaxOutputTokens(4096)).toBe(4096)
    expect(parseMaxOutputTokens('4096')).toBe(4096)
    expect(parseMaxOutputTokens(' 4096 ')).toBe(4096)
  })

  it('reads 0 as "no cap" — a value, not an absence', () => {
    // 0 是上游认的语义（真机实测：`max_tokens: 0` 与不传该字段同效）。解析层要是
    // 把它当假值丢掉，"不设上限" 就永远没法通过卡片表达。
    expect(parseMaxOutputTokens(0)).toBe(COMATE_UNLIMITED_MAX_TOKENS)
    expect(parseMaxOutputTokens('0')).toBe(COMATE_UNLIMITED_MAX_TOKENS)
  })

  it('treats a blank string as absent, not as zero', () => {
    // `Number('')` 是 0：不特判的话，一个空的环境变量会被读成「不设上限」，
    // 把用户存的 32000 静默顶掉。
    expect(parseMaxOutputTokens('')).toBeUndefined()
    expect(parseMaxOutputTokens('   ')).toBeUndefined()
  })

  it('refuses everything that is not a non-negative safe integer', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, 'abc', '12px', true, null, undefined, {}, []]) {
      expect(parseMaxOutputTokens(bad), `value=${String(bad)}`).toBeUndefined()
    }
  })
})

describe('resolveMaxOutputTokens', () => {
  it('prefers the env var over the saved field', () => {
    // 故意让 env 压过卡片：无头脚本（verify-*.mjs、CI）必须能压过本机存的值，
    // 否则一个已保存的 32000 会让脚本里的覆盖静默失效。
    expect(resolveMaxOutputTokens(4096, env('64'))).toEqual({ value: 64, source: 'env' })
  })

  it('falls back to the saved field', () => {
    expect(resolveMaxOutputTokens(4096, env())).toEqual({ value: 4096, source: 'config' })
  })

  it('falls back to the default when neither is set', () => {
    expect(resolveMaxOutputTokens(undefined, env())).toEqual({
      value: COMATE_DEFAULT_MAX_TOKENS,
      source: 'default',
    })
  })

  it('reports an unusable env value instead of dropping it silently', () => {
    // 打错的 env 不该让插件装配失败，但也不该无声无息：调用方靠 `ignored` 打日志。
    expect(resolveMaxOutputTokens(undefined, env('32000k'))).toEqual({
      value: COMATE_DEFAULT_MAX_TOKENS,
      source: 'default',
      ignored: { layer: 'env', raw: '32000k' },
    })
  })

  it('keeps the ignored env value on the record even when the field decides', () => {
    expect(resolveMaxOutputTokens(4096, env('-1'))).toEqual({
      value: 4096,
      source: 'config',
      ignored: { layer: 'env', raw: '-1' },
    })
  })

  it('reads an empty env var as unset', () => {
    expect(resolveMaxOutputTokens(4096, env(''))).toEqual({ value: 4096, source: 'config' })
  })

  it('lets 0 win from either layer', () => {
    expect(resolveMaxOutputTokens(0, env())).toEqual({ value: 0, source: 'config' })
    expect(resolveMaxOutputTokens(4096, env('0'))).toEqual({ value: 0, source: 'env' })
  })
})

describe('comateModelMaxTokens', () => {
  it('passes a cap through', () => {
    expect(comateModelMaxTokens(4096, CONTEXT_WINDOW)).toBe(4096)
  })

  it('spells "unlimited" as the context window', () => {
    // pi-ai 拒绝非正的 `maxTokens`，所以「不设上限」在描述符里只能写成这个模型能
    // 表达的最宽上限。它**不构成**请求上限——真上限由 configuredMaxTokens 决定。
    expect(comateModelMaxTokens(COMATE_UNLIMITED_MAX_TOKENS, CONTEXT_WINDOW)).toBe(CONTEXT_WINDOW)
  })
})

describe('comateConfiguredMaxTokens', () => {
  it('lists every served model against the cap', () => {
    expect([...comateConfiguredMaxTokens(['a', 'b'], 4096)]).toEqual([['a', 4096], ['b', 4096]])
  })

  it('leaves the model out entirely when the cap is unlimited', () => {
    // 不是「列成 0」：这一层的一个 0 会被 harness 原样物化成 `max_tokens: 0`，
    // 而 pi-ai 在 `defaultMaxTokens` 上要的是正整数。缺席才是「不设上限」。
    expect([...comateConfiguredMaxTokens(['a'], COMATE_UNLIMITED_MAX_TOKENS)]).toEqual([])
  })
})

describe('comatePiModel', () => {
  /** The descriptor is a pi-ai `Model` with our compat block bolted on. */
  function descriptor(cap?: number) {
    return comatePiModel(MODEL, 'http://127.0.0.1:1/v1', cap) as unknown as {
      maxTokens: number
      compat: { maxTokensField?: string; thinkingFormat?: string }
    }
  }

  it('defaults the descriptor to 32000 when no cap is passed', () => {
    expect(descriptor().maxTokens).toBe(COMATE_DEFAULT_MAX_TOKENS)
  })

  it('carries the configured cap', () => {
    expect(descriptor(4096).maxTokens).toBe(4096)
  })

  it('declares max_tokens rather than leaving the field name to detection', () => {
    // baseUrl 是回环、provider 是 `comate`，pi-ai 的 detectCompat() 认不出家族，
    // 不显式声明就会回落到 `max_completion_tokens`。
    expect(descriptor(4096).compat.maxTokensField).toBe('max_tokens')
    expect(descriptor(4096).compat.thinkingFormat).toBe('openai')
  })
})

/** A shim stand-in: `resolveModel` never opens a socket. */
function stubShim(): ComateShim {
  return { baseUrl: () => 'http://127.0.0.1:1' } as unknown as ComateShim
}

/** The real adapter over a one-model catalog, with a live cap read. */
function buildAdapter(readCap: () => number) {
  const catalog = new ComateCatalog()
  catalog.set([MODEL])
  return createComateAdapter({ shim: stubShim(), catalog, maxOutputTokens: readCap })
}

describe('the cap the harness actually reads', () => {
  it('lands in the resolved model info, not only in the descriptor', async () => {
    const comate = buildAdapter(() => 4096)
    await expect(comate.adapter.resolveModel(COMATE_PROVIDER, MODEL_ID))
      .resolves.toMatchObject({ defaultMaxTokens: 4096 })
  })

  it('omits the cap when it is unlimited, so the harness materializes nothing', async () => {
    const comate = buildAdapter(() => COMATE_UNLIMITED_MAX_TOKENS)
    const info = await comate.adapter.resolveModel(COMATE_PROVIDER, MODEL_ID)
    expect(info.defaultMaxTokens).toBeUndefined()
  })

  it('still reports the model, so an unlimited cap is not a missing model', async () => {
    const comate = buildAdapter(() => COMATE_UNLIMITED_MAX_TOKENS)
    const info = await comate.adapter.resolveModel(COMATE_PROVIDER, MODEL_ID)
    expect(info.id).toBe(MODEL_ID)
    expect(info.provider).toBe(COMATE_PROVIDER)
  })

  it('picks up a saved change once invalidate() is called', async () => {
    // 真机上「保存」会走到 republish() → invalidate()，所以这就是卡片生效的路径。
    let cap = 4096
    const comate = buildAdapter(() => cap)
    expect((await comate.adapter.resolveModel(COMATE_PROVIDER, MODEL_ID)).defaultMaxTokens).toBe(4096)
    cap = 77
    comate.invalidate()
    expect((await comate.adapter.resolveModel(COMATE_PROVIDER, MODEL_ID)).defaultMaxTokens).toBe(77)
  })

  it('keeps every served model on the same cap', async () => {
    const catalog = new ComateCatalog()
    catalog.set([MODEL, { ...MODEL, id: 'test/model-second//public', name: 'model-second' }])
    const comate = createComateAdapter({ shim: stubShim(), catalog, maxOutputTokens: () => 4096 })
    for (const id of [MODEL_ID, 'test/model-second//public']) {
      expect((await comate.adapter.resolveModel(COMATE_PROVIDER, id)).defaultMaxTokens).toBe(4096)
    }
  })
})
