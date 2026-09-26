/**
 * DSH 标题生成请求的预算修复（方案 A）。
 *
 * 背景（真机实测，2026-09-26）：
 *
 *   DSH 的 `dsh-session-title-first-prompt-llm` 发起标题请求时固定
 *   `max_tokens=64`，而 Comate 网关对多数推理模型把 `max_tokens` 当作
 *   **总预算（含 reasoning/thinking）**。标题任务的思考 token 超过 64 后
 *   `finish_reason=length`、正文为 0，DSH 把这次的失败静默吞掉，只剩
 *   fallback 的首条消息截断标题——表现就是「任务完成后没写标题」。
 *
 *   实测各模型思考量（标题任务、max_tokens=64）：deepseek-v4-pro ~109
 *   字符、MiniMax-M3 ~262、mimo-v2.5(-pro) ~240-252、glm-5.2 ~249、
 *   glm-5.3 ~268——全部吃光 64 直接 length；deepseek-v4.1-flash 思考
 *   波动（~164）跨过 64 就偶发失败。预算提到 1024 后这些模型均正常出
 *   正文；mimo 系的思考随预算膨胀（256→1121 字符、512→2189 仍 length），
 *   单独调预算救不了，由 {@link applyTitleReasoningFix} 的
 *   `reasoning_effort: "off"` 处理（关掉思考直接出标题）；glm-5.3 不吃
 *   任何关思考的拼写，只认预算，两者互为兜底。
 *
 * 实现：只识别 DSH 标题请求（system 含固定文案 `Create a concise
 * title ...`），把 `max_tokens` 从小于 {@link COMATE_TITLE_MAX_TOKENS}
 * 的任意值提到 1024。普通任务请求的 system 不会命中，一字不动。
 *
 * @module dsh-connect-comate/title-fix
 */

/** 标题请求的预算下限：低于它的会被提到这个值。真机验证 1024 对 v4-pro /
 * MiniMax-M3 / glm-5.2 / glm-5.3 均足够（思考量级约 100-300 token）。 */
export const COMATE_TITLE_MAX_TOKENS = 1024

/**
 * DSH 标题 system 的固定文案片段。宽松匹配（忽略大小写、允许空白差异），
 * 宿主改了措辞小变体也能命中；正常任务 prompt 不会包含这句话。
 */
const TITLE_SYSTEM_RE = /create\s+a\s+concise\s+title/i

/** 一次标题预算改写的观测结果。 */
export interface TitleBudgetFixResult {
  /** 改写后的请求体（JSON 字符串；未命中或无需改写时与入参相同）。 */
  body: string
  /** 是否命中标题请求特征。 */
  matched: boolean
  /** 命中时的原 `max_tokens`（缺失/非法时为 undefined）。 */
  before?: number
  /** 命中且被提升后的 `max_tokens`。 */
  after?: number
}

/** 消息 content 可能是 string 或 OpenAI 内容块数组，统一取文本。 */
function messageText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map(part => (typeof part === 'object' && part !== null && 'text' in part
        ? String((part as { text: unknown }).text)
        : ''))
      .join('')
  }
  return ''
}

/**
 * 解析请求体并判定是否 DSH 标题请求。不抛错：
 * 任何解析失败 / 结构怪异都返回 `matched: false`。
 */
function inspectTitleRequest(source: string): {
  obj?: Record<string, unknown>
  matched: boolean
} {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return { matched: false }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { matched: false }
  }
  const obj = body as Record<string, unknown>
  if (!Array.isArray(obj['messages'])) return { matched: false }

  const matched = obj['messages'].some(message => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return false
    const msg = message as Record<string, unknown>
    return msg['role'] === 'system' && TITLE_SYSTEM_RE.test(messageText(msg['content']))
  })
  return matched ? { obj, matched } : { matched: false }
}

/**
 * 识别 DSH 标题请求并提升其 `max_tokens` 预算。
 *
 * 纯函数、不抛错：任何解析失败都原样返回（`matched: false`），与
 * `prepareChatBody` 的容错风格一致——shim 的聊天数据路径不许因为一个
 * 辅助改写挂掉整个请求。
 */
export function applyTitleBudgetFix(source: string): TitleBudgetFixResult {
  const { obj, matched } = inspectTitleRequest(source)
  if (!matched || obj === undefined) return { body: source, matched: false }

  const current = obj['max_tokens']
  if (typeof current !== 'number' || !Number.isFinite(current) || current < 1) {
    return { body: source, matched: true }
  }
  if (current >= COMATE_TITLE_MAX_TOKENS) {
    return { body: source, matched: true, before: current }
  }
  obj['max_tokens'] = COMATE_TITLE_MAX_TOKENS
  return {
    body: JSON.stringify(obj),
    matched: true,
    before: current,
    after: COMATE_TITLE_MAX_TOKENS,
  }
}

/** 一次标题请求「关思考」改写的观测结果。 */
export interface TitleReasoningFixResult {
  /** 改写后的请求体（未命中 / 无需改写时与入参相同）。 */
  body: string
  /** 是否命中标题请求特征。 */
  matched: boolean
  /** 是否注入了 `reasoning_effort: "off"`。 */
  injected: boolean
  /** 命中时请求里已有的 `reasoning_effort` 值（注入前）。 */
  existing?: string
}

/**
 * 识别 DSH 标题请求并注入 `reasoning_effort: "off"`（方案 B）。
 *
 * 预算提升（方案 A）救不了思考随预算膨胀的模型（mimo 系实测 256→1121、
 * 512→2189 字符仍 length）；关掉思考后它们直接输出标题。对已显式携带
 * `reasoning_effort` 的请求不覆盖（DSH 现在不传，但将来传了就尊重它）。
 * 网关不认 off 的模型（glm-5.3 实测不吃任何关思考拼写）由预算方案兜底，
 * 注入本身无害。
 */
export function applyTitleReasoningFix(source: string): TitleReasoningFixResult {
  const { obj, matched } = inspectTitleRequest(source)
  if (!matched || obj === undefined) return { body: source, matched: false, injected: false }

  const existing = obj['reasoning_effort']
  if (existing !== undefined) {
    return {
      body: source,
      matched: true,
      injected: false,
      existing: typeof existing === 'string' ? existing : String(existing),
    }
  }
  obj['reasoning_effort'] = 'off'
  return { body: JSON.stringify(obj), matched: true, injected: true }
}
