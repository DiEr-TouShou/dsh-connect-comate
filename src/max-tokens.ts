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
 * 优先级：`WPS_COMATE_MAX_TOKENS`（env）> 配置字段 `maxOutputTokens` > 32000 默认。
 * env 优先于卡片，是**故意**的：无头/脚本场景（`scripts/verify-*.mjs`、CI）必须
 * 能压过本机卡片里存的值，否则一个已保存的 32000 会让脚本里的覆盖静默失效。
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
export type ComateMaxTokensSource = 'env' | 'config' | 'default'

/** A candidate value that was present but unusable, reported rather than thrown. */
export interface ComateIgnoredMaxTokens {
  /** Which layer carried the unusable value. */
  layer: 'env' | 'config'
  /** The raw value, as read. */
  raw: unknown
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
 * Resolve the effective output cap.
 *
 * @param configValue - the settings field's value (`maxOutputTokens`).
 * @param env - environment to read {@link COMATE_MAX_TOKENS_ENV} from.
 * @returns the cap (0 = unlimited) and the layer that decided it.
 */
export function resolveMaxOutputTokens(
  configValue?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ComateMaxTokensResolution {
  const fromEnv = parseMaxOutputTokens(env[COMATE_MAX_TOKENS_ENV])
  if (fromEnv !== undefined) return { value: fromEnv, source: 'env' }
  const fromConfig = parseMaxOutputTokens(configValue)
  if (fromConfig !== undefined) {
    return { value: fromConfig, source: 'config', ...ignoredEnv(env) }
  }
  return { value: COMATE_DEFAULT_MAX_TOKENS, source: 'default', ...ignoredEnv(env) }
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
 * An unlimited cap yields an EMPTY map — the model is left out rather than
 * listed with 0, because a 0 in this map is what the harness would materialize
 * into `max_tokens: 0` (and because `defaultMaxTokens` must be a positive
 * integer where pi-ai validates it).
 *
 * @param ids - the model ids currently served by this route.
 * @param cap - the resolved cap (0 = unlimited).
 * @returns the map to hand to the pi-ai provider profile.
 */
export function comateConfiguredMaxTokens(
  ids: Iterable<string>,
  cap: number,
): Map<string, number> {
  const configured = new Map<string, number>()
  if (cap === COMATE_UNLIMITED_MAX_TOKENS) return configured
  for (const id of ids) configured.set(id, cap)
  return configured
}
