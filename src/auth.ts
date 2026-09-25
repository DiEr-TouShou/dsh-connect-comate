/**
 * WPS Comate credential resolution: read-only discovery of the locally
 * signed-in Comate desktop client.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 只读发现桌面端登录态、按平台探测候选路径、doctor/status 诊断结构、
 *     凭据绝不写入 DSH 设置等设计思路沿用自该项目；WPS 侧的路径与字段
 *     为本机实测（2026-09）。
 *
 * WPS Comate 桌面端把登录后的模型接入配置保存在
 *   `~/.wpscomate/config.json`（`providers.official` 一节），内含：
 *     baseUrl    —— 如 https://comate.wps.cn/llmproxy/v1/user
 *     apiKey     —— 上游鉴权密钥（authHeader=true 时走 Authorization 头）
 *     headers.cookie —— 上游 Cookie
 *     models[]   —— 模型目录（id / name / context_window / llm_types ...）
 * 同构副本在 `~/.wpscomate/agent/models.json`。
 * 本模块只读这些文件，从不写入；token 不进入 DSH 设置。
 *
 * ## 手动 wps_sid 的存储（v0.4 起为密文）
 *
 * 桌面端 config 里的 apiKey/cookie 只是占位，真正的会话 Cookie 由 Comate UI 每次
 * 任务下发，所以 llmproxy 需要一个手工填的 `wps_sid`。它存在 DSH 的设置文档里
 * （0.1.7 上就是用户手写的 `cordis.patch.yml`）——**v0.4 起存的是密文**
 * （`enc:v1:…`，见 `./secret.ts`），本模块负责在读路径上把它解开。
 *
 * 兼容性：没有该前缀的值一律按**明文**读（0.4 之前写进去的、以及 `WPS_COMATE_SID`
 * 这种用户自己给的值），所以升级不会把手上的凭据弄丢；卡片会在打开时把它升级成
 * 密文。解不开的密文（密钥文件丢了、或密文来自另一台机器/另一个用户）不会抛错，
 * 而是被当作「没有可用凭据」上报，并带上原因——静默 401 是这里最坏的失败形态。
 *
 * @module dsh-connect-comate/auth
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isSealedComateSecret, type ComateSealAnswer } from './bridge.ts'
import {
  COMATE_SECRET_DIRNAME,
  COMATE_SECRET_KEY_ENV,
  COMATE_SECRET_KEY_FILENAME,
  openSecret,
  sealSecret,
  type ComateOpenFailure,
} from './secret.ts'

/** Re-exported so the CLI can report where the key file lives without importing `secret.ts`. */
export { COMATE_SECRET_KEY_ENV } from './secret.ts'

/** Env var overriding the exact Comate config file path. */
export const COMATE_CONFIG_ENV = 'WPS_COMATE_CONFIG_FILE'

/** Env var overriding the Comate home directory (default `~/.wpscomate`). */
export const COMATE_HOME_ENV = 'WPS_COMATE_HOME'

/**
 * Env var providing the WPS login cookie (wps_sid) for manual auth mode.
 *
 * A **sealed** value is accepted here too: the read path is shared with the
 * settings field, so `WPS_COMATE_SID=enc:v1:…` works and is the only way a
 * headless run can use an encrypted credential.
 */
export const COMATE_SID_ENV = 'WPS_COMATE_SID'

export const COMATE_HOME_DIRNAME = '.wpscomate'
export const COMATE_CONFIG_FILENAME = 'config.json'
export const COMATE_MODELS_FILENAME = 'models.json'
export const COMATE_AGENT_SUBDIR = 'agent'
export const COMATE_USER_AUTH_RELPATH = join(COMATE_AGENT_SUBDIR, 'auth', 'user_auth.json')

/** Default context window when the config omits it (all observed models use 1M). */
export const COMATE_DEFAULT_CONTEXT_WINDOW = 1_000_000

/**
 * The Comate marker for image input, one entry of a model's `llm_types`.
 *
 * 真机形状（`~/.wpscomate/config.json` → `providers.official.models[]`）：
 *   `"llm_types": ["llm-chat", "llm-multimodal"]`
 * 本机 10 个模型里 5 个带这个标记。
 */
