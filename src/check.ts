/**
 * The minimal-request connectivity check, shared by the CLI (`check`) and the
 * plugin card's 「测试连接」 action.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 「一次最小请求验证凭据」的做法沿用自该项目。
 * 改动：把这段逻辑从 `bin.ts` 抽出来，让命令行与卡片走同一份实现——两处各写
 *   一遍的话，卡片测通、命令行测不通（或反之）会变成无法复现的「玄学问题」。
 *   v0.4.2：脱敏规则从本模块搬到零依赖的 `./redact.ts`（规则本身也补齐了
 *   Bearer / JSON 形状），因为常驻聊天路径 `shim.ts` 也要用同一份——规则留在这里
 *   的话 shim 要么引不到、要么得抄一份。`safeMessage` 从这里再导出，保持既有 API。
 *
 * @module dsh-connect-comate/check
 */

import type { ComateCredential } from './auth.ts'
import type { ComateCheckOutcome } from './bridge.ts'
import { safeMessage } from './redact.ts'
import type { ComateUpstreamClient } from './upstream.ts'

/**
 * The probe's request and answer shapes live in `./bridge.ts` (dependency free)
 * because the card renders them; re-exported here as this module's own API.
 */
export type { ComateCheckOutcome, ComateCheckReason } from './bridge.ts'

/**
 * The redaction helper now lives in the zero-dependency `./redact.ts`; re-exported
 * here because `bin.ts` and the tests have always imported it from this module.
 */
export { safeMessage } from './redact.ts'

/**
 * Output budget of the probe request. Small on purpose: the point is to learn
 * whether the credential is accepted, not to generate anything.
 */
export const COMATE_CHECK_MAX_TOKENS = 8

/**
 * The probe request body.
 *
 * Deliberately minimal and fixed: `stream: true` because the Comate gateway
 * always streams, one short user turn, and a tiny output budget. The CLI and
 * the card send these same bytes, so a passing card check means exactly what a
 * passing `check` command means.
 *
 * @param model - the model id to probe.
 * @returns the JSON request body.
 */
export function comateCheckBody(model: string): string {
  return JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'ping' }],
    stream: true,
    max_tokens: COMATE_CHECK_MAX_TOKENS,
  })
}

/** What {@link runComateCheck} needs; the credential is resolved by the caller. */
export interface ComateCheckOptions {
  credential: ComateCredential
  client: Pick<ComateUpstreamClient, 'chatStream'>
  /** Model id to probe. */
  model: string
  signal?: AbortSignal
}

/**
 * Send one minimal chat request and report what happened.
 *
 * Never throws: every failure mode is an answer the caller renders, because
 * "the probe failed" is a normal outcome of pressing a test button.
 *
 * @param options - credential, client, and the model to probe.
 * @returns the observed outcome.
 */
export async function runComateCheck(options: ComateCheckOptions): Promise<ComateCheckOutcome> {
  const { credential, client, model, signal } = options
  const result = await client.chatStream(credential, comateCheckBody(model), signal)
  if (result.ok) {
    // Drain the stream so the connection is released even though the body is
    // of no interest: a probe must not leave a socket half-read.
    try {
      await result.response.body?.cancel()
    } catch {
      // A stream that already ended needs no cancellation.
    }
    return { ok: true, model }
  }
  return {
    ok: false,
    model,
    status: result.status,
    kind: result.kind,
    message: safeMessage(result.message),
  }
}
