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

/**
 * Action route: seal a plaintext `wps_sid` into its storable form.
 *
 * The browser half cannot do this itself: the encryption key is host-side
 * (a key file plus this machine's fingerprint, see `./secret.ts`), and the
 * browser has no business holding it. So the card sends the typed value over the
 * same loopback path the connection probe already uses and gets back only the
 * ciphertext to store.
 *
 * Two inputs, one route: a typed `sid`, or `fromStored: true` to seal whatever is
 * already saved — the latter is how a plaintext value left by an older version is
 * upgraded WITHOUT the plaintext ever entering the browser.
 */
export const COMATE_SEAL_PATH = '/plugins/dsh-connect-comate/__seal'

/**
 * Prefix of a sealed (encrypted) `wps_sid` value.
 *
 * Declared here, not in `./secret.ts`, because **both halves** must agree on it:
 * the host writes and reads it, and the card has to tell "already sealed" from
 * "still plaintext" without importing `node:crypto`. `./secret.ts` imports this
 * constant, so the spelling exists once.
 */
export const COMATE_SEALED_PREFIX = 'enc:v1:'

/**
 * Shortest possible base64url body of a sealed value: 12-byte IV + 16-byte GCM
 * tag + at least 1 byte of ciphertext.
 *
 * Only used to reject obviously-junk strings early (a hand-edited `enc:v1:` with
 * nothing behind it). The authoritative structural check is in `./secret.ts`,
 * which actually parses the payload.
 */
const COMATE_SEALED_MIN_CHARS = 39

/**
 * Whether a stored value carries this plugin's sealed envelope.
 *
 * Anything without the prefix is a LEGACY PLAINTEXT value: every version before
 * 0.4 wrote one, so the host must keep reading it and the card must offer to
 * upgrade it. This predicate is deliberately about the envelope only — whether a
 * sealed value can actually be opened depends on the key file, which only the
 * host can touch.
 */
export function isSealedComateSecret(value: string): boolean {
  if (!value.startsWith(COMATE_SEALED_PREFIX)) return false
  const body = value.slice(COMATE_SEALED_PREFIX.length)
  return body.length >= COMATE_SEALED_MIN_CHARS && /^[A-Za-z0-9_-]+$/.test(body)
}

/** The seal route's answer. Never carries the plaintext back. */
export interface ComateSealAnswer {
  /** The value to store in the settings field. */
  sealed: string
  /**
   * Length of the plaintext that was sealed.
   *
   * Exists so the card can keep telling the user "N characters saved" — the
   * length is the only property of the credential the UI ever showed, and after
   * sealing it can no longer be read off the stored string.
   */
  length: number
}

/** Card-facing model directory entry. */
export interface ComatePersistedModel {
  id: string
  name: string
  /** Whether the model accepts image input (Comate `llm-multimodal`). */
  multimodal: boolean
  contextWindow: number
}

/**
 * Default output-token cap for every model on this route.
 *
 * The Comate config exposes no max-output field for any of its models (verified:
 * `~/.wpscomate/config.json` and the desktop client's `agent/models.json` carry
 * only `context_window` / `id` / `llm_types` / `model_source` / `model_tier` /
 * `name`), so this is this plugin's own default rather than a mirror of anything
 * upstream.
 *
 * Declared here, not in `auth.ts`, because **both halves** need the number: the
 * host resolves the effective cap from it (`max-tokens.ts`), and the card seeds
 * its input field with it. `auth.ts` imports `node:crypto`, so a browser-half
 * import from there would drag that into the client bundle — and this module is
 * the node-free vocabulary the two halves already share.
 */
export const COMATE_DEFAULT_MAX_TOKENS = 32_000

/**
 * Thinking levels this route offers WITHOUT asking, in pi-ai's own escalation
 * order: the four the model picker has always listed.
 *
 * Declared here, not in `./thinking-levels.ts`, because **both halves** name
 * them: the host builds `thinkingLevelMap` from them, and the card interpolates
 * the list into the copy that explains what the extra levels add on top.
 */
export const COMATE_BASE_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const

