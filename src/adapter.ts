/**
 * The `comate` pi-ai provider: one loopback-backed adapter registered
 * into the Harness LLM seam, assembled from public `dsh-llm-pi-ai`
 * extension points.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — pi-ai provider 的装配方式（createProvider + openAICompletionsApi +
 *     inert auth plane + 用 shim 的进程内 secret 作为 apiKey）由该项目
 *     （转引自 corrinehu/dsh-workbuddy-connect，MIT）实现并验证。
 * 改动：模型描述符的多模态由 Comate config 的 llm_types 判定
 *   （`llm-multimodal` → 图片输入），而非用户手动勾选；输出上限用
 *   COMATE_DEFAULT_MAX_TOKENS（config 无 max-output 字段）。
 *   `llm_types` 在真机上是**数组**（本机 10 个模型里 5 个带多模态标记），
 *   归一化在 `auth.ts` 的 `parseLlmTypes`；出站图片的线形状修正在
 *   `multimodal.ts`（实测网关对裸字符串/假 base64/svg 会静默给空正文）。
 *
 * @module dsh-connect-comate/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, Provider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { COMATE_DEFAULT_MAX_TOKENS, COMATE_MULTIMODAL_TYPE, type ComateModel } from './auth.ts'
import type { ComateCatalog } from './catalog.ts'
import type { ComateShim } from './shim.ts'

/** Provider route this bundle owns. */
export const COMATE_PROVIDER = 'comate'

/** Provider idle ceiling while one stream read is outstanding. */
export const COMATE_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Image-request budgets at the dsh-llm-pi-ai defaults; the profile type made
 * them required in 0.1.1-rc.2.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

/**
 * Inert pi-ai auth plane. The comate route authenticates only through the
 * shim shared secret resolved per request by `resolveApiKey`, so pi-ai's own
 * credential lifecycle and ambient discovery must never manufacture a
 * credential for it. `PiAiAdapterOptions.auth` is required since 0.1.1-rc.2;
 * every ambient question here answers "nothing stored, nothing set".
 */
