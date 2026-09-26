import { describe, expect, it, vi } from 'vitest'
import {
  acquireComateSettingsForm,
  ComateSettingsWriteError,
  comateSettingsWritable,
  readComateValue,
  writeComateSettings,
  type ComateSettingsForm,
} from '../src/client/settings-scope.ts'
import { COMATE_ENTRY_ID, COMATE_SETTINGS_NS } from '../src/bridge.ts'

/** A DSH 0.1.7 live reference, exactly as the browser mirror shapes it. */
function live<T>(value: T): { get(): T } {
  return Object.freeze({ get: () => value })
}

interface FormOptions {
  /** `set()` answers `false` — the Host refused or skipped the write. */
  refuse?: boolean
  /** `set()` answers `true` but nothing is stored: the silent-revert case. */
  swallow?: boolean
  /**
   * Deliver the section the way 0.1.7 does: every volatile field wrapped in a
   * live reference. The default models the real shape, since a suite built on
   * plain objects never exercises the read path that actually runs in a browser.
   */
  liveRefs?: boolean
  writable?: boolean
}

interface FakeForm extends ComateSettingsForm {
  /** Every `set()` call in order, for ordering assertions. */
  calls: Array<[string, unknown]>
  /** Replace the stored section, as an external surface would. */
  put(value: Record<string, unknown>): void
}

/** A form stub shaped like 0.1.7's `ConfigForm` (and 0.1.5's `SettingsScope`). */
function fakeForm(initial: Record<string, unknown>, options: FormOptions = {}): FakeForm {
  let stored = { ...initial }
  const calls: Array<[string, unknown]> = []
  return {
    calls,
    put(value) { stored = { ...stored, ...value } },
    getSnapshot() {
      const value = options.liveRefs === false
        ? { ...stored }
        : {
            configFile: live(stored.configFile),
            wpsSid: live(stored.wpsSid),
            cookieOnly: live(stored.cookieOnly),
            enabledModelIds: live(stored.enabledModelIds),
            maxOutputTokens: live(stored.maxOutputTokens),
            maxOutputTokensByModel: live(stored.maxOutputTokensByModel),
            modelAliases: live(stored.modelAliases),
            extraThinkingLevels: live(stored.extraThinkingLevels),
          }
      return { status: 'ready', writable: options.writable ?? true, value }
    },
    subscribe: () => () => {},
    async set(field: string, value: unknown) {
      calls.push([field, value])
      if (options.refuse === true) return false
      if (options.swallow !== true) stored = { ...stored, [field]: value }
      return true
    },
  }
}

