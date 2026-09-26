import { describe, expect, it } from 'vitest'
import {
  COMATE_CHECK_MAX_TOKENS,
  COMATE_CHECK_READ_LIMIT,
  COMATE_CHECK_TIMEOUT_MS,
  comateCheckBody,
  runComateCheck,
  safeMessage,
  type ComateCheckOutcome,
  type ComateCheckOptions,
} from '../src/check.ts'
import type { ComateCredential } from '../src/auth.ts'
import type { ComateChatResult } from '../src/upstream.ts'

const CREDENTIAL: ComateCredential = {
  baseUrl: 'https://comate.wps.cn/llmproxy/v1/user',
  apiKey: 'placeholder-key',
  cookie: 'wps_sid=placeholder',
  authHeader: true,
  models: [{ id: 'model-a', name: 'A', contextWindow: 1_000_000 }],
  configFile: 'C:/fake/config.json',
}

/** A stub client recording what the probe sent. */
function stubClient(result: ComateChatResult) {
  const calls: Array<{ credential: ComateCredential; body: string; signal: AbortSignal | undefined }> = []
  return {
    calls,
    client: {
      async chatStream(
        credential: ComateCredential,
        body: string,
        signal?: AbortSignal,
      ): Promise<ComateChatResult> {
        calls.push({ credential, body, signal })
        return result
      },
    },
  }
}

/**
 * A Response whose body is a scripted SSE stream.
 *
 * `hang` keeps the stream open once the script runs out, which is how the
 * timeout cases are built: a body that never closes and never reacts to the
 * abort is exactly the shape the budget has to be able to cut through.
 *
 * @param chunks - the stream's payload, in order; strings are UTF-8 encoded.
 * @param options - `hang` to leave the stream open at the end.
 */
function sseResponse(chunks: readonly (string | Uint8Array)[], options: { hang?: boolean } = {}) {
  const encoder = new TextEncoder()
  let index = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        const chunk = chunks[index++]
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk as Uint8Array)
        return
      }
      if (options.hang === true) return new Promise<void>(() => {})
      controller.close()
    },
    cancel() { cancelled = true },
  })
  return {
    result: { ok: true, response: new Response(stream, { status: 200 }) } as ComateChatResult,
    wasCancelled: () => cancelled,
  }
}

/** One SSE data frame carrying an assistant delta. */
function contentFrame(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
}

/** Run the probe against a scripted answer, with a budget short enough for a test. */
function probe(result: ComateChatResult, options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  const stub = stubClient(result)
  const run = (): Promise<ComateCheckOutcome> => {
    const request: ComateCheckOptions = {
      credential: CREDENTIAL,
      client: stub.client,
      model: 'model-a',
      // Short by default: a test that hangs is a test that failed.
      timeoutMs: options.timeoutMs ?? 500,
    }
    if (options.signal !== undefined) request.signal = options.signal
    return runComateCheck(request)
  }
  return { stub, run }
}

describe('comateCheckBody', () => {
  it('sends the minimal request the CLI has always sent', () => {
    expect(JSON.parse(comateCheckBody('model-a'))).toEqual({
      model: 'model-a',
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
      max_tokens: COMATE_CHECK_MAX_TOKENS,
    })
  })

  it('keeps the output budget tiny: the probe is not a generation', () => {
    expect(COMATE_CHECK_MAX_TOKENS).toBe(8)
  })
})