export const COMATE_MULTIMODAL_TYPE = 'llm-multimodal'

/** The chat marker every catalogued model carries. */
export const COMATE_CHAT_TYPE = 'llm-chat'

/**
 * Default DSH output budget; the Comate config exposes no max-output field.
 *
 * Re-exported from `bridge.ts` so the browser half can use the same number
 * without importing this module (which pulls in `node:crypto`).
 */
export { COMATE_DEFAULT_MAX_TOKENS } from './bridge.ts'

/** One model entry from the Comate config. */
export interface ComateModel {
  id: string
  name: string
  contextWindow: number
  /**
   * Normalized `llm_types`, e.g. `['llm-chat', 'llm-multimodal']`. Always an
   * array: the desktop config ships one, and the string spelling is accepted
   * only as a legacy/alternate shape (see {@link parseLlmTypes}).
   */
  llmTypes?: string[]
  modelSource?: string
  modelTier?: string
}

/** Normalized Comate credential, read from the desktop client's own config. */
export interface ComateCredential {
  baseUrl: string
  apiKey: string
  cookie?: string
  /** Whether the apiKey goes in an `Authorization` header (Comate sets true). */
  authHeader: boolean
  models: readonly ComateModel[]
  /** Which file this credential was read from. */
  configFile: string
}

/** Read-only sign-in summary for status output. */
export interface ComateAuthStatus {
  state: 'signed-in' | 'signed-out'
  baseUrl?: string
  modelCount?: number
}

/** One config candidate's diagnostic entry. */
export interface ComateCandidateDiagnostics {
  path: string
  present: boolean
  valid: boolean
  baseUrl?: string
  modelCount?: number
  error?: string
}

