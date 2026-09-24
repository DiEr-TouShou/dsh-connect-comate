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
 * @module dsh-connect-comate/auth
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Env var overriding the exact Comate config file path. */
export const COMATE_CONFIG_ENV = 'WPS_COMATE_CONFIG_FILE'

/** Env var overriding the Comate home directory (default `~/.wpscomate`). */
export const COMATE_HOME_ENV = 'WPS_COMATE_HOME'

/** Env var providing the WPS login cookie (wps_sid) for manual auth mode. */
export const COMATE_SID_ENV = 'WPS_COMATE_SID'

export const COMATE_HOME_DIRNAME = '.wpscomate'
export const COMATE_CONFIG_FILENAME = 'config.json'
export const COMATE_MODELS_FILENAME = 'models.json'
export const COMATE_AGENT_SUBDIR = 'agent'
export const COMATE_USER_AUTH_RELPATH = join(COMATE_AGENT_SUBDIR, 'auth', 'user_auth.json')

/** Default context window when the config omits it (all observed models use 1M). */
export const COMATE_DEFAULT_CONTEXT_WINDOW = 1_000_000

/** Default DSH output budget; the Comate config exposes no max-output field. */
export const COMATE_DEFAULT_MAX_TOKENS = 32_000

/** One model entry from the Comate config. */
export interface ComateModel {
  id: string
  name: string
  contextWindow: number
  /** e.g. `llm-chat`, `llm-multimodal`. */
  llmTypes?: string
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
  hints: string[]
}

function nonEmptyEnv(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
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
  const llmTypes = typeof raw['llm_types'] === 'string' && raw['llm_types'] !== ''
    ? raw['llm_types'] as string
    : undefined
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

/** Constructor options; all fields optional. */
export interface ComateStoreOptions {
  /** Explicit Comate config-file path, overriding env and platform defaults. */
  configFile?: string
  /**
   * Manual WPS login cookie value (`wps_sid` from www.wps.cn). The desktop
   * config only stores placeholders (the real cookie is delivered per task
   * by the Comate UI), so v0.1 lets you paste the sid here as `wps_sid=<v>`.
   */
  wpsSid?: string
  /**
   * When true, drop the Authorization bearer (config apiKey is a placeholder
   * too) and authenticate with the Cookie alone.
   */
  cookieOnly?: boolean
}

/**
 * Read-only credential store. Resolves the first candidate that yields a
 * valid credential; never writes the desktop client's files.
 */
export class ComateCredentialStore {
  private configFileOverride: string | undefined
  private wpsSidOverride: string | undefined
  private cookieOnlyOverride: boolean

  constructor(options: ComateStoreOptions = {}) {
    this.configFileOverride = options.configFile
    this.wpsSidOverride = options.wpsSid
    this.cookieOnlyOverride = options.cookieOnly === true
  }

  /** Repoint the config file; applies on the next read. */
  setConfigFile(path: string | undefined): void {
    this.configFileOverride = path
  }

  /** Set the manual wps_sid cookie value; applies on the next read. */
  setWpsSid(sid: string | undefined): void {
    this.wpsSidOverride = sid
  }

  /** Toggle cookie-only auth; applies on the next read. */
  setCookieOnly(value: boolean): void {
    this.cookieOnlyOverride = value
  }

  /** Manual sid from options or env (`WPS_COMATE_SID`), if any. */
  private sidOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const sid = this.wpsSidOverride ?? nonEmptyEnv(env[COMATE_SID_ENV])
    return sid === undefined || sid.trim() === '' ? undefined : sid.trim()
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

  /** First candidate that yields a valid credential. */
  async current(): Promise<ComateCredential | undefined> {
    for (const path of this.candidates()) {
      const { credential } = await this.readCandidate(path)
      if (credential !== undefined) {
        const sid = this.sidOverride()
        if (sid !== undefined || this.cookieOnlyOverride) {
          return {
            ...credential,
            ...sid !== undefined ? { cookie: `wps_sid=${sid}` } : {},
            authHeader: credential.authHeader && !this.cookieOnlyOverride,
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
    const wpsSid: ComateDoctorReport['wpsSid'] = this.sidOverride(env) === undefined ? 'unset' : 'set'
    const hints: string[] = []
    if (signIn !== 'signed-in') {
      hints.push('Sign in once in the WPS Comate desktop client (it writes ~/.wpscomate/config.json), then run status again.')
    }
    if (!candidates.some(candidate => candidate.present)) {
      hints.push(`No Comate config file found; set ${COMATE_CONFIG_ENV} if it lives elsewhere.`)
    }
    if (wpsSid === 'unset') {
      hints.push('The desktop config stores placeholder apiKey/cookie only (the real credential is delivered per task by the Comate UI), so llmproxy answers 401. Fill `wpsSid` in the DSH plugin settings (wps_sid from www.wps.cn cookies) or set WPS_COMATE_SID.')
    }
    if (userAuthPresent === false) {
      hints.push('No user_auth.json found; v0.1 relies on config.json as-is (token refresh is a future step).')
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
   * v0.1 keeps no plugin-owned credential copy, so there is nothing to
   * remove; the Comate desktop files are never touched.
   */
  async logout(): Promise<void> {}
}