describe('readComateValue', () => {
  it('peels live references instead of treating one as the section', () => {
    const form = fakeForm({ wpsSid: 'sid', cookieOnly: true, enabledModelIds: ['a', 'b'] })
    expect(readComateValue(form)).toEqual({ wpsSid: 'sid', cookieOnly: true, enabledModelIds: ['a', 'b'] })
  })

  it('reads plain values too (the 0.1.5 shape)', () => {
    const form = fakeForm({ wpsSid: 'sid', cookieOnly: true, enabledModelIds: ['a'] }, { liveRefs: false })
    expect(readComateValue(form)).toEqual({ wpsSid: 'sid', cookieOnly: true, enabledModelIds: ['a'] })
  })

  it('drops fields carrying the wrong type', () => {
    const form = fakeForm({ wpsSid: 42, cookieOnly: 'yes', enabledModelIds: ['a', 7] }, { liveRefs: false })
    expect(readComateValue(form)).toEqual({ enabledModelIds: ['a'] })
  })

  it('reads the output cap, 0 included', () => {
    // 0 是「不设上限」，必须原样读回来——丢掉它就等于用户没法表达「不限」。
    expect(readComateValue(fakeForm({ maxOutputTokens: 4096 })).maxOutputTokens).toBe(4096)
    expect(readComateValue(fakeForm({ maxOutputTokens: 0 })).maxOutputTokens).toBe(0)
  })

  it('drops a corrupt output cap rather than passing it to the save path', () => {
    // 一个被手改坏的 profile 不该把 `"32000"` / `-1` / `1.5` 送进 schema。
    for (const bad of ['32000', -1, 1.5, Number.NaN, null, true]) {
      expect(readComateValue(fakeForm({ maxOutputTokens: bad })).maxOutputTokens, `value=${String(bad)}`)
        .toBeUndefined()
    }
  })

  it('reads the per-model cap map, 0 included', () => {
    // 0 在每模型这一层同样是「这个模型不设上限」，必须原样读回来；live 引用也要剥。
    const form = fakeForm({ maxOutputTokensByModel: { a: 4096, b: 0 } })
    expect(readComateValue(form).maxOutputTokensByModel).toEqual({ a: 4096, b: 0 })
  })

  it('drops unusable per-model entries instead of the whole map', () => {
    // 一条坏条目是「一个模型读不出来」，不能让其余模型一起丢设置；空字符串键
    // 也不像模型 id，一并丢掉。
    const form = fakeForm({ maxOutputTokensByModel: { a: 4096, b: -1, c: 'x', '': 1 } }, { liveRefs: false })
    expect(readComateValue(form).maxOutputTokensByModel).toEqual({ a: 4096 })
  })

  it('reads anything that is not a map as "no overrides"', () => {
    for (const bad of [undefined, null, 'x', 42, ['a'], true]) {
      expect(readComateValue(fakeForm({ maxOutputTokensByModel: bad }, { liveRefs: false })).maxOutputTokensByModel,
        `value=${String(bad)}`).toBeUndefined()
    }
  })

  it('reads the alias map through its live references', () => {
    // 每一条别名也是活引用：不剥的话读回来的是 `{get: ...}`，而卡片会把它当名字画
    // 出去——或者更早一步，在 `parseModelAliases` 里被当垃圾丢掉。
    const form = fakeForm({ modelAliases: { a: '快问快答', b: '  Trimmed  ' } })
    expect(readComateValue(form).modelAliases).toEqual({ a: '快问快答', b: 'Trimmed' })
  })

  it('drops a blank alias and an unusable one instead of the whole map', () => {
    // 空串是「没有别名」（卡片清空输入框就是这样落盘的），不是「名字为空」：留着它
    // 会让选择器画出一个没名字的模型。
    const form = fakeForm({ modelAliases: { a: 'A', b: '', c: '   ', d: 7 } }, { liveRefs: false })
    expect(readComateValue(form).modelAliases).toEqual({ a: 'A' })
  })

  it('reads anything that is not a map as "no aliases"', () => {
    for (const bad of [undefined, null, 'x', 42, ['a'], true]) {
      expect(readComateValue(fakeForm({ modelAliases: bad }, { liveRefs: false })).modelAliases,
        `value=${String(bad)}`).toBeUndefined()
    }
  })

  it('reads the extra levels, canonicalized', () => {
    // 手写的文档里可能有重复、有拼错、有顺序不同，读回来的必须是同一张干净的表：
    // 存进去什么顺序、读回来什么顺序，否则「保存后显示没勾上」这种没法处理的提示
    // 就会出现在一份其实没问题的设置上。
    const form = fakeForm({ extraThinkingLevels: ['max', 'off', 'off', 'xhight'] })
    expect(readComateValue(form).extraThinkingLevels).toEqual(['off', 'max'])
  })

  it('reads anything that is not a list as "nothing turned on"', () => {
    for (const bad of [undefined, null, 'off', 42, { off: true }]) {
      expect(readComateValue(fakeForm({ extraThinkingLevels: bad }, { liveRefs: false })).extraThinkingLevels,
        `value=${String(bad)}`).toBeUndefined()
    }
  })

  it('returns an empty section when there is no form or no value', () => {
    expect(readComateValue(undefined)).toEqual({})
    const empty: ComateSettingsForm = {
      getSnapshot: () => ({ status: 'loading' }),
      subscribe: () => () => {},
      set: async () => true,
    }
    expect(readComateValue(empty)).toEqual({})
  })
})

describe('comateSettingsWritable', () => {
  it('treats a missing form as read-only', () => {
    expect(comateSettingsWritable(undefined)).toBe(false)
  })

  it('treats an absent writable flag as writable', () => {
    const form: ComateSettingsForm = {
      getSnapshot: () => ({ status: 'ready' }),
      subscribe: () => () => {},
      set: async () => true,
    }
    expect(comateSettingsWritable(form)).toBe(true)
  })

  it('follows the flag when the Host reports one', () => {
    expect(comateSettingsWritable(fakeForm({}, { writable: true }))).toBe(true)
    expect(comateSettingsWritable(fakeForm({}, { writable: false }))).toBe(false)
  })
})

