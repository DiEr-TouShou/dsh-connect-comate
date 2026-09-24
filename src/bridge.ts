/**
 * Host ↔ browser bridge: the node-free vocabulary both halves of the plugin
 * share, plus the two volatility helpers the DSH 0.1.7 line makes mandatory.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — `asVolatile()` / `unwrapVolatile()` / `unwrapVolatileDeep()` 的判定方式
 *     （运行时探测 `schema.volatile()`、活引用形状 `{get(): T}`、交给 settings
 *     服务前必须递归剥净）由该项目在 2.0.12–2.0.14 三个版本里逐条查出并验证。
 * 改动：把常量与类型也收进这里，使浏览器半不再需要 import 任何宿主模块。
 *
 * ## 为什么 0.1.7 上必须有这三个 helper
 *
 * 1. **写入被拒**：0.1.7 的 settings 写入门先要 `volatileForm(schema)` 非空
 *    （否则 `Plugin entry "<ns>" has no volatile fields`），再要求每条写入路径
 *    `isVolatilePath` 为真。因此可写字段必须由 schema 自己声明 volatile。
 * 2. **声明方式**：`volatile()` 是 schemastery 3.18.3 才有的方法。更早的版本上
 *    只能退化成 identity no-op——**刻意不手写 `meta.volatile = true`**：那会绕过
 *    schemastery 自身的 `validateVolatileSchema` 校验，产出一个它自己都不认的
 *    schema。
 * 3. **取值形状**：声明为 volatile 的字段在 `apply()` 里、以及浏览器侧 settings
 *    镜像里，交付的都是冻结的 `{get(): T}` **活引用**（`createVolatile`）。不解包
 *    就会静默拿到对象或 `undefined`。而活引用**仍然是 `typeof === "object"`**，
 *    所以任何「是对象就当映射用」的读法都会栽在这里。
 *
 * @module dsh-connect-comate/bridge
 */

/** Stable browser-plugin name suffix; the host entry keeps the bare package name. */
export const COMATE_CLIENT_NAME = 'dsh-connect-comate-client'

/**
 * The profile plugin entry id, which on DSH 0.1.7 **is** the settings namespace.
 *
 * 0.1.5 registered its own namespace string (`comate`); 0.1.7 replaced that with
 * the Loader entry: `SettingsForms.write` resolves a namespace by
 * `configEditor.entries().find(row => row.options.id === ns)`.
 */
export const COMATE_ENTRY_ID = 'dsh-connect-comate'

/**
 * The settings namespace the plugin registers on the 0.1.5 line, where a plugin
 * owns the namespace string instead of inheriting its entry id. Kept for the
 * capability-probed fallback and for `bin` diagnostics.
 */
export const COMATE_SETTINGS_NS = 'comate'

/**
 * Read-only host route the card reads the discovered model directory from.
 *
 * The host deliberately does NOT write the directory back into settings: on
 * 0.1.7 a settings write targets the user's hand-written `cordis.patch.yml`, and
 * rewriting that file whenever discovery changes would destroy its comments and
 * formatting. A loopback-only GET route keeps the channel read-only.
 */
export const COMATE_CATALOG_PATH = '/plugins/dsh-connect-comate/__catalog'

/**
 * Action route: re-read the local Comate config and republish the directory.
 *
 * The host discovers models at startup and when `configFile` changes; a model
 * the user just added (or signed into) in the desktop client would otherwise
 * need a DSH restart. A POST because it performs work, even though it writes
 * nothing anywhere.
 */
export const COMATE_REFRESH_PATH = '/plugins/dsh-connect-comate/__refresh'

/**
 * Action route: send one minimal chat request to verify the credential.
 *
 * Optionally carries an UNSAVED draft `wpsSid` / `cookieOnly` so the card can be
 * tested before saving. The draft lives only in that one request: nothing
 * persists it and the answer never echoes it back.
 */
export const COMATE_CHECK_PATH = '/plugins/dsh-connect-comate/__check'

/** Card-facing model directory entry. */
export interface ComatePersistedModel {
  id: string
  name: string
  /** Whether the model accepts image input (Comate `llm-multimodal`). */
  multimodal: boolean
  contextWindow: number
}

/**
 * The settings section the card edits, as the browser mirror delivers it.
 * Every field except `configFile` is declared volatile on the host schema, so on
 * 0.1.7 each one may arrive wrapped in a live reference — read it through
 * {@link unwrapVolatile}, never directly.
 *
 * The host's deprecated `lastCatalog` field is not part of this view: the model
 * directory has one source, {@link COMATE_CATALOG_PATH}.
 */
