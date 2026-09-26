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
 *   v0.4.2-rc.3：探测不再把「HTTP 200」当成功。旧实现拿到 2xx 就 `cancel()` 掉 body
 *   直接返回 ok，于是**空正文**和**流内 error**都显示成「连接成功」——上游只要
 *   肯回状态行，探测就绿。现在探测会真的读一段（有总预算、有字节上限）、解析
 *   SSE、识别流内错误，并把「鉴权通过 / 推理完成 / 内容可用」拆成三个独立事实
 *   （见 `bridge.ts` 的 `ComateCheckOutcome`）。
 *
 * @module dsh-connect-comate/check
 */

import type { ComateCredential } from './auth.ts'
import type { ComateCheckOutcome, UpstreamErrorKind } from './bridge.ts'
import { safeMessage } from './redact.ts'
import type { ComateUpstreamClient } from './upstream.ts'
import { classifyUpstreamError } from './upstream.ts'

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
 * Total wall-clock budget of one probe: the request AND the stream read.
 *
 * The probe is a handful of bytes each way and normally answers in under two
 * seconds; a thinking model spending its eight tokens can take longer. What the
 * budget is really for is the case where the upstream answers the status line
 * and then says nothing at all — without it, the test button spins forever.
 */
export const COMATE_CHECK_TIMEOUT_MS = 15_000

/**
 * How much of the probe stream is read at most.
 *
 * Reading the stream is only safe because it is bounded: a probe needs a few
 * chunks to see whether an event, a clean end and some text arrived, and a
 * stream that is still going after 64 KiB is not going to answer a question
 * this small.
 */
export const COMATE_CHECK_READ_LIMIT = 64 * 1024

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
  /** Override the total budget; the tests use a small value. */
  timeoutMs?: number
}

/**
 * Sentinel the read loop races its reads against.
 *
 * A plain `AbortSignal` is not enough on its own: aborting the fetch does kill
 * the socket on the real path, but the loop must also stop waiting when the
 * body in front of it ignores the abort (a stalled gateway, or a test's
 * synthetic stream). Racing a deadline covers both, and the abort is still sent
 * alongside it so the real socket is released rather than merely abandoned.
 */
const EXPIRED = Symbol('comate-probe-deadline')

/** One probe's clock, plus why the read stopped before a clean end. */
interface ProbeBudget {
  /** Wall-clock budget in milliseconds. */
  ms: number
  /** The budget ran out. */
  spent: boolean
  /** The caller's signal fired. */
  aborted: boolean
}

