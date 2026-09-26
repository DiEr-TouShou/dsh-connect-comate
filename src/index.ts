/**
 * WPS Comate models for DeepSeek Harness, reusing the locally signed-in
 * Comate desktop client's config. Registers the `comate` provider; streaming,
 * tool calls, compaction, and permissions stay Harness-owned.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 宿主的装配顺序（先起 shim，拿到端口后才构造 provider，再注册
 *     adapter 与可配置 provider，最后异步灌入模型目录）由该项目
 *     （转引自 corrinehu/dsh-workbuddy-connect，MIT）设计并验证；
 *     0.1.7 的三处差异（settings 换型、volatile 声明、活引用）与其判定方式
 *     沿用该项目 2.0.12–2.0.14 逐条查出的结论。
 * 改动：无区域/账号/积分概念（Comate 本地 config 即单一登录态），
 *   模型目录直接来自本地 config，无需远端刷新；目录不再经 settings 回写，
 *   改由只读路由（{@link registerComateStatusRoute}）发布。
 *
 * @module dsh-connect-comate
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
// Type-only: declares the `settings` service seat on Context.
import type {} from '@deepseek-ai/dsh-settings'
// Type-only: brings in `Fiber.entry` and the `loader/volatile-update` event the
// 0.1.7 configuration path listens to. Never a runtime import.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { COMATE_PROVIDER, comateModelInput, createComateAdapter } from './adapter.ts'
import { ComatePresignUploader } from './assets.ts'
import type { ComateModel, ComateSidResolution } from './auth.ts'
import { COMATE_DEFAULT_MAX_TOKENS, ComateCredentialStore } from './auth.ts'
import { ComateCatalog, selectComateModels } from './catalog.ts'
import { runComateCheck, type ComateCheckOutcome } from './check.ts'
import { COMATE_MAX_TOKENS_ENV, parseMaxTokensByModel, resolveComateMaxTokens, resolveMaxOutputTokens, unusableModelTokens } from './max-tokens.ts'
import { modelAliasOf, parseModelAliases, unusableModelAliases } from './model-alias.ts'
import { parseExtraThinkingLevels, unusableThinkingLevels, type ComateExtraThinkingLevel } from './thinking-levels.ts'
import { createComateShim } from './shim.ts'
import { ComateUpstreamClient } from './upstream.ts'
import {
  asVolatile,
  COMATE_EXTRA_THINKING_LEVELS,
  type ComatePersistedModel,
} from './bridge.ts'
import { bindComateSettings } from './settings-surface.ts'
import { registerComateStatusRoute, type ComateCheckInput, type ComateSealInput } from './web-status.ts'

export { COMATE_PROVIDER, createComateAdapter, comateModelInput, type ComateAdapter } from './adapter.ts'
export { createComateShim, type ComateShim } from './shim.ts'
export { ComateCatalog, selectComateModels } from './catalog.ts'
export {
  asVolatile,
  COMATE_BASE_THINKING_LEVELS,
  COMATE_CATALOG_PATH,
  COMATE_CHECK_PATH,
  COMATE_CLIENT_NAME,
  COMATE_ENTRY_ID,
  COMATE_EXTRA_THINKING_LEVELS,
  COMATE_REFRESH_PATH,
  COMATE_SEALED_PREFIX,
  COMATE_SEAL_PATH,
  COMATE_SETTINGS_NS,
  COMATE_THINKING_LEVEL_WIRE,
  isSealedComateSecret,
  unwrapVolatile,
  unwrapVolatileDeep,
  type ComateCatalogAnswer,
  type ComateCheckOutcome,
  type ComateCheckReason,
  type ComateExtraThinkingLevel,
  type ComatePersistedModel,
  type ComateSealAnswer,
  type ComateSettingsValue,
} from './bridge.ts'
export {
  COMATE_CHECK_MAX_TOKENS,
  comateCheckBody,
  runComateCheck,
  safeMessage,
  type ComateCheckOptions,
} from './check.ts'
export {
  registerComateStatusRoute,
  type ComateActionDeps,
  type ComateCatalogDeps,
  type ComateCheckInput,
  type ComateSealInput,
} from './web-status.ts'
export {
  bindComateSettings,
  type ComateSettingsBinding,
  type ComateSettingsSurface,
} from './settings-surface.ts'
export {
  COMATE_CONFIG_ENV,
  COMATE_HOME_ENV,
  COMATE_SECRET_KEY_ENV,
  COMATE_SID_ENV,
  COMATE_DEFAULT_CONTEXT_WINDOW,
  COMATE_DEFAULT_MAX_TOKENS,
  ComateCredentialStore,
  defaultComateHome,
  defaultConfigCandidates,
  defaultSecretKeyFile,
  parseComateConfig,
  parseComateModel,
  type ComateAuthStatus,
  type ComateCandidateDiagnostics,
  type ComateCredential,
  type ComateDoctorReport,
  type ComateModel,
  type ComateSidResolution,
  type ComateSidStorage,
  type ComateStoreOptions,
} from './auth.ts'
export {
  COMATE_SECRET_DIRNAME,
  COMATE_SECRET_KEY_FILENAME,
  isSealed,
  machineFingerprint,
  openSecret,
  sealSecret,
  type ComateOpenFailure,
  type ComateOpenResult,
  type ComateSecretOptions,
} from './secret.ts'
export {
  classifyUpstreamError,
  ComateUpstreamClient,
  prepareChatBody,
  type ComateChatResult,
  type UpstreamErrorKind,
} from './upstream.ts'
export {
  COMATE_ASSET_BASE_ENV,
  ComatePresignUploader,
  decodeImageDataUrl,
  downloadUrlExpiry,
  resolveAssetBase,
  type ComateAssetUploader,
} from './assets.ts'
export {
  emptyImageStats,
  emptyUploadStats,
  normalizeChatImages,
  sanitizeImageSource,
  uploadChatImages,
  type ImageSanitizeStats,
  type ImageUploadStats,
} from './multimodal.ts'
export { COMATE_CONNECT_VERSION } from './version.ts'
export {
  COMATE_MAX_TOKENS_ENV,
  COMATE_UNLIMITED_MAX_TOKENS,
  comateConfiguredMaxTokens,
  comateModelMaxTokens,
  parseMaxOutputTokens,
  parseMaxTokensByModel,
  resolveComateMaxTokens,
  resolveMaxOutputTokens,
  unusableModelTokens,
  type ComateMaxTokensQuery,
  type ComateMaxTokensResolution,
  type ComateMaxTokensSource,
} from './max-tokens.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-connect-comate'

/** The model registry and settings store required before the provider can register. */
export const inject = ['llm', 'settings']

