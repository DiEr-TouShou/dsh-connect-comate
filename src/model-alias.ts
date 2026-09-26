/**
 * 模型别名：把本机 Comate config 里发现的名字换成一个用户自己认得出来的显示名。
 *
 * ## 别名只改「显示名」，不改 id
 *
 * DSH 的模型选择器画的是描述符的 `name`，而**请求、设置文档、逐模型上限表**用的
 * 都是 id。所以别名只在 {@link comatePiModel} 的 `name` 上落地，id 一字不动：
 * 给模型改个名不可能弄丢 `maxOutputTokensByModel` 里那条上限，也不可能让
 * `agent-default-model` 里存的 model 失效。
 *
 * ## 为什么这个模块不 import 任何东西
 *
 * 卡片（浏览器半）和宿主（node 半）必须用**同一份**解析规则，否则「卡片写进去的
 * 那张表」和「宿主读出来的那张表」会悄悄分叉——比如卡片 trim 了而宿主没 trim，
 * 于是一个只有空格的别名在界面上是「没设」，在配置里却是个真键。把规则放在这个
 * 零依赖模块里，两半 import 的是同一段代码，这种分叉就不可能发生。
 *
 * 容错规则与 `max-tokens.ts` 同款：坏条目只丢自己，并把「丢了什么」交出去给宿主
 * 打日志（{@link unusableModelAliases}）。
 *
 * @module dsh-connect-comate/model-alias
 */

/** 一张别名表：模型 id → 显示名。 */
export type ComateModelAliases = ReadonlyMap<string, string>

/**
 * Read the `modelAliases` field into the aliases it actually sets.
 *
 * 规则（两半共用，所以写在注释里当契约）：
 *
 * - 键和值都 trim；trim 后为空的键或值**都不进表**——空串不是「把名字改空」，
 *   而是「没有别名」，回落到发现名。这也是卡片里清空输入框能撤销别名的原因。
 * - 值不是字符串的条目丢掉，其余照用：手写 YAML 里的 `{id: 123}` 不该让整张表
 *   失效，更不该让插件装配失败。
 * - 用 `Map` 而不是普通对象：键来自上游给的模型 id，`__proto__` 这种键不该有机会
 *   碰到原型。
 *
 * @param value - the raw settings field.
 * @returns the usable aliases; empty when the field is absent or unreadable.
 */
export function parseModelAliases(value: unknown): ComateModelAliases {
  const aliases = new Map<string, string>()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return aliases
  for (const [rawId, rawName] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawName !== 'string') continue
    const id = rawId.trim()
    const name = rawName.trim()
    if (id === '' || name === '') continue
    aliases.set(id, name)
  }
  return aliases
}

/**
 * The entries {@link parseModelAliases} refused, in the field's own order.
 *
 * 被丢掉的条目在卡片里表现为「空框」，与「从没设过」长得一模一样；只有日志能把
 * 它们分开，所以宿主需要知道丢的是哪个模型、原值长什么样。
 *
 * @param value - the raw settings field.
 * @returns one record per unusable entry.
 */
export function unusableModelAliases(value: unknown): { modelId: string; raw: unknown }[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const refused: { modelId: string; raw: unknown }[] = []
  for (const [rawId, rawName] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawName === 'string' && rawName.trim() !== '' && rawId.trim() !== '') continue
    refused.push({ modelId: rawId, raw: rawName })
  }
  return refused
}

/**
 * One model's alias, or `undefined` to keep the discovered name.
 *
 * @param aliases - the parsed table.
 * @param modelId - the model the descriptor is being built for.
 */
export function modelAliasOf(aliases: ComateModelAliases, modelId: string): string | undefined {
  return aliases.get(modelId)
}

/**
 * A fingerprint of an alias map that ignores key order.
 *
 * 卡片问这张表的两个问题——「用户碰过没有」与「有没有东西要存」——都不能用原始文本
 * 回答：同一张表换个键序重建就会读成「变了」，而那种「保存失败」的提示用户根本没法
 * 处理。所以这里排序后 `JSON.stringify`：键序无关，且**转义安全**——别名是用户敲的
 * 任意文本，拼字符串当指纹的话 `{"a": "x\ny=z"}` 会和 `{"a": "x", "y": "z"}`
 * 撞在一起（一个多行别名就能撞），而 JSON 会把换行转义掉。
 *
 * @param aliases - the parsed table.
 */
export function aliasKey(aliases: ComateModelAliases): string {
  const pairs = [...aliases.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return JSON.stringify(pairs)
}
