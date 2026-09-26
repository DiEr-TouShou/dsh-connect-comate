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
  COMATE_CHECK_PATH,
  COMATE_ENTRY_ID,
  COMATE_REFRESH_PATH,
  COMATE_SEAL_PATH,
  COMATE_SETTINGS_NS,
  unwrapVolatile,
  type ComateCatalogAnswer,
  type ComateCheckOutcome,
  type ComateSealAnswer,
  type ComateSettingsValue,
} from '../bridge.ts'
import { parseModelAliases } from '../model-alias.ts'
import { parseExtraThinkingLevels } from '../thinking-levels.ts'

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

/** The fields the card may save; an omitted field keeps its stored value. */
export interface ComateSettingsPatch {
  /**
   * The **sealed** value to store (see {@link sealComateSid}) — the card never
   * writes a plaintext sid, and the host never expects one. The card also never
   * re-sends the stored value: omitted keeps it, an explicit empty string clears
   * it.
   */
  wpsSid?: string | undefined
  cookieOnly?: boolean
  enabledModelIds?: readonly string[]
  /** Output-token cap: positive integer, or 0 for "no cap". */
  maxOutputTokens?: number
  /**
   * Per-model overrides of {@link ComateSettingsValue.maxOutputTokens}, keyed by
   * model id (0 = no cap for that model).
   *
   * Only overrides the card actually holds appear here: a model with no entry
   * follows the global field, so removing an override means deleting the key
   * rather than writing the global value into it. A full map is written on every
   * save that touched it, which is also how a removed key gets removed from the
   * document.
   */
  maxOutputTokensByModel?: Readonly<Record<string, number>>
  /**
   * Display-name overrides, keyed by model id.
   *
   * A full map on every save that touched it, like the cap map above: an alias
   * is removed by dropping its key, and a model with no key keeps the name
   * Comate reported.
   */
  modelAliases?: Readonly<Record<string, string>>
  /**
   * Extra thinking levels to offer in the picker, on top of the base four.
   *
   * Written as the card's checkbox state — the whole list every time, so
   * unchecking a level removes it. Only the levels listed are added; the base
   * four are not addressable from here.
   */
  extraThinkingLevels?: readonly string[]
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
  // The cap is a plain number, so unlike the fields above a bare `typeof` check
  // is enough — but a corrupt section (a string, a negative, a fraction) must
  // read as "unset" rather than reach the save path as a bogus value.
  const maxOutputTokens = unwrapVolatile(section.maxOutputTokens)
  if (typeof maxOutputTokens === 'number' && Number.isSafeInteger(maxOutputTokens) && maxOutputTokens >= 0) {
    value.maxOutputTokens = maxOutputTokens
  }
  // The per-model map is the same kind of value one level down: every entry must
  // pass the same test as the global field, and a bad entry is dropped instead of
  // being handed to the save path — one model's broken number must not make the
  // whole map unreadable. The map itself may also arrive as a live reference.
  const byModel = unwrapVolatile(section.maxOutputTokensByModel)
  if (byModel !== null && typeof byModel === 'object' && !Array.isArray(byModel)) {
    const caps: Record<string, number> = {}
    for (const [id, raw] of Object.entries(byModel as Record<string, unknown>)) {
      const cap = unwrapVolatile(raw)
      if (id.trim() === '' || typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap < 0) continue
      caps[id] = cap
    }
    if (Object.keys(caps).length > 0) value.maxOutputTokensByModel = caps
  }
  // Aliases are strings one level down, and blank is NOT a value here: a key
  // whose text is empty means "no alias", so it must read as unset rather than
  // reach the save path as an empty name. Same drop-one-bad-entry rule as caps.
  const aliases = unwrapVolatile(section.modelAliases)
  if (aliases !== null && typeof aliases === 'object' && !Array.isArray(aliases)) {
    // Unwrap one level down BEFORE parsing — `asVolatile(z.dict(...))` may hand
    // each value over as a live reference — and then let the SHARED parser decide
    // what is a usable alias. Trimming, and "a blank value is no alias", are one
    // rule with one home (`model-alias.ts`), because the card writes with that
    // rule and this reads with it; two spellings would let them drift.
    const plain = Object.fromEntries(
      Object.entries(aliases as Record<string, unknown>).map(([id, raw]) => [id, unwrapVolatile(raw)]),
    )
    const names = parseModelAliases(plain)
    if (names.size > 0) value.modelAliases = Object.fromEntries(names)
  }
  // The level list goes through the SHARED parser as well, and for a second
  // reason beyond "one rule, one home": the save path compares the stored value
  // against what the card wrote, and the card writes the canonical subset in the
  // vocabulary's own order. Reading the document's raw spelling here
  // (`['off','off','xhight']`) would make that compare report "did not persist"
  // for a document the user hand-edited — a verdict they could not act on.
  const levels = unwrapVolatile(section.extraThinkingLevels)
  if (Array.isArray(levels)) {
    const named = parseExtraThinkingLevels(levels.map(unwrapVolatile))
    if (named.length > 0) value.extraThinkingLevels = [...named]
  }
  return value
}

