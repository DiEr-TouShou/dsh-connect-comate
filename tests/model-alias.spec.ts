/**
 * 模型别名：解析规则，以及「别名只改显示名」这条承诺的证据。
 *
 * 别名坏掉的方式有两种，而且都不报错：
 *
 *   1. **解析分叉**：卡片写进去的表和宿主读出来的表不是同一张（一边 trim、一边不
 *      trim），表现为「保存成功但名字没变」，或者「名字变了，但设置里多出一个空键」。
 *   2. **别名动到了 id**：名字是给人看的，id 是请求、`maxOutputTokensByModel`、
 *      `agent-default-model` 认的东西。别名要是连 id 一起改，用户改个名字就能弄丢
 *      一条已保存的上限。
 *
 * 所以这里两组断言：解析规则本身（纯函数），以及描述符里 `name` 变了而 `id` 没变。
 * 第 2 条刻意走**真的** `createComateAdapter` + `resolveModel()`，而不是断言我们
 * 自己的中间对象——只有从这个入口看到的结果才算「选择器真的会这么画」。
 */
import { describe, expect, it } from 'vitest'
import { COMATE_PROVIDER, comatePiModel, createComateAdapter } from '../src/adapter.ts'
import { COMATE_DEFAULT_MAX_TOKENS } from '../src/bridge.ts'
import { ComateCatalog } from '../src/catalog.ts'
import {
  aliasKey,
  modelAliasOf,
  parseModelAliases,
  unusableModelAliases,
} from '../src/model-alias.ts'
import type { ComateShim } from '../src/shim.ts'

const MODEL_ID = 'test/model-chat//public'
const MODEL = {
  id: MODEL_ID,
  name: 'model-chat',
  contextWindow: 200_000,
  llmTypes: ['llm-chat'],
}

describe('parseModelAliases', () => {
  it('reads a map of model id to display name', () => {
    const aliases = parseModelAliases({ [MODEL_ID]: '快问快答' })
    expect(aliases.get(MODEL_ID)).toBe('快问快答')
    expect(aliases.size).toBe(1)
  })

  it('trims both the id and the name', () => {
    // 两半共用这一个函数，所以「一个只有空格的别名」在卡片里和配置里必须是同一件事。
    const aliases = parseModelAliases({ '  model-a  ': '  Named  ' })
    expect(aliases.get('model-a')).toBe('Named')
    expect(aliases.size).toBe(1)
  })

  it('drops a blank name, because blank means "no alias" and not "an empty name"', () => {
    // 清空输入框是撤销别名的手段，所以空值必须是「这个键不存在」，而不是存一个空串
    // 进设置文档——后者会让选择器画出一个没有名字的模型。
    expect(parseModelAliases({ 'model-a': '' }).size).toBe(0)
    expect(parseModelAliases({ 'model-a': '   ' }).size).toBe(0)
  })

  it('drops a blank id', () => {
    expect(parseModelAliases({ '   ': 'Named' }).size).toBe(0)
  })

  it('drops an unusable name without touching its neighbours', () => {
    // 手写 YAML 里的 `{model-a: 123}` 不该让整张表失效，更不该让插件装配失败。
    const aliases = parseModelAliases({ 'model-a': 123, 'model-b': 'B' })
    expect(aliases.size).toBe(1)
    expect(aliases.get('model-b')).toBe('B')
  })

  it('reads anything that is not a map as "no aliases"', () => {
    for (const value of [undefined, null, 'model-a', 7, ['model-a'], true]) {
      expect(parseModelAliases(value).size).toBe(0)
    }
  })

  it('keeps a key like __proto__ as a plain entry', () => {
    // 键来自上游给的模型 id，用 Map 而不是普通对象就是为了让 `__proto__` 这类键
    // 老老实实当一个键，而不是有机会碰到原型。
    const aliases = parseModelAliases(JSON.parse('{"__proto__": "Named"}') as unknown)
    expect(aliases.get('__proto__')).toBe('Named')
    expect((Object.prototype as Record<string, unknown>)['Named']).toBeUndefined()
  })
})

describe('unusableModelAliases', () => {
  it('names the model and the raw value it refused', () => {
    const refused = unusableModelAliases({ 'model-a': 123, 'model-b': '  ', 'model-c': 'C' })
    expect(refused).toEqual([
      { modelId: 'model-a', raw: 123 },
      { modelId: 'model-b', raw: '  ' },
    ])
  })

  it('reads a non-map as "nothing refused"', () => {
    // 与 `unusableModelTokens` 同款：整份字段类型都不对时，schema 那一层已经拦下了，
    // 这里不必再造一条永远见不到的日志。
    for (const value of [undefined, null, 'model-a', 7, ['model-a']]) {
      expect(unusableModelAliases(value)).toEqual([])
    }
  })
})