describe('writeComateSettings', () => {
  const patch = { wpsSid: 'sid', cookieOnly: false, enabledModelIds: ['a'] }

  it('writes the three fields in a stable order and verifies them', async () => {
    const form = fakeForm({})
    await expect(writeComateSettings(form, patch)).resolves.toBeUndefined()
    expect(form.calls.map(([field]) => field)).toEqual(['wpsSid', 'cookieOnly', 'enabledModelIds'])
    expect(readComateValue(form)).toEqual({ wpsSid: 'sid', cookieOnly: false, enabledModelIds: ['a'] })
  })

  it('raises a refusal instead of reporting success', async () => {
    const form = fakeForm({}, { refuse: true })
    const failure = await writeComateSettings(form, patch).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ComateSettingsWriteError)
    expect((failure as ComateSettingsWriteError).code).toBe('refused')
    expect((failure as ComateSettingsWriteError).field).toBe('wpsSid')
  })

  it('raises not-persisted when set() resolves but nothing is stored', async () => {
    // The silent-revert case: on Windows the profile patch is replaced by
    // "write temp + rename", and a scanner, sync folder, or editor holding the
    // file makes that rename fail after the retries — which the scope answers as
    // a normal return. Reporting it as success is how a save "takes effect" and
    // then reverts.
    const form = fakeForm({}, { swallow: true })
    const failure = await writeComateSettings(form, patch).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ComateSettingsWriteError)
    expect((failure as ComateSettingsWriteError).code).toBe('not-persisted')
    expect((failure as ComateSettingsWriteError).field).toBe('wpsSid')
  })

  it('names the field whose read-back disagrees', async () => {
    const form = fakeForm({}, { swallow: true })
    form.put({ wpsSid: 'sid', cookieOnly: false })
    const failure = await writeComateSettings(form, patch).catch((error: unknown) => error)
    expect((failure as ComateSettingsWriteError).field).toBe('enabledModelIds')
  })

  it('accepts a set() that answers void, as the 0.1.5 scope does', async () => {
    const form = fakeForm({})
    const voidSet: ComateSettingsForm = {
      getSnapshot: form.getSnapshot.bind(form),
      subscribe: form.subscribe.bind(form),
      set: async (field, value) => { await form.set(field, value) },
    }
    await expect(writeComateSettings(voidSet, patch)).resolves.toBeUndefined()
  })

  it('compares model selections as sets, not sequences', async () => {
    // The stored order can differ from the order the card wrote; only the
    // membership is part of the value's meaning.
    const form = fakeForm({}, { swallow: true })
    form.put({ wpsSid: 'sid', cookieOnly: false, enabledModelIds: ['a', 'b'] })
    await expect(writeComateSettings(form, { ...patch, enabledModelIds: ['b', 'a'] })).resolves.toBeUndefined()
  })

  it('raises not-persisted when the selection came back different', async () => {
    const form = fakeForm({}, { swallow: true })
    form.put({ wpsSid: 'sid', cookieOnly: false, enabledModelIds: ['a'] })
    const failure = await writeComateSettings(form, { ...patch, enabledModelIds: ['a', 'b'] })
      .catch((error: unknown) => error)
    expect((failure as ComateSettingsWriteError).field).toBe('enabledModelIds')
  })

  it('never sends a live reference as a written value', async () => {
    const form = fakeForm({})
    await writeComateSettings(form, patch)
    expect(() => structuredClone(form.calls)).not.toThrow()
  })

  it('keeps the stored sid when the patch omits it', async () => {
    // The card never re-sends the saved sid (it does not even hold it in the
    // draft), so a save of the other fields must not touch the credential —
    // and must not fail the wpsSid read-back it never issued.
    const form = fakeForm({ wpsSid: 'stored', cookieOnly: false, enabledModelIds: [] })
    await expect(writeComateSettings(form, { cookieOnly: true, enabledModelIds: ['a'] })).resolves.toBeUndefined()
    expect(form.calls.map(([field]) => field)).toEqual(['cookieOnly', 'enabledModelIds'])
    expect(readComateValue(form).wpsSid).toBe('stored')
  })

  it('writes an explicit empty string when asked to clear the sid', async () => {
    const form = fakeForm({ wpsSid: 'stored', cookieOnly: false, enabledModelIds: [] })
    await expect(writeComateSettings(form, { wpsSid: '' })).resolves.toBeUndefined()
    expect(form.calls.map(([field]) => field)).toEqual(['wpsSid'])
    expect(readComateValue(form).wpsSid).toBe('')
  })

  it('does not flag not-persisted for a field the patch did not touch', async () => {
    const form = fakeForm({}, { swallow: true })
    await expect(writeComateSettings(form, { cookieOnly: false })).resolves.toBeUndefined()
  })

  it('writes the output cap after the selection, and verifies it', async () => {
    const form = fakeForm({})
    await expect(writeComateSettings(form, { ...patch, maxOutputTokens: 4096 })).resolves.toBeUndefined()
    expect(form.calls.map(([field]) => field))
      .toEqual(['wpsSid', 'cookieOnly', 'enabledModelIds', 'maxOutputTokens'])
    expect(readComateValue(form).maxOutputTokens).toBe(4096)
  })

  it('writes an explicit 0, the "no cap" spelling', async () => {
    // 0 不能被当成「空值/清空」而跳过写入：它是本插件唯一能表达「不设上限」的值。
    const form = fakeForm({ maxOutputTokens: 4096 })
    await expect(writeComateSettings(form, { maxOutputTokens: 0 })).resolves.toBeUndefined()
    expect(form.calls).toEqual([['maxOutputTokens', 0]])
    expect(readComateValue(form).maxOutputTokens).toBe(0)
  })

  it('raises not-persisted when the cap came back different', async () => {
    const form = fakeForm({}, { swallow: true })
    form.put({ maxOutputTokens: 4096 })
    const failure = await writeComateSettings(form, { maxOutputTokens: 32000 })
      .catch((error: unknown) => error)
    expect((failure as ComateSettingsWriteError).code).toBe('not-persisted')
    expect((failure as ComateSettingsWriteError).field).toBe('maxOutputTokens')
  })

  it('writes the per-model cap map and verifies it', async () => {
    const form = fakeForm({})
    await expect(writeComateSettings(form, { maxOutputTokensByModel: { a: 4096, b: 0 } })).resolves.toBeUndefined()
    expect(form.calls).toEqual([['maxOutputTokensByModel', { a: 4096, b: 0 }]])
    expect(readComateValue(form).maxOutputTokensByModel).toEqual({ a: 4096, b: 0 })
  })

  it('removes an override by writing a map without it', async () => {
    // 卡片清空某一格就是这样落盘的：整张 map 重写，少掉的那个键才真的消失。
    const form = fakeForm({ maxOutputTokensByModel: { a: 4096, b: 8192 } })
    await expect(writeComateSettings(form, { maxOutputTokensByModel: { b: 8192 } })).resolves.toBeUndefined()
    expect(readComateValue(form).maxOutputTokensByModel).toEqual({ b: 8192 })
  })

  it('accepts an empty map as "no overrides at all"', async () => {
    // 全部清空是合法状态（每个模型都跟随全局），不能被当成「空值」跳过或报错。
    const form = fakeForm({ maxOutputTokensByModel: { a: 4096 } })
    await expect(writeComateSettings(form, { maxOutputTokensByModel: {} })).resolves.toBeUndefined()
    expect(form.calls).toEqual([['maxOutputTokensByModel', {}]])
    expect(readComateValue(form).maxOutputTokensByModel).toBeUndefined()
  })

  it('raises not-persisted when a per-model entry came back different', async () => {
    const form = fakeForm({}, { swallow: true })
    form.put({ maxOutputTokensByModel: { a: 4096 } })
    const failure = await writeComateSettings(form, { maxOutputTokensByModel: { a: 8192 } })
      .catch((error: unknown) => error)
    expect((failure as ComateSettingsWriteError).code).toBe('not-persisted')
    expect((failure as ComateSettingsWriteError).field).toBe('maxOutputTokensByModel')
  })

  it('does not hand the Host the caller own object', async () => {
    // 写出去的是副本：卡片那边的草稿不能被 Host 拿着当共享可变状态。
    const form = fakeForm({})
    const patch = { maxOutputTokensByModel: { a: 4096 } }
    await expect(writeComateSettings(form, patch)).resolves.toBeUndefined()
    expect(form.calls[0]![1]).not.toBe(patch.maxOutputTokensByModel)
    expect(form.calls[0]![1]).toEqual({ a: 4096 })
  })

  it('leaves the stored per-model map alone when the patch omits it', async () => {
    const form = fakeForm({ maxOutputTokensByModel: { a: 4096 }, enabledModelIds: [] })
    await expect(writeComateSettings(form, { cookieOnly: true })).resolves.toBeUndefined()
    expect(form.calls.map(([field]) => field)).toEqual(['cookieOnly'])
    expect(readComateValue(form).maxOutputTokensByModel).toEqual({ a: 4096 })
  })

  it('leaves the stored cap alone when the patch omits it', async () => {
    // 卡片不重发没改过的字段；保存其他项不能把上限重置成默认值。
    const form = fakeForm({ maxOutputTokens: 4096, enabledModelIds: [] })
    await expect(writeComateSettings(form, { cookieOnly: true })).resolves.toBeUndefined()
    expect(form.calls.map(([field]) => field)).toEqual(['cookieOnly'])
    expect(readComateValue(form).maxOutputTokens).toBe(4096)
  })

  it('writes the alias map and verifies it', async () => {
    const form = fakeForm({})
    await expect(writeComateSettings(form, { modelAliases: { a: '快问快答', b: 'B' } })).resolves.toBeUndefined()
    expect(form.calls).toEqual([['modelAliases', { a: '快问快答', b: 'B' }]])
    expect(readComateValue(form).modelAliases).toEqual({ a: '快问快答', b: 'B' })
  })

  it('removes an alias by writing a map without it', async () => {
    // 清空一格的落盘方式：整张 map 重写，少掉的那个键才真的消失（而不是存个空串）。
    const form = fakeForm({ modelAliases: { a: 'A', b: 'B' } })
    await expect(writeComateSettings(form, { modelAliases: { b: 'B' } })).resolves.toBeUndefined()
    expect(readComateValue(form).modelAliases).toEqual({ b: 'B' })
  })

  it('accepts an empty alias map as "no aliases at all"', async () => {
    const form = fakeForm({ modelAliases: { a: 'A' } })
    await expect(writeComateSettings(form, { modelAliases: {} })).resolves.toBeUndefined()
    expect(form.calls).toEqual([['modelAliases', {}]])
    expect(readComateValue(form).modelAliases).toBeUndefined()
  })

  it('raises not-persisted when an alias came back different', async () => {
    const form = fakeForm({}, { swallow: true })
    form.put({ modelAliases: { a: 'A' } })
    const failure = await writeComateSettings(form, { modelAliases: { a: 'B' } })
      .catch((error: unknown) => error)
    expect((failure as ComateSettingsWriteError).code).toBe('not-persisted')
    expect((failure as ComateSettingsWriteError).field).toBe('modelAliases')
  })

  it('accepts a re-ordered alias map as persisted', async () => {
    // 宿主可能按自己的键序重新序列化：那还是同一份设置，不能报「没存上」。
    const form = fakeForm({ modelAliases: { b: 'B', a: 'A' } })
    await expect(writeComateSettings(form, { modelAliases: { a: 'A', b: 'B' } })).resolves.toBeUndefined()
  })

  it('does not hand the Host the caller own alias object', async () => {
    const form = fakeForm({})
    const patch = { modelAliases: { a: 'A' } }
    await expect(writeComateSettings(form, patch)).resolves.toBeUndefined()
    expect(form.calls[0]![1]).not.toBe(patch.modelAliases)
    expect(form.calls[0]![1]).toEqual({ a: 'A' })
  })

  it('leaves the stored aliases alone when the patch omits them', async () => {
    const form = fakeForm({ modelAliases: { a: 'A' }, enabledModelIds: [] })
    await expect(writeComateSettings(form, { cookieOnly: true })).resolves.toBeUndefined()
    expect(form.calls.map(([field]) => field)).toEqual(['cookieOnly'])
    expect(readComateValue(form).modelAliases).toEqual({ a: 'A' })
  })

  it('writes the extra levels and verifies them', async () => {
    const form = fakeForm({})
    await expect(writeComateSettings(form, { extraThinkingLevels: ['off', 'max'] })).resolves.toBeUndefined()
    expect(form.calls).toEqual([['extraThinkingLevels', ['off', 'max']]])
    expect(readComateValue(form).extraThinkingLevels).toEqual(['off', 'max'])
  })

  it('compares extra levels as a set, not a sequence', async () => {
    // 宿主回读的顺序不该决定「存上了没有」：这是一个集合，不是列表。
    const form = fakeForm({ extraThinkingLevels: ['max', 'off'] })
    await expect(writeComateSettings(form, { extraThinkingLevels: ['off', 'max'] })).resolves.toBeUndefined()
  })

  it('accepts an empty level list as "nothing turned on"', async () => {
    // 三个勾选框全取消就是这样落盘的：写空表，而不是「什么都不写」（后者会留下
    // 上一轮的档位，用户看到的是「取消不了」）。
    const form = fakeForm({ extraThinkingLevels: ['off'] })
    await expect(writeComateSettings(form, { extraThinkingLevels: [] })).resolves.toBeUndefined()
    expect(form.calls).toEqual([['extraThinkingLevels', []]])
    expect(readComateValue(form).extraThinkingLevels).toBeUndefined()
  })

  it('raises not-persisted when a level came back different', async () => {
    const form = fakeForm({}, { swallow: true })
    form.put({ extraThinkingLevels: ['off'] })
    const failure = await writeComateSettings(form, { extraThinkingLevels: ['max'] })
      .catch((error: unknown) => error)
    expect((failure as ComateSettingsWriteError).code).toBe('not-persisted')
    expect((failure as ComateSettingsWriteError).field).toBe('extraThinkingLevels')
  })

  it('leaves the stored levels alone when the patch omits them', async () => {
    const form = fakeForm({ extraThinkingLevels: ['off'], enabledModelIds: [] })
    await expect(writeComateSettings(form, { cookieOnly: true })).resolves.toBeUndefined()
    expect(form.calls.map(([field]) => field)).toEqual(['cookieOnly'])
    expect(readComateValue(form).extraThinkingLevels).toEqual(['off'])
  })
})