/** Plugin configuration. */
export interface Config {
  /** Explicit Comate config-file path, overriding env and platform defaults. */
  configFile?: string
  /**
   * Manual WPS login cookie value: the `wps_sid` from www.wps.cn cookies
   * (paste the value only, without the `wps_sid=` prefix). The desktop
   * config stores placeholders, so v0.1 needs this for llmproxy to accept
   * the request.
   */
  wpsSid?: string
  /** Authenticate with the Cookie alone (drop the Authorization bearer). */
  cookieOnly?: boolean
  /**
   * @deprecated The host no longer publishes the discovered directory through
   * settings (on 0.1.7 that write would target the user's own
   * `cordis.patch.yml`). The card reads it from the read-only
   * `COMATE_CATALOG_PATH` route instead. The field is still declared so a
   * config written by 0.1.x keeps validating.
   */
  lastCatalog?: ComatePersistedModel[]
  /**
   * Explicitly enabled model ids. Empty/absent means "show every discovered
   * model"; once the card saves a non-empty selection, only those models are
   * registered into DSH's model list.
   */
  enabledModelIds?: string[]
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
  maxOutputTokens?: number
  /**
   * Per-model overrides of {@link Config.maxOutputTokens}, keyed by model id.
   *
   * Written by the card's per-model cap boxes. An entry is `0` for "no cap for
   * this model"; a model with no entry follows the global field, so removing an
   * override means deleting its key. Blank entries are never stored, which is
   * what keeps the settings document readable.
   */
  maxOutputTokensByModel?: Record<string, number>
  /**
   * Display-name overrides, keyed by model id.
   *
   * Cosmetic by construction: the alias replaces the descriptor's `name` — what
   * DSH's model picker paints — while the id stays untouched. So a rename can
   * never invalidate a saved {@link Config.maxOutputTokensByModel} entry or an
   * `agent-default-model` choice, and clearing a box (or writing an empty value)
   * means "no alias", not "an empty name".
   */
  modelAliases?: Record<string, string>
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
  extraThinkingLevels?: string[]
}

