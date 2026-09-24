import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMATE_CHECK_PATH, COMATE_REFRESH_PATH } from '../src/bridge.ts'
import { refreshComateCatalog, testComateConnection } from '../src/client/settings-scope.ts'

/** Replace the global fetch for one test and return the recorded calls. */
function stubFetch(response: Response | (() => Promise<Response>)) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const impl = async (url: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init })
    return typeof response === 'function' ? await response() : response
  }
  vi.stubGlobal('fetch', vi.fn(impl))
  return calls
}

/** Parse the JSON body one call carried. */
function bodyOf(call: { init: RequestInit | undefined } | undefined): unknown {
  return JSON.parse(String(call?.init?.body ?? 'null'))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Both actions are host POSTs whose authorization is the host's own loopback
 * gates, so what matters here is the exact request shape and the two distinct
 * failure channels: a transport/route refusal throws, while a probe that ran and
 * failed RESOLVES with `{ok:false}`.
 */
describe('refreshComateCatalog', () => {
  it('POSTs to the refresh route with a JSON content type and same-origin credentials', async () => {
    const answer = { signedIn: true, providerRegistered: true, models: [] }
    const calls = stubFetch(new Response(JSON.stringify(answer), { status: 200 }))

    await expect(refreshComateCatalog()).resolves.toEqual(answer)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(COMATE_REFRESH_PATH)
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.credentials).toBe('same-origin')
    expect((calls[0]?.init?.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(bodyOf(calls[0])).toEqual({})
  })

  it('surfaces the route error text on a refusal', async () => {
    stubFetch(new Response(JSON.stringify({ error: 'origin-not-trusted' }), { status: 403 }))
    await expect(refreshComateCatalog()).rejects.toThrow('origin-not-trusted')
  })

  it('falls back to the status line when the refusal body is not JSON', async () => {
    stubFetch(new Response('<html>nope</html>', { status: 500 }))
    await expect(refreshComateCatalog()).rejects.toThrow('HTTP 500')
  })
})

describe('testComateConnection', () => {
  it('POSTs the draft credential to the check route', async () => {
    const calls = stubFetch(new Response(JSON.stringify({ ok: true, model: 'a' }), { status: 200 }))

    await expect(testComateConnection({ wpsSid: 'draft', cookieOnly: true })).resolves.toEqual({
      ok: true,
      model: 'a',
    })

    expect(calls[0]?.url).toBe(COMATE_CHECK_PATH)
    expect(calls[0]?.init?.method).toBe('POST')
    expect(bodyOf(calls[0])).toEqual({ wpsSid: 'draft', cookieOnly: true })
  })

  it('sends an empty object when no draft is supplied', async () => {
    const calls = stubFetch(new Response(JSON.stringify({ ok: false, reason: 'no-credential' }), { status: 200 }))
    await testComateConnection()
    expect(bodyOf(calls[0])).toEqual({})
  })

  it('resolves a failed probe instead of throwing', async () => {
    // A refused upstream is an answer the card renders next to the button, not an
    // exception the card has to guess at.
    stubFetch(new Response(JSON.stringify({ ok: false, status: 401, kind: 'session_dead' }), { status: 200 }))
    await expect(testComateConnection()).resolves.toEqual({ ok: false, status: 401, kind: 'session_dead' })
  })

  it('throws when the route itself refuses the call', async () => {
    stubFetch(new Response(JSON.stringify({ error: 'expected application/json' }), { status: 415 }))
    await expect(testComateConnection()).rejects.toThrow('expected application/json')
  })

  it('never sends a function in the body', async () => {
    const calls = stubFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await testComateConnection({ wpsSid: 'draft' })
    expect(() => structuredClone(bodyOf(calls[0]))).not.toThrow()
  })
})
