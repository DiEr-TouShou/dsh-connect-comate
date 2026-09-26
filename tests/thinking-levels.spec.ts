/**
 * 思考档位：哪些档位被提供，以及「提供」到底改了什么。
 *
 * 三件事分开验，因为它们的坏法完全不同：
 *
 *   1. **解析**（纯函数）：设置里那个字符串数组读成一张干净的档位集合；坏条目只丢
 *      自己。这一层坏了，表现为「勾了没反应」或「勾一个坏名字，另外两个也消失了」。
 *   2. **描述符**：档位有没有进 `thinkingLevelMap`，直接决定选择器列不列它。pi-ai
 *      对 `xhigh` / `max` 的缺省判定与基础档位相反（缺省 = 不支持），所以这里要钉住
 *      「不提供」是显式 `null` 而不是缺键。
 *   3. **线值**：真发出去的 `reasoning_effort` 是什么。这一层最容易做出「选择器上
 *      写着 off、请求里什么也没带、上游照常思考」——也就是 0.4.1-rc.2 之前的状态，
 *      所以第 3 组用真的 `openAICompletionsApi` 走一遍，断言**出站 body**。
 *
 * `off` 的两面性在这里被钉成两条相邻的断言：打开它以后，选择「off」会发
 * `reasoning_effort=off`，而**不指定档位**也会发它（pi-ai 在未指定时会读
 * `thinkingLevelMap.off`）。后者是打开这一项的代价，卡片文案里说了，测试里也要有，
 * 否则将来有人「顺手」把 off 打开成默认，没人会注意到含义被改了。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSupportedThinkingLevels, type ThinkingLevel } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { COMATE_PROVIDER, comatePiModel, createComateAdapter } from '../src/adapter.ts'
import { ComateCatalog } from '../src/catalog.ts'
import type { ComateShim } from '../src/shim.ts'
import {
  COMATE_BASE_THINKING_LEVELS,
  COMATE_EXTRA_THINKING_LEVELS,
  COMATE_THINKING_LEVEL_WIRE,
  type ComateExtraThinkingLevel,
} from '../src/bridge.ts'
import {
  COMATE_THINKING_LEVEL_MAP,
  buildThinkingLevelMap,
  parseExtraThinkingLevels,
  unusableThinkingLevels,
} from '../src/thinking-levels.ts'

const MODEL_INFO = { id: 'model-a', name: 'A', contextWindow: 1_000_000 }

/** The real descriptor the adapter builds for one set of enabled levels. */
function model(extra: readonly ComateExtraThinkingLevel[] = []) {
  return comatePiModel(MODEL_INFO, 'http://127.0.0.1:1/v1', 32_000, { extraThinkingLevels: extra })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildThinkingLevelMap', () => {
  it('offers exactly the base four when nothing is turned on', () => {
    // 与 `COMATE_THINKING_LEVEL_MAP` 同一张表：升级不能让所有人的选择器多一行。
    expect(buildThinkingLevelMap([])).toEqual(COMATE_THINKING_LEVEL_MAP)
    for (const level of COMATE_BASE_THINKING_LEVELS) {
      expect(buildThinkingLevelMap([])[level]).toBe(level)
    }
  })

  it('pins the three extra levels to null while they are off', () => {
    // 显式 `null` 而不是缺键：pi-ai 对 xhigh / max 的缺省判定是「不支持」，留空与
    // 写 null 在它眼里是两件事。
    for (const level of COMATE_EXTRA_THINKING_LEVELS) {
      expect(buildThinkingLevelMap([])[level]).toBeNull()
    }
  })

  it('fills in the wire value of each level that is turned on', () => {
    for (const level of COMATE_EXTRA_THINKING_LEVELS) {
      const map = buildThinkingLevelMap([level])
      expect(map[level]).toBe(COMATE_THINKING_LEVEL_WIRE[level])
      for (const other of COMATE_EXTRA_THINKING_LEVELS) {
        if (other === level) continue
        expect(map[other]).toBeNull()
      }
    }
  })

  it('leaves the base four untouched however many levels are turned on', () => {
    const map = buildThinkingLevelMap([...COMATE_EXTRA_THINKING_LEVELS])
    for (const level of COMATE_BASE_THINKING_LEVELS) {
      expect(map[level]).toBe(level)
    }
  })

  it('spells "off" as off, never as the OpenAI vocabulary\'s none', () => {
    // 真机实测（2026-09-26，本机，10 个模型）：`none` 会被上游接受（HTTP 200）却
    // **忽略**——reasoning_content 停在基线长度（201–1665 字符，没有一个归零）；
    // 真正让思考归零的是 `off`（7 个模型 656→0 这样掉到 0）。这条断言是「不把
    // OpenAI 词汇表当成上游事实」的看门人。
    expect(COMATE_THINKING_LEVEL_WIRE.off).toBe('off')
    expect(COMATE_THINKING_LEVEL_WIRE.off).not.toBe('none')
  })

  it('never maps a level to an empty wire value', () => {
    // 空串在 pi-ai 那条链路上是「没有值」的意思（它只认字符串非空与否），一个空串
    // 会让档位看起来存在、发出去却什么都没有。
    for (const level of COMATE_EXTRA_THINKING_LEVELS) {
      expect(COMATE_THINKING_LEVEL_WIRE[level]).not.toBe('')
    }
  })
})

