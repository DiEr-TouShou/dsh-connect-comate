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
 *   （`llm-multimodal` → 图片输入），而非用户手动勾选；输出上限由
 *   `max-tokens.ts` 解析（env / 每模型条目 / 全局字段，0 = 不设上限），同时落进
 *   描述符的 `maxTokens` 与 profile 的 `configuredMaxTokens`——只有后者会成为**真**
 *   上限（harness 的 `resolveCallWithInfo` 把它物化成 `config.maxTokens`），
 *   而且**逐个模型**解析：同一路由上的两个模型可以各用各的上限。
 *   `llm_types` 在真机上是**数组**（本机 10 个模型里 5 个带多模态标记），
 *   归一化在 `auth.ts` 的 `parseLlmTypes`；出站图片的线形状修正在
 *   `multimodal.ts`（实测网关对裸字符串/假 base64/svg 会静默给空正文）。
 *
 * @module dsh-connect-comate/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, Provider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { COMATE_DEFAULT_MAX_TOKENS, COMATE_MULTIMODAL_TYPE, type ComateModel } from './auth.ts'
import type { ComateCatalog } from './catalog.ts'
import { comateConfiguredMaxTokens, comateModelMaxTokens } from './max-tokens.ts'
import type { ComateShim } from './shim.ts'
import {
  COMATE_THINKING_LEVEL_MAP,
  buildThinkingLevelMap,
  type ComateExtraThinkingLevel,
} from './thinking-levels.ts'

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

/**
 * The durable attachment service the host's pi-ai adapter asks for.
 *
 * Derived from the adapter's own option type rather than imported from
 * `@deepseek-ai/dsh-attachment`: that package is host-bundled and outside this
 * plugin's dependency set, and the derived type is exact where the package is
 * present and `any` where it is not — never a wrong shape.
 */
export type ComateAttachmentService =
  NonNullable<ReturnType<NonNullable<PiAiAdapterOptions['resolveAttachments']>>>

