import { describe, expect, it, vi } from 'vitest'
import { COMATE_CHECK_MAX_TOKENS, comateCheckBody, runComateCheck, safeMessage } from '../src/check.ts'
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
  const calls: Array<{ credential: ComateCredential; body: string }> = []
  return {
    calls,
    client: {
      async chatStream(credential: ComateCredential, body: string): Promise<ComateChatResult> {
        calls.push({ credential, body })
        return result
      },
    },
  }
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
  it('reports success and the model it probed', async () => {
    const stub = stubClient({ ok: true, response: new Response('data: {}\n\n', { status: 200 }) })
    const outcome = await runComateCheck({ credential: CREDENTIAL, client: stub.client, model: 'model-a' })
    expect(outcome).toEqual({ ok: true, model: 'model-a' })
    expect(stub.calls).toHaveLength(1)
    expect(JSON.parse(stub.calls[0]?.body ?? '')).toEqual(JSON.parse(comateCheckBody('model-a')))
  })

  it('releases the stream it never reads', async () => {
    const response = new Response('data: {}\n\n', { status: 200 })
    const cancel = vi.spyOn(response.body as ReadableStream, 'cancel')
    const stub = stubClient({ ok: true, response })
    await runComateCheck({ credential: CREDENTIAL, client: stub.client, model: 'model-a' })
    expect(cancel).toHaveBeenCalled()
  })

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
    const out = safeMessage('failed?code=SEKRET&token=SEKRET2&apiKey=SEKRET3')
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
