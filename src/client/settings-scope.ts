/**
 * Browser half's settings surface: acquire the form for this plugin's section
 * on whichever DSH line is running, read it through the volatile-reference
 * unwrapper, and write it with read-back verification.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 「按能力获取 scope（0.1.7 走 `configForms.get(ns)`、0.1.5 回落
 *     `settingsScope.bind()`）、`set()` resolve 不等于已落盘所以要回读校验」
 *     这两条结论由该项目在 2.0.12–2.0.14 逐条查出并验证。
 * 改动：只保留本插件真正用到的成员；回读校验抽成可测的纯函数。
 *
 * ## 为什么这个模块不碰 `document`、也不 import 任何宿主模块
 *
 * 它是 host↔browser 的纯逻辑桥梁：这样它既能在 node 测试环境里被真实调用
 * （而不是像 workbuddy 2.0.14 之前那样，整套测试只用普通对象模拟
 * `getSnapshot().value`，于是线上真实的活引用形状从未被测过），也不会把
 * 任何宿主代码拖进浏览器 bundle。
 *
 * @module dsh-connect-comate/client/settings-scope
 */

import {
  COMATE_ENTRY_ID,
  COMATE_SETTINGS_NS,
  unwrapVolatile,
  type ComateSettingsValue,
} from '../bridge.ts'

/** One settings form's synchronous snapshot, as both lines shape it. */
export interface ComateSettingsSnapshot {
  /** `loading` | `ready` | `unavailable` on 0.1.7; absent on 0.1.5. */
  status?: string
  /** Last accepted section; may hold live references for volatile fields. */
  value?: unknown
  /** Whether the Host document accepts writes. */
  writable?: boolean
}

/**
 * The settings form both lines hand out.
 *
 * 0.1.7's `ConfigForm` and 0.1.5's `SettingsScope` expose the same
 * read/observe/write trio with the same names, so one structural type serves
 * both. The only divergence that matters is `set()`'s answer: 0.1.7 resolves
 * `false` for a refused or skipped write, 0.1.5 resolves `void`.
 */
export interface ComateSettingsForm {
  getSnapshot(): ComateSettingsSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean | void>
}

/** The namespace row a `settings.describe` answer carries. */
interface ComateNamespaceView {
  ns: string
}

/** 0.1.7's `ConfigForms`, narrowed to the members this plugin uses. */
interface ComateConfigForms {
  describe(): { getSnapshot(): { view?: { namespaces?: readonly ComateNamespaceView[] } | undefined } }
  get(entryId: string): ComateSettingsForm
}

/** 0.1.5's `SettingsScopeBinder`, narrowed to the members this plugin uses. */
interface ComateSettingsScopeBinder {
  bind(spec: { namespace: string }): ComateSettingsForm
}

/**
 * The slice of the browser context the acquisition needs.
 *
 * Deliberately just `get`: the settings surface differs by line and Cordis'
 * dependency gate is hard — any `inject` entry the running line does not provide
 * keeps `apply` from ever running. Probing both names through `ctx.get()` (which
 * returns `undefined`, never throws, for an absent service) is what lets one
 * build serve both lines.
 */
export interface ComateServiceProbe {
  get(name: string): unknown
}

/** Why a settings write did not land. */
export type ComateSettingsWriteFailure = 'refused' | 'not-persisted'

/**
 * A settings write the Host did not accept.
 *
 * Distinguishing the two causes matters to the user: `refused` means the Host
 * rejected the value, `not-persisted` means the write was answered but the
 * document did not change — on Windows the profile patch is replaced by
 * "write temp + rename", and a virus scanner, sync folder, or editor holding the
 * file makes that rename fail after the retries, which the scope reports as a
 * normal return. Reporting the second as success is how a save "takes effect"
 * and then silently reverts.
 */
export class ComateSettingsWriteError extends Error {
  /** Machine-readable cause, stable across bundle boundaries. */
  readonly code: ComateSettingsWriteFailure
  /** The field that did not land. */
  readonly field: string

  constructor(code: ComateSettingsWriteFailure, field: string, message: string) {
    super(message)
    this.name = 'ComateSettingsWriteError'
    this.code = code
    this.field = field
  }
}

/** The three fields the card saves. */
export interface ComateSettingsPatch {
  wpsSid: string
  cookieOnly: boolean
  enabledModelIds: readonly string[]
}

/**
 * The Loader entry id the Host actually serves this plugin under.
 *
 * 0.1.7 keys settings by entry id, and a plugin can be composed under an id that
 * differs from its package name — so the served namespace is taken from the
 * describe mirror rather than assumed. The exact id wins over the fuzzy match:
 * a sibling package whose name merely contains "comate" must not be mistaken for
 * this one.
 */
function servedEntryId(forms: ComateConfigForms): string {
  let namespaces: readonly ComateNamespaceView[] = []
  try {
    namespaces = forms.describe().getSnapshot().view?.namespaces ?? []
  } catch {
    // A mirror that has not answered yet must not stop the card from mounting.
    return COMATE_ENTRY_ID
  }
  const exact = namespaces.find(entry => entry.ns === COMATE_ENTRY_ID)
  if (exact !== undefined) return exact.ns
  const fuzzy = namespaces.find(entry => /comate/i.test(entry.ns))
  return fuzzy?.ns ?? COMATE_ENTRY_ID
}

