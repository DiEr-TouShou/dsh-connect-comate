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
import type { ComateModel } from './auth.ts'
import { ComateCredentialStore } from './auth.ts'
import { ComateCatalog, selectComateModels } from './catalog.ts'
import { createComateShim } from './shim.ts'
import { ComateUpstreamClient } from './upstream.ts'
import {
  asVolatile,
  type ComatePersistedModel,
} from './bridge.ts'
import { bindComateSettings } from './settings-surface.ts'
import { registerComateStatusRoute } from './web-status.ts'

export { COMATE_PROVIDER, createComateAdapter, comateModelInput, type ComateAdapter } from './adapter.ts'
export { createComateShim, type ComateShim } from './shim.ts'
export { ComateCatalog, selectComateModels } from './catalog.ts'
export {
  asVolatile,
  COMATE_CATALOG_PATH,
  COMATE_CLIENT_NAME,
  COMATE_ENTRY_ID,
  COMATE_SETTINGS_NS,
  unwrapVolatile,
  unwrapVolatileDeep,
  type ComatePersistedModel,
  type ComateSettingsValue,
} from './bridge.ts'
export {
  registerComateStatusRoute,
  type ComateCatalogAnswer,
  type ComateCatalogDeps,
} from './web-status.ts'
export {
  bindComateSettings,
  type ComateSettingsBinding,
  type ComateSettingsSurface,
} from './settings-surface.ts'
export {
  COMATE_CONFIG_ENV,
  COMATE_HOME_ENV,
  COMATE_SID_ENV,
  COMATE_DEFAULT_CONTEXT_WINDOW,
  COMATE_DEFAULT_MAX_TOKENS,
  ComateCredentialStore,
  defaultComateHome,
  defaultConfigCandidates,
  parseComateConfig,
  parseComateModel,
  type ComateAuthStatus,
  type ComateCandidateDiagnostics,
  type ComateCredential,
  type ComateDoctorReport,
  type ComateModel,
  type ComateStoreOptions,
} from './auth.ts'
export {
  classifyUpstreamError,
  ComateUpstreamClient,
  prepareChatBody,
  type ComateChatResult,
  type UpstreamErrorKind,
} from './upstream.ts'
export { COMATE_CONNECT_VERSION } from './version.ts'

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
}

const persistedModelConfig = z.object({
  id: z.string().required(),
  name: z.string().required(),
  multimodal: z.boolean(),
  contextWindow: z.number().step(1).min(1),
})

/**
 * The three fields the card writes. Each one is declared volatile so 0.1.7's
 * write gate (`volatileForm` non-empty, then `isVolatilePath` per written path)
 * accepts it; on 0.1.5 `asVolatile` is an identity no-op and the schema stays
 * exactly the shape that line validated before.
 */
export const Config: z<Config> = z.object({
  configFile: z.string().description('WPS Comate config.json 路径（默认 ~/.wpscomate/config.json）'),
  wpsSid: asVolatile(z.string().description(
    '手动填写的 WPS 登录 Cookie：打开 www.wps.cn → F12 → Application → Cookies 取 wps_sid 的值（只填值，不带 "wps_sid=" 前缀）',
  )),
  cookieOnly: asVolatile(z.boolean().description('只使用 Cookie 鉴权（不发送 Authorization 头）；上游报 API 密钥无效时开启')),
  lastCatalog: z.array(persistedModelConfig).default([]).description('已弃用：宿主不再回写目录，卡片改从只读路由读取'),
  enabledModelIds: asVolatile(z.array(z.string()).default([]).description('勾选启用的模型 id；留空表示全部启用')),
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
  const shim = createComateShim({ store, client, catalog, logger: ctx.logger })

  let stopped = false
  ctx.effect(() => () => { stopped = true })

  let discovered: readonly ComateModel[] = []
  let persistedCatalog: ComatePersistedModel[] = []
  let signedIn = false
  let providerRegistered = false
  let invalidateCatalog = (): void => {}
  let lastConfigFile = config.configFile

  /** Live view over the plugin's own configuration section. */
  let current: () => Config = () => config

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

  registerComateStatusRoute(ctx, {
    models: () => persistedCatalog,
    signedIn: () => signedIn,
    providerRegistered: () => providerRegistered,
  })

  void shim.ready
    .then(async () => {
      if (stopped) return
      try {
        // Constructed only once the listener holds a port: the provider's
        // models read the shim origin at construction time.
        const comate = createComateAdapter({ shim, catalog })
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