/** Secret-free doctor report. */
export interface ComateDoctorReport {
  schemaVersion: number
  package: string
  version: string
  node: string
  candidates: ComateCandidateDiagnostics[]
  userAuthPresent: boolean
  signIn: ComateAuthStatus['state']
  /** Whether a manual wps_sid (config or env) will be used. */
  wpsSid: 'set' | 'unset'
  /** How that sid is protected at rest; `unset` when there is none. */
  wpsSidStorage: ComateSidStorage
  /** Why a sealed sid could not be opened; `undefined` unless `wpsSidStorage` is `unreadable`. */
  wpsSidProblem?: ComateOpenFailure | undefined
  /** Key file the sealed value is bound to. A path, never the key. */
  wpsSidKeyFile: string
  hints: string[]
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
export type ComateSidStorage =
  /** Nothing stored. */
  | 'unset'
  /** Stored as typed (a value written before 0.4, or from the env var). */
  | 'plaintext'
  /** Sealed and decryptable. */
  | 'sealed'
  /** Sealed, but this machine/user cannot open it (key file gone, replaced, or foreign). */
  | 'unreadable'

/** One read's view of the stored sid, plaintext included. Never logged or returned raw. */
export interface ComateSidResolution {
  /** Usable plaintext sid; absent when nothing usable is stored. */
  sid?: string
  storage: ComateSidStorage
  /** Set exactly when `storage` is `unreadable`. */
  problem?: ComateOpenFailure
  /** The key file in force for this read. */
  keyFile: string
}

function nonEmptyEnv(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Trim a candidate value, treating blank as absent. */
function nonEmptyString(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

/** The Comate home directory (env override or `~/.wpscomate`). */
export function defaultComateHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return nonEmptyEnv(env[COMATE_HOME_ENV]) ?? join(home, COMATE_HOME_DIRNAME)
}

/** Platform-default config candidates, in probe order. */
export function defaultConfigCandidates(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const root = defaultComateHome(env, home)
  return [join(root, COMATE_CONFIG_FILENAME), join(root, COMATE_AGENT_SUBDIR, COMATE_MODELS_FILENAME)]
}

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
export function defaultSecretKeyFile(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return nonEmptyEnv(env[COMATE_SECRET_KEY_ENV])
    ?? join(defaultComateHome(env, home), COMATE_SECRET_DIRNAME, COMATE_SECRET_KEY_FILENAME)
}

/**
 * Normalize one model's `llm_types` into a trimmed, de-duplicated array.
 *
 * 两种形状都收：真机是 **JSON 数组**（`["llm-chat", "llm-multimodal"]`），
 * 而本模块最初的实现只认空格分隔的字符串——于是真机上 `llmTypes` 恒为
 * `undefined`，5 个多模态模型在 DSH 里全部失去图片输入能力（测试数据用的是
 * 字符串，所以 128 例全绿而真机功能缺失）。字符串分支保留，是为了让旧写法与
 * 别处副本继续可读，不是主路径。
 *
 * @returns the types, or undefined when nothing usable is present.
 */
export function parseLlmTypes(value: unknown): string[] | undefined {
  const entries: unknown[] = typeof value === 'string'
    ? value.split(/[\s,]+/)
    : Array.isArray(value)
      ? value
      : []
  const types: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    const type = entry.trim()
    if (type !== '' && !types.includes(type)) types.push(type)
  }
  return types.length === 0 ? undefined : types
}

/** Parse one config model entry; entries without an id are dropped. */
export function parseComateModel(value: unknown): ComateModel | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const id = typeof raw['id'] === 'string' ? raw['id'].trim() : ''
  if (id === '') return undefined
  const name = typeof raw['name'] === 'string' && raw['name'].trim() !== ''
    ? raw['name'].trim()
    : id
  const contextValue = typeof raw['context_window'] === 'number'
    ? raw['context_window']
    : raw['contextWindow']
  const contextWindow = typeof contextValue === 'number' && contextValue > 0
    ? contextValue
    : COMATE_DEFAULT_CONTEXT_WINDOW
  const llmTypes = typeof raw['multimodal'] === 'boolean'
    // 桌面端 `isModelMultimodal` 先认 `multimodal: boolean` 覆盖字段，这里同序。
    ? [COMATE_CHAT_TYPE, ...raw['multimodal'] === true ? [COMATE_MULTIMODAL_TYPE] : []]
    : parseLlmTypes(raw['llm_types'])
  const modelSource = typeof raw['model_source'] === 'string' && raw['model_source'] !== ''
    ? raw['model_source'] as string
    : undefined
  const modelTier = typeof raw['model_tier'] === 'string' && raw['model_tier'] !== ''
    ? raw['model_tier'] as string
    : undefined
  return {
    id,
    name,
    contextWindow,
    ...llmTypes === undefined ? {} : { llmTypes },
    ...modelSource === undefined ? {} : { modelSource },
    ...modelTier === undefined ? {} : { modelTier },
  }
}

/**
 * Parse a Comate config document. Returns undefined when the document carries
 * no usable `providers.official` (missing file content, wrong shape, empty
 * baseUrl or apiKey).
 */
export function parseComateConfig(text: string, filePath: string): ComateCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  const providers = typeof document['providers'] === 'object' && document['providers'] !== null
    ? document['providers'] as Record<string, unknown>
    : {}
  const official = typeof providers['official'] === 'object' && providers['official'] !== null
    ? providers['official'] as Record<string, unknown>
    : undefined
  if (official === undefined) return undefined
  const baseUrl = typeof official['baseUrl'] === 'string' && official['baseUrl'].trim() !== ''
    ? official['baseUrl'].trim()
    : ''
  const apiKey = typeof official['apiKey'] === 'string' && official['apiKey'].trim() !== ''
    ? official['apiKey'].trim()
    : ''
  if (baseUrl === '' || apiKey === '') return undefined
  const authHeader = official['authHeader'] !== false
  let cookie: string | undefined
  const headers = typeof official['headers'] === 'object' && official['headers'] !== null
    ? official['headers'] as Record<string, unknown>
    : {}
  // 桌面端 config 里的 cookie 只是占位字面量 "COOKIE"，真正的会话
  // Cookie 由 UI 每次任务下发；占位值视为缺省。
  if (typeof headers['cookie'] === 'string' && headers['cookie'] !== ''
    && headers['cookie'].trim().toUpperCase() !== 'COOKIE') {
    cookie = headers['cookie']
  }
  const models: ComateModel[] = []
  if (Array.isArray(official['models'])) {
    for (const raw of official['models']) {
      const model = parseComateModel(raw)
      if (model !== undefined) models.push(model)
    }
  }
  return {
    baseUrl,
    apiKey,
    ...cookie === undefined ? {} : { cookie },
    authHeader,
    models,
    configFile: filePath,
  }
}

