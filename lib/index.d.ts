import z from "@deepseek-ai/schemastery";
import "@earendil-works/pi-ai";
import { PiAiAdapter, PiAiAdapterOptions } from "@deepseek-ai/dsh-llm-pi-ai";
import { Context } from "@deepseek-ai/cordis";
//#region src/bridge.d.ts
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
declare const COMATE_CLIENT_NAME = "dsh-connect-comate-client";
/**
 * The profile plugin entry id, which on DSH 0.1.7 **is** the settings namespace.
 *
 * 0.1.5 registered its own namespace string (`comate`); 0.1.7 replaced that with
 * the Loader entry: `SettingsForms.write` resolves a namespace by
 * `configEditor.entries().find(row => row.options.id === ns)`.
 */
declare const COMATE_ENTRY_ID = "dsh-connect-comate";
/**
 * The settings namespace the plugin registers on the 0.1.5 line, where a plugin
 * owns the namespace string instead of inheriting its entry id. Kept for the
 * capability-probed fallback and for `bin` diagnostics.
 */
declare const COMATE_SETTINGS_NS = "comate";
/**
 * Read-only host route the card reads the discovered model directory from.
 *
 * The host deliberately does NOT write the directory back into settings: on
 * 0.1.7 a settings write targets the user's hand-written `cordis.patch.yml`, and
 * rewriting that file whenever discovery changes would destroy its comments and
 * formatting. A loopback-only GET route keeps the channel read-only.
 */
declare const COMATE_CATALOG_PATH = "/plugins/dsh-connect-comate/__catalog";
/**
 * Action route: re-read the local Comate config and republish the directory.
 *
 * The host discovers models at startup and when `configFile` changes; a model
 * the user just added (or signed into) in the desktop client would otherwise
 * need a DSH restart. A POST because it performs work, even though it writes
 * nothing anywhere.
 */
declare const COMATE_REFRESH_PATH = "/plugins/dsh-connect-comate/__refresh";
/**
 * Action route: send one minimal chat request to verify the credential.
 *
 * Optionally carries an UNSAVED draft `wpsSid` / `cookieOnly` so the card can be
 * tested before saving. The draft lives only in that one request: nothing
 * persists it and the answer never echoes it back.
 */
declare const COMATE_CHECK_PATH = "/plugins/dsh-connect-comate/__check";
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
declare const COMATE_SEAL_PATH = "/plugins/dsh-connect-comate/__seal";
/**
 * Prefix of a sealed (encrypted) `wps_sid` value.
 *
 * Declared here, not in `./secret.ts`, because **both halves** must agree on it:
 * the host writes and reads it, and the card has to tell "already sealed" from
 * "still plaintext" without importing `node:crypto`. `./secret.ts` imports this
 * constant, so the spelling exists once.
 */
declare const COMATE_SEALED_PREFIX = "enc:v1:";
/**
 * Whether a stored value carries this plugin's sealed envelope.
 *
 * Anything without the prefix is a LEGACY PLAINTEXT value: every version before
 * 0.4 wrote one, so the host must keep reading it and the card must offer to
 * upgrade it. This predicate is deliberately about the envelope only — whether a
 * sealed value can actually be opened depends on the key file, which only the
 * host can touch.
 */