/**
 * Thinking levels that are offered only when the user turns them on, in the
 * order the card shows them.
 *
 * They are off by default because each one is a claim this plugin cannot make
 * on its own: `off` changes what an UNNAMED effort means (see
 * {@link COMATE_THINKING_LEVEL_WIRE}), and `xhigh` / `max` are accepted by the
 * gateway but were measured to behave no differently from `high`.
 *
 * The order below is the CARD's, not the model picker's: the picker lists what
 * pi-ai's own `EXTENDED_THINKING_LEVELS` says, which puts `off` first.
 */
export const COMATE_EXTRA_THINKING_LEVELS = ['off', 'xhigh', 'max'] as const

/** One manually enabled thinking level. */
export type ComateExtraThinkingLevel = (typeof COMATE_EXTRA_THINKING_LEVELS)[number]

/**
 * The `reasoning_effort` value each manually enabled level sends.
 *
 * Measured on the live gateway (2026-09-26, this machine, the 10-model catalog),
 * not guessed. Every number below is `reasoning_content` characters on one
 * arithmetic prompt, so the two ends are comparable:
 *
 * - `'off'` really does stop thinking — it drops to **0 chars** from a
 *   non-zero baseline on deepseek-v4-flash (656→0), -pro (398→0),
 *   -v4.1-flash (313→0), MiniMax-M3 (104→0), mimo-v2.5 (1609→0),
 *   mimo-v2.5-pro (132→0) and glm-5.2 (1242→0). Two models ignore it and think
 *   *more*: glm-5.3-flash (660→1357) and glm-5.3 (810→3059). kimi-k3 cannot be
 *   counted either way — its baseline is already 0 on this prompt.
 *   (An earlier measurement in this file claimed all three zhipu models ignored
 *   `off`; re-measuring on 2026-09-26 showed glm-5.2 obeying it, so the caveat
 *   is scoped to the two glm-5.3 models.)
 * - `'none'` — the value the OpenAI `reasoning_effort` vocabulary uses for
 *   "off" — is ACCEPTED (HTTP 200) and **ignored**: `reasoning_content` stays
 *   at its baseline length on all ten models (201–1665 chars, none at 0). So
 *   `none` is NOT the off switch here, and spelling the level with it would be
 *   a lie the picker told.
 * - `'xhigh'` / `'max'` are accepted (HTTP 200) and still reason, but two
 *   samples per level could not tell them apart from `high`. The spread WITHIN
 *   one level dwarfs any between-level difference: deepseek-v4-flash `high`
 *   came back 412 and 365 while `xhigh` gave 332/377 and `max` 230/335; on
 *   -pro, `high` gave 536/722 against `xhigh` 628/402 and `max` 522/392. They
 *   are therefore offered as aliases the user opts into, never as a measured
 *   escalation.
 * - `reasoning_effort: false` is a 400 (`invalid request body`), so a level must
 *   carry a string.
 *
 * ## Why offering `off` also changes what "no effort" means
 *
 * pi-ai consults `thinkingLevelMap.off` in exactly one place when nothing names
 * an effort (`openai-completions.js`: `else if (!options?.reasoningEffort &&
 * model.reasoning && compat.supportsReasoningEffort)`), and that same entry is
 * what makes the level appear in the picker at all. There is no way to offer
 * `off` without also making the picker's "provider default" send it — so the
 * card says so out loud instead of hiding it.
 */