const persistedModelConfig = z.object({
  id: z.string().required(),
  name: z.string().required(),
  multimodal: z.boolean(),
  contextWindow: z.number().step(1).min(1),
})

/**
 * The four fields the card writes. Each one is declared volatile so 0.1.7's
 * write gate (`volatileForm` non-empty, then `isVolatilePath` per written path)
 * accepts it; on 0.1.5 `asVolatile` is an identity no-op and the schema stays
 * exactly the shape that line validated before.
 */
export const Config: z<Config> = z.object({
  configFile: z.string().description('WPS Comate config.json 路径（默认 ~/.wpscomate/config.json）'),
  wpsSid: asVolatile(z.string().description(
    '手动填写的 WPS 登录 Cookie：打开 www.wps.cn → F12 → Application → Cookies 取 wps_sid 的值（只填值，不带 "wps_sid=" 前缀）。卡片里以密码框呈现（只显示圆点、不可复制），保存时由宿主加密成 enc:v1: 密文再写入本文件，因此这里通常是一串密文而非明文。',
  )),
  cookieOnly: asVolatile(z.boolean().description('只使用 Cookie 鉴权（不发送 Authorization 头）；上游报 API 密钥无效时开启')),
  lastCatalog: z.array(persistedModelConfig).default([]).description('已弃用：宿主不再回写目录，卡片改从只读路由读取'),
  enabledModelIds: asVolatile(z.array(z.string()).default([]).description('勾选启用的模型 id；留空表示全部启用')),
  maxOutputTokens: asVolatile(z.number().step(1).min(0).default(COMATE_DEFAULT_MAX_TOKENS).description(
    '输出 token 上限（默认值，所有模型共用）：正整数为上限，0 表示不设上限（由上游决定）；单个模型可在 maxOutputTokensByModel 里覆盖；环境变量 WPS_COMATE_MAX_TOKENS 存在时优先于两者生效',
  )),
  maxOutputTokensByModel: asVolatile(z.dict(z.number().step(1).min(0)).default({}).description(
    '按模型 id 覆盖输出 token 上限：正整数为上限，0 表示该模型不设上限；未列出的模型跟随 maxOutputTokens',
  )),
  modelAliases: asVolatile(z.dict(z.string()).default({}).description(
    '按模型 id 设置显示名别名：只改 DSH 模型选择器里显示的名字，不改 id（请求、输出上限表、default-model 用的都是 id）；值留空即撤销该别名',
  )),
  extraThinkingLevels: asVolatile(z.array(z.string()).default([]).description(
    '额外开放的思考档位（off / xhigh / max 的子集，默认不开放；基础档位 minimal/low/medium/high 始终提供）。off 实测能真正关掉思考，但打开它也会让「provider default」变成不思考；xhigh/max 实测被上游接受、效果与 high 无差别',
  )),
})

/** Convert a discovered Comate model into the card-facing shape. */
function toPersistedModel(model: ComateModel): ComatePersistedModel {
  return {
    id: model.id,
    name: model.name,
    multimodal: comateModelInput(model).includes('image'),
    contextWindow: model.contextWindow,
  }
}