describe('what the picker lists', () => {
  it('lists the four base levels when nothing is turned on', () => {
    expect(getSupportedThinkingLevels(model())).toEqual(['minimal', 'low', 'medium', 'high'])
  })

  it('adds a turned-on level, and only that one', () => {
    expect(getSupportedThinkingLevels(model(['xhigh'])))
      .toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
  })

  it('lists all seven when all three are turned on', () => {
    // 顺序由 pi-ai 自己的 EXTENDED_THINKING_LEVELS 决定，所以 `off` 在最前——不是
    // 我们在卡片上排的 off / xhigh / max。
    expect(getSupportedThinkingLevels(model([...COMATE_EXTRA_THINKING_LEVELS])))
      .toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('the request pi-ai builds from that declaration', () => {
  /** Stub fetch and record the JSON bodies the adapter sends. */
  function captureBodies(): Array<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>)
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }))
    return bodies
  }

  /** Drive one real request through the api the adapter registers. */
  async function send(
    extra: readonly ComateExtraThinkingLevel[],
    reasoning?: ThinkingLevel,
  ): Promise<Array<Record<string, unknown>>> {
    const bodies = captureBodies()
    const api = openAICompletionsApi()
    const stream = api.streamSimple(
      model(extra),
      { messages: [{ role: 'user', content: 'ping', timestamp: 0 }] },
      reasoning === undefined
        ? { apiKey: 'test-key' }
        : { apiKey: 'test-key', reasoning },
    )
    for await (const _event of stream) {
      // deliberately not inspected
    }
    return bodies
  }

  it('sends reasoning_effort=xhigh when the user picks xhigh', async () => {
    const bodies = await send(['xhigh'], 'xhigh')
    expect(bodies[0]?.['reasoning_effort']).toBe('xhigh')
  })

  it('sends reasoning_effort=max when the user picks max', async () => {
    const bodies = await send(['max'], 'max')
    expect(bodies[0]?.['reasoning_effort']).toBe('max')
  })

  it('sends no reasoning_effort at all while nothing extra is turned on', async () => {
    // 默认状态：出站 body 里连字段都没有——上游自己的默认（思考）说了算。
    const bodies = await send([])
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')
  })

  it('reaches off through the unnamed-effort branch, because that is the only way in', async () => {
    // pi-ai 自己的类型把这件事写死了：`SimpleStreamOptions.reasoning` 是
    // `ThinkingLevel = minimal|low|medium|high|xhigh|max`，**没有 off**；而
    // `thinkingLevelMap` 的键是 `ModelThinkingLevel = off | ThinkingLevel`。
    // 也就是说用户在选择器里选 off，到 pi-ai 这里一定落在「未指定档位」那一支，
    // 于是读的是 `thinkingLevelMap.off`（`dist/api/openai-completions.js`：
    // `!options?.reasoningEffort` 那一段）——这正是打开它以后「provider default」
    // 也变成不思考的原因，也是卡片文案里必须写出来的那句。
    const bodies = await send(['off'])
    expect(bodies[0]?.['reasoning_effort']).toBe('off')
  })

  it('does not let turning off leak into the other levels', async () => {
    const bodies = await send([...COMATE_EXTRA_THINKING_LEVELS], 'high')
    expect(bodies[0]?.['reasoning_effort']).toBe('high')
  })
})

