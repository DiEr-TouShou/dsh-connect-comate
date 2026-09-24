import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { COMATE_ENTRY_ID, COMATE_SETTINGS_NS } from '../src/bridge.ts'
import { bindComateSettings } from '../src/settings-surface.ts'

/** A DSH 0.1.7 live reference, exactly as the harness shapes it. */
function live<T>(value: T): { get(): T } {
  return Object.freeze({ get: () => value })
}

interface Harness {
  ctx: Context
  /** Disposers the plugin registered through `ctx.effect`. */
  effects: Array<() => void>
  /** Listeners registered through `ctx.on`, by event name. */
  listeners: Map<string, () => void>
  /** Messages logged at error level. */
  errors: string[]
}

/** A context stub covering only the seats the settings assembly touches. */
function harness(settings: unknown, entryId: string | undefined = COMATE_ENTRY_ID): Harness {
  const effects: Array<() => void> = []
  const listeners = new Map<string, () => void>()
  const errors: string[] = []
  const fiber = entryId === undefined ? {} : { entry: { options: { id: entryId } } }
  const ctx = {
    settings,
    fiber,
    logger: {
      error: (...args: unknown[]) => { errors.push(args.map(value => String(value)).join(' ')) },
      warn: () => {},
    },
    effect: (fn: () => unknown) => {
      const disposer = fn()
      if (typeof disposer === 'function') effects.push(disposer as () => void)
      return {}
    },
    on: (name: string, callback: () => void) => { listeners.set(name, callback) },
  }
  return { ctx: ctx as unknown as Context, effects, listeners, errors }
}

/**
 * Both host lines must mount from ONE build.
 *
 * The 0.1.5 line's `SettingsProvider.register` and the 0.1.7 line's
 * `SettingsForms.configure` are mutually exclusive — neither exists on the other
 * line — and the failure mode of assuming either one is total: `apply()` throws,
 * so the provider is never registered and the card never appears. A suite that
 * exercises only one line goes green while the other line is broken, which is
 * exactly how workbuddy's first 0.1.7 port passed review and CI.
 */
describe('bindComateSettings', () => {
  describe('0.1.7 line (SettingsForms)', () => {
    it('mounts through configure() and keys the section by the Loader entry id', () => {
      const configure = vi.fn((_presentation: { auto?: boolean }, _owner?: unknown) => () => {})
      const onChange = vi.fn()
      const base = { wpsSid: live('sid'), cookieOnly: live(true), enabledModelIds: live(['a']) }
      const h = harness({ configure })

      const binding = bindComateSettings(h.ctx, { fake: 'schema' }, base, onChange)

      expect(binding).toBeDefined()
      expect(configure).toHaveBeenCalledTimes(1)
      // `auto: false`: this plugin ships its own card, and an auto-generated
      // form would render wps_sid as a plaintext text field.
      expect(configure.mock.calls[0]?.[0]).toEqual({ auto: false })
      expect(binding?.settingsNs).toBe(COMATE_ENTRY_ID)
      // Live references are peeled on EVERY read, not just the first.
      expect(binding?.current()).toEqual({ wpsSid: 'sid', cookieOnly: true, enabledModelIds: ['a'] })
      expect(binding?.current()).toEqual({ wpsSid: 'sid', cookieOnly: true, enabledModelIds: ['a'] })
      // configure()'s disposer is tied to the fiber rather than dropped.
      expect(h.effects).toHaveLength(1)
    })

    it('re-reads the section after every committed write', () => {
      const onChange = vi.fn()
      const h = harness({ configure: vi.fn(() => () => {}) })

      bindComateSettings(h.ctx, {}, {}, onChange)

      const listener = h.listeners.get('loader/volatile-update')
      expect(listener).toBeDefined()
      listener?.()
      expect(onChange).toHaveBeenCalledTimes(1)
    })

    it('falls back to the package name when the Loader entry id is unavailable', () => {
      const h = harness({ configure: vi.fn(() => () => {}) }, undefined)

      expect(bindComateSettings(h.ctx, {}, {}, () => {})?.settingsNs).toBe(COMATE_ENTRY_ID)
    })
  })

  describe('0.1.5 line (SettingsProvider)', () => {
    it('mounts through register() with the plugin-owned namespace', () => {
      const register = vi.fn((_ns: string, _schema: unknown, _options?: { base?: unknown }) => ({
        get: () => ({ wpsSid: 'from-scope' }),
        watch: () => () => {},
      }))
      const h = harness({ register })

      const binding = bindComateSettings(h.ctx, { fake: 'schema' }, {}, () => {})

      expect(register).toHaveBeenCalledTimes(1)
      expect(register.mock.calls[0]?.[0]).toBe(COMATE_SETTINGS_NS)
      expect(binding?.settingsNs).toBe(COMATE_SETTINGS_NS)
      expect(binding?.current()).toEqual({ wpsSid: 'from-scope' })
    })

    it('hands the service a composition layer free of live references', () => {
      // 0.1.5 validates and structuredClones this argument before registering the
      // namespace; one surviving reference makes every field fail validation, the
      // section silently fails to register, and the card's settings disappear.
      const register = vi.fn((_ns: string, _schema: unknown, _options?: { base?: unknown }) => ({
        get: () => ({}),
        watch: () => () => {},
      }))
      const base = { wpsSid: live('sid'), enabledModelIds: live(['a']) }
      const h = harness({ register })

      bindComateSettings(h.ctx, { fake: 'schema' }, base, () => {})

      const passed = register.mock.calls[0]?.[2] as { base?: unknown } | undefined
      expect(() => structuredClone(passed?.base)).not.toThrow()
      expect(passed?.base).toEqual({ wpsSid: 'sid', enabledModelIds: ['a'] })
    })

    it('watches the scope and ties the release to the fiber', () => {
      let watched: (() => void) | undefined
      const onChange = vi.fn()
      const register = vi.fn(() => ({
        get: () => ({}),
        watch: (callback: () => void) => { watched = callback; return () => {} },
      }))
      const h = harness({ register })

      bindComateSettings(h.ctx, {}, {}, onChange)

      expect(h.effects).toHaveLength(1)
      watched?.()
      expect(onChange).toHaveBeenCalledTimes(1)
    })
  })

  describe('neither line', () => {
    it('refuses to register anything rather than mount half-assembled', () => {
      const h = harness({ describe: () => [] })

      expect(bindComateSettings(h.ctx, {}, {}, () => {})).toBeUndefined()
      expect(h.errors).toHaveLength(1)
      expect(h.errors[0]).toContain('neither configure')
      expect(h.effects).toHaveLength(0)
      expect(h.listeners.size).toBe(0)
    })

    it('prefers the 0.1.7 shape when a line provides both', () => {
      const configure = vi.fn(() => () => {})
      const register = vi.fn()
      const h = harness({ configure, register })

      bindComateSettings(h.ctx, {}, {}, () => {})

      expect(configure).toHaveBeenCalledTimes(1)
      expect(register).not.toHaveBeenCalled()
    })
  })
})