/**
 * One-shot credential inputs for a single read.
 *
 * Used by the card's 「测试连接」 so an unsaved draft sid can be probed before it
 * is committed. Nothing here is ever stored: the fields live on the call, not on
 * the store, so a test cannot change what the plugin actually uses.
 */
export interface ComateCredentialOverride {
  /** Manual sid to use for this read; absent or blank keeps the saved value. */
  wpsSid?: string
  /** Cookie-only auth for this read; absent keeps the saved value. */
  cookieOnly?: boolean
}

/** Constructor options; all fields optional. */
export interface ComateStoreOptions {
  /** Explicit Comate config-file path, overriding env and platform defaults. */
  configFile?: string
  /**
   * Manual WPS login cookie value (`wps_sid` from www.wps.cn). The desktop
   * config only stores placeholders (the real cookie is delivered per task
   * by the Comate UI), so the sid can be pasted here as `wps_sid=<v>`.
   *
   * Either spelling is accepted: a sealed value (`enc:v1:…`, what the card now
   * stores) or plaintext (what older versions stored).
   */
  wpsSid?: string
  /**
   * When true, drop the Authorization bearer (config apiKey is a placeholder
   * too) and authenticate with the Cookie alone.
   */
  cookieOnly?: boolean
  /** Explicit key-file path, overriding env and the Comate-home default. */
  secretKeyFile?: string
}

/**
 * Read-only credential store. Resolves the first candidate that yields a
 * valid credential; never writes the desktop client's files.
 */
export class ComateCredentialStore {
  private configFileOverride: string | undefined
  private wpsSidOverride: string | undefined
  private cookieOnlyOverride: boolean
  private secretKeyFileOverride: string | undefined

  constructor(options: ComateStoreOptions = {}) {
    this.configFileOverride = options.configFile
    this.wpsSidOverride = options.wpsSid
    this.cookieOnlyOverride = options.cookieOnly === true
    this.secretKeyFileOverride = options.secretKeyFile
  }

  /** Repoint the config file; applies on the next read. */
  setConfigFile(path: string | undefined): void {
    this.configFileOverride = path
  }

  /**
   * Set the manual wps_sid; applies on the next read.
   *
   * The value is whatever the settings document holds — sealed (`enc:v1:…`) or
   * legacy plaintext — and is deliberately NOT decrypted here: this setter runs
   * inside the synchronous settings-change handler, and keeping the raw string
   * means the plaintext only exists for the one read that actually needs it.
   */
  setWpsSid(sid: string | undefined): void {
    this.wpsSidOverride = sid
  }

  /** Toggle cookie-only auth; applies on the next read. */
  setCookieOnly(value: boolean): void {
    this.cookieOnlyOverride = value
  }

  /** Repoint the key file that protects a sealed sid; applies on the next read. */
  setSecretKeyFile(path: string | undefined): void {
    this.secretKeyFileOverride = path
  }

  /** The key file in force: explicit override, env, then the Comate-home default. */
  keyFile(env: NodeJS.ProcessEnv = process.env): string {
    return this.secretKeyFileOverride ?? defaultSecretKeyFile(env)
  }

  /** The raw stored value (settings override or env), still sealed if sealed. */
  private rawSid(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const sid = this.wpsSidOverride ?? nonEmptyEnv(env[COMATE_SID_ENV])
    return sid === undefined || sid.trim() === '' ? undefined : sid.trim()
  }