/**
 * Resolve the settings form for this plugin's section, or `undefined` when
 * neither line's service is available.
 *
 * @param probe - the browser context (or any `{ get }` stub in tests).
 * @returns the form, or `undefined` so the card can render read-only.
 */
export function acquireComateSettingsForm(probe: ComateServiceProbe): ComateSettingsForm | undefined {
  try {
    const forms = probe.get('configForms') as ComateConfigForms | undefined
    if (forms !== undefined && forms !== null
      && typeof forms.get === 'function' && typeof forms.describe === 'function') {
      return forms.get(servedEntryId(forms))
    }
    const legacy = probe.get('settingsScope') as ComateSettingsScopeBinder | undefined
    if (legacy !== undefined && legacy !== null && typeof legacy.bind === 'function') {
      return legacy.bind({ namespace: COMATE_SETTINGS_NS })
    }
  } catch (error: unknown) {
    // Probing must never be the reason a card fails to load; the host provider
    // is unaffected either way.
    console.error('[dsh-connect-comate] settings surface probe failed:', error)
  }
  return undefined
}

/**
 * Whether the Host document accepts writes through this form.
 *
 * No form at all means no write path, so the card renders read-only rather than
 * offering buttons that cannot work. An absent `writable` flag is NOT read as
 * "not writable": 0.1.5's snapshot may omit it, and treating that as locked would
 * freeze a perfectly writable card.
 */
export function comateSettingsWritable(form: ComateSettingsForm | undefined): boolean {
  if (form === undefined) return false
  return form.getSnapshot().writable !== false
}

/**
 * Read the card's view of the section.
 *
 * Every field may arrive as a `{get(): T}` live reference on 0.1.7 (and as a
 * plain value on 0.1.5), so each one goes through {@link unwrapVolatile}; a live
 * reference is still `typeof === 'object'`, which is exactly how a naive reader
 * ends up treating it as the section itself.
 *
 * The deprecated host-published `lastCatalog` is deliberately NOT read: the
 * model directory now has one source, the read-only catalog route.
 *
 * @param form - the settings form, if any.
 * @returns the section as plain values; `{}` when nothing is available.
 */
export function readComateValue(form: ComateSettingsForm | undefined): ComateSettingsValue {
  const raw = form?.getSnapshot().value
  if (raw === null || typeof raw !== 'object') return {}
  const section = raw as Record<string, unknown>
  const value: ComateSettingsValue = {}
  const configFile = unwrapVolatile(section.configFile)
  if (typeof configFile === 'string') value.configFile = configFile
  const wpsSid = unwrapVolatile(section.wpsSid)
  if (typeof wpsSid === 'string') value.wpsSid = wpsSid
  const cookieOnly = unwrapVolatile(section.cookieOnly)
  if (typeof cookieOnly === 'boolean') value.cookieOnly = cookieOnly
  const enabled = unwrapVolatile(section.enabledModelIds)
  if (Array.isArray(enabled)) value.enabledModelIds = enabled.filter((id): id is string => typeof id === 'string')
  return value
}

/** Set equality over model ids; order is not part of the saved value's meaning. */
function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const set = new Set(left)
  return right.every(id => set.has(id))
}

/**
 * Let the form's write answer fold back into the settings mirror before the
 * read-back below inspects it. A macrotask, not a microtask: it drains every
 * pending microtask first, so the fold cannot be observed half-applied.
 */
function afterWriteSettles(): Promise<void> {
  return new Promise<void>(resolve => { setTimeout(resolve, 0) })
}

/**
 * Queue one field write and refuse to treat a refusal as success.
 *
 * @param form - the settings form.
 * @param field - scalar field inside the section.
 * @param value - JSON-shaped value selected by the user.
 * @throws {ComateSettingsWriteError} `refused` when the Host answered `false`.
 */
async function writeField(form: ComateSettingsForm, field: string, value: unknown): Promise<void> {
  const accepted = await form.set(field, value)
  if (accepted === false) {
    throw new ComateSettingsWriteError('refused', field, `the Host refused the settings field "${field}"`)
  }
}

/**
 * Save the card's three fields, verifying that they actually landed.
 *
 * @param form - the settings form.
 * @param patch - the values to save.
 * @throws {ComateSettingsWriteError} `refused` for a rejected write,
 * `not-persisted` when the value read back differs from what was written.
 */
export async function writeComateSettings(
  form: ComateSettingsForm,
  patch: ComateSettingsPatch,
): Promise<void> {
  await writeField(form, 'wpsSid', patch.wpsSid)
  await writeField(form, 'cookieOnly', patch.cookieOnly)
  // An all-selected list is normalized to `[]` by the caller, which the host
  // reads as "show every discovered model" and keeps the saved section compact.
  await writeField(form, 'enabledModelIds', [...patch.enabledModelIds])

  await afterWriteSettles()
  const saved = readComateValue(form)
  if (saved.wpsSid !== patch.wpsSid) {
    throw new ComateSettingsWriteError('not-persisted', 'wpsSid', 'settings field "wpsSid" was not persisted')
  }
  if ((saved.cookieOnly === true) !== patch.cookieOnly) {
    throw new ComateSettingsWriteError('not-persisted', 'cookieOnly', 'settings field "cookieOnly" was not persisted')
  }
  if (!sameStringSet(saved.enabledModelIds ?? [], patch.enabledModelIds)) {
    throw new ComateSettingsWriteError(
      'not-persisted',
      'enabledModelIds',
      'settings field "enabledModelIds" was not persisted',
    )
  }
}