/**
 * Start the loopback endpoint, register the `comate` provider, and seed the
 * model catalog from the desktop client's own config.
 */
export function apply(ctx: Context, config: Config): void {
  const store = new ComateCredentialStore()
  const client = new ComateUpstreamClient()
  const catalog = new ComateCatalog()
  // 一个实例 = 一份上传缓存：同一张图（多轮里每轮都会重发）只上传一次。
  const uploader = new ComatePresignUploader()
  const shim = createComateShim({ store, client, catalog, uploader, logger: ctx.logger })

  /**
   * Live read of the configured output cap for one model (`0` = no cap).
   *
   * Read per call rather than captured, so a saved card value applies to the
   * next request. Precedence and the `0` spelling live in `max-tokens.ts`:
   * env → that model's own entry → the global field → 32000.
   */
  const outputCap = (modelId: string): number => resolveComateMaxTokens({
    modelId,
    byModel: current().maxOutputTokensByModel,
    configValue: current().maxOutputTokens,
  }).value

  let stopped = false
  ctx.effect(() => () => { stopped = true })

  let discovered: readonly ComateModel[] = []
  let persistedCatalog: ComatePersistedModel[] = []
  let signedIn = false
  let providerRegistered = false
  let invalidateCatalog = (): void => {}
  let lastConfigFile = config.configFile
  let warnedNoAttachments = false

  /**
   * Say out loud which output cap is in force, once per change.
   *
   * Three cases deserve a line: a value that was set but unusable (otherwise a
   * mistyped `WPS_COMATE_MAX_TOKENS` — or a hand-edited per-model entry — would
   * silently do nothing), and an env value overriding a differing saved card
   * value (otherwise the card would look broken). An ordinary save, or the plain
   * default, logs nothing.
   */
  let lastCapNote = ''
  const reportOutputCap = (settings: Config): void => {
    const resolution = resolveMaxOutputTokens(settings.maxOutputTokens)
    // What the settings field says, env ignored: only needed to spot an override.
    const saved = resolveMaxOutputTokens(settings.maxOutputTokens, {}).value
    const overrides = parseMaxTokensByModel(settings.maxOutputTokensByModel)
    const refused = unusableModelTokens(settings.maxOutputTokensByModel)
    const note = `${resolution.source}:${resolution.value}:${String(saved)}:${overrides.size}:${refused.length}`
    if (note === lastCapNote) return
    lastCapNote = note
    if (resolution.ignored !== undefined) {
      ctx.logger.warn(
        `dsh-connect-comate: ignoring the unusable ${COMATE_MAX_TOKENS_ENV} value`
        + ` (${JSON.stringify(resolution.ignored.raw)}); the output cap falls back to the settings field`,
      )
    }
    if (resolution.source === 'env' && saved !== resolution.value) {
      ctx.logger.warn(
        `dsh-connect-comate: ${COMATE_MAX_TOKENS_ENV} overrides the saved output cap`
        + ` (${resolution.value} instead of ${saved}; 0 means no cap)`,
      )
    }
    // A dropped entry is one model's setting that could not be read. Naming the
    // model is the only way the user can find it: the card renders that box
    // empty, which looks exactly like "never set".
    for (const entry of refused) {
      ctx.logger.warn(
        `dsh-connect-comate: ignoring the unusable output cap for model "${entry.modelId}"`
        + ` (${JSON.stringify(entry.raw)}); that model follows the global cap`,
      )
    }
  }

  /** Live view over the plugin's own configuration section. */
  let current: () => Config = () => config

  /**
   * Live read of one model's display-name alias (`undefined` = discovered name).
   *
   * Read per call, like the output cap, so a saved rename reaches the picker on
   * the next catalog read instead of the next restart. The parsing rules are
   * shared with the card (`model-alias.ts`), so the map the card writes and the
   * map this reads can never disagree about what a blank value means.
   */
  const modelAlias = (modelId: string): string | undefined =>
    modelAliasOf(parseModelAliases(current().modelAliases), modelId)

  /**
   * Live read of the manually enabled extra thinking levels.
   *
   * Empty means "offer exactly the base four" — the 0.4.1-rc.2 picker — and
   * an unreadable entry is dropped rather than taking the whole list down with
   * it, so a typo in one level cannot hide the other two.
   */
  const extraThinkingLevels = (): ComateExtraThinkingLevel[] =>
    parseExtraThinkingLevels(current().extraThinkingLevels)

  /**
   * Say out loud which alias / thinking-level entries could not be read.
   *
   * Same reasoning as the output-cap pass below: a dropped entry is invisible in
   * the card (the box renders empty, the level renders unchecked, which looks
   * exactly like "never set"), so the log is the only place that can name it.
   * The note is the refused entries THEMSELVES rather than their count: two
   * different typos both have length 1, and the second one still deserves a
   * line.
   */
  let lastTuningNote = ''
  const reportModelTuning = (settings: Config): void => {
    const refusedAliases = unusableModelAliases(settings.modelAliases)
    const refusedLevels = unusableThinkingLevels(settings.extraThinkingLevels)
    const note = JSON.stringify([refusedAliases, refusedLevels])
    if (note === lastTuningNote) return
    lastTuningNote = note
    for (const entry of refusedAliases) {
      ctx.logger.warn(
        `dsh-connect-comate: ignoring the unusable alias for model "${entry.modelId}"`
        + ` (${JSON.stringify(entry.raw)}); that model keeps the name Comate reported`,
      )
    }
    for (const entry of refusedLevels) {
      ctx.logger.warn(
        `dsh-connect-comate: ignoring the unusable thinking level ${JSON.stringify(entry)};`
        + ` extraThinkingLevels accepts only ${COMATE_EXTRA_THINKING_LEVELS.join(', ')}`,
      )
    }
  }

  /**
   * Say out loud how the stored `wps_sid` is protected, once per change.
   *
   * Two states deserve a line. A value written by an older version is still
   * plaintext in a file the user may well share or commit — the card upgrades it,
   * but a headless run never opens the card, so the log is the only place that can
   * say so. A sealed value that cannot be opened (key file deleted, replaced, or
   * copied from another machine) otherwise presents as a plain 401, which is the
   * worst failure shape here: it looks like the upstream refusing a perfectly
   * good sid.
   */
  let lastSidNote = ''
  const reportSidStorage = async (): Promise<void> => {
    let resolution: ComateSidResolution
    try {
      resolution = await store.resolveSid()
    } catch (error: unknown) {
      ctx.logger.warn('dsh-connect-comate: could not inspect the stored wps_sid', error)
      return
    }
    const note = `${resolution.storage}:${resolution.problem ?? ''}`
    if (note === lastSidNote) return
    lastSidNote = note
    if (resolution.storage === 'unreadable') {
      ctx.logger.error(
        `dsh-connect-comate: the stored wps_sid is sealed but cannot be decrypted (${resolution.problem});`
        + ` the key file ${resolution.keyFile} is missing, unreadable, or was created for another machine/user.`
        + ' Paste the sid again in the plugin card, or point WPS_COMATE_SECRET_KEY_FILE at the right key file.',
      )
    } else if (resolution.storage === 'plaintext') {
      ctx.logger.warn(
        'dsh-connect-comate: the stored wps_sid is still plaintext in the DSH settings document;'
        + ' open the plugin card once (or run `dsh plugin exec dsh-connect-comate seal`) to store it sealed',
      )
    }
  }

  /** Rebuild the runtime catalog from discovery plus the enabled-id set. */
  const republish = (): void => {
    const enabled = new Set(current().enabledModelIds ?? [])
    catalog.set(selectComateModels(discovered, enabled))
    // The card publishes the FULL discovered directory, not the filtered
    // selection: the whole point of the checkbox list is to offer every model
    // that is not currently enabled.
    persistedCatalog = discovered.map(toPersistedModel)
    invalidateCatalog()
  }

  /** Push the resolved settings into the credential store and runtime catalog. */
  const applySettings = (): void => {
    const next = current()
    store.setConfigFile(next.configFile)
    store.setWpsSid(next.wpsSid)
    store.setCookieOnly(next.cookieOnly === true)
    reportOutputCap(next)
    reportModelTuning(next)
    // Fire-and-forget: it only logs, and a settings change must not wait on file
    // I/O (the key file may live on a slow or missing path).
    void reportSidStorage()
    republish()
    if (next.configFile !== lastConfigFile) {
      lastConfigFile = next.configFile
      void rediscover()
    }
  }

  /**
   * Re-read the local Comate config and republish the directory.
   *
   * Never rejects: a signed-out machine must still register the provider (with
   * an empty catalog) so the card can explain what to do, and the
   * `configFile`-change path calls this fire-and-forget — a rejection there
   * would surface as an unhandled rejection instead of a warning.
   */
  const rediscover = async (): Promise<void> => {
    try {
      const credential = await store.resolve()
      discovered = credential.models
      signedIn = true
    } catch (error: unknown) {
      discovered = []
      signedIn = false
      ctx.logger.warn(
        'dsh-connect-comate: no signed-in WPS Comate credential; provider registered with an empty catalog'
        + ' (run `dsh plugin exec dsh-connect-comate doctor`)',
        error,
      )
    }
    republish()
  }

  // --- Settings surface: probe the two DSH lines, never assume one. --------
  //
  // A plugin that assumes 0.1.7 fails to mount on 0.1.5 and vice versa, and the
  // failure mode is total (no provider, no card) while looking exactly like
  // "the plugin is broken". Both lines expose `settings` to `inject`, so the
  // service is present either way and only its SHAPE tells the lines apart.
  const binding = bindComateSettings(ctx, Config, config, () => { if (!stopped) applySettings() })
  if (binding === undefined) return
  const settingsNs = binding.settingsNs
  current = () => binding.current()
  applySettings()

  ctx.effect(() => () => {
    void shim.close()
  })

  /**
   * The model the card's connection probe should use.
   *
   * The first ENABLED model, so the probe exercises a route the user actually
   * intends to use. An empty enabled set means "every discovered model", so this
   * degrades to the directory's first entry exactly when nothing is filtered.
   */
  const enabledFirstModel = (): string | undefined =>
    selectComateModels(discovered, new Set(current().enabledModelIds ?? []))[0]?.id

  /**
   * Probe the connection with the card's (possibly unsaved) draft inputs.
   *
   * The draft never touches the store: `store.current(override)` applies it to
   * this one read, so pressing 「测试连接」 cannot change what the plugin uses, and
   * two concurrent probes cannot contaminate each other.
   *
   * Never throws — a failed probe is an answer the card renders.
   */
  const checkConnection = async (input: ComateCheckInput): Promise<ComateCheckOutcome> => {
    const credential = await store.current({
      ...input.wpsSid === undefined ? {} : { wpsSid: input.wpsSid },
      ...input.cookieOnly === undefined ? {} : { cookieOnly: input.cookieOnly },
    })
    if (credential === undefined) return { ok: false, reason: 'no-credential' }
    const model = input.model ?? enabledFirstModel() ?? credential.models[0]?.id
    if (model === undefined) return { ok: false, reason: 'no-model' }
    return runComateCheck({ credential, client, model })
  }

  registerComateStatusRoute(ctx, {
    models: () => persistedCatalog,
    signedIn: () => signedIn,
    providerRegistered: () => providerRegistered,
    // Reported host-side because the browser cannot tell a sealed value that
    // opens from one whose key file is gone. Resolved live (one key-file stat
    // plus HKDF per catalog read) rather than cached: the card reads this right
    // after a save, which is exactly when a cached answer would be stale.
    sidState: async () => {
      const resolved: ComateSidResolution = await store.resolveSid()
      return resolved.problem === undefined
        ? { storage: resolved.storage }
        : { storage: resolved.storage, problem: resolved.problem }
    },
  }, {
    // The same re-read the startup path uses, so a refresh can never diverge
    // from what a restart would have discovered.
    refresh: rediscover,
    check: checkConnection,
    // Sealing is the store's job, not the route's: the store owns the key file
    // and the sealing path, so the CLI (`seal`) and the card produce byte-identical
    // envelopes for the same input.
    seal: (input: ComateSealInput) => input.fromStored === true
      ? store.sealStored()
      : store.seal(input.sid ?? ''),
  })

  void shim.ready
    .then(async () => {
      if (stopped) return
      try {
        // Constructed only once the listener holds a port: the provider's
        // models read the shim origin at construction time.
        const comate = createComateAdapter({
          shim,
          catalog,
          // The output cap is the one request knob this route owns; read live so
          // a saved card value applies without a restart. `invalidate()` is still
          // required when it changes: the profile's `configuredMaxTokens` — what
          // the harness turns into the request's `max_tokens` — is rebuilt there.
          maxOutputTokens: outputCap,
          // Renaming and the level list both land in the model descriptors, so
          // they ride the same live-read + `invalidate()` path as the cap: the
          // catalog republish that follows a save is what pushes them out.
          modelAlias,
          extraThinkingLevels,
          // The durable attachment service is a HOST service: it owns the
          // stored bytes of every image the user attached, and pi-ai's context
          // builder reads them through it and nowhere else. An image whose
          // service is missing therefore fails the whole request with
          // `UNSUPPORTED_CONTENT` — the host's own pi-ai route wires the same
          // pair. Resolved lazily per request, because the plugin that provides
          // it may mount after this one; the warn is one-shot so a machine that
          // never has it does not turn every image request into log noise.
          attachments: () => {
            const attachments = ctx.get('attachments')
            if (attachments === undefined && !warnedNoAttachments) {
              warnedNoAttachments = true
              ctx.logger.warn(
                'dsh-connect-comate: the host durable attachment service is unavailable; image input'
                + ' will fail with UNSUPPORTED_CONTENT (text requests are unaffected)',
              )
            }
            return attachments
          },
          // Only the text handle printed beside an image; the bytes travel
          // through the attachment service either way.
          toProcessPath: (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath),
          onReplayDegrade: ({ provider, model, reason }) => {
            ctx.logger.warn(
              `dsh-connect-comate: unusable replay state on assistant history for route`
              + ` "${provider}/${model}"; sending that message as provider-neutral content (${reason})`,
            )
          },
        })
        invalidateCatalog = () => { comate.invalidate() }

        let releaseAdapter: (() => void) | undefined
        let releaseConfigurable: (() => void) | undefined
        try {
          releaseAdapter = ctx.llm.registerAdapter([COMATE_PROVIDER], comate.adapter)
          releaseConfigurable = ctx.llm.registerConfigurableProviders([{
            provider: COMATE_PROVIDER,
            displayName: 'WPS Comate',
            // 0.1.7 keys provider configuration surfaces by the Loader entry id
            // (same rule `dsh-llm-deepseek` follows); 0.1.5 by the namespace the
            // plugin registered above.
            settingsNs,
            settingsPath: [],
            declared: false,
          }])
        } finally {
          if (releaseAdapter === undefined || releaseConfigurable === undefined) {
            // Registration threw; release whichever half landed.
            releaseAdapter?.()
            releaseConfigurable?.()
          }
        }
        ctx.effect(() => () => {
          releaseAdapter?.()
          releaseConfigurable?.()
        })
        providerRegistered = true
      } catch (error: unknown) {
        ctx.logger.error('dsh-connect-comate: provider registration failed', error)
        return
      }

      // Seed discovery from the locally signed-in Comate config.
      await rediscover()
    })
    .catch((error: unknown) => {
      ctx.logger.error('dsh-connect-comate: loopback endpoint failed to start; provider not registered', error)
    })
}