/** Constructor dependencies. */
export interface ComateAdapterOptions {
  shim: ComateShim
  catalog: ComateCatalog
  /**
   * The host's durable attachment service (`ctx.get('attachments')`).
   *
   * pi-ai cannot inline an image the harness never stored: its context builder
   * reads the durable bytes through this service and nothing else, so an
   * unwired accessor (or one that resolves nothing) makes the adapter reject
   * every message carrying an image with `UNSUPPORTED_CONTENT` — which is
   * exactly the failure the `image` modality we advertise must not have.
   */
  attachments?: () => ComateAttachmentService | undefined
  /**
   * Map one stored image's host path into the current tool execution world.
   *
   * Only shapes the text handle beside the image; the bytes travel through
   * {@link ComateAdapterOptions.attachments} either way.
   */
  toProcessPath?: (hostPath: string) => string | undefined
  /** Observe one assistant history message degrading to provider-neutral replay. */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
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
  maxOutputTokens?: (modelId: string) => number
  /**
   * Live read of one model's display-name alias, or `undefined` to keep the
   * discovered name.
   *
   * Live for the same reason as {@link ComateAdapterOptions.maxOutputTokens},
   * and it needs the same `invalidate()`: the name is baked into the descriptor
   * `getModels()` returns, so a saved rename reaches the picker on the next
   * catalog read rather than the next restart.
   */
  modelAlias?: (modelId: string) => string | undefined
  /**
   * Live read of the manually enabled extra thinking levels.
   *
   * Global rather than per model (one picker, one list), and empty means "offer
   * exactly the base four" — see {@link ComateModelTuning}. Same `invalidate()`
   * requirement: which levels exist is part of the descriptor too.
   */
  extraThinkingLevels?: () => readonly ComateExtraThinkingLevel[]
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
 * The table itself lives in `./thinking-levels.ts` (re-exported here because
 * this is the module a reader of the model descriptors lands on); the measured
 * facts behind each wire value — why `off` is spelled `'off'` and not `'none'`,
 * why `xhigh`/`max` are opt-in, and why offering `off` also changes what an
 * unnamed effort means — are documented once, on
 * `COMATE_THINKING_LEVEL_WIRE` in `bridge.ts`.
 */
export { COMATE_THINKING_LEVEL_MAP }

/**
 * The two per-model knobs that are not part of the discovered catalog.
 *
 * Both are already RESOLVED by the caller: the adapter takes values, not
 * settings fields, so the parsing rules (and their warnings) stay in one place
 * and the descriptor stays a pure function of what it is handed.
 */
export interface ComateModelTuning {
  /** Display-name override; `undefined` keeps the discovered name. */
  alias?: string | undefined
  /**
   * Manually enabled extra thinking levels.
   *
   * Empty or omitted means "offer exactly the base four" and reuses the frozen
   * {@link COMATE_THINKING_LEVEL_MAP} object identity — so a deployment that
   * turns nothing on gets the 0.4.1-rc.2 descriptor byte for byte.
   */
  extraThinkingLevels?: readonly ComateExtraThinkingLevel[] | undefined
}

/**
 * Build one pi-ai model descriptor pointing at the loopback shim.
 *
 * Exported so the reasoning declaration can be asserted against the REAL
 * descriptor rather than a copy of it: `getSupportedThinkingLevels()` on this
 * object is exactly what the model picker offers.
 *
 * @param info - one catalog entry.
 * @param baseUrl - the shim origin plus `/v1`.
 * @param maxOutputTokens - the resolved output cap; `0` means "no cap", spelled
 * here as the model's own window because pi-ai refuses a non-positive
 * `maxTokens` (see `comateModelMaxTokens`).
 * @param tuning - the per-model display name and the route's extra thinking
 * levels; see {@link ComateModelTuning}.
 * @returns the pi-ai model descriptor.
 */
export function comatePiModel(
  info: ComateModel,
  baseUrl: string,
  maxOutputTokens: number = COMATE_DEFAULT_MAX_TOKENS,
  tuning: ComateModelTuning = {},
): Model<Api> {
  const extra = tuning.extraThinkingLevels ?? []
  return {
    id: info.id,
    // The alias only ever changes what the picker PAINTS. `id` above is what a
    // request, a `maxOutputTokensByModel` entry and `agent-default-model` all
    // address this model by, so renaming one can never invalidate a saved
    // choice — see `model-alias.ts`.
    name: tuning.alias ?? info.name,
    api: 'openai-completions',
    provider: COMATE_PROVIDER,
    baseUrl,
    input: comateModelInput(info),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: comateModelMaxTokens(maxOutputTokens, info.contextWindow),
    // Every model in the local catalog reasons by default (the baseline probe
    // always returned `reasoning_content`), and all of them accept the effort
    // parameter, so the capability is declared rather than withheld.
    reasoning: true,
    thinkingLevelMap: extra.length === 0 ? COMATE_THINKING_LEVEL_MAP : buildThinkingLevelMap(extra),
    compat: {
      supportsReasoningEffort: true,
      // Named explicitly: pi-ai otherwise auto-detects the reasoning wire format
      // from `baseUrl`, and this route's baseUrl is a loopback shim that says
      // nothing about the upstream. `'openai'` is the plain `reasoning_effort`
      // field, which is the spelling the gateway was measured to accept.
      thinkingFormat: 'openai',
      // Same reason, same detection gap: without this pi-ai falls back to
      // `max_completion_tokens`. Measured on the live gateway (2026-09, this
      // machine, `deepseek-v4-flash`): BOTH spellings are honoured —
      // `max_tokens: 16` and `max_completion_tokens: 16` each answer
      // `finish_reason=length` with 16 characters, while `max_tokens: 0` reads
      // as "no cap" (`finish_reason=stop`, the full 200-line answer).
      // `max_tokens` is the classic OpenAI spelling and the one this project's
      // live verification scripts already send, so the route declares it rather
      // than leaving it to detection.
      maxTokensField: 'max_tokens',
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

  /** Live read of the configured cap for one model; `0` means "no cap". */
  const outputCap = (modelId: string): number =>
    options.maxOutputTokens?.(modelId) ?? COMATE_DEFAULT_MAX_TOKENS

  const buildModels = (): Model<Api>[] => {
    // The OpenAI SDK pi-ai drives appends `/chat/completions` to baseURL,
    // so the shim's routes line up with the `/v1` prefix in place.
    const baseUrl = `${shim.baseUrl()}/v1`
    // Read once per build, not once per model: the level list is global, and a
    // per-model read would let one snapshot contain two different answers.
    const extraThinkingLevels = options.extraThinkingLevels?.() ?? []
    return catalog.current().map(info => comatePiModel(info, baseUrl, outputCap(info.id), {
      alias: options.modelAlias?.(info.id),
      extraThinkingLevels,
    }))
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

  /**
   * Build the profile snapshot: the catalog and the output cap are both read
   * fresh, because `configuredMaxTokens` is what the harness turns into the
   * request's `max_tokens` — a saved cap must land here, not only in the model
   * descriptors.
   */
  const buildProfile = (): ResolvedPiAiProviderProfile => ({
    provider: COMATE_PROVIDER,
    displayName: 'WPS Comate',
    streamIdleTimeoutMs: COMATE_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-comate retryPolicy'),
    // The real per-request cap, one entry per model. `dsh-llm-pi-ai`'s own
    // profile docs: a `configuredMaxTokens` entry is materialized into a request
    // that names no cap of its own — and the harness does exactly that in
    // `resolveCallWithInfo` (`config.maxTokens = info.defaultMaxTokens`). A model
    // whose cap is unlimited yields no entry at all, so nothing is materialized
    // for it while its neighbours keep theirs.
    configuredMaxTokens: comateConfiguredMaxTokens(
      catalog.current().map(info => [info.id, outputCap(info.id)] as const),
    ),
    // Per-model failures gate every request: `modelOf` throws INVALID_CONFIG
    // for any id present here. The comate catalog is built from live reads,
    // so an empty map is the accurate answer — no known-bad model.
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  })

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[COMATE_PROVIDER, buildProfile()]])

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    // Resolve the shim's per-process shared secret as the OpenAI apiKey so
    // pi-ai sends it as `Authorization: Bearer <shared-secret>`. The shim
    // validates this before forwarding and resolves the real Comate apiKey
    // itself via the store, so the secret never reaches upstream.
    resolveApiKey: async () => shim.token(),
    // Images: the harness keeps them as durable attachments, and pi-ai's
    // context builder is the only thing that turns one into request bytes.
    // Without this pair the adapter falls back to its text-only builder, which
    // throws `UNSUPPORTED_CONTENT` on any image — the whole advertised modality
    // is dead while every text request still looks healthy. Same wiring as the
    // host's own pi-ai provider, so the two routes agree on the seam.
    resolveAttachments: () => options.attachments?.(),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(attachments, (hostPath) => options.toProcessPath?.(hostPath), ref),
    ...options.onReplayDegrade === undefined ? {} : { onReplayDegrade: options.onReplayDegrade },
  })

  return {
    adapter,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[COMATE_PROVIDER, buildProfile()]])
    },
  }
}