/** What one pass over the probe stream saw. Mutated in place, so a read that is cut short keeps its partial progress. */
interface ProbeObservation {
  /** Well-formed SSE events framed; `[DONE]` counts as one. */
  events: number
  /** A non-empty assistant text delta arrived. */
  content: boolean
  /** A non-empty reasoning delta arrived. */
  reasoning: boolean
  /** The stream reached an end of its own (`[DONE]`, `finish_reason`, or EOF). */
  ended: boolean
  /** The byte cap was hit instead of an end. */
  truncated: boolean
  /** An in-stream error payload, already classified. */
  error?: { kind: UpstreamErrorKind; message: string }
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
  const timeoutMs = options.timeoutMs ?? COMATE_CHECK_TIMEOUT_MS
  const controller = new AbortController()
  const budget: ProbeBudget = { ms: timeoutMs, spent: false, aborted: false }
  let expire: () => void = () => {}
  const expired = new Promise<typeof EXPIRED>((resolve) => { expire = () => resolve(EXPIRED) })
  const timer = setTimeout(() => {
    budget.spent = true
    expire()
    // Releases the real socket; the race in the read loop is what makes the
    // probe return even when the socket ignores this.
    controller.abort()
  }, timeoutMs)
  // The caller's abort has to end the read too, not just the socket — same
  // reason as the budget: a body that ignores the abort would otherwise keep
  // the probe waiting.
  const onAbort = (): void => {
    budget.aborted = true
    expire()
    controller.abort()
  }
  if (signal !== undefined) {
    // An already-aborted signal never fires again, so it has to be honoured
    // here rather than waited for.
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    // The request phase is raced against the budget for the same reason the
    // read phase is: aborting the fetch is how the socket is released, not what
    // makes the probe return. Without this, an upstream that never answers
    // would hang the probe forever — the original bug's other half.
    const step = await Promise.race([
      client.chatStream(credential, comateCheckBody(model), controller.signal),
      expired,
    ])
    if (step === EXPIRED) {
      return {
        ok: false,
        model,
        status: 0,
        kind: 'server',
        message: budget.aborted
          ? 'the probe was aborted before the upstream answered'
          : `probe timed out after ${timeoutMs}ms before the upstream answered`,
      }
    }
    const result = step
    if (!result.ok) {
      return {
        ok: false,
        model,
        status: result.status,
        kind: result.kind,
        message: safeMessage(result.message),
      }
    }
    return await observeProbe(model, result.response, budget, expired)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Read the probe stream and turn what it carried into an outcome.
 *
 * The branches mirror the order the gateway answers in: an error inside the
 * stream, then "nothing at all", then "started but never finished", then a
 * clean round trip. The first two are the shapes the old implementation
 * reported as success.
 *
 * @param model - the model the probe used, echoed into the outcome.
 * @param response - the 2xx response whose body is the SSE stream.
 * @param budget - this probe's clock, read after the read to tell a timeout from an EOF.
 * @param expired - the promise the read loop races against.
 */
async function observeProbe(
  model: string,
  response: Response,
  budget: ProbeBudget,
  expired: Promise<typeof EXPIRED>,
): Promise<ComateCheckOutcome> {
  const observation: ProbeObservation = {
    events: 0,
    content: false,
    reasoning: false,
    ended: false,
    truncated: false,
  }
  let readFailure: string | undefined
  try {
    if (response.body === null) readFailure = 'the response carried no body'
    else await readProbeStream(response.body, observation, expired)
  } catch (error: unknown) {
    readFailure = safeMessage(error)
  }

  const base = { model, status: response.status }

  // 1. An error inside the stream. The status line said 200, so this is the only
  //    place the gateway's real answer is visible — and it is where a dead
  //    session actually shows up (the gateway answers 200 and then says so).
  if (observation.error !== undefined) {
    return {
      ...base,
      ok: false,
      accepted: observation.error.kind !== 'session_dead',
      completed: false,
      content: observation.content,
      reasoning: observation.reasoning,
      kind: observation.error.kind,
      message: safeMessage(observation.error.message),
    }
  }

  // 2. HTTP 200 and not one event. This is the exact shape that used to read as
  //    「连接成功」: there is no evidence here that anything works.
  if (observation.events === 0) {
    return {
      ...base,
      ok: false,
      accepted: false,
      completed: false,
      content: false,
      reasoning: false,
      kind: 'server',
      message: cutoffReason(budget, observation, readFailure),
    }
  }

  // 3. Events arrived, but the stream never ended on its own terms. The
  //    credential is proven at this point; the round trip is not.
  if (!observation.ended) {
    return {
      ...base,
      ok: false,
      accepted: true,
      completed: false,
      content: observation.content,
      reasoning: observation.reasoning,
      kind: 'server',
      message: cutoffReason(budget, observation, readFailure),
    }
  }

  // 4. A clean round trip. `content` may still be false — see the outcome docs.
  return {
    ...base,
    ok: true,
    accepted: true,
    completed: true,
    content: observation.content,
    reasoning: observation.reasoning,
  }
}

/**
 * Why the read stopped before a clean end, in one line.
 *
 * Ordered by what the user can act on: a cancelled probe is not a fault, a
 * spent budget means a slow or silent upstream, the byte cap means a stream
 * that never ends, and anything left is the stream's own behaviour (a dead
 * socket, or an end with nothing in it).
 *
 * @param budget - the probe's clock.
 * @param observation - what the read got through.
 * @param readFailure - the read's own error text, when it threw.
 * @returns a redaction-safe one-line reason.
 */
function cutoffReason(
  budget: ProbeBudget,
  observation: ProbeObservation,
  readFailure: string | undefined,
): string {
  const progress = observation.events === 0
    ? 'without a single SSE event'
    : `with ${observation.events} event(s) read`
  if (budget.aborted) return `the probe was aborted ${progress}`
  if (budget.spent) return `probe timed out after ${budget.ms}ms ${progress}`
  if (observation.truncated) return `stopped reading after ${COMATE_CHECK_READ_LIMIT} bytes (${progress})`
  return readFailure ?? `the stream ended ${progress}`
}

/**
 * Frame the SSE stream and record what it carried.
 *
 * Deliberately not a general SSE parser: the probe only needs to know whether
 * an event arrived, whether one of them was an error, whether the stream
 * signalled a clean end, and whether any text came out. Unknown fields are
 * ignored, and a payload that is neither JSON nor `[DONE]` is ignored rather
 * than fatal — a probe should not fail because the gateway added a comment line.
 *
 * @param body - the probe response body.
 * @param observation - filled in place; a throw leaves the partial progress.
 * @param expired - resolves when the probe's budget is spent.
 */
async function readProbeStream(
  body: ReadableStream<Uint8Array>,
  observation: ProbeObservation,
  expired: Promise<typeof EXPIRED>,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let data: string[] = []
  let bytes = 0

  const flush = (): void => {
    if (data.length === 0) return
    const payload = data.join('\n')
    data = []
    absorbEvent(payload, observation)
  }

  try {
    for (;;) {
      // Racing rather than awaiting `read()` directly is what makes the budget
      // binding even when the body ignores the abort. A read left in flight by
      // the deadline is settled by the `cancel()` below.
      const step = await Promise.race([reader.read(), expired])
      if (step === EXPIRED) return
      if (step.done) break
      bytes += step.value.byteLength
      pending += decoder.decode(step.value, { stream: true })
      let index = pending.indexOf('\n')
      while (index >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, '')
        pending = pending.slice(index + 1)
        if (line === '') flush()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        // `event:` / `id:` / `retry:` / comments carry nothing the probe needs.
        index = pending.indexOf('\n')
      }
      // Both of these mean there is nothing left to learn: stop early so the
      // stream is released instead of read to its end.
      if (observation.error !== undefined || observation.ended) return
      if (bytes >= COMATE_CHECK_READ_LIMIT) {
        observation.truncated = true
        return
      }
    }
    // A stream may end without the blank line that closes its last event.
    flush()
    observation.ended = true
  } finally {
    // Release the socket whether the read finished, errored, or ran out of
    // budget: a probe must never leave a connection half-read.
    void reader.cancel().catch(() => {})
  }
}

/** Fold one SSE event payload into the observation. */
function absorbEvent(payload: string, observation: ProbeObservation): void {
  const text = payload.trim()
  if (text === '') return
  observation.events += 1
  if (text === '[DONE]') {
    observation.ended = true
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Not JSON. The gateway has been seen to end a live stream with a bare
    // diagnostic line, so a session-dead marker still counts as an error; junk
    // does not.
    if (classifyUpstreamError(200, text) === 'session_dead') {
      observation.error = { kind: 'session_dead', message: text }
    }
    return
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
  const frame = parsed as Record<string, unknown>
  const error = frame['error']
  if (error !== undefined && error !== null) {
    observation.error = { kind: classifyStreamError(text, error), message: text }
    return
  }
  const choices = frame['choices']
  if (!Array.isArray(choices)) return
  for (const choice of choices) {
    if (typeof choice !== 'object' || choice === null) continue
    const record = choice as Record<string, unknown>
    // `delta` for a streaming frame, `message` for a whole answer delivered in
    // one event; the probe does not care which shape the gateway chose.
    const carrier = record['delta'] ?? record['message']
    if (typeof carrier === 'object' && carrier !== null) {
      const delta = carrier as Record<string, unknown>
      if (nonEmptyText(delta['reasoning_content']) || nonEmptyText(delta['reasoning'])) observation.reasoning = true
      if (nonEmptyText(delta['content'])) observation.content = true
    }
    if (record['finish_reason'] !== undefined && record['finish_reason'] !== null) observation.ended = true
  }
}

/**
 * Classify an in-stream error payload.
 *
 * The HTTP status is 200 by definition here, so {@link classifyUpstreamError}
 * gets a synthetic status and works off the body's markers alone. That is also
 * why the gateway's own `"type":"authentication_error"` spelling is checked
 * separately: it is the shape the live gateway uses for an expired session, and
 * the marker list has no wording for it.
 *
 * @param text - the raw event payload.
 * @param error - the parsed `error` member, for the fields the markers miss.
 * @returns the classified kind.
 */
function classifyStreamError(text: string, error: unknown): UpstreamErrorKind {
  const classified = classifyUpstreamError(200, text)
  if (classified !== 'client') return classified
  if (typeof error === 'object' && error !== null) {
    const frame = error as Record<string, unknown>
    if (frame['type'] === 'authentication_error' || frame['code'] === 'not_login') return 'session_dead'
  }
  return classified
}

/** Whether a delta field actually carries text. */
function nonEmptyText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}