/** A shim stand-in: `resolveModel` never opens a socket. */
function stubShim(): ComateShim {
  return { baseUrl: () => 'http://127.0.0.1:1' } as unknown as ComateShim
}

/** The real adapter over a one-model catalog, with a live level read. */
function buildAdapter(readLevels: () => readonly ComateExtraThinkingLevel[]) {
  const catalog = new ComateCatalog()
  catalog.set([{ id: MODEL_INFO.id, name: MODEL_INFO.name, contextWindow: MODEL_INFO.contextWindow, llmTypes: ['llm-chat'] }])
  return createComateAdapter({ shim: stubShim(), catalog, extraThinkingLevels: readLevels })
}

describe('what the harness offers for one model', () => {
  it('reports the enabled levels as selectable efforts, off included', async () => {
    // 这一组是「卡片勾选框 → 选择器真的多一行」的完整链路：harness 读的就是
    // `reasoning.efforts`，而它来自 pi-ai 的 `getSupportedThinkingLevels`。
    const comate = buildAdapter(() => [...COMATE_EXTRA_THINKING_LEVELS])
    const info = await comate.adapter.resolveModel(COMATE_PROVIDER, MODEL_INFO.id)
    expect(info.reasoning?.efforts.map(effort => effort.id))
      .toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('reports only the base four when nothing is turned on', async () => {
    const comate = buildAdapter(() => [])
    const info = await comate.adapter.resolveModel(COMATE_PROVIDER, MODEL_INFO.id)
    expect(info.reasoning?.efforts.map(effort => effort.id))
      .toEqual(['minimal', 'low', 'medium', 'high'])
  })

  it('picks up a saved change once invalidate() is called', async () => {
    // 真机上「保存」会走到 republish() → invalidate()，这就是勾选框生效的路径。
    let levels: ComateExtraThinkingLevel[] = []
    const comate = buildAdapter(() => levels)
    const first = await comate.adapter.resolveModel(COMATE_PROVIDER, MODEL_INFO.id)
    expect(first.reasoning?.efforts.map(effort => effort.id)).toEqual(['minimal', 'low', 'medium', 'high'])
    levels = ['off']
    comate.invalidate()
    const second = await comate.adapter.resolveModel(COMATE_PROVIDER, MODEL_INFO.id)
    expect(second.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'minimal', 'low', 'medium', 'high'])
  })
})

describe('parseExtraThinkingLevels', () => {
  it('reads the levels it names, in the vocabulary\'s own order', () => {
    // 顺序由词汇表决定，不由用户在 YAML 里敲的顺序决定——选择器里那一行的位置不该
    // 取决于手写文件的键序。
    expect(parseExtraThinkingLevels(['max', 'off'])).toEqual(['off', 'max'])
  })

  it('drops an unknown level instead of taking the others down with it', () => {
    expect(parseExtraThinkingLevels(['off', 'xhight', 'max'])).toEqual(['off', 'max'])
  })

  it('collapses duplicates', () => {
    expect(parseExtraThinkingLevels(['off', 'off'])).toEqual(['off'])
  })

  it('trims, so a padded name still counts', () => {
    expect(parseExtraThinkingLevels(['  off  '])).toEqual(['off'])
  })

  it('reads anything that is not an array as "nothing turned on"', () => {
    for (const value of [undefined, null, 'off', 3, { off: true }]) {
      expect(parseExtraThinkingLevels(value)).toEqual([])
    }
  })
})

describe('unusableThinkingLevels', () => {
  it('reports the entries it refused, deduplicated', () => {
    // 被丢掉的条目在卡片里表现为「没勾」，与「从没勾过」长得一模一样：日志是唯一
    // 能把它们分开的地方。
    expect(unusableThinkingLevels(['off', 'xhight', 'xhight', 3])).toEqual(['xhight', 3])
  })

  it('stays quiet about a list it could read', () => {
    expect(unusableThinkingLevels(['off', 'max'])).toEqual([])
  })

  it('reports a whole field that is not a list, but not an absent one', () => {
    expect(unusableThinkingLevels('off')).toEqual(['off'])
    expect(unusableThinkingLevels(undefined)).toEqual([])
    expect(unusableThinkingLevels(null)).toEqual([])
  })
})