const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('dsh-connect-comate: the comate route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/** Constructor dependencies. */
export interface ComateAdapterOptions {
  shim: ComateShim
  catalog: ComateCatalog
}

/** What {@link createComateAdapter} hands back. */
export interface ComateAdapter {
  adapter: PiAiAdapter
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void
}

/**
 * pi-ai input modalities: images only when Comate advertises `llm-multimodal`.
 *
 * `llmTypes` 是数组（见 `auth.ts` 的 `parseLlmTypes`）。真机 10 个模型里 5 个带
 * `llm-multimodal`，网关也确认接受 base64 图片（`multimodal.ts` 里有实测表），
 * 所以这个函数是「DSH 允许附图片」的唯一开关。
 */
export function comateModelInput(model: ComateModel): ('text' | 'image')[] {
  return model.llmTypes?.includes(COMATE_MULTIMODAL_TYPE) === true
    ? ['text', 'image']
    : ['text']
}

/**
 * Thinking levels this route offers, and the wire value each one sends.
 *
 * Measured against the live gateway (2026-09, this machine), not guessed:
 *
 * - every value in the OpenAI `reasoning_effort` vocabulary is ACCEPTED (HTTP
 *   200, no 400) on `llmproxy/v1/user/chat/completions`;
 * - the no-parameter baseline ALWAYS returns `reasoning_content`, i.e. these
 *   models think by default;
 * - `'off'` genuinely turns thinking off — `reasoning_content` drops to zero
 *   chars on all five models probed (deepseek-v4-flash/-pro, MiniMax-M3,
 *   mimo-v2.5, mimo-v2.5-pro);
 * - `'high'` is the value the Comate desktop client itself sends;
 * - `xhigh` and `max` are accepted but their semantics for these models could
 *   not be established locally, so they are pinned to `null` (not offered)
 *   rather than presented as a level whose effect nobody measured.
 *
 * ## Why `off` is NOT offered, even though the gateway honours it
 *
 * `dsh-llm-pi-ai` rewrites an `off` choice to "omit the option" before pi-ai
 * ever sees it — `profileOptions()` does `reasoning === 'off' ? undefined :
 * reasoning` (`lib/index.js:1671`, fed from `resolveReasoningLevel(model,
 * options.reasoningEffort ?? profile.reasoning)` at :1847). So an `off` entry
 * here would never be consulted: the request would carry no reasoning
 * parameter, the gateway would keep thinking ON (its measured default), and the
 * picker would have said "off". That is a lie about behaviour, so `off` is
 * pinned to `null` and the honest "send nothing" choice is the picker's own
 * "provider default".
 */
export const COMATE_THINKING_LEVEL_MAP = {
  off: null,
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: null,
  max: null,
} as const

/**
 * Build one pi-ai model descriptor pointing at the loopback shim.
 *
 * Exported so the reasoning declaration can be asserted against the REAL
 * descriptor rather than a copy of it: `getSupportedThinkingLevels()` on this
 * object is exactly what the model picker offers.
 *
 * @param info - one catalog entry.
 * @param baseUrl - the shim origin plus `/v1`.
 * @returns the pi-ai model descriptor.
 */
export function comatePiModel(info: ComateModel, baseUrl: string): Model<Api> {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: COMATE_PROVIDER,
    baseUrl,
    input: comateModelInput(info),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: COMATE_DEFAULT_MAX_TOKENS,
    // Every model in the local catalog reasons by default (the baseline probe
    // always returned `reasoning_content`), and all of them accept the effort
    // parameter, so the capability is declared rather than withheld.
    reasoning: true,
    thinkingLevelMap: COMATE_THINKING_LEVEL_MAP,
    compat: {
      supportsReasoningEffort: true,
      // Named explicitly: pi-ai otherwise auto-detects the reasoning wire format
      // from `baseUrl`, and this route's baseUrl is a loopback shim that says
      // nothing about the upstream. `'openai'` is the plain `reasoning_effort`
      // field, which is the spelling the gateway was measured to accept.
      thinkingFormat: 'openai',
    },
  } as unknown as Model<Api>
}

/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read so the shim's
 * ephemeral port applies from the first snapshot after startup.
 */
export function createComateAdapter(options: ComateAdapterOptions): ComateAdapter {
  const { shim, catalog } = options

  const buildModels = (): Model<Api>[] => {
    // The OpenAI SDK pi-ai drives appends `/chat/completions` to baseURL,
    // so the shim's routes line up with the `/v1` prefix in place.
    const baseUrl = `${shim.baseUrl()}/v1`
    return catalog.current().map(info => comatePiModel(info, baseUrl))
  }

  const base = createProvider({
    id: COMATE_PROVIDER,
    name: 'WPS Comate',
    auth: {
      apiKey: {
        name: 'WPS Comate loopback bearer',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'Comate' }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })

  // `getModels` is delegated to a live read (the reuse-catalog pattern from
  // dsh-llm-pi-ai): stream dispatch still runs through the constructed
  // provider, while the catalog answer tracks the config refresh.
  const provider: Provider = { ...base, getModels: () => buildModels() }

  const profile: ResolvedPiAiProviderProfile = {
    provider: COMATE_PROVIDER,
    displayName: 'WPS Comate',
    streamIdleTimeoutMs: COMATE_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-comate retryPolicy'),
    configuredMaxTokens: new Map(),
    // Per-model failures gate every request: `modelOf` throws INVALID_CONFIG
    // for any id present here. The comate catalog is built from live reads,
    // so an empty map is the accurate answer — no known-bad model.
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[COMATE_PROVIDER, profile]])

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    // Resolve the shim's per-process shared secret as the OpenAI apiKey so
    // pi-ai sends it as `Authorization: Bearer <shared-secret>`. The shim
    // validates this before forwarding and resolves the real Comate apiKey
    // itself via the store, so the secret never reaches upstream.
    resolveApiKey: async () => shim.token(),
  })

  return {
    adapter,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[COMATE_PROVIDER, profile]])
    },
  }
}
