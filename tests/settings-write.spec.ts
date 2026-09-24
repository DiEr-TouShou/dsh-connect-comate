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
