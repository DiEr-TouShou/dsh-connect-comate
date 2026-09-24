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
 *
 * @module dsh-connect-comate/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, Provider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { COMATE_DEFAULT_MAX_TOKENS, type ComateModel } from './auth.ts'
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

/** pi-ai input modalities: images only when Comate advertises `llm-multimodal`. */
export function comateModelInput(model: ComateModel): ('text' | 'image')[] {
  return model.llmTypes !== undefined && model.llmTypes.includes('llm-multimodal')
    ? ['text', 'image']
    : ['text']
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info: ComateModel, baseUrl: string): Model<Api> {
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
    reasoning: false,
    compat: { supportsReasoningEffort: false },
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
    return catalog.current().map(info => toPiModel(info, baseUrl))
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