declare function isSealedComateSecret(value: string): boolean;
/** The seal route's answer. Never carries the plaintext back. */
interface ComateSealAnswer {
  /** The value to store in the settings field. */
  sealed: string;
  /**
   * Length of the plaintext that was sealed.
   *
   * Exists so the card can keep telling the user "N characters saved" — the
   * length is the only property of the credential the UI ever showed, and after
   * sealing it can no longer be read off the stored string.
   */
  length: number;
}
/** Card-facing model directory entry. */
interface ComatePersistedModel {
  id: string;
  name: string;
  /** Whether the model accepts image input (Comate `llm-multimodal`). */
  multimodal: boolean;
  contextWindow: number;
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
declare const COMATE_DEFAULT_MAX_TOKENS = 32000;
/**
 * Thinking levels this route offers WITHOUT asking, in pi-ai's own escalation
 * order: the four the model picker has always listed.
 *
 * Declared here, not in `./thinking-levels.ts`, because **both halves** name
 * them: the host builds `thinkingLevelMap` from them, and the card interpolates
 * the list into the copy that explains what the extra levels add on top.
 */
declare const COMATE_BASE_THINKING_LEVELS: readonly ["minimal", "low", "medium", "high"];
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
declare const COMATE_EXTRA_THINKING_LEVELS: readonly ["off", "xhigh", "max"];
/** One manually enabled thinking level. */
type ComateExtraThinkingLevel = (typeof COMATE_EXTRA_THINKING_LEVELS)[number];
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
declare const COMATE_THINKING_LEVEL_WIRE: Readonly<Record<ComateExtraThinkingLevel, string>>;
/**
 * The settings section the card edits, as the browser mirror delivers it.
 * Every field except `configFile` is declared volatile on the host schema, so on
 * 0.1.7 each one may arrive wrapped in a live reference — read it through
 * {@link unwrapVolatile}, never directly.
 *
 * The host's deprecated `lastCatalog` field is not part of this view: the model
 * directory has one source, {@link COMATE_CATALOG_PATH}.
 */
interface ComateSettingsValue {
  configFile?: string;
  wpsSid?: string;
  cookieOnly?: boolean;
  enabledModelIds?: string[];
  /** Output-token cap: positive integer, or 0 for "no cap". */
  maxOutputTokens?: number;
  /**
   * Per-model overrides of {@link ComateSettingsValue.maxOutputTokens}.
   *
   * Keyed by model id; value 0 means "no cap for this model". A model with no
   * entry follows the global field, which is why an override can be removed by
   * dropping the key rather than by writing the global value back into it.
   */
  maxOutputTokensByModel?: Record<string, number>;
  /**
   * Display-name overrides, keyed by model id.
   *
   * Purely cosmetic: the alias replaces the name DSH shows in its model picker
   * and nowhere else. The model's id — what a request and the settings document
   * address it by — never changes, so renaming a model can never break a saved
   * `maxOutputTokensByModel` entry or a `default-model` choice.
   */
  modelAliases?: Record<string, string>;
  /**
   * Manually enabled extra thinking levels, a subset of
   * {@link COMATE_EXTRA_THINKING_LEVELS}.
   *
   * Absent/empty is the default and offers exactly
   * {@link COMATE_BASE_THINKING_LEVELS}; a non-empty list adds those levels to
   * the picker. Only the levels listed are added — the field is not a
   * replacement for the base four.
   */
  extraThinkingLevels?: string[];
}
/**
 * Upstream failure classes the shim maps onto distinct HTTP answers.
 *
 * Declared here rather than in `./upstream.ts` so this module stays dependency
 * free — the browser half renders these names, and a type it imports must not
 * drag a `node:crypto` import into the client bundle. `./upstream.ts`
 * re-exports it, so the host-side name is unchanged.
 */
type UpstreamErrorKind = 'hard_credit' | 'soft_rate' | 'session_dead' | 'not_found' | 'server' | 'client';
/**
 * How the stored `wps_sid` is protected.
 *
 * `unreadable` is the one state the BROWSER cannot work out for itself: a sealed
 * envelope looks identical whether or not this machine's key file can open it,
 * so the card needs the host to tell it. Every other state is derivable from the
 * stored string's shape alone.
 */
type ComateSidStorage$1 = 'unset' | 'plaintext' | 'sealed' | 'unreadable';
/** The status route's answer. Deliberately contains no credential of any kind. */
interface ComateCatalogAnswer {
  signedIn: boolean;
  providerRegistered: boolean;
  models: readonly ComatePersistedModel[];
  /**
   * Storage state of the saved `wps_sid`, as resolved by the host.
   *
   * Absent when the host could not determine it (the route needs `webServer`,
   * and a deployment without one still serves models); the card then falls back
   * to reading the stored string's prefix.
   */
  sidStorage?: ComateSidStorage$1;
  /** Why a sealed value could not be opened; only sent with `unreadable`. */
  sidProblem?: string;
}
/** Why a probe could not run at all (as opposed to running and failing). */
type ComateCheckReason = 'no-credential' | 'no-model';
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
interface ComateCheckOutcome {
  /** `accepted && completed`: the probe finished a clean round trip. */
  ok: boolean;
  /**
   * The gateway took the credential: HTTP 200 came back, at least one SSE event
   * arrived, and none of them was an authentication failure.
   *
   * `false` is not the same as 「凭据是坏的」: an empty 200 proves nothing either
   * way, and that is the point of separating this from `ok`.
   */
  accepted?: boolean;
  /** The stream ended on its own terms (`[DONE]`, `finish_reason`, or EOF). */
  completed?: boolean;
  /** A non-empty assistant text delta arrived. */
  content?: boolean;
  /**
   * Reasoning-only output was seen. Diagnostic: it explains a successful probe
   * that carried no `content`, and is never part of `ok`.
   */
  reasoning?: boolean;
  /**
   * Why the probe never reached the network. Set by the host when it could not
   * assemble a credential or pick a model; absent whenever the request ran, even
   * if the upstream then refused it.
   */
  reason?: ComateCheckReason;
  /** The model the probe used. */
  model?: string;
  /** HTTP status: the refusal's, or 200 for a failure found inside the stream. */
  status?: number;
  /** Classified failure kind: the refusal's, or the in-stream error's. */
  kind?: UpstreamErrorKind;
  /**
   * Redacted, length-capped detail: the upstream excerpt or transport error on
   * failure, and why the read stopped short on a probe that did not complete.
   */
  message?: string;
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
declare function asVolatile<S>(schema: S): S;
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
declare function unwrapVolatile<T>(value: T): T;
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
declare function unwrapVolatileDeep<T>(value: T): T;
//#endregion
//#region src/secret.d.ts
/**
 * At-rest protection for the manually pasted `wps_sid`.
 *
 * 背景：v0.4 之前，卡片里填的 `wps_sid` 以**明文**写进 DSH 的设置文档
 * （0.1.7 上就是用户手写的 `cordis.patch.yml`）。那是一个真实的长效凭据，而设置
 * 文件会被分享、同步、备份、截图、误提交进 git——明文躺在里面就等于凭据在漂。
 *
 * 本模块把它变成密文：AES-256-GCM，密钥由**本机密钥文件**（随机 32 字节）与
 * **机器指纹**经 HKDF-SHA256 派生。
 *
 * ## 威胁模型（说清楚，免得当成它做不到的事）
 *
 * 防的是：设置文件单独外流。共享 profile、提交 `cordis.patch.yml`、同步盘、
 * 备份、截图、贴日志——拿到这些的人只看到 `enc:v1:<base64url>`。
 *
 * 不防的是：攻击者已经能读这台机器上当前用户的任意文件。密钥文件就在
 * `~/.wpscomate/dsh-connect-comate/secret.key`，同机同用户可读；这不是
 * 「用户设主密码」那种强度，也刻意不做成那种强度——那会要求每次启动解锁，
 * 破坏无头运行与自启动。
 *
 * 机器指纹进 KDF 是为了堵住「设置文件 + 密钥文件一起被拷走」这条路径：换机、
 * 换用户名、换平台/架构，派生出的密钥就不同，密文解不开（此时插件会明确报告
 * 「已保存但无法解密」，让用户重新粘贴，而不是静默 401）。
 *
 * ## 格式
 *
 * 密钥文件（JSON，0600）：
 *   `{ "v": 1, "alg": "aes-256-gcm+hkdf-sha256", "salt": "<base64url 32B>", "createdAt": "…" }`
 *
 * 密文（一个 YAML/JSON 里都安全的字符串）：
 *   `enc:v1:` + base64url( iv[12] || tag[16] || ciphertext )
 *
 * base64url 而不是标准 base64，是为了让整串**不含 `+` `/` `=`**：它会写进
 * YAML 的 plain scalar 位置，出现这些字符就要靠序列化器正确加引号，而
 * `enc:v1:…` 里的冒号后面没有空格、本身就是合法 plain scalar（真机实测
 * js-yaml dump/load 往返一致）。
 *
 * ## 为什么本模块不 import `auth.ts`
 *
 * `auth.ts` 需要它来解密（`auth → secret`），所以反过来 import 会成环。密钥
 * 文件的**默认路径**因此留给 `auth.ts`（它本来就知道 `~/.wpscomate` 在哪），
 * 这里只收显式路径：一个纯粹「路径进、密码学与文件 IO 出」的模块，也更好测。
 *
 * @module dsh-connect-comate/secret
 */
/**
 * Env var pointing the key file somewhere else.
 *
 * 存在的理由和 `WPS_COMATE_CONFIG_FILE` 一样：无头/CI 场景要能把密钥放在自己
 * 管得住的目录里。它**不是**「换一把密钥」的开关——换路径就是换密钥，已存的
 * 密文会解不开。
 */
declare const COMATE_SECRET_KEY_ENV = "WPS_COMATE_SECRET_KEY_FILE";
/** Sub-directory of the Comate home that holds this plugin's own key file. */
declare const COMATE_SECRET_DIRNAME = "dsh-connect-comate";
/** File name of the key file inside {@link COMATE_SECRET_DIRNAME}. */
declare const COMATE_SECRET_KEY_FILENAME = "secret.key";
/** Why a sealed value could not be turned back into a sid. */
type ComateOpenFailure =
/** The key file does not exist (fresh machine, deleted, or another user). */
'key-missing' |
/** The key file exists but is not a document this module can use. */
'key-unreadable' |
/** The stored string is not a well-formed sealed value. */
'malformed' |
/** GCM authentication failed: wrong key (other machine/user) or altered bytes. */
'auth-failed';
/** The result of opening a stored value. */
type ComateOpenResult = {
  ok: true;
  value: string;
} | {
  ok: false;
  reason: ComateOpenFailure;
};
/** One key file and the fingerprint the derived key is bound to. */
interface ComateSecretOptions {
  /** Path of the key file. Created on seal, only read on open. */
  keyFile: string;
  /**
   * Machine binding mixed into the KDF. Defaults to
   * {@link machineFingerprint}; tests pass a literal so they do not depend on
   * the machine they run on.
   */
  fingerprint?: string;
}
/**
 * A stable, non-secret description of this machine and user.
 *
 * Every component is case-folded: Windows treats host names and user names
 * case-insensitively, so a differently-cased read of the same machine must not
 * derive a different key.
 *
 * `homedir()` is deliberately NOT part of it — it usually embeds the user name
 * already, and a home directory that moves (a remapped drive, a renamed profile
 * folder) would then silently invalidate every stored secret.
 *
 * @returns the fingerprint string used as HKDF salt.
 */
declare function machineFingerprint(): string;
/** Whether a value is already sealed (never re-seals, never double-wraps). */
declare function isSealed(value: string): boolean;
/**
 * Encrypt one plaintext secret into its storable form.
 *
 * @param plaintext - the sid, already trimmed by the caller.
 * @param options - key file path and optional fingerprint override.
 * @returns `enc:v1:<base64url>`, safe to put in a settings document.
 * @throws {Error} when the key file cannot be created or read. Callers must not
 * fall back to writing the plaintext: the whole point is that it never lands.
 */
declare function sealSecret(plaintext: string, options: ComateSecretOptions): Promise<string>;
/**
 * Decrypt a stored value.
 *
 * Never throws: "the stored sid cannot be opened" is a state the caller renders
 * (the card explains it, `doctor` reports it), not an exception to guess at.
 *
 * @param sealed - the stored string, expected to carry the sealed prefix.
 * @param options - key file path and optional fingerprint override.
 * @returns the plaintext, or the reason it is unavailable.
 */
declare function openSecret(sealed: string, options: ComateSecretOptions): Promise<ComateOpenResult>;
//#endregion
//#region src/auth.d.ts
/** Env var overriding the exact Comate config file path. */
declare const COMATE_CONFIG_ENV = "WPS_COMATE_CONFIG_FILE";
/** Env var overriding the Comate home directory (default `~/.wpscomate`). */
declare const COMATE_HOME_ENV = "WPS_COMATE_HOME";
/**
 * Env var providing the WPS login cookie (wps_sid) for manual auth mode.
 *
 * A **sealed** value is accepted here too: the read path is shared with the
 * settings field, so `WPS_COMATE_SID=enc:v1:…` works and is the only way a
 * headless run can use an encrypted credential.
 */
declare const COMATE_SID_ENV = "WPS_COMATE_SID";
/** Default context window when the config omits it (all observed models use 1M). */
declare const COMATE_DEFAULT_CONTEXT_WINDOW = 1000000;
/** One model entry from the Comate config. */
interface ComateModel {
  id: string;
  name: string;
  contextWindow: number;
  /**
   * Normalized `llm_types`, e.g. `['llm-chat', 'llm-multimodal']`. Always an
   * array: the desktop config ships one, and the string spelling is accepted
   * only as a legacy/alternate shape (see {@link parseLlmTypes}).
   */
  llmTypes?: string[];
  modelSource?: string;
  modelTier?: string;
}
/** Normalized Comate credential, read from the desktop client's own config. */
interface ComateCredential {
  baseUrl: string;
  apiKey: string;
  cookie?: string;
  /** Whether the apiKey goes in an `Authorization` header (Comate sets true). */
  authHeader: boolean;
  models: readonly ComateModel[];
  /** Which file this credential was read from. */
  configFile: string;
}
/** Read-only sign-in summary for status output. */
interface ComateAuthStatus {
  state: 'signed-in' | 'signed-out';
  baseUrl?: string;
  modelCount?: number;
}
/** One config candidate's diagnostic entry. */
interface ComateCandidateDiagnostics {
  path: string;
  present: boolean;
  valid: boolean;
  baseUrl?: string;
  modelCount?: number;
  error?: string;
}
/** Secret-free doctor report. */
interface ComateDoctorReport {
  schemaVersion: number;
  package: string;
  version: string;
  node: string;
  candidates: ComateCandidateDiagnostics[];
  userAuthPresent: boolean;
  signIn: ComateAuthStatus['state'];
  /** Whether a manual wps_sid (config or env) will be used. */
  wpsSid: 'set' | 'unset';
  /** How that sid is protected at rest; `unset` when there is none. */
  wpsSidStorage: ComateSidStorage;
  /** Why a sealed sid could not be opened; `undefined` unless `wpsSidStorage` is `unreadable`. */
  wpsSidProblem?: ComateOpenFailure | undefined;
  /** Key file the sealed value is bound to. A path, never the key. */
  wpsSidKeyFile: string;
  hints: string[];
}
/**
 * How the stored `wps_sid` is protected at rest.
 *
 * Four states, not a boolean: `plaintext` is the upgrade path (a value written by
 * an older version is still readable and should be re-saved), while `unreadable`
 * is the failure the user must be told about explicitly — both are "a sid is
 * configured", and collapsing them into `set` is how a broken key file turns into
 * an unexplained 401.
 */
type ComateSidStorage =
/** Nothing stored. */
'unset' |
/** Stored as typed (a value written before 0.4, or from the env var). */
'plaintext' |
/** Sealed and decryptable. */
'sealed' |
/** Sealed, but this machine/user cannot open it (key file gone, replaced, or foreign). */
'unreadable';
/** One read's view of the stored sid, plaintext included. Never logged or returned raw. */
interface ComateSidResolution {
  /** Usable plaintext sid; absent when nothing usable is stored. */
  sid?: string;
  storage: ComateSidStorage;
  /** Set exactly when `storage` is `unreadable`. */
  problem?: ComateOpenFailure;
  /** The key file in force for this read. */
  keyFile: string;
}
/** The Comate home directory (env override or `~/.wpscomate`). */
declare function defaultComateHome(env?: NodeJS.ProcessEnv, home?: string): string;
/** Platform-default config candidates, in probe order. */
declare function defaultConfigCandidates(env?: NodeJS.ProcessEnv, home?: string): string[];
/**
 * Where the key that protects the stored `wps_sid` lives by default.
 *
 * Under the Comate home, NOT under the DSH profile: the whole point of sealing
 * the sid is that the profile's settings document can leave this machine (be
 * shared, synced, backed up, committed) without the credential going with it, so
 * the key must not sit in the same directory tree as the ciphertext.
 *
 * It is a plain file, deliberately: OS keychain access would mean a native
 * dependency or a platform-specific API call, and a master password would mean
 * the user unlocking something before every headless run.
 *
 * @param env - environment to read {@link COMATE_SECRET_KEY_ENV} from.
 * @param home - home directory to resolve the Comate home against.
 * @returns the absolute key-file path.
 */
declare function defaultSecretKeyFile(env?: NodeJS.ProcessEnv, home?: string): string;
/** Parse one config model entry; entries without an id are dropped. */
declare function parseComateModel(value: unknown): ComateModel | undefined;
/**
 * Parse a Comate config document. Returns undefined when the document carries
 * no usable `providers.official` (missing file content, wrong shape, empty
 * baseUrl or apiKey).
 */
declare function parseComateConfig(text: string, filePath: string): ComateCredential | undefined;
/**
 * One-shot credential inputs for a single read.
 *
 * Used by the card's 「测试连接」 so an unsaved draft sid can be probed before it
 * is committed. Nothing here is ever stored: the fields live on the call, not on
 * the store, so a test cannot change what the plugin actually uses.
 */
interface ComateCredentialOverride {
  /** Manual sid to use for this read; absent or blank keeps the saved value. */
  wpsSid?: string;
  /** Cookie-only auth for this read; absent keeps the saved value. */
  cookieOnly?: boolean;
}
/** Constructor options; all fields optional. */
interface ComateStoreOptions {
  /** Explicit Comate config-file path, overriding env and platform defaults. */
  configFile?: string;
  /**
   * Manual WPS login cookie value (`wps_sid` from www.wps.cn). The desktop
   * config only stores placeholders (the real cookie is delivered per task
   * by the Comate UI), so the sid can be pasted here as `wps_sid=<v>`.
   *
   * Either spelling is accepted: a sealed value (`enc:v1:…`, what the card now
   * stores) or plaintext (what older versions stored).
   */
  wpsSid?: string;
  /**
   * When true, drop the Authorization bearer (config apiKey is a placeholder
   * too) and authenticate with the Cookie alone.
   */
  cookieOnly?: boolean;
  /** Explicit key-file path, overriding env and the Comate-home default. */
  secretKeyFile?: string;
}
/**
 * Read-only credential store. Resolves the first candidate that yields a
 * valid credential; never writes the desktop client's files.
 */
declare class ComateCredentialStore {
  private configFileOverride;
  private wpsSidOverride;
  private cookieOnlyOverride;
  private secretKeyFileOverride;
  constructor(options?: ComateStoreOptions);
  /** Repoint the config file; applies on the next read. */
  setConfigFile(path: string | undefined): void;
  /**
   * Set the manual wps_sid; applies on the next read.
   *
   * The value is whatever the settings document holds — sealed (`enc:v1:…`) or
   * legacy plaintext — and is deliberately NOT decrypted here: this setter runs
   * inside the synchronous settings-change handler, and keeping the raw string
   * means the plaintext only exists for the one read that actually needs it.
   */
  setWpsSid(sid: string | undefined): void;
  /** Toggle cookie-only auth; applies on the next read. */
  setCookieOnly(value: boolean): void;
  /** Repoint the key file that protects a sealed sid; applies on the next read. */
  setSecretKeyFile(path: string | undefined): void;
  /** The key file in force: explicit override, env, then the Comate-home default. */
  keyFile(env?: NodeJS.ProcessEnv): string;
  /** The raw stored value (settings override or env), still sealed if sealed. */
  private rawSid;
  /**
   * The raw value that came from the SETTINGS document, env ignored.
   *
   * The plaintext-upgrade path must act on what is actually stored: sealing the
   * `WPS_COMATE_SID` env value and writing that back would put a credential the
   * user only ever meant for one shell session into a persisted file.
   */
  private storedRawSid;
  /**
   * Resolve the stored sid for one read, decrypting a sealed value.
   *
   * @param env - environment to read {@link COMATE_SID_ENV} from.
   * @returns the usable sid (if any), how it was stored, and the key file used.
   */
  resolveSid(env?: NodeJS.ProcessEnv): Promise<ComateSidResolution>;
  /**
   * Seal a plaintext sid into its storable form.
   *
   * @param sid - the value as typed; trimmed, and an empty one is refused.
   * @returns the sealed string plus the plaintext length, for the card's copy.
   * @throws {Error} when the key file cannot be created or read.
   */
  seal(sid: string, env?: NodeJS.ProcessEnv): Promise<ComateSealAnswer>;
  /**
   * Seal the value already stored in the settings document.
   *
   * This is the plaintext-upgrade path: the host seals what it already holds, so
   * the plaintext never has to travel through the browser to be re-saved.
   *
   * @throws {Error} when nothing is stored, the stored value is already sealed,
   * or the key file cannot be used.
   */
  sealStored(env?: NodeJS.ProcessEnv): Promise<ComateSealAnswer>;
  /** The config-file candidates, in probe order. */
  private candidates;
  /** Read one candidate; a parse failure is reported, never thrown. */
  readCandidate(path: string): Promise<{
    credential?: ComateCredential;
    error?: string;
  }>;
  /**
   * First candidate that yields a valid credential.
   *
   * @param override - one-shot credential inputs, applied to THIS call only and
   * never stored. It exists so the card's 「测试连接」 can probe an unsaved draft
   * sid before the user commits to saving it; writing the draft into the
   * instance fields instead would let two concurrent requests contaminate each
   * other, and would make a mere test silently change what the plugin uses.
   * An absent or blank field falls back to the saved value.
   * @returns the credential, or undefined when no candidate resolves.
   */
  current(override?: ComateCredentialOverride): Promise<ComateCredential | undefined>;
  /** The credential to send upstream; throws when none is signed in. */
  resolve(): Promise<ComateCredential>;
  /** Read-only sign-in summary; never throws. */
  status(): Promise<ComateAuthStatus>;
  /** Secret-free diagnostics for the doctor CLI. */
  doctor(version: string, env?: NodeJS.ProcessEnv, home?: string): Promise<ComateDoctorReport>;
  private userAuthPresent;
  /**
   * The plugin keeps no credential copy of its own, so there is nothing to
   * remove; the Comate desktop files are never touched.
   *
   * The key file is deliberately left alone as well: deleting it would not
   * "log out", it would only make every already-stored ciphertext permanently
   * unopenable (and the next seal would mint a different key behind the user's
   * back). Removing the sid means clearing the settings field, which the card's
   * 「清除已存的 sid」 does.
   */
  logout(): Promise<void>;
}
//#endregion
//#region src/catalog.d.ts
/**
 * Derive the runtime catalog from the discovered directory plus the user's
 * explicit enabled-id selection (参考 dsh-connect-workbuddy 的 deriveCatalog，
 * MIT)：空选择回退为整个目录，保证从未配置过的插件仍然暴露全部模型；一旦
 * 用户保存过显式勾选，运行时只暴露勾选项，未勾选的不进入模型列表。
 */
declare function selectComateModels(models: readonly ComateModel[], enabled: ReadonlySet<string>): ComateModel[];
/** Mutable catalog shared by the shim's `/v1/models` and the adapter. */
declare class ComateCatalog {
  private models;
  /** Current entries; empty until the config has been read once. */
  current(): readonly ComateModel[];
  /** Replace the list; callers invalidate their adapter snapshot after this. */
  set(models: readonly ComateModel[]): void;
}
//#endregion
//#region src/assets.d.ts
/** 覆盖资产接口地址（私有化部署/排障用）。 */
declare const COMATE_ASSET_BASE_ENV = "WPS_COMATE_ASSET_BASE";
/** 上传一张图片并换回可抓取 URL 的能力。 */
interface ComateAssetUploader {
  /**
   * @param dataUrl - `data:image/<type>;base64,<payload>`。
   * @param credential - 当前凭据；只有带 cookie 时才能上传。
   * @returns 模型后端可抓取的 URL；无法上传时 undefined（调用方保留 base64）。
   */
  upload(dataUrl: string, credential: ComateCredential): Promise<string | undefined>;
}
/** 解析资产接口地址：env 覆盖优先，否则取网关同源。 */
declare function resolveAssetBase(baseUrl: string, env?: NodeJS.ProcessEnv): string | undefined;
/** 解出 `data:image/<type>;base64,<payload>` 的字节；不是真 base64 图片时 undefined。 */
declare function decodeImageDataUrl(dataUrl: string): {
  mime: string;
  bytes: Buffer;
} | undefined;
/** 从预签名 URL 的查询串读有效期（ks3 用 `X-Amz-Expires` 秒数，部分实现用 `Expires` 时间戳）。 */
declare function downloadUrlExpiry(url: string, now?: number): number;
/**
 * 桌面端同款 presign 上传器。
 *
 * 按内容 sha256 缓存 `relative_key`：同一张图（多轮对话里每轮都会重发）只上传
 * 一次；下载 URL 按有效期复用，过期才重新预签名。**刻意不接调用方的
 * AbortSignal**：上传结果会被后续请求复用，让一个断开的请求取消共享上传会让
 * 另一个正在等同一张图的请求一起失败。每次上传有自己的超时上限。
 */
declare class ComatePresignUploader implements ComateAssetUploader {
  private readonly cache;
  private readonly env;
  private readonly fetchImpl;
  constructor(options?: {
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
  });
  upload(dataUrl: string, credential: ComateCredential): Promise<string | undefined>;
  /** 三步走：presign-upload → PUT → presign-download。 */
  private uploadOnce;
  /** 复用未过期的下载 URL，过期则只重新预签名（不重传字节）。 */
  private freshUrl;
  /** Step1：要一个预签名 PUT URL。 */
  private presignUpload;
  /** Step2：把字节直传对象存储。 */
  private putBytes;
  /** Step3：把 relative_key 换成临时下载 URL。 */
  private presignDownload;
  /** POST JSON + `Cookie`；成功且 `code === 0` 才返回解析后的响应体。 */
  private postJson;
}
//#endregion
//#region src/multimodal.d.ts
/** What one pass over the body found and changed. */
interface ImageSanitizeStats {
  /** Image content parts seen. */
  seen: number;
  /** Parts emitted in a different shape than they arrived (string→object, `input_image`→`image_url`). */
  repaired: number;
  /** Fake `data:image/*;base64,<url>` prefixes stripped back to the URL. */
  stripped: number;
  /** Parts replaced by a text notice (unsupported type, empty or unusable source). */
  dropped: number;
}
/** A zeroed stats record. */
declare function emptyImageStats(): ImageSanitizeStats;
/** The verdict on one image source string. */
interface ImageSourceVerdict {
  /** The source to send, when usable. */
  url?: string;
  /** Why it was rejected, when not. */
  reason?: string;
  /** Whether a fake base64 prefix was removed to get here. */
  stripped?: boolean;
}
/**
 * Decide what (if anything) to send for one image source.
 *
 * Pure: no logging, no mutation, so the table in the module doc is directly
 * assertable in tests.
 */
declare function sanitizeImageSource(source: string): ImageSourceVerdict;
/**
 * Rewrite every image content part of a chat body into the shape the Comate
 * gateway actually honours. Mutates `body` in place; stats are accumulated into
 * the passed record so the caller can log what happened.
 *
 * @param body - a parsed chat-completions body.
 * @param stats - accumulator; defaults to a throwaway record.
 * @returns the same stats record.
 */
declare function normalizeChatImages(body: Record<string, unknown>, stats?: ImageSanitizeStats): ImageSanitizeStats;
/** 图片外置（上传换 URL）的统计。 */
interface ImageUploadStats {
  /** 图片被换成上传后的 URL（含命中上传器缓存）。 */
  externalized: number;
  /** 上传失败、保留 base64 原样发出的图片数。 */
  failed: number;
}
/** A zeroed upload-stats record. */
declare function emptyUploadStats(): ImageUploadStats;
/**
 * 把 body 里 inline base64 的图片换成上传后的 URL。
 *
 * 设计要点：
 * - **在 {@link normalizeChatImages} 之后跑**：那时图片只剩「对象形状 + 真 base64」
 *   一种形式，这一遍只需认 `data:image/*;base64,`，不必再处理裸字符串/假 base64。
 * - **逐张降级**：某张图上传失败只影响那一张（保留 base64），不拖累整个请求。
 * - **同一请求内按 URL 去重**：同一张图在一轮里出现多次（多轮历史）只等一次上传。
 * - **没有任何改动就返回原字符串**：无图片的请求不重新序列化，字节级不变。
 *
 * @param source - 已归一化的请求体 JSON。
 * @param uploader - 上传器；未注入时直接原样返回（功能关闭）。
 * @param credential - 当前凭据；无 cookie 时上传器会拒绝，这里照样原样返回。
 * @param stats - accumulator; filled with what was externalized and what failed.
 * @returns 改写后的 body JSON，或原字符串。
 */
declare function uploadChatImages(source: string, uploader: ComateAssetUploader | undefined, credential: ComateCredential | undefined, stats?: ImageUploadStats): Promise<string>;
//#endregion
//#region src/upstream.d.ts
/** Chat answer: either a live SSE response or a classified failure. */
type ComateChatResult = {
  ok: true;
  response: Response;
} | {
  ok: false;
  status: number;
  kind: UpstreamErrorKind;
  message: string;
};
/** Classify an upstream failure from its HTTP status and body excerpt. */
declare function classifyUpstreamError(status: number, body: string): UpstreamErrorKind;
/**
 * Normalize an OpenAI chat-completions body for the Comate upstream: force
 * `stream: true` (the Comate client streams SSE), flatten `tool_choice` (object
 * forms are a common 400 source on custom gateways), and repair the image
 * content shapes the gateway mishandles silently (see `multimodal.ts` for the
 * probe table). `developer` role is rewritten to `system` defensively; if the
 * gateway rejects `system`, remove this rewrite and re-test.
 *
 * @param source - the raw request body as received by the shim.
 * @param imageStats - optional accumulator; when passed, it is filled with what
 * the image pass saw and changed so the caller can log it. Purely diagnostic:
 * omitting it changes no behaviour.
 */
declare function prepareChatBody(source: string, imageStats?: ImageSanitizeStats): string;
/**
 * Upstream HTTP client. One instance serves the whole plugin; requests take
 * the credential explicitly so a config change applies on the next call.
 */
declare class ComateUpstreamClient {
  /** POST the chat endpoint; a successful answer is the raw SSE response. */
  chatStream(credential: ComateCredential, bodyJson: string, signal?: AbortSignal): Promise<ComateChatResult>;
}
//#endregion
//#region src/shim.d.ts
/** Minimal logger surface the plugin context already provides. */
interface ShimLogger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
/** What the plugin needs from a running shim. */
interface ComateShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>;
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string;
  /**
   * The per-process shared secret the plugin's own client must carry as
   * `Authorization: Bearer <token>`. Lives only in memory; the adapter
   * resolves this instead of the upstream apiKey, because the shim resolves
   * the real credential itself via the store.
   */
  token(): string;
  /** Stop serving and destroy open connections. */
  close(): Promise<void>;
}
/** Constructor dependencies. */
interface ComateShimOptions {
  store: ComateCredentialStore;
  client: Pick<ComateUpstreamClient, 'chatStream'>;
  catalog: ComateCatalog;
  /**
   * 把 inline base64 图片换成可抓取 URL 的上传器。不传则不外置：图片以 base64
   * 原样发出（本机 5 个多模态模型里有 4 个吃 base64，`mimo-v2.5` 不吃）。
   */
  uploader?: ComateAssetUploader;
  logger?: ShimLogger;
}
/**
 * Start the loopback endpoint. Requests must carry the shim's shared secret;
 * the loopback bind alone is not a trust boundary.
 */
declare function createComateShim(options: ComateShimOptions): ComateShim;
//#endregion
//#region src/adapter.d.ts
/** Provider route this bundle owns. */
declare const COMATE_PROVIDER = "comate";
/**
 * The durable attachment service the host's pi-ai adapter asks for.
 *
 * Derived from the adapter's own option type rather than imported from
 * `@deepseek-ai/dsh-attachment`: that package is host-bundled and outside this
 * plugin's dependency set, and the derived type is exact where the package is
 * present and `any` where it is not — never a wrong shape.
 */
type ComateAttachmentService = NonNullable<ReturnType<NonNullable<PiAiAdapterOptions['resolveAttachments']>>>;
/** Constructor dependencies. */
interface ComateAdapterOptions {
  shim: ComateShim;
  catalog: ComateCatalog;
  /**
   * The host's durable attachment service (`ctx.get('attachments')`).
   *
   * pi-ai cannot inline an image the harness never stored: its context builder
   * reads the durable bytes through this service and nothing else, so an
   * unwired accessor (or one that resolves nothing) makes the adapter reject
   * every message carrying an image with `UNSUPPORTED_CONTENT` — which is
   * exactly the failure the `image` modality we advertise must not have.
   */
  attachments?: () => ComateAttachmentService | undefined;
  /**
   * Map one stored image's host path into the current tool execution world.
   *
   * Only shapes the text handle beside the image; the bytes travel through
   * {@link ComateAdapterOptions.attachments} either way.
   */
  toProcessPath?: (hostPath: string) => string | undefined;
  /** Observe one assistant history message degrading to provider-neutral replay. */
  onReplayDegrade?: (detail: {
    provider: string;
    model: string;
    reason: string;
  }) => void;
  /**
   * Live read of the configured output cap for ONE model: a positive integer,
   * or `0` for "no cap at all".
   *
   * Per model because the cap is resolved per model (env → that model's own
   * entry → the global field → the default): the descriptor's `maxTokens` and
   * the profile's `configuredMaxTokens` entry must both be built from the same
   * answer, and two models on this route can carry different ones.
   *
   * Live rather than a snapshot because the value comes from the settings
   * section: a saved change must apply to the next request, not the next
   * restart. `invalidate()` still has to be called when it changes — the cap is
   * also baked into the profile's `configuredMaxTokens`, which is what the
   * harness turns into the request's `max_tokens`.
   *
   * Defaults to {@link COMATE_DEFAULT_MAX_TOKENS} when omitted.
   */
  maxOutputTokens?: (modelId: string) => number;
  /**
   * Live read of one model's display-name alias, or `undefined` to keep the
   * discovered name.
   *
   * Live for the same reason as {@link ComateAdapterOptions.maxOutputTokens},
   * and it needs the same `invalidate()`: the name is baked into the descriptor
   * `getModels()` returns, so a saved rename reaches the picker on the next
   * catalog read rather than the next restart.
   */
  modelAlias?: (modelId: string) => string | undefined;
  /**
   * Live read of the manually enabled extra thinking levels.
   *
   * Global rather than per model (one picker, one list), and empty means "offer
   * exactly the base four" — see {@link ComateModelTuning}. Same `invalidate()`
   * requirement: which levels exist is part of the descriptor too.
   */
  extraThinkingLevels?: () => readonly ComateExtraThinkingLevel[];
}
/** What {@link createComateAdapter} hands back. */
interface ComateAdapter {
  adapter: PiAiAdapter;
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void;
}
/**
 * pi-ai input modalities: images only when Comate advertises `llm-multimodal`.
 *
 * `llmTypes` 是数组（见 `auth.ts` 的 `parseLlmTypes`）。真机 10 个模型里 5 个带
 * `llm-multimodal`，网关也确认接受 base64 图片（`multimodal.ts` 里有实测表），
 * 所以这个函数是「DSH 允许附图片」的唯一开关。
 */
declare function comateModelInput(model: ComateModel): ('text' | 'image')[];
/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read so the shim's
 * ephemeral port applies from the first snapshot after startup.
 */
declare function createComateAdapter(options: ComateAdapterOptions): ComateAdapter;
//#endregion
//#region src/redact.d.ts
/**
 * Redact an unexpected value and cap its length, for a message that leaves the
 * host.
 *
 * Redaction runs BEFORE the cap: a cap-first order could cut a token in half and
 * leave the first half of a real secret on display.
 *
 * @param error - any thrown value or third-party excerpt.
 * @returns a single-line, redacted, length-capped message.
 */
declare function safeMessage(error: unknown): string;
//#endregion
//#region src/check.d.ts
/**
 * Output budget of the probe request. Small on purpose: the point is to learn
 * whether the credential is accepted, not to generate anything.
 */
declare const COMATE_CHECK_MAX_TOKENS = 8;
/**
 * Total wall-clock budget of one probe: the request AND the stream read.
 *
 * The probe is a handful of bytes each way and normally answers in under two
 * seconds; a thinking model spending its eight tokens can take longer. What the
 * budget is really for is the case where the upstream answers the status line
 * and then says nothing at all — without it, the test button spins forever.
 */
declare const COMATE_CHECK_TIMEOUT_MS = 15000;
/**
 * How much of the probe stream is read at most.
 *
 * Reading the stream is only safe because it is bounded: a probe needs a few
 * chunks to see whether an event, a clean end and some text arrived, and a
 * stream that is still going after 64 KiB is not going to answer a question
 * this small.
 */
declare const COMATE_CHECK_READ_LIMIT: number;
/**
 * The probe request body.
 *
 * Deliberately minimal and fixed: `stream: true` because the Comate gateway
 * always streams, one short user turn, and a tiny output budget. The CLI and
 * the card send these same bytes, so a passing card check means exactly what a
 * passing `check` command means.
 *
 * @param model - the model id to probe.
 * @returns the JSON request body.
 */
declare function comateCheckBody(model: string): string;
/** What {@link runComateCheck} needs; the credential is resolved by the caller. */
interface ComateCheckOptions {
  credential: ComateCredential;
  client: Pick<ComateUpstreamClient, 'chatStream'>;
  /** Model id to probe. */
  model: string;
  signal?: AbortSignal;
  /** Override the total budget; the tests use a small value. */
  timeoutMs?: number;
}
/**
 * Send one minimal chat request and report what happened.
 *
 * Never throws: every failure mode is an answer the caller renders, because
 * "the probe failed" is a normal outcome of pressing a test button.
 *
 * @param options - credential, client, and the model to probe.
 * @returns the observed outcome.
 */
declare function runComateCheck(options: ComateCheckOptions): Promise<ComateCheckOutcome>;
//#endregion
//#region src/web-status.d.ts
/** Host state the status route answers with. */
interface ComateCatalogDeps {
  /** Model directory discovered from the local Comate config. */
  models: () => readonly ComatePersistedModel[];
  /** Whether a locally signed-in Comate credential resolved. */
  signedIn: () => boolean;
  /**
   * Whether the `comate` provider actually landed in the harness registry.
   *
   * Registration happens after the loopback listener is up, so it is the one
   * step whose failure is otherwise invisible from outside: `apply()` has already
   * returned, the card renders, and only a log line records that no model can be
   * selected. Reporting it here is what turns that silent half-mount into
   * something the user (and `curl`) can see.
   */
  providerRegistered: () => boolean;
  /**
   * Storage state of the saved `wps_sid`.
   *
   * Exists because `unreadable` is not derivable in the browser: a sealed
   * envelope whose key file is gone looks exactly like a healthy one, so without
   * this the card would report a green 「已加密保存」 for a credential that can no
   * longer be used — and the user's first clue would be an unexplained 401.
   *
   * Optional: a deployment that composes these routes without a credential store
   * simply omits it, and the card falls back to the stored string's prefix.
   * MUST NOT reject — a probe that fails is reported as "unknown", never as a
   * broken catalog.
   */
  sidState?: () => Promise<{
    storage: ComateSidStorage$1;
    problem?: string;
  }>;
}
/** Input of one connection probe; every field is an optional draft override. */
interface ComateCheckInput {
  /** Unsaved sid to probe with; absent keeps the saved one. */
  wpsSid?: string;
  /** Unsaved cookie-only choice to probe with; absent keeps the saved one. */
  cookieOnly?: boolean;
  /** Model to probe; absent uses the card's default pick. */
  model?: string;
}
/**
 * Input of one seal request.
 *
 * Two shapes, one route. `sid` is the ordinary "I just typed a value" path;
 * `fromStored` is the plaintext-upgrade path, where the host seals the value it
 * already holds — that way the plaintext of a credential saved by an older
 * version never has to travel through the browser just to be re-saved.
 */
interface ComateSealInput {
  /** Plaintext sid to seal. Blank/absent means "not this shape". */
  sid?: string;
  /** Seal whatever the settings document already stores. */
  fromStored?: boolean;
}
/**
 * The work the action routes delegate.
 *
 * Kept as an injected port rather than imported directly so this module stays a
 * guard-and-serialize shell: the routes can be exercised with stub actions, and
 * the host's discovery state has exactly one owner.
 */
interface ComateActionDeps {
  /**
   * Re-read the local Comate config and republish the directory.
   * Must not reject: the host's own discovery already answers a signed-out
   * machine with an empty directory, so a refresh always has a true snapshot.
   */
  refresh: () => Promise<void>;
  /** Probe the connection with the given (possibly draft) inputs. */
  check: (input: ComateCheckInput) => Promise<ComateCheckOutcome>;
  /**
   * Seal a plaintext sid (or the stored one) into its storable form.
   *
   * MAY reject: unlike a probe, a failed seal is not an answer the card renders
   * as data — the save must be aborted, because the alternative is writing the
   * plaintext into the settings document, which is the thing this route exists
   * to prevent. The rejection message is shown to the user.
   */
  seal: (input: ComateSealInput) => Promise<ComateSealAnswer>;
}
/**
 * Register the status and action routes for as long as the composing deployment
 * provides a web server.
 *
 * `ctx.inject` is the right shape rather than `ctx.get`: an Electron/file-IPC
 * deployment has no `webServer` at all, and there the callback simply never runs
 * — the card then shows "no model directory yet" and its buttons report the
 * action is unavailable, while model serving is unaffected, because the
 * adapter's catalog comes from the local Comate config and never from these
 * routes.
 *
 * @param ctx - the plugin's context.
 * @param deps - live readers over the host's discovery state.
 * @param actions - the three actions the card can trigger.
 */
declare function registerComateStatusRoute(ctx: Context, deps: ComateCatalogDeps, actions: ComateActionDeps): void;
//#endregion
//#region src/settings-surface.d.ts
/**
 * One registered namespace's owner scope, as the 0.1.5 line hands it out.
 * Structural on purpose: see {@link ComateSettingsSurface}.
 */
interface ComateSettingsScope<T> {
  get(): T;
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void;
}
/**
 * The two settings service shapes this plugin has to serve.
 *
 * 0.1.5's `SettingsProvider` exposes `register(ns, schema, options)` and returns
 * an owner scope; 0.1.7 replaced the whole service with `SettingsForms`, whose
 * namespace IS the Loader entry id and whose only registration call is
 * `configure(presentation, owner)`. Neither method exists on the other line, and
 * the plugin must not fail to mount on either — so the surface is probed at
 * runtime through this structural type rather than typed against one line's
 * declarations (which would make the other line a compile error).
 */
interface ComateSettingsSurface {
  /** 0.1.7 (`SettingsForms`): declare this entry's configuration page policy. */
  configure?: ((presentation: {
    auto?: boolean;
  }, owner?: unknown) => () => void) | undefined;
  /** 0.1.5 (`SettingsProvider`): register this plugin's own settings namespace. */
  register?: ((ns: string, schema: unknown, options?: {
    base?: unknown;
  }) => ComateSettingsScope<unknown>) | undefined;
}
/** What the host keeps from the settings surface. */
interface ComateSettingsBinding<T> {
  /**
   * Namespace this plugin's section is addressed by on the running line: the
   * Loader entry id on 0.1.7, the plugin-registered namespace on 0.1.5.
   */
  settingsNs: string;
  /** Read the section's resolved values, free of live references. */
  current(): T;
}
/**
 * Bind the configuration section, or report that this deployment offers neither
 * shape.
 *
 * @param ctx - the plugin's context.
 * @param schema - the plugin's Config schema (used only on the 0.1.5 line, where
 * the plugin owns the namespace; on 0.1.7 the Loader owns it).
 * @param base - the composition-layer config the Loader handed to `apply`.
 * @param onChange - invoked after every committed settings change.
 * @returns the binding, or `undefined` when the plugin must not register at all.
 */
declare function bindComateSettings<T>(ctx: Context, schema: unknown, base: T, onChange: () => void): ComateSettingsBinding<T> | undefined;
//#endregion
//#region src/version.d.ts
/**
 * Package version, injected at build time by `tsdown.config.ts`.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT）—— 版本由构建期 define
 * 注入而非运行时读取 package.json（发布包只含 lib/）。
 *
 * @module dsh-connect-comate/version
 */
/** The npm package version this build was produced from. */
declare const COMATE_CONNECT_VERSION: string;
//#endregion
//#region src/max-tokens.d.ts
/**
 * Output-token cap resolution for the `comate` route.
 *
 * 背景（0.3.3 之前的实际情况，已核过代码）：
 *
 *   `adapter.ts` 把模型描述符的 `maxTokens` 写死成 `COMATE_DEFAULT_MAX_TOKENS`
 *   （32000）。那个值**不构成请求上限**——`dsh-llm-pi-ai` 的 profile 文档原话是
 *   "This sizes the model; it never becomes a per-request cap on its own"
 *   （`lib/types/config.d.ts`，`defaultMaxTokens` 条目），真正把上限落到请求上的
 *   是 harness 的 `resolveCallWithInfo`：
 *
 *     config.maxTokens === undefined && info.defaultMaxTokens !== undefined
 *       ? { ...config, maxTokens: info.defaultMaxTokens } : config
 *
 *   而 `info.defaultMaxTokens` 只由 profile 的 `configuredMaxTokens`（按模型 id）
 *   供给——本插件的那个 Map 一直是**空的**。于是：32000 只出现在「模型容量」的
 *   描述里，出站请求里根本没有 `max_tokens` 字段，上游用自己默认的上限。
 *
 * 本模块把那个值变成「一处可配置、且真的生效」的东西：
 *
 *   解析出的上限 → profile 的 `configuredMaxTokens` → harness 物化进
 *   `config.maxTokens` → pi-ai 写 `max_tokens` → 网关执行。
 *
 * 优先级：`WPS_COMATE_MAX_TOKENS`（env）> 每模型条目 `maxOutputTokensByModel[id]`
 * > 全局字段 `maxOutputTokens` > 32000 默认。
 * env 优先于卡片，是**故意**的：无头/脚本场景（`scripts/verify-*.mjs`、CI）必须
 * 能压过本机卡片里存的值，否则一个已保存的 32000 会让脚本里的覆盖静默失效。
 *
 * ## 每模型一层（0.4.1-rc.1）
 *
 * 同一个网关上的模型上下文窗口并不一样，一个统一的 32000 对窗口小的模型是浪费、
 * 对窗口大的模型是浪费余地——而真正按模型算的那个值只能由用户定。所以全局字段
 * 降级成「默认值」，`maxOutputTokensByModel` 里的条目按模型 id 覆盖它：
 * **缺席 = 跟随全局**，`0` = 这个模型不设上限（与全局 `0` 同义，但只作用于这一个）。
 * 一层一层的写法让「改默认值」仍然是一次改动，不必逐个模型重填。
 *
 * 取值语义：**正整数 = 上限，0 = 不设上限**。0 之所以有意义，是因为上游认它——
 * 真机实测（2026-09，本机）：`max_tokens: 0` 与不传该字段的表现一致（完整输出、
 * `finish_reason=stop`），而 `max_tokens: 16` 会 `finish_reason=length`。
 *
 * @module dsh-connect-comate/max-tokens
 */
/**
 * Env var forcing the output cap, whatever the saved card value says.
 *
 * 正整数 = 上限，`0` = 不设上限；空值/非法值会被忽略并记在
 * {@link ComateMaxTokensResolution.ignored} 里（不抛错：一个打错的 env 不该让
 * 插件装配失败）。
 */
declare const COMATE_MAX_TOKENS_ENV = "WPS_COMATE_MAX_TOKENS";
/**
 * The value that means "no cap at all".
 *
 * 不是「上限为 0」：上游把它当作「没给这个字段」，harness 那边则表现为
 * **不物化** `config.maxTokens`（见 {@link comateConfiguredMaxTokens}）。
 */
declare const COMATE_UNLIMITED_MAX_TOKENS = 0;
/** Where the effective cap came from. */
type ComateMaxTokensSource = 'env' | 'model' | 'config' | 'default';
/** A candidate value that was present but unusable, reported rather than thrown. */
interface ComateIgnoredMaxTokens {
  /** Which layer carried the unusable value. */
  layer: 'env' | 'model' | 'config';
  /** The raw value, as read. */
  raw: unknown;
  /**
   * The model whose entry was unusable. Only ever set with `layer: 'model'`:
   * the other two layers are global, so there is no model to name.
   */
  modelId?: string;
}
/** The resolved cap plus how it was decided. */
interface ComateMaxTokensResolution {
  /** Effective cap: a positive integer, or {@link COMATE_UNLIMITED_MAX_TOKENS}. */
  value: number;
  /** Which layer decided it. */
  source: ComateMaxTokensSource;
  /**
   * A higher-priority layer that carried a value this module refused to use
   * (`"abc"`, `-1`, `1.5`, …). Present so the caller can say so out loud instead
   * of leaving the user wondering why their setting did nothing.
   */
  ignored?: ComateIgnoredMaxTokens;
}
/**
 * Read one candidate value: positive integer = cap, `0` = unlimited, anything
 * else = unusable.
 *
 * Strings are accepted because the env layer always delivers one; numbers come
 * from the settings schema. Blank strings are "absent", NOT zero — `Number('')`
 * is 0, which would silently turn an empty env var into "unlimited".
 *
 * @param value - a raw candidate (number, string, or anything else).
 * @returns the cap, or undefined when the value is not usable.
 */
declare function parseMaxOutputTokens(value: unknown): number | undefined;
/**
 * Normalize the per-model override map (`maxOutputTokensByModel`).
 *
 * Tolerates anything a hand-edited `cordis.patch.yml` can contain: a non-object
 * reads as "no overrides", a blank key is dropped, and an entry whose value is
 * not a usable cap is **left out of the map** (a per-model entry is one model's
 * setting, so a broken one must not poison the others).
 *
 * Dropping is not the same as hiding: {@link unusableModelTokens} returns the
 * same entries this function refused, so the caller can say so out loud.
 *
 * @param value - the raw settings field (`maxOutputTokensByModel`).
 * @returns the usable overrides, keyed by model id (value 0 = unlimited).
 */
declare function parseMaxTokensByModel(value: unknown): Map<string, number>;
/**
 * The entries {@link parseMaxTokensByModel} had to drop.
 *
 * @param value - the raw settings field (`maxOutputTokensByModel`).
 * @returns one record per unusable entry, in the map's own order.
 */
declare function unusableModelTokens(value: unknown): {
  modelId: string;
  raw: unknown;
}[];
/** What {@link resolveComateMaxTokens} needs to answer for one model. */
interface ComateMaxTokensQuery {
  /** The model being resolved. Absent = resolve the global default alone. */
  modelId?: string;
  /** The per-model override map, as read from settings. */
  byModel?: unknown;
  /** The settings field's global value (`maxOutputTokens`). */
  configValue?: unknown;
  /** Environment to read {@link COMATE_MAX_TOKENS_ENV} from. */
  env?: NodeJS.ProcessEnv;
}
/**
 * Resolve the effective output cap for one model.
 *
 * Layers, highest first: env → the model's own entry → the global field →
 * {@link COMATE_DEFAULT_MAX_TOKENS}. The per-model layer sits above the global
 * one so a model can be pinned without disturbing the rest, and below the env
 * var so headless runs keep their absolute override.
 *
 * @param query - the model id, the override map, the global value, and the env.
 * @returns the cap (0 = unlimited) and the layer that decided it.
 */
declare function resolveComateMaxTokens(query?: ComateMaxTokensQuery): ComateMaxTokensResolution;
/**
 * Resolve the effective output cap, ignoring any per-model override.
 *
 * Kept as the global-field entry point (the card's default, `bin` diagnostics,
 * the cap-override warning): it answers "what does the shared setting say".
 *
 * @param configValue - the settings field's value (`maxOutputTokens`).
 * @param env - environment to read {@link COMATE_MAX_TOKENS_ENV} from.
 * @returns the cap (0 = unlimited) and the layer that decided it.
 */
declare function resolveMaxOutputTokens(configValue?: unknown, env?: NodeJS.ProcessEnv): ComateMaxTokensResolution;
/**
 * The cap as a pi-ai model descriptor must spell it.
 *
 * pi-ai refuses a non-positive `maxTokens`, so "unlimited" cannot be written as
 * 0 there. It is spelled as the model's own context window instead: the widest
 * cap this route can express, and the value the thinking-budget ceiling falls
 * back to. The *effective* per-request cap is still governed by
 * {@link comateConfiguredMaxTokens}, which omits the model entirely when the
 * cap is unlimited — so this number never becomes a request cap on its own.
 *
 * @param cap - the resolved cap (0 = unlimited).
 * @param contextWindow - the model's context window.
 * @returns a positive integer for the descriptor's `maxTokens`.
 */
declare function comateModelMaxTokens(cap: number, contextWindow: number): number;
/**
 * The profile's `configuredMaxTokens` map: the per-model caps the harness
 * materializes into a request that names none of its own.
 *
 * One entry per model, because the cap is resolved per model: two models on this
 * route can legitimately carry different caps, and a model pinned to "unlimited"
 * must be left OUT of the map rather than listed with 0 — a 0 here is what the
 * harness would materialize into `max_tokens: 0`, and `defaultMaxTokens` must be
 * a positive integer where pi-ai validates it.
 *
 * @param caps - `[modelId, cap]` pairs, cap 0 = unlimited.
 * @returns the map to hand to the pi-ai provider profile.
 */
declare function comateConfiguredMaxTokens(caps: Iterable<readonly [string, number]>): Map<string, number>;
//#endregion
//#region src/index.d.ts
/** Stable Cordis plugin name. */
declare const name = "dsh-connect-comate";
/** The model registry and settings store required before the provider can register. */
declare const inject: string[];
/** Plugin configuration. */
interface Config {
  /** Explicit Comate config-file path, overriding env and platform defaults. */
  configFile?: string;
  /**
   * Manual WPS login cookie value: the `wps_sid` from www.wps.cn cookies
   * (paste the value only, without the `wps_sid=` prefix). The desktop
   * config stores placeholders, so v0.1 needs this for llmproxy to accept
   * the request.
   */
  wpsSid?: string;
  /** Authenticate with the Cookie alone (drop the Authorization bearer). */
  cookieOnly?: boolean;
  /**
   * @deprecated The host no longer publishes the discovered directory through
   * settings (on 0.1.7 that write would target the user's own
   * `cordis.patch.yml`). The card reads it from the read-only
   * `COMATE_CATALOG_PATH` route instead. The field is still declared so a
   * config written by 0.1.x keeps validating.
   */
  lastCatalog?: ComatePersistedModel[];
  /**
   * Explicitly enabled model ids. Empty/absent means "show every discovered
   * model"; once the card saves a non-empty selection, only those models are
   * registered into DSH's model list.
   */
  enabledModelIds?: string[];
  /**
   * Output-token cap for every request on this route: a positive integer, or
   * `0` for "no cap at all" (the upstream then decides).
   *
   * Defaults to 32000, and unlike the old hard-coded descriptor value this one
   * is **enforced**: it lands in the pi-ai profile's `configuredMaxTokens`, which
   * the harness materializes into a request that names no cap of its own. So `0`
   * genuinely restores the uncapped behaviour this plugin had before.
   *
   * Since 0.4.1-rc.1 this is the DEFAULT every model follows unless
   * {@link Config.maxOutputTokensByModel} overrides it for that model.
   *
   * `WPS_COMATE_MAX_TOKENS` overrides this field when set (deliberate: headless
   * runs and the live verification scripts must be able to force a value over
   * whatever the card saved).
   */
  maxOutputTokens?: number;
  /**
   * Per-model overrides of {@link Config.maxOutputTokens}, keyed by model id.
   *
   * Written by the card's per-model cap boxes. An entry is `0` for "no cap for
   * this model"; a model with no entry follows the global field, so removing an
   * override means deleting its key. Blank entries are never stored, which is
   * what keeps the settings document readable.
   */
  maxOutputTokensByModel?: Record<string, number>;
  /**
   * Display-name overrides, keyed by model id.
   *
   * Cosmetic by construction: the alias replaces the descriptor's `name` — what
   * DSH's model picker paints — while the id stays untouched. So a rename can
   * never invalidate a saved {@link Config.maxOutputTokensByModel} entry or an
   * `agent-default-model` choice, and clearing a box (or writing an empty value)
   * means "no alias", not "an empty name".
   */
  modelAliases?: Record<string, string>;
  /**
   * Extra thinking levels to offer in the model picker, on top of
   * `minimal` / `low` / `medium` / `high`.
   *
   * A subset of `off` / `xhigh` / `max`, written by the card's checkboxes and
   * empty by default. Only the levels listed are ADDED — this field never
   * removes a base level.
   *
   * `off` is the one entry with a side effect beyond adding a row to the picker:
   * pi-ai reads `thinkingLevelMap.off` whenever nothing names an effort, so
   * enabling it also makes the picker's "provider default" mean "thinking off".
   * The card says so next to the box; the measured wire values are in
   * `bridge.ts`.
   */
  extraThinkingLevels?: string[];
}
/**
 * The four fields the card writes. Each one is declared volatile so 0.1.7's
 * write gate (`volatileForm` non-empty, then `isVolatilePath` per written path)
 * accepts it; on 0.1.5 `asVolatile` is an identity no-op and the schema stays
 * exactly the shape that line validated before.
 */
declare const Config: z<Config>;
/**
 * Start the loopback endpoint, register the `comate` provider, and seed the
 * model catalog from the desktop client's own config.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { COMATE_ASSET_BASE_ENV, COMATE_BASE_THINKING_LEVELS, COMATE_CATALOG_PATH, COMATE_CHECK_MAX_TOKENS, COMATE_CHECK_PATH, COMATE_CHECK_READ_LIMIT, COMATE_CHECK_TIMEOUT_MS, COMATE_CLIENT_NAME, COMATE_CONFIG_ENV, COMATE_CONNECT_VERSION, COMATE_DEFAULT_CONTEXT_WINDOW, COMATE_DEFAULT_MAX_TOKENS, COMATE_ENTRY_ID, COMATE_EXTRA_THINKING_LEVELS, COMATE_HOME_ENV, COMATE_MAX_TOKENS_ENV, COMATE_PROVIDER, COMATE_REFRESH_PATH, COMATE_SEALED_PREFIX, COMATE_SEAL_PATH, COMATE_SECRET_DIRNAME, COMATE_SECRET_KEY_ENV, COMATE_SECRET_KEY_FILENAME, COMATE_SETTINGS_NS, COMATE_SID_ENV, COMATE_THINKING_LEVEL_WIRE, COMATE_UNLIMITED_MAX_TOKENS, type ComateActionDeps, type ComateAdapter, type ComateAssetUploader, type ComateAuthStatus, type ComateCandidateDiagnostics, ComateCatalog, type ComateCatalogAnswer, type ComateCatalogDeps, type ComateChatResult, type ComateCheckInput, type ComateCheckOptions, type ComateCheckOutcome, type ComateCheckReason, type ComateCredential, ComateCredentialStore, type ComateDoctorReport, type ComateExtraThinkingLevel, type ComateMaxTokensQuery, type ComateMaxTokensResolution, type ComateMaxTokensSource, type ComateModel, type ComateOpenFailure, type ComateOpenResult, type ComatePersistedModel, ComatePresignUploader, type ComateSealAnswer, type ComateSealInput, type ComateSecretOptions, type ComateSettingsBinding, type ComateSettingsSurface, type ComateSettingsValue, type ComateShim, type ComateSidResolution, type ComateSidStorage, type ComateStoreOptions, ComateUpstreamClient, Config, type ImageSanitizeStats, type ImageUploadStats, type UpstreamErrorKind, apply, asVolatile, bindComateSettings, classifyUpstreamError, comateCheckBody, comateConfiguredMaxTokens, comateModelInput, comateModelMaxTokens, createComateAdapter, createComateShim, decodeImageDataUrl, defaultComateHome, defaultConfigCandidates, defaultSecretKeyFile, downloadUrlExpiry, emptyImageStats, emptyUploadStats, inject, isSealed, isSealedComateSecret, machineFingerprint, name, normalizeChatImages, openSecret, parseComateConfig, parseComateModel, parseMaxOutputTokens, parseMaxTokensByModel, prepareChatBody, registerComateStatusRoute, resolveAssetBase, resolveComateMaxTokens, resolveMaxOutputTokens, runComateCheck, safeMessage, sanitizeImageSource, sealSecret, selectComateModels, unusableModelTokens, unwrapVolatile, unwrapVolatileDeep, uploadChatImages };