/** Set equality over model ids; order is not part of the saved value's meaning. */
function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const set = new Set(left)
  return right.every(id => set.has(id))
}

/**
 * Whether two cap maps say the same thing.
 *
 * By membership and value, not by key order: a map rebuilt in another order (or
 * one that dropped a key whose value was the same as the global field) is still
 * the same setting, and a false "did not persist" verdict would be unactionable.
 */
function sameCapMap(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): boolean {
  const ids = Object.keys(left)
  if (ids.length !== Object.keys(right).length) return false
  return ids.every(id => left[id] === right[id])
}

/**
 * Whether two string maps say the same thing.
 *
 * Key order is not part of the value's meaning, so it is not part of the test:
 * a map the Host re-serialized in another order is the same setting, and a false
 * "did not persist" verdict would be unactionable for the user.
 */
function sameStringMap(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const ids = Object.keys(left)
  if (ids.length !== Object.keys(right).length) return false
  return ids.every(id => left[id] === right[id])
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
 * Save the card's fields, verifying that they actually landed.
 *
 * @param form - the settings form.
 * @param patch - the values to save; an omitted field is neither written nor
 * verified, so the stored sid in particular survives a save untouched.
 * @throws {ComateSettingsWriteError} `refused` for a rejected write,
 * `not-persisted` when a written value reads back different.
 */
export async function writeComateSettings(
  form: ComateSettingsForm,
  patch: ComateSettingsPatch,
): Promise<void> {
  if (patch.wpsSid !== undefined) await writeField(form, 'wpsSid', patch.wpsSid)
  if (patch.cookieOnly !== undefined) await writeField(form, 'cookieOnly', patch.cookieOnly)
  // An all-selected list is normalized to `[]` by the caller, which the host
  // reads as "show every discovered model" and keeps the saved section compact.
  if (patch.enabledModelIds !== undefined) {
    await writeField(form, 'enabledModelIds', [...patch.enabledModelIds])
  }
  if (patch.maxOutputTokens !== undefined) {
    await writeField(form, 'maxOutputTokens', patch.maxOutputTokens)
  }
  // A copy, not the caller's object: the write path hands this to the Host, and
  // the card's draft must not become shared mutable state with it.
  if (patch.maxOutputTokensByModel !== undefined) {
    await writeField(form, 'maxOutputTokensByModel', { ...patch.maxOutputTokensByModel })
  }
  if (patch.modelAliases !== undefined) {
    await writeField(form, 'modelAliases', { ...patch.modelAliases })
  }
  if (patch.extraThinkingLevels !== undefined) {
    await writeField(form, 'extraThinkingLevels', [...patch.extraThinkingLevels])
  }

  await afterWriteSettles()
  const saved = readComateValue(form)
  // Only written fields are verified. The card never receives the stored sid
  // into any editable state, so a mismatch verdict on an omitted sid would be
  // unactionable for the user.
  if (patch.wpsSid !== undefined && saved.wpsSid !== patch.wpsSid) {
    throw new ComateSettingsWriteError('not-persisted', 'wpsSid', 'settings field "wpsSid" was not persisted')
  }
  if (patch.cookieOnly !== undefined && (saved.cookieOnly === true) !== patch.cookieOnly) {
    throw new ComateSettingsWriteError('not-persisted', 'cookieOnly', 'settings field "cookieOnly" was not persisted')
  }
  if (patch.enabledModelIds !== undefined && !sameStringSet(saved.enabledModelIds ?? [], patch.enabledModelIds)) {
    throw new ComateSettingsWriteError(
      'not-persisted',
      'enabledModelIds',
      'settings field "enabledModelIds" was not persisted',
    )
  }
  if (patch.maxOutputTokens !== undefined && saved.maxOutputTokens !== patch.maxOutputTokens) {
    throw new ComateSettingsWriteError(
      'not-persisted',
      'maxOutputTokens',
      'settings field "maxOutputTokens" was not persisted',
    )
  }
  if (patch.maxOutputTokensByModel !== undefined
    && !sameCapMap(saved.maxOutputTokensByModel ?? {}, patch.maxOutputTokensByModel)) {
    throw new ComateSettingsWriteError(
      'not-persisted',
      'maxOutputTokensByModel',
      'settings field "maxOutputTokensByModel" was not persisted',
    )
  }
  // `sameStringMap`, not a byte compare: the Host may re-serialize the map in its
  // own key order, and "did not persist" must mean the VALUE differs.
  if (patch.modelAliases !== undefined
    && !sameStringMap(saved.modelAliases ?? {}, patch.modelAliases)) {
    throw new ComateSettingsWriteError(
      'not-persisted',
      'modelAliases',
      'settings field "modelAliases" was not persisted',
    )
  }
  // Order-insensitive for the same reason, plus the host may have collapsed
  // duplicates: this field is a set of levels.
  if (patch.extraThinkingLevels !== undefined
    && !sameStringSet(saved.extraThinkingLevels ?? [], patch.extraThinkingLevels)) {
    throw new ComateSettingsWriteError(
      'not-persisted',
      'extraThinkingLevels',
      'settings field "extraThinkingLevels" was not persisted',
    )
  }
}

/**
 * POST one JSON body to a host action route and parse its answer.
 *
 * Both actions are same-origin loopback calls, so they carry the session
 * credentials but never a plugin-issued token: the host's own gates (loopback
 * Host + loopback Origin + JSON content type) are the authorization.
 *
 * @param path - the action route.
 * @param body - the JSON body, or undefined for an empty POST.
 * @returns the parsed answer.
 * @throws {Error} with the route's own error text when it refuses the request.
 */
async function postAction<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body ?? {}),
  })
  if (!response.ok) {
    // A route that answers with a reason is more useful than its status code
    // alone; fall back to the code when the body is not the expected shape.
    let detail = `HTTP ${response.status}`
    try {
      const parsed = await response.json() as { error?: unknown }
      if (typeof parsed?.error === 'string' && parsed.error !== '') detail = parsed.error
    } catch {
      // keep the status line
    }
    throw new Error(detail)
  }
  return await response.json() as T
}