export const COMATE_THINKING_LEVEL_WIRE: Readonly<Record<ComateExtraThinkingLevel, string>> = {
  off: 'off',
  xhigh: 'xhigh',
  max: 'max',
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
  /** Output-token cap: positive integer, or 0 for "no cap". */
  maxOutputTokens?: number
  /**
   * Per-model overrides of {@link ComateSettingsValue.maxOutputTokens}.
   *
   * Keyed by model id; value 0 means "no cap for this model". A model with no
   * entry follows the global field, which is why an override can be removed by
   * dropping the key rather than by writing the global value back into it.
   */
  maxOutputTokensByModel?: Record<string, number>
  /**
   * Display-name overrides, keyed by model id.
   *
   * Purely cosmetic: the alias replaces the name DSH shows in its model picker
   * and nowhere else. The model's id — what a request and the settings document
   * address it by — never changes, so renaming a model can never break a saved
   * `maxOutputTokensByModel` entry or a `default-model` choice.
   */
  modelAliases?: Record<string, string>
  /**
   * Manually enabled extra thinking levels, a subset of
   * {@link COMATE_EXTRA_THINKING_LEVELS}.
   *
   * Absent/empty is the default and offers exactly
   * {@link COMATE_BASE_THINKING_LEVELS}; a non-empty list adds those levels to
   * the picker. Only the levels listed are added — the field is not a
   * replacement for the base four.
   */
  extraThinkingLevels?: string[]
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

/**
 * How the stored `wps_sid` is protected.
 *
 * `unreadable` is the one state the BROWSER cannot work out for itself: a sealed
 * envelope looks identical whether or not this machine's key file can open it,
 * so the card needs the host to tell it. Every other state is derivable from the
 * stored string's shape alone.
 */
export type ComateSidStorage = 'unset' | 'plaintext' | 'sealed' | 'unreadable'

/** The status route's answer. Deliberately contains no credential of any kind. */
export interface ComateCatalogAnswer {
  signedIn: boolean
  providerRegistered: boolean
  models: readonly ComatePersistedModel[]
  /**
   * Storage state of the saved `wps_sid`, as resolved by the host.
   *
   * Absent when the host could not determine it (the route needs `webServer`,
   * and a deployment without one still serves models); the card then falls back
   * to reading the stored string's prefix.
   */
  sidStorage?: ComateSidStorage
  /** Why a sealed value could not be opened; only sent with `unreadable`. */
  sidProblem?: string
}

/** Why a probe could not run at all (as opposed to running and failing). */
export type ComateCheckReason = 'no-credential' | 'no-model'

/**
 * What one probe request observed, as three separate facts.
 *
 * v0.4.2-rc.3: the probe used to answer a single boolean derived from the HTTP
 * status alone — anything 2xx read as 「连接成功」, including an empty body and a
 * stream whose first event was an error. The three facts below are what the
 * gateway actually has to say, in the order it says them:
 *
 *   1. {@link accepted}  — it took the credential (HTTP 200, and no event in the
 *      stream said the session was dead).
 *   2. {@link completed} — the stream reached a clean end without an in-stream
 *      error, so a full round trip happened.
 *   3. {@link content}   — at least one non-empty assistant text delta arrived.
 *
 * {@link ok} is 1 ∧ 2. Fact 3 is reported but never required: the probe caps
 * output at a handful of tokens, and a thinking model can legitimately spend
 * them all on reasoning and emit no text at all — calling that a broken
 * connection would be wrong.
 */
export interface ComateCheckOutcome {
  /** `accepted && completed`: the probe finished a clean round trip. */
  ok: boolean
  /**
   * The gateway took the credential: HTTP 200 came back, at least one SSE event
   * arrived, and none of them was an authentication failure.
   *
   * `false` is not the same as 「凭据是坏的」: an empty 200 proves nothing either
   * way, and that is the point of separating this from `ok`.
   */
  accepted?: boolean
  /** The stream ended on its own terms (`[DONE]`, `finish_reason`, or EOF). */
  completed?: boolean
  /** A non-empty assistant text delta arrived. */
  content?: boolean
  /**
   * Reasoning-only output was seen. Diagnostic: it explains a successful probe
   * that carried no `content`, and is never part of `ok`.
   */
  reasoning?: boolean
  /**
   * Why the probe never reached the network. Set by the host when it could not
   * assemble a credential or pick a model; absent whenever the request ran, even
   * if the upstream then refused it.
   */
  reason?: ComateCheckReason
  /** The model the probe used. */
  model?: string
  /** HTTP status: the refusal's, or 200 for a failure found inside the stream. */
  status?: number
  /** Classified failure kind: the refusal's, or the in-stream error's. */
  kind?: UpstreamErrorKind
  /**
   * Redacted, length-capped detail: the upstream excerpt or transport error on
   * failure, and why the read stopped short on a probe that did not complete.
   */
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