describe('runComateCheck', () => {
  it('sends the probe request it has always sent', async () => {
    const { result } = sseResponse([contentFrame('pong'), 'data: [DONE]\n\n'])
    const { stub, run } = probe(result)
    await run()
    expect(stub.calls).toHaveLength(1)
    expect(JSON.parse(stub.calls[0]?.body ?? '')).toEqual(JSON.parse(comateCheckBody('model-a')))
  })

  it('reports a clean round trip as three separate facts', async () => {
    const { result } = sseResponse([
      contentFrame('pong'),
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ])
    const { run } = probe(result)
    await expect(run()).resolves.toEqual({
      ok: true,
      model: 'model-a',
      status: 200,
      accepted: true,
      completed: true,
      content: true,
      reasoning: false,
    })
  })

  it('passes a stream that ended cleanly without any text', async () => {
    // An eight-token budget and a thinking model: reasoning is a legitimate
    // answer, so 「没有文本」 must not be reported as a broken connection.
    const { result } = sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'hmm' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`,
    ])
    const { run } = probe(result)
    const outcome = await run()
    expect(outcome).toMatchObject({ ok: true, accepted: true, completed: true, content: false, reasoning: true })
  })

  it('releases the stream as soon as it has what it needs', async () => {
    const { result, wasCancelled } = sseResponse([
      contentFrame('hi'),
      'data: [DONE]\n\n',
      contentFrame('never read'),
    ])
    const { run } = probe(result)
    expect((await run()).ok).toBe(true)
    expect(wasCancelled()).toBe(true)
  })

  // ---- the two shapes the old implementation called 「连接成功」 ----

  it('refuses an empty 200 body', async () => {
    const { result } = sseResponse([])
    const { run } = probe(result)
    const outcome = await run()
    expect(outcome).toMatchObject({ ok: false, accepted: false, completed: false, status: 200, kind: 'server' })
    expect(outcome.message).toContain('without a single SSE event')
  })

  it('refuses a 200 response with no body at all', async () => {
    const { run } = probe({ ok: true, response: new Response(null, { status: 200 }) })
    const outcome = await run()
    expect(outcome).toMatchObject({ ok: false, accepted: false, status: 200, kind: 'server' })
    expect(outcome.message).toBe('the response carried no body')
  })

  it('refuses an error delivered inside a 200 stream', async () => {
    // The gateway answers 200 and *then* says the session is gone; the status
    // line alone would have read as success.
    const { result } = sseResponse([
      `data: ${JSON.stringify({ error: { message: '未登录，请先登录', type: 'authentication_error', code: 'not_login' } })}\n\n`,
    ])
    const { run } = probe(result)
    const outcome = await run()
    expect(outcome).toMatchObject({ ok: false, accepted: false, completed: false, status: 200, kind: 'session_dead' })
    expect(outcome.message).toContain('not_login')
  })

  it('keeps 「凭据已通过」 and 「请求失败」 apart for a non-auth in-stream error', async () => {
    const { result } = sseResponse([
      contentFrame('par'),
      `data: ${JSON.stringify({ error: { message: '积分不足', code: 'insufficient_credit' } })}\n\n`,
    ])
    const { run } = probe(result)
    const outcome = await run()
    expect(outcome).toMatchObject({ ok: false, accepted: true, completed: false, content: true, kind: 'hard_credit' })
  })

  it('reads a bare diagnostic line that names a dead session', async () => {
    const { result } = sseResponse(['data: Offline user session not found (12153)\n\n'])
    const { run } = probe(result)
    expect(await run()).toMatchObject({ ok: false, accepted: false, kind: 'session_dead' })
  })

  it('ignores a payload that is neither an event nor an error', async () => {
    const { result } = sseResponse([
      ': keep-alive\n\n',
      'event: ping\n\n',
      contentFrame('pong'),
      'data: [DONE]\n\n',
    ])
    const { run } = probe(result)
    expect((await run()).ok).toBe(true)
  })

  it('reassembles a character split across two chunks', async () => {
    // The gateway streams UTF-8 and does not care where the chunk boundary
    // lands; a probe that decodes per chunk would see mojibake and might miss
    // the content entirely.
    const encoder = new TextEncoder()
    const glyph = encoder.encode('好')
    const { result } = sseResponse([
      encoder.encode('data: {"choices":[{"delta":{"content":"'),
      glyph.slice(0, 1),
      glyph.slice(1),
      encoder.encode('"}}]}\n\n'),
      'data: [DONE]\n\n',
    ])
    const { run } = probe(result)
    expect(await run()).toMatchObject({ ok: true, content: true })
  })

  it('redacts an in-stream error before it leaves the host', async () => {
    const { result } = sseResponse([
      `data: ${JSON.stringify({ error: { message: 'rejected wps_sid=deadbeef and token=abcdef123456' } })}\n\n`,
    ])
    const { run } = probe(result)
    const outcome = await run()
    expect(outcome.message).not.toContain('deadbeef')
    expect(outcome.message).not.toContain('abcdef123456')
    expect(outcome.message).toContain('[redacted]')
  })

  // ---- the budget ----

  it('gives up on a stream that answers nothing', async () => {
    const { result, wasCancelled } = sseResponse([], { hang: true })
    const { run } = probe(result, { timeoutMs: 50 })
    const outcome = await run()
    expect(outcome).toMatchObject({ ok: false, accepted: false, status: 200, kind: 'server' })
    expect(outcome.message).toBe(`probe timed out after 50ms without a single SSE event`)
    expect(wasCancelled()).toBe(true)
  })

  it('gives up on a stream that starts and then goes quiet', async () => {
    const { result } = sseResponse([contentFrame('pong')], { hang: true })
    const { run } = probe(result, { timeoutMs: 50 })
    const outcome = await run()
    expect(outcome).toMatchObject({ ok: false, accepted: true, completed: false, content: true, kind: 'server' })
    expect(outcome.message).toBe('probe timed out after 50ms with 1 event(s) read')
  })

  it('gives up on a stream that never ends, without reading it to the end', async () => {
    const flood = Array.from({ length: 2_000 }, () => contentFrame('x'.repeat(40)))
    const { result } = sseResponse(flood, { hang: true })
    const { run } = probe(result, { timeoutMs: 5_000 })
    const outcome = await run()
    expect(outcome).toMatchObject({ ok: false, accepted: true, completed: false, content: true })
    expect(outcome.message).toContain(`after ${COMATE_CHECK_READ_LIMIT} bytes`)
  })

  it('honours the caller\'s abort', async () => {
    const { result } = sseResponse([contentFrame('pong')], { hang: true })
    const controller = new AbortController()
    const { run } = probe(result, { timeoutMs: 5_000, signal: controller.signal })
    const pending = run()
    controller.abort()
    const outcome = await pending
    expect(outcome).toMatchObject({ ok: false, accepted: true, kind: 'server' })
    expect(outcome.message).toBe('the probe was aborted with 1 event(s) read')
  })

  it('bounds the request phase, not just the read', async () => {
    // An upstream that never answers the status line at all: aborting the fetch
    // is how the socket dies, not what makes the probe return.
    const client = { chatStream: (): Promise<ComateChatResult> => new Promise<never>(() => {}) }
    const outcome = await runComateCheck({ credential: CREDENTIAL, client, model: 'model-a', timeoutMs: 30 })
    expect(outcome).toMatchObject({ ok: false, status: 0, kind: 'server' })
    expect(outcome.message).toBe('probe timed out after 30ms before the upstream answered')
  })

  it('names the caller, not the clock, when the caller aborts before the answer', async () => {
    const controller = new AbortController()
    controller.abort()
    const client = { chatStream: (): Promise<ComateChatResult> => new Promise<never>(() => {}) }
    const outcome = await runComateCheck({
      credential: CREDENTIAL,
      client,
      model: 'model-a',
      signal: controller.signal,
    })
    expect(outcome.message).toBe('the probe was aborted before the upstream answered')
  })

  it('defaults to a budget that is long enough to be useful', () => {
    expect(COMATE_CHECK_TIMEOUT_MS).toBe(15_000)
  })

  // ---- unchanged behaviours ----

  it('classifies an upstream refusal instead of throwing', async () => {
    const stub = stubClient({ ok: false, status: 402, kind: 'hard_credit', message: '积分不足' })
    const outcome = await runComateCheck({ credential: CREDENTIAL, client: stub.client, model: 'model-a' })
    expect(outcome).toEqual({ ok: false, model: 'model-a', status: 402, kind: 'hard_credit', message: '积分不足' })
  })

  it('reports a transport failure as a server-class failure', async () => {
    const stub = stubClient({ ok: false, status: 0, kind: 'server', message: 'transport error: ECONNREFUSED' })
    const outcome = await runComateCheck({ credential: CREDENTIAL, client: stub.client, model: 'model-a' })
    expect(outcome.ok).toBe(false)
    expect(outcome.kind).toBe('server')
    expect(outcome.status).toBe(0)
  })

  it('redacts an upstream excerpt before it leaves the host', async () => {
    // An error body is third-party text; it has no business carrying a bearer or
    // a cookie into a browser response.
    const stub = stubClient({
      ok: false,
      status: 401,
      kind: 'session_dead',
      message: 'token=abcdef123456 and wps_sid=deadbeef rejected',
    })
    const outcome = await runComateCheck({ credential: CREDENTIAL, client: stub.client, model: 'model-a' })
    expect(outcome.message).not.toContain('abcdef123456')
    expect(outcome.message).not.toContain('deadbeef')
    expect(outcome.message).toContain('[redacted]')
  })
})

describe('safeMessage', () => {
  it('reads the message off an Error', () => {
    expect(safeMessage(new Error('plain failure'))).toBe('plain failure')
  })

  it('stringifies a non-Error', () => {
    expect(safeMessage('just a string')).toBe('just a string')
  })

  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature'
    const out = safeMessage(`rejected ${jwt}`)
    expect(out).not.toContain(jwt)
    expect(out).toContain('[redacted token]')
  })

  it('redacts credential-ish query parameters', () => {
    // 刻意不用 `code`：它现在是唯一带例外的键（错误标识要留着），见 redact.spec.ts。
    const out = safeMessage('failed?token=SEKRET&apiKey=SEKRET2&access_token=SEKRET3')
    expect(out).not.toContain('SEKRET')
    expect(out).not.toContain('SEKRET2')
    expect(out).not.toContain('SEKRET3')
  })

  it('redacts a wps_sid cookie', () => {
    const out = safeMessage('Cookie: wps_sid=verysecretvalue; other=1')
    expect(out).not.toContain('verysecretvalue')
    expect(out).toContain('wps_sid=[redacted]')
  })

  it('caps the length', () => {
    expect(safeMessage('x'.repeat(5000)).length).toBe(500)
  })
})