  /**
   * The raw value that came from the SETTINGS document, env ignored.
   *
   * The plaintext-upgrade path must act on what is actually stored: sealing the
   * `WPS_COMATE_SID` env value and writing that back would put a credential the
   * user only ever meant for one shell session into a persisted file.
   */
  private storedRawSid(): string | undefined {
    const sid = this.wpsSidOverride
    return sid === undefined || sid.trim() === '' ? undefined : sid.trim()
  }

  /**
   * Resolve the stored sid for one read, decrypting a sealed value.
   *
   * @param env - environment to read {@link COMATE_SID_ENV} from.
   * @returns the usable sid (if any), how it was stored, and the key file used.
   */
  async resolveSid(env: NodeJS.ProcessEnv = process.env): Promise<ComateSidResolution> {
    const raw = this.rawSid(env)
    const keyFile = this.keyFile(env)
    if (raw === undefined) return { storage: 'unset', keyFile }
    // No envelope means a value written before 0.4 (or a user-supplied env one):
    // read it as-is rather than refusing it, so an upgrade never loses the
    // credential that is already working.
    if (!isSealedComateSecret(raw)) return { sid: raw, storage: 'plaintext', keyFile }
    const opened = await openSecret(raw, { keyFile })
    return opened.ok
      ? { sid: opened.value, storage: 'sealed', keyFile }
      : { storage: 'unreadable', problem: opened.reason, keyFile }
  }

  /**
   * Seal a plaintext sid into its storable form.
   *
   * @param sid - the value as typed; trimmed, and an empty one is refused.
   * @returns the sealed string plus the plaintext length, for the card's copy.
   * @throws {Error} when the key file cannot be created or read.
   */
  async seal(sid: string, env: NodeJS.ProcessEnv = process.env): Promise<ComateSealAnswer> {
    const trimmed = sid.trim()
    if (trimmed === '') throw new Error('comate: refusing to seal an empty sid')
    return { sealed: await sealSecret(trimmed, { keyFile: this.keyFile(env) }), length: trimmed.length }
  }

  /**
   * Seal the value already stored in the settings document.
   *
   * This is the plaintext-upgrade path: the host seals what it already holds, so
   * the plaintext never has to travel through the browser to be re-saved.
   *
   * @throws {Error} when nothing is stored, the stored value is already sealed,
   * or the key file cannot be used.
   */
  async sealStored(env: NodeJS.ProcessEnv = process.env): Promise<ComateSealAnswer> {
    const stored = this.storedRawSid()
    if (stored === undefined) throw new Error('comate: no stored wps_sid to seal')
    if (isSealedComateSecret(stored)) throw new Error('comate: the stored wps_sid is already sealed')
    return await this.seal(stored, env)
  }

  /** The config-file candidates, in probe order. */
  private candidates(
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir(),
  ): string[] {
    const explicit = this.configFileOverride ?? nonEmptyEnv(env[COMATE_CONFIG_ENV])
    if (explicit !== undefined) return [explicit]
    return defaultConfigCandidates(env, home)
  }

