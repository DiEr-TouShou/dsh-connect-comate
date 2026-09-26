/**
 * Which thinking levels this route offers, and what each one sends.
 *
 * 背景：`dsh-llm-pi-ai` 把「可选档位」和「发什么值」两件事都压在模型描述符的
 * `thinkingLevelMap` 上（`getSupportedThinkingLevels()` 决定选择器列出哪些，
 * pi-ai 的 openai-completions 用它把档位翻成 `reasoning_effort`）。所以本插件
 * 能做的只有一件事：**决定那张表里每个档位是 `null`（不提供）还是线值**。
 *
 * 默认表 = 四个基础档位照原样发 + `off` / `xhigh` / `max` 三个档位钉成 `null`
 * （不提供）。用户手动打开的那几个档位会被填上线值——线值本身以及为什么是这些
 * 值（`none` 实测无效、`xhigh`/`max` 实测与 `high` 无差别、以及打开 `off` 会连带
 * 改掉「不指定档位」的含义）都记在 `bridge.ts` 的
 * {@link COMATE_THINKING_LEVEL_WIRE} 上，那里是**两半共用**的唯一一份事实。
 *
 * 本模块只负责「把设置里那个字符串数组读成一张干净的档位集合」，外加一个可被
 * 测的纯函数式建表。设置字段本身可能来自手写的 `cordis.patch.yml`，所以容错规则
 * 与 `max-tokens.ts` 同款：坏条目**只丢自己**，并把「丢了什么」交出去给宿主打日志。
 *
 * @module dsh-connect-comate/thinking-levels
 */

import {
  COMATE_BASE_THINKING_LEVELS,
  COMATE_EXTRA_THINKING_LEVELS,
  COMATE_THINKING_LEVEL_WIRE,
  type ComateExtraThinkingLevel,
} from './bridge.ts'

/**
 * pi-ai 认得的全部档位。
 *
 * 这里拼的是**联合类型**，不是选择器的顺序：选择器列什么、按什么顺序列，都由
 * pi-ai 自己的 `EXTENDED_THINKING_LEVELS` 决定（`['off', 'minimal', 'low',
 * 'medium', 'high', 'xhigh', 'max']`），我们只能决定每一项是 `null`（不提供）
 * 还是线值。所以打开 `off` 的效果是它出现在选择器**最上面**，而不是末尾。
 */
const ALL_LEVELS = [...COMATE_BASE_THINKING_LEVELS, ...COMATE_EXTRA_THINKING_LEVELS]

/** pi-ai 的一个思考档位。 */
export type ComateThinkingLevel = (typeof ALL_LEVELS)[number]

/**
 * Re-exported so a consumer of this module does not have to know that the extra
 * levels' *type* is declared next to their vocabulary in `bridge.ts`.
 */
export type { ComateExtraThinkingLevel }

/** `thinkingLevelMap` 的取值：线值，或 `null` 表示「不提供这个档位」。 */
export type ComateThinkingLevelMap = Readonly<Record<ComateThinkingLevel, string | null>>

/**
 * The default table: the four base levels send themselves, the three extra ones
 * are not offered.
 *
 * 这是「用户什么都没打开」时的表，也是 0.4.1-rc.2 的行为——所以它必须逐字节
 * 不变，否则升级会悄悄改掉所有人的选择器。
 */
export const COMATE_THINKING_LEVEL_MAP: ComateThinkingLevelMap = buildThinkingLevelMap([])

/**
 * Build the table for one set of manually enabled extra levels.
 *
 * 基础四个永远照原样发（它们就是 OpenAI 的词汇表本身）；`extra` 里的档位填
 * {@link COMATE_THINKING_LEVEL_WIRE} 的线值，其余三个保持 `null`。未在 `extra`
 * 里出现的档位**显式**钉成 `null` 而不是留空：pi-ai 对 `xhigh` / `max` 的缺省
 * 判定与基础档位相反（缺省 = 不支持），显式写出来两边才一致。
 *
 * @param extra - the manually enabled levels; unknown entries are ignored.
 * @returns the `thinkingLevelMap` a model descriptor must carry.
 */
export function buildThinkingLevelMap(
  extra: readonly ComateExtraThinkingLevel[],
): ComateThinkingLevelMap {
  const enabled = new Set<string>(extra)
  const map: Record<string, string | null> = {}
  for (const level of COMATE_BASE_THINKING_LEVELS) map[level] = level
  for (const level of COMATE_EXTRA_THINKING_LEVELS) {
    map[level] = enabled.has(level) ? COMATE_THINKING_LEVEL_WIRE[level] : null
  }
  return map as ComateThinkingLevelMap
}

/**
 * Read the `extraThinkingLevels` field into the levels it actually names.
 *
 * 容错：非数组读作「什么都没打开」（默认行为）；数组里的条目逐个校验，认不出的
 * 丢掉、其余照用——一个手打错的档位名不该让整份设置失效，更不该让插件装配失败。
 * 重复项去重，并按 {@link COMATE_EXTRA_THINKING_LEVELS} 的顺序归一化：选择器里
 * 的先后由这张表决定，不由用户在 YAML 里敲的顺序决定。
 *
 * @param value - the raw settings field.
 * @returns the enabled levels, ordered as the card shows them.
 */
export function parseExtraThinkingLevels(value: unknown): ComateExtraThinkingLevel[] {
  if (!Array.isArray(value)) return []
  const named = new Set(
    value.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim()),
  )
  return COMATE_EXTRA_THINKING_LEVELS.filter(level => named.has(level))
}

/**
 * The entries {@link parseExtraThinkingLevels} refused, in the field's own order.
 *
 * 与 `max-tokens.ts` 的 `unusableModelTokens` 同一个理由：被丢掉的条目在卡片里
 * 表现为「没勾」，与「从没勾过」长得一模一样，只有日志能把它们分开。
 *
 * 这一层不是多虑：`z.array(z.string())` 只要求是字符串，所以 `[off, xhight]`
 * 这种拼错能过 schema 校验、一路走到这里。
 *
 * @param value - the raw settings field.
 * @returns one record per unusable entry (the raw value, deduplicated).
 */
export function unusableThinkingLevels(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return value === undefined || value === null ? [] : [value]
  }
  const known = new Set<string>(COMATE_EXTRA_THINKING_LEVELS)
  const refused: unknown[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && known.has(entry.trim())) continue
    if (!refused.some(seen => seen === entry)) refused.push(entry)
  }
  return refused
}