describe('acquireComateSettingsForm', () => {
  it('uses the served entry id from the describe mirror on the 0.1.7 line', () => {
    const get = vi.fn((entryId: string) => ({ entryId }))
    const probe = {
      get: (name: string) => (name === 'configForms'
        ? {
            describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'dsh-connect-comate' }] } }) }),
            get,
          }
        : undefined),
    }
    expect(acquireComateSettingsForm(probe)).toEqual({ entryId: COMATE_ENTRY_ID })
    expect(get).toHaveBeenCalledWith(COMATE_ENTRY_ID)
  })

  it('prefers the exact entry id over a fuzzy sibling', () => {
    const get = vi.fn((entryId: string) => ({ entryId }))
    const probe = {
      get: (name: string) => (name === 'configForms'
        ? {
            describe: () => ({
              getSnapshot: () => ({
                view: { namespaces: [{ ns: 'comate-helpers' }, { ns: 'dsh-connect-comate' }] },
              }),
            }),
            get,
          }
        : undefined),
    }
    expect(acquireComateSettingsForm(probe)).toEqual({ entryId: COMATE_ENTRY_ID })
  })

  it('accepts a fuzzy match when the entry was composed under another id', () => {
    const probe = {
      get: (name: string) => (name === 'configForms'
        ? {
            describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'my-comate-fork' }] } }) }),
            get: (entryId: string) => ({ entryId }),
          }
        : undefined),
    }
    expect(acquireComateSettingsForm(probe)).toEqual({ entryId: 'my-comate-fork' })
  })

  it('falls back to the default entry id when the mirror cannot answer', () => {
    const get = vi.fn((entryId: string) => ({ entryId }))
    const probe = {
      get: (name: string) => (name === 'configForms'
        ? { describe: () => { throw new Error('mirror not ready') }, get }
        : undefined),
    }
    expect(acquireComateSettingsForm(probe)).toEqual({ entryId: COMATE_ENTRY_ID })
  })

  it('falls back to settingsScope.bind on the 0.1.5 line', () => {
    const bind = vi.fn((spec: { namespace: string }) => ({ spec }))
    const probe = { get: (name: string) => (name === 'settingsScope' ? { bind } : undefined) }
    expect(acquireComateSettingsForm(probe)).toEqual({ spec: { namespace: COMATE_SETTINGS_NS } })
  })

  it('returns undefined when neither service is available', () => {
    expect(acquireComateSettingsForm({ get: () => undefined })).toBeUndefined()
  })

  it('returns undefined rather than throwing when a probe blows up', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const probe = { get: () => { throw new Error('service resolution exploded') } }
    expect(acquireComateSettingsForm(probe)).toBeUndefined()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
