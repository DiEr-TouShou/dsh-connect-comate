/**
 * WPS Comate upstream client: OpenAI-compatible chat streaming against the
 * Comate `llmproxy` gateway.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 强制 stream:true、tool_choice 压平为字符串、developer→system 改写、
 *     错误分类（hard_credit / soft_rate / session_dead / ...）的做法沿用自
 *     该项目（其上游协议参照 Sliverkiss/workbuddy2api，MIT）。
 *
 * 端点依据（本机实测，2026-09）：
 *   WPS Comate 桌面端 config.json `providers.official` 给出的
 *   baseUrl = https://comate.wps.cn/llmproxy/v1/user，
 *   api = openai-completions；桌面端 sdk-v2-adapter 的请求头清单为
 *   Cookie / X-Comate-Scene / X-Comate-Version / X-Request-Id / X-Session-Id，
 *   authHeader=true（apiKey 走 Authorization）。
 *   chat 请求路径 = {baseUrl}/chat/completions，SSE 流式返回。
 *   X-Comate-Scene / X-Comate-Version 的具体取值需实机抓包确认；
 *   服务端通常容忍缺失或旧版本，README 将其列为第一待验证项。
 *
 * @module dsh-connect-comate/upstream
 */

import { randomUUID } from 'node:crypto'
import type { ComateCredential } from './auth.ts'
import type { UpstreamErrorKind } from './bridge.ts'

/**
 * Upstream failure classes the shim maps onto distinct HTTP answers.
 *
 * The union itself lives in `./bridge.ts` so the browser half can name these
 * classes without importing this module (and its `node:crypto`). Re-exported
 * here because this is where the classification happens.
 */
export type { UpstreamErrorKind } from './bridge.ts'

/** Chat answer: either a live SSE response or a classified failure. */
export type ComateChatResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; kind: UpstreamErrorKind; message: string }

const COMATE_ORIGIN = 'https://comate.wps.cn'
const COMATE_UA = 'WPSComate/2.0 (compatible; dsh-connect-comate)'
const ERROR_BODY_LIMIT = 4096

/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS: readonly string[] = [
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

/** Session-invalidation markers that mean "sign in again in the Comate client". */
const SESSION_DEAD_MARKERS: readonly string[] = [
  'Offline user session not found', '12153', 'session expired', 'not logged in', 'unauthorized',
]

/** Classify an upstream failure from its HTTP status and body excerpt. */
export function classifyUpstreamError(status: number, body: string): UpstreamErrorKind {
  if (status === 402) return 'hard_credit'
  const lower = body.toLowerCase()
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return 'hard_credit'
  }
  for (const marker of SESSION_DEAD_MARKERS) {
    if (body.includes(marker)) return 'session_dead'
  }
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'client'
}

/**
 * Normalize an OpenAI chat-completions body for the Comate upstream:
 * force `stream: true` (the Comate client streams SSE) and flatten
 * `tool_choice` (object forms are a common 400 source on custom gateways).
 * `developer` role is rewritten to `system` defensively; if the gateway
 * rejects `system`, remove this rewrite and re-test.
 */
export function prepareChatBody(source: string): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const obj = body as Record<string, unknown>
  obj['stream'] = true
  if (Array.isArray(obj['messages'])) {
    for (const value of obj['messages']) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const message = value as Record<string, unknown>
      if (message['role'] === 'developer') message['role'] = 'system'
    }
  }
  normalizeToolChoice(obj)
  return JSON.stringify(obj)
}

/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj: Record<string, unknown>): void {
  const suppress = (): void => {
    delete obj['tools']
    delete obj['functions']
  }
  const present = 'tool_choice' in obj
  if (!present) return
  const choice: unknown = obj['tool_choice']
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete obj['tool_choice']
      suppress()
    }
    return
  }
  if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
    const wrapped = choice as Record<string, unknown>
    const type = typeof wrapped['type'] === 'string' ? wrapped['type'].trim().toLowerCase() : ''
    if (type === 'none') {
      delete obj['tool_choice']
      suppress()
    } else if (type === 'auto' || type === 'required') {
      obj['tool_choice'] = type
    } else if (type === 'function') {
      const fn = typeof wrapped['function'] === 'object' && wrapped['function'] !== null
        ? (wrapped['function'] as Record<string, unknown>)
        : undefined
      let name = typeof fn?.['name'] === 'string' ? fn['name'] : ''
      if (name === '' && typeof wrapped['name'] === 'string') name = wrapped['name']
      name = name.trim()
      obj['tool_choice'] = name !== '' ? name : 'auto'
    } else {
      delete obj['tool_choice']
    }
    return
  }
  delete obj['tool_choice']
}

/** Headers every chat request carries; values beyond auth are best-effort. */
function chatHeaders(credential: ComateCredential): Record<string, string> {
  return {
    'Accept': 'text/event-stream, application/json',
    'Content-Type': 'application/json',
    'User-Agent': COMATE_UA,
    'Origin': COMATE_ORIGIN,
    'Referer': `${COMATE_ORIGIN}/`,
    // 依据桌面端 sdk-v2-adapter 的请求头清单；具体取值待实机验证。
    'X-Comate-Scene': 'localChat',
    'X-Comate-Version': '2.0',
    'X-Request-Id': randomUUID(),
    'X-Session-Id': randomUUID(),
    ...credential.authHeader ? { 'Authorization': `Bearer ${credential.apiKey}` } : {},
    ...credential.cookie === undefined ? {} : { 'Cookie': credential.cookie },
  }
}

/**
 * Upstream HTTP client. One instance serves the whole plugin; requests take
 * the credential explicitly so a config change applies on the next call.
 */
export class ComateUpstreamClient {
  /** POST the chat endpoint; a successful answer is the raw SSE response. */
  async chatStream(
    credential: ComateCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<ComateChatResult> {
    const base = credential.baseUrl.replace(/\/+$/, '')
    let response: Response
    try {
      response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: chatHeaders(credential),
        body: bodyJson,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) return { ok: true, response }
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, text),
      message: text,
    }
  }
}