/**
 * Re-read the local Comate config on the host and return the fresh directory.
 *
 * The host discovers models at startup and when `configFile` changes, so a model
 * the user just signed into in the desktop client would otherwise need a DSH
 * restart.
 *
 * @returns the host's post-refresh snapshot.
 */
export async function refreshComateCatalog(): Promise<ComateCatalogAnswer> {
  return postAction<ComateCatalogAnswer>(COMATE_REFRESH_PATH)
}

/**
 * Send one minimal chat request through the host to verify the credential.
 *
 * `input` carries the card's UNSAVED draft values, so a sid can be tested before
 * it is saved. The host applies them to that single request only; nothing is
 * persisted and the answer never echoes them back.
 *
 * @param input - optional draft overrides.
 * @returns the probe's outcome; a failed probe resolves, it does not reject.
 */
export async function testComateConnection(
  input: { wpsSid?: string; cookieOnly?: boolean } = {},
): Promise<ComateCheckOutcome> {
  return postAction<ComateCheckOutcome>(COMATE_CHECK_PATH, input)
}

/**
 * Encrypt a plaintext sid into the value that belongs in the settings document.
 *
 * The key is host-side by design (a key file plus this machine's fingerprint), so
 * the browser cannot seal anything itself — and should not be able to. The
 * plaintext travels over the same loopback path the connection probe already
 * uses, and only the ciphertext comes back.
 *
 * Unlike the probe, this REJECTS when it fails: the caller must abort the save,
 * because the only alternative would be writing the plaintext, which is exactly
 * what this route exists to prevent.
 *
 * @param sid - the plaintext value as typed.
 * @returns the sealed string plus the plaintext length, for the card's copy.
 */
export async function sealComateSid(sid: string): Promise<ComateSealAnswer> {
  return postAction<ComateSealAnswer>(COMATE_SEAL_PATH, { sid })
}

/**
 * Seal the value the settings document already stores.
 *
 * The plaintext-upgrade path: the host seals what it already holds, so a
 * credential saved by an older version never has to enter the browser just to be
 * re-saved in encrypted form.
 *
 * @returns the sealed string plus the plaintext length.
 */
export async function sealStoredComateSid(): Promise<ComateSealAnswer> {
  return postAction<ComateSealAnswer>(COMATE_SEAL_PATH, { fromStored: true })
}