describe('modelAliasOf', () => {
  it('answers the alias for a named model', () => {
    expect(modelAliasOf(parseModelAliases({ 'model-a': 'Named' }), 'model-a')).toBe('Named')
  })

  it('answers undefined for a model with no alias, so the discovered name stands', () => {
    expect(modelAliasOf(parseModelAliases({ 'model-a': 'Named' }), 'model-b')).toBeUndefined()
  })
})

describe('aliasKey', () => {
  it('ignores key order', () => {
    // 宿主可能按自己的键序重新序列化同一张表，那不是「用户改了东西」。
    const left = parseModelAliases({ 'model-a': 'A', 'model-b': 'B' })
    const right = parseModelAliases({ 'model-b': 'B', 'model-a': 'A' })
    expect(aliasKey(left)).toBe(aliasKey(right))
  })

  it('changes when a name changes', () => {
    const before = parseModelAliases({ 'model-a': 'A' })
    const after = parseModelAliases({ 'model-a': 'B' })
    expect(aliasKey(before)).not.toBe(aliasKey(after))
  })

  it('changes when a key appears or disappears', () => {
    const before = parseModelAliases({ 'model-a': 'A' })
    expect(aliasKey(parseModelAliases({ 'model-a': 'A', 'model-b': 'B' }))).not.toBe(aliasKey(before))
    expect(aliasKey(parseModelAliases({}))).not.toBe(aliasKey(before))
  })

  it('does not let a multi-line name collide with two short ones', () => {
    // 拼字符串当指纹会在这里撞车（`a=x\ny=z` 两种拼法一模一样），JSON 转义不会。
    const one = parseModelAliases({ 'a': 'x\ny=z' })
    const two = parseModelAliases({ 'a': 'x', 'y': 'z' })
    expect(aliasKey(one)).not.toBe(aliasKey(two))
  })
})

describe('the name the model picker paints', () => {
  it('uses the alias when one is set', () => {
    const model = comatePiModel(MODEL, 'http://127.0.0.1:1/v1', COMATE_DEFAULT_MAX_TOKENS, { alias: '快问快答' })
    expect(model.name).toBe('快问快答')
  })

  it('keeps the discovered name when no alias is set', () => {
    expect(comatePiModel(MODEL, 'http://127.0.0.1:1/v1').name).toBe(MODEL.name)
    expect(comatePiModel(MODEL, 'http://127.0.0.1:1/v1', COMATE_DEFAULT_MAX_TOKENS).name).toBe(MODEL.name)
  })

  it('never moves the id, because the id is what every saved choice addresses', () => {
    // 这条是别名安全的全部依据：改名字不能让 `maxOutputTokensByModel` 里的条目、
    // `agent-default-model` 里存的选择失效。
    const model = comatePiModel(MODEL, 'http://127.0.0.1:1/v1', COMATE_DEFAULT_MAX_TOKENS, { alias: '快问快答' })
    expect(model.id).toBe(MODEL_ID)
  })
})

/** A shim stand-in: `resolveModel` never opens a socket. */
function stubShim(): ComateShim {
  return { baseUrl: () => 'http://127.0.0.1:1' } as unknown as ComateShim
}

/** The real adapter over a one-model catalog, with live alias and level reads. */
function buildAdapter(options: {
  modelAlias?: (modelId: string) => string | undefined
  extraThinkingLevels?: () => readonly ('off' | 'xhigh' | 'max')[]
}) {
  const catalog = new ComateCatalog()
  catalog.set([MODEL])
  return createComateAdapter({ shim: stubShim(), catalog, ...options })
}

describe('the alias the adapter publishes', () => {
  it('reaches the resolved model info, not only the descriptor', async () => {
    const comate = buildAdapter({ modelAlias: () => '快问快答' })
    await expect(comate.adapter.resolveModel(COMATE_PROVIDER, MODEL_ID))
      .resolves.toMatchObject({ id: MODEL_ID, name: '快问快答' })
  })

  it('picks up a saved rename once invalidate() is called', async () => {
    // 真机上「保存」会走到 republish() → invalidate()，这就是卡片改名后生效的路径。
    let alias = 'First'
    const comate = buildAdapter({ modelAlias: () => alias })
    expect((await comate.adapter.resolveModel(COMATE_PROVIDER, MODEL_ID)).name).toBe('First')
    alias = 'Second'
    comate.invalidate()
    expect((await comate.adapter.resolveModel(COMATE_PROVIDER, MODEL_ID)).name).toBe('Second')
  })

  it('falls back to the discovered name for a model with no alias', async () => {
    const comate = buildAdapter({ modelAlias: () => undefined })
    expect((await comate.adapter.resolveModel(COMATE_PROVIDER, MODEL_ID)).name).toBe(MODEL.name)
  })
})