  /** Read one candidate; a parse failure is reported, never thrown. */
  async readCandidate(path: string): Promise<{ credential?: ComateCredential; error?: string }> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      return {
        error: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
          ? 'missing'
          : `unreadable: ${String(error)}`,
      }
    }
    const credential = parseComateConfig(text, path)
    return credential === undefined
      ? { error: 'unparsable or missing providers.official' }
      : { credential }
  }

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
  async current(override: ComateCredentialOverride = {}): Promise<ComateCredential | undefined> {
    const draftSid = nonEmptyString(override.wpsSid)
    const cookieOnly = override.cookieOnly ?? this.cookieOnlyOverride
    // Resolved once, outside the candidate loop: the stored sid does not depend on
    // which config file answers. A draft skips the read entirely, so probing a
    // typed value cannot fail because the SAVED one has an unusable key file.
    const storedSid = draftSid === undefined ? (await this.resolveSid()).sid : undefined
    const sid = draftSid ?? storedSid
    for (const path of this.candidates()) {
      const { credential } = await this.readCandidate(path)
      if (credential !== undefined) {
        if (sid !== undefined || cookieOnly) {
          return {
            ...credential,
            ...sid !== undefined ? { cookie: `wps_sid=${sid}` } : {},
            authHeader: credential.authHeader && !cookieOnly,
          }
        }
        return credential
      }
    }
    return undefined
  }

  /** The credential to send upstream; throws when none is signed in. */
  async resolve(): Promise<ComateCredential> {
    const credential = await this.current()
    if (credential === undefined) {
      throw new Error(
        `comate: no signed-in WPS Comate credential found (expected ${this.candidates().join(' or ')}`
        + `, or set ${COMATE_CONFIG_ENV})`,
      )
    }
    return credential
  }

  /** Read-only sign-in summary; never throws. */
  async status(): Promise<ComateAuthStatus> {
    const credential = await this.current()
    return credential === undefined
      ? { state: 'signed-out' }
      : { state: 'signed-in', baseUrl: credential.baseUrl, modelCount: credential.models.length }
  }

  /** Secret-free diagnostics for the doctor CLI. */
  async doctor(
    version: string,
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir(),
  ): Promise<ComateDoctorReport> {
    const candidates: ComateCandidateDiagnostics[] = []
    for (const path of this.candidates(env, home)) {
      const { credential, error } = await this.readCandidate(path)
      candidates.push({
        path,
        present: error !== 'missing',
        valid: credential !== undefined,
        ...credential === undefined ? {} : { baseUrl: credential.baseUrl, modelCount: credential.models.length },
        ...error !== undefined && error !== 'missing' ? { error } : {},
      })
    }
    const signIn = (await this.status()).state
    const userAuthPresent = await this.userAuthPresent(env, home)
    const sid = await this.resolveSid(env)
    const wpsSid: ComateDoctorReport['wpsSid'] = sid.storage === 'unset' ? 'unset' : 'set'
    const hints: string[] = []
    if (signIn !== 'signed-in') {
      hints.push('Sign in once in the WPS Comate desktop client (it writes ~/.wpscomate/config.json), then run status again.')
    }
    if (!candidates.some(candidate => candidate.present)) {
      hints.push(`No Comate config file found; set ${COMATE_CONFIG_ENV} if it lives elsewhere.`)
    }
    if (sid.storage === 'unset') {
      hints.push('The desktop config stores placeholder apiKey/cookie only (the real credential is delivered per task by the Comate UI), so llmproxy answers 401. Fill `wpsSid` in the DSH plugin settings (wps_sid from www.wps.cn cookies) or set WPS_COMATE_SID.')
    }
    if (sid.storage === 'plaintext') {
      hints.push('The stored wps_sid is still PLAINTEXT in the DSH settings document. Open the plugin card once — it upgrades the value in place — or run `dsh-connect-comate seal` and paste the result yourself.')
    }
    if (sid.storage === 'unreadable') {
      hints.push(`The stored wps_sid is sealed but cannot be decrypted (${sid.problem}); the key file ${sid.keyFile} is missing, unreadable, or was created for another machine/user. Paste the sid again in the plugin card, or point ${COMATE_SECRET_KEY_ENV} at the right key file.`)
    }
    if (userAuthPresent === false) {
      hints.push('No user_auth.json found; the plugin relies on config.json as-is (token refresh is a future step).')
    }
    return {
      schemaVersion: 1,
      package: 'dsh-connect-comate',
      version,
      node: process.version,
      candidates,
      userAuthPresent,
      signIn,
      wpsSid,
      wpsSidStorage: sid.storage,
      // Always present, `undefined` when there is nothing to report: an optional
      // field assigned `undefined` is dropped by JSON.stringify, so the `--json`
      // document stays clean without a conditional spread here.
      wpsSidProblem: sid.problem,
      wpsSidKeyFile: sid.keyFile,
      hints,
    }
  }

  private async userAuthPresent(
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir(),
  ): Promise<boolean> {
    const path = join(defaultComateHome(env, home), COMATE_USER_AUTH_RELPATH)
    try {
      await readFile(path)
      return true
    } catch {
      return false
    }
  }

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
  async logout(): Promise<void> {}
}