export interface ComateSettingsValue {
  configFile?: string
  wpsSid?: string
  cookieOnly?: boolean
  enabledModelIds?: string[]
}

/**
 * Upstream failure classes the shim maps onto distinct HTTP answers.
 *
 * Declared here rather than in `./upstream.ts` so this module stays dependency
 * free — the browser half renders these names, and a type it imports must not
 * drag a `node:crypto` import into the client bundle. `./upstream.ts`
 * re-exports it, so the host-side name is unchanged.
 */
export type UpstreamErrorKind =
  | 'hard_credit'
  | 'soft_rate'
  | 'session_dead'
  | 'not_found'
  | 'server'
  | 'client'

/** The status route's answer. Deliberately contains no credential of any kind. */
export interface ComateCatalogAnswer {
  signedIn: boolean
  providerRegistered: boolean
  models: readonly ComatePersistedModel[]
}

/** Why a probe could not run at all (as opposed to running and failing). */
export type ComateCheckReason = 'no-credential' | 'no-model'

/** What one probe request observed. */
export interface ComateCheckOutcome {
  /** Whether the upstream accepted the credential and started a stream. */
  ok: boolean
  /**
   * Why the probe never reached the network. Set by the host when it could not
   * assemble a credential or pick a model; absent whenever the request ran, even
   * if the upstream then refused it.
   */
  reason?: ComateCheckReason
  /** The model the probe used. */
  model?: string
  /** HTTP status, present when the upstream answered non-2xx. */
  status?: number
  /** Classified failure kind, present when the upstream answered non-2xx. */
  kind?: UpstreamErrorKind
  /** Redacted, length-capped upstream excerpt or transport error. */
  message?: string
}

/**
 * Mark a schema field as a stable config reference on the DSH lines that
 * support it.
 *
 * `volatile()` exists from schemastery 3.18.3 (the DSH 0.1.7 line, whose write
 * gate reads the marker). Older pinning (3.18.2, the 0.1.5 line) has no such
 * method, and the schema must stay byte-identical to the unmarked original
 * there — so on that line this degrades to an identity no-op that returns the
 * very same object.
 *
 * The signature preserves the caller's schema type exactly, so it works without
 * importing schemastery's (unexported) `Schema` type alias, and both arms stay
 * testable with a plain object stub.
 *
 * @param schema - any schemastery schema instance.
 * @returns the volatile-marked schema, or the input unchanged when unsupported.
 */
export function asVolatile<S>(schema: S): S {
  const probe = schema as { volatile?: () => unknown }
  if (typeof probe.volatile !== 'function') return schema
  return probe.volatile() as S
}

/**
 * Peel ONE level of live reference.
 *
 * A volatile field resolves to a frozen `{get(): T}` object; ordinary values
 * pass through untouched. This is the read path: it returns exactly the value
 * the field holds, without copying it.
 *
 * @param value - a resolved config value, possibly a live reference.
 * @returns the referenced value, or the input unchanged.
 */
export function unwrapVolatile<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  const getter = (value as { get?: unknown }).get
  if (typeof getter !== 'function') return value
  return (getter as () => T).call(value)
}

/**
 * Deep copy of a config value with every live reference replaced by the value it
 * resolves to.
 *
 * {@link unwrapVolatile} only peels the one level a caller reads, which is all
 * ordinary read paths need. Handing a config object to a settings service is
 * different: 0.1.5's `installSection` validates and `structuredClone`s the WHOLE
 * object, so a reference surviving anywhere inside it fails schema validation
 * with a message that names the field but not the cause
 * (`$.wpsSid expected string but got [object Object]`) — and the namespace then
 * never registers, so the card's settings silently disappear.
 *
 * Arrays are rebuilt rather than mutated in place, and the caller's object is
 * never touched.
 *
 * @param value - a raw or resolved config value.
 * @returns an equivalent structure containing no live references.
 */
export function unwrapVolatileDeep<T>(value: T): T {
  const plain = unwrapVolatile(value)
  if (Array.isArray(plain)) {
    return plain.map(item => unwrapVolatileDeep(item)) as unknown as T
  }
  if (plain === null || typeof plain !== 'object') return plain
  const prototype: unknown = Object.getPrototypeOf(plain)
  // Only plain objects are config: a class instance is a caller's own value and
  // rebuilding it as a plain object would silently change its identity/type.
  if (prototype !== Object.prototype && prototype !== null) return plain
  const source = plain as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(source)) result[key] = unwrapVolatileDeep(source[key])
  return result as T
}
