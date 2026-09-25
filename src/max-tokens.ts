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

import { COMATE_DEFAULT_MAX_TOKENS } from './bridge.ts'

/**
 * Env var forcing the output cap, whatever the saved card value says.
 *
 * 正整数 = 上限，`0` = 不设上限；空值/非法值会被忽略并记在
 * {@link ComateMaxTokensResolution.ignored} 里（不抛错：一个打错的 env 不该让
 * 插件装配失败）。
 */
export const COMATE_MAX_TOKENS_ENV = 'WPS_COMATE_MAX_TOKENS'

/**
 * The value that means "no cap at all".
 *
 * 不是「上限为 0」：上游把它当作「没给这个字段」，harness 那边则表现为
 * **不物化** `config.maxTokens`（见 {@link comateConfiguredMaxTokens}）。
 */
export const COMATE_UNLIMITED_MAX_TOKENS = 0

/** Where the effective cap came from. */
export type ComateMaxTokensSource = 'env' | 'model' | 'config' | 'default'

/** A candidate value that was present but unusable, reported rather than thrown. */
export interface ComateIgnoredMaxTokens {
  /** Which layer carried the unusable value. */
  layer: 'env' | 'model' | 'config'
  /** The raw value, as read. */
  raw: unknown
  /**
   * The model whose entry was unusable. Only ever set with `layer: 'model'`:
   * the other two layers are global, so there is no model to name.
   */
  modelId?: string
}

/** The resolved cap plus how it was decided. */
export interface ComateMaxTokensResolution {
  /** Effective cap: a positive integer, or {@link COMATE_UNLIMITED_MAX_TOKENS}. */
  value: number
  /** Which layer decided it. */
  source: ComateMaxTokensSource
  /**
   * A higher-priority layer that carried a value this module refused to use
   * (`"abc"`, `-1`, `1.5`, …). Present so the caller can say so out loud instead
   * of leaving the user wondering why their setting did nothing.
   */
  ignored?: ComateIgnoredMaxTokens
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
export function parseMaxOutputTokens(value: unknown): number | undefined {
  const text = typeof value === 'string' ? value.trim() : undefined
  if (text !== undefined && text === '') return undefined
  const numeric = typeof value === 'number'
    ? value
    : text !== undefined
      ? Number(text)
      : undefined
  if (numeric === undefined || !Number.isSafeInteger(numeric) || numeric < 0) return undefined
  return numeric
}

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
export function parseMaxTokensByModel(value: unknown): Map<string, number> {
  const entries = new Map<string, number>()
  for (const [id, raw] of modelCapEntries(value)) {
    const cap = parseMaxOutputTokens(raw)
    if (cap !== undefined) entries.set(id, cap)
  }
  return entries
}

/**
 * The entries {@link parseMaxTokensByModel} had to drop.
 *
 * @param value - the raw settings field (`maxOutputTokensByModel`).
 * @returns one record per unusable entry, in the map's own order.
 */
export function unusableModelTokens(value: unknown): { modelId: string; raw: unknown }[] {
  const refused: { modelId: string; raw: unknown }[] = []
  for (const [id, raw] of modelCapEntries(value)) {
    if (parseMaxOutputTokens(raw) === undefined) refused.push({ modelId: id, raw })
  }
  return refused
}

/**
 * Iterate the field's own key/value pairs, skipping what is not a map at all.
 *
 * A blank key is skipped rather than kept: it names no model, so no request
 * could ever match it.
 */
function* modelCapEntries(value: unknown): Generator<[string, unknown]> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (id.trim() === '') continue
    yield [id, raw]
  }
}

/**
 * The raw entry for one model, or `undefined` when the field has none.
 *
 * Read through {@link modelCapEntries} rather than by index so a field that is
 * not a map at all (a string, an array) answers "no entry" instead of throwing
 * or matching a character index.
 */
function rawModelCap(value: unknown, modelId: string): unknown {
  for (const [id, raw] of modelCapEntries(value)) {
    if (id === modelId) return raw
  }
  return undefined
}

/** What {@link resolveComateMaxTokens} needs to answer for one model. */
export interface ComateMaxTokensQuery {
  /** The model being resolved. Absent = resolve the global default alone. */
  modelId?: string
  /** The per-model override map, as read from settings. */
  byModel?: unknown
  /** The settings field's global value (`maxOutputTokens`). */
  configValue?: unknown
  /** Environment to read {@link COMATE_MAX_TOKENS_ENV} from. */
  env?: NodeJS.ProcessEnv
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
export function resolveComateMaxTokens(query: ComateMaxTokensQuery = {}): ComateMaxTokensResolution {
  const env = query.env ?? process.env
  const fromEnv = parseMaxOutputTokens(env[COMATE_MAX_TOKENS_ENV])
  if (fromEnv !== undefined) return { value: fromEnv, source: 'env' }
  const envIgnored = ignoredEnv(env)
  if (query.modelId !== undefined) {
    const raw = rawModelCap(query.byModel, query.modelId)
    if (raw !== undefined) {
      const cap = parseMaxOutputTokens(raw)
      if (cap !== undefined) return { value: cap, source: 'model', ...envIgnored }
      // Unusable per-model entry: fall through to the global layers, but name the
      // model in the verdict so the caller's warning can point at the entry.
      return {
        ...globalOr(query.configValue, envIgnored),
        ignored: envIgnored.ignored ?? { layer: 'model', raw, modelId: query.modelId },
      }
    }
  }
  return globalOr(query.configValue, envIgnored)
}

/** The two global layers: the settings field, then the plugin default. */
function globalOr(
  configValue: unknown,
  extra: { ignored?: ComateIgnoredMaxTokens },
): ComateMaxTokensResolution {
  const fromConfig = parseMaxOutputTokens(configValue)
  if (fromConfig !== undefined) return { value: fromConfig, source: 'config', ...extra }
  return { value: COMATE_DEFAULT_MAX_TOKENS, source: 'default', ...extra }
}

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
export function resolveMaxOutputTokens(
  configValue?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ComateMaxTokensResolution {
  return resolveComateMaxTokens({ configValue, env })
}

/**
 * Report an env value that was set but unusable, so the fall-through to the
 * card's value is visible rather than silent.
 *
 * A blank value is NOT reported: `parseMaxOutputTokens` reads it as "absent", so
 * `WPS_COMATE_MAX_TOKENS=` (an empty assignment, or a CI variable expanded to
 * nothing) is a normal "not set" rather than a mistake worth a warning.
 */
function ignoredEnv(env: NodeJS.ProcessEnv): { ignored?: ComateIgnoredMaxTokens } {
  const raw = env[COMATE_MAX_TOKENS_ENV]
  if (raw === undefined || raw.trim() === '') return {}
  if (parseMaxOutputTokens(raw) !== undefined) return {}
  return { ignored: { layer: 'env', raw } }
}

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
export function comateModelMaxTokens(cap: number, contextWindow: number): number {
  return cap === COMATE_UNLIMITED_MAX_TOKENS ? contextWindow : cap
}

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
export function comateConfiguredMaxTokens(
  caps: Iterable<readonly [string, number]>,
): Map<string, number> {
  const configured = new Map<string, number>()
  for (const [id, cap] of caps) {
    if (cap === COMATE_UNLIMITED_MAX_TOKENS) continue
    configured.set(id, cap)
  }
  return configured
}
