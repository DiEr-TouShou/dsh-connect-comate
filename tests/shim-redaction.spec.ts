import { afterEach, describe, expect, it } from 'vitest'
import type { ComateCredential } from '../src/auth.ts'
import { createComateShim, type ComateShim } from '../src/shim.ts'
import type { ComateChatResult } from '../src/upstream.ts'

/**
 * shim 的**错误出口**必须脱敏。
 *
 * 这是真机上被复现过的泄露：上游网关的错误正文是第三方文本，它回显一条
 * `Cookie`、一个 Bearer，或者把请求 URL 抄回来，都不稀奇。之前 `check.ts` 有脱敏
 * （按按钮时走一次），常驻的聊天路径 `shim.ts` 没有——于是每次聊天请求都在把
 * 上游原文原样交给 pi-ai、交给浏览器面板。
 *
 * 这里跑的是**真的** shim（真 HTTP 回环、真鉴权、真 body 读取），只有上游被桩替代，
 * 所以断言的是「越过边界的那串字节」，而不是某个函数的返回值。三个用例对应三条
 * 真实的出口：上游拒绝、凭据解析失败、handler 内部异常。
 */

/** 合成凭据：只用于断言「它不出现」。 */
const SID = 'SYNTHSID9f8e7d6c5b4a'
const KEY = 'sk-live-SYNTHETICKEY123456'
const TOKEN = 'SYNTHTOKENabcdef123456'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aCJ9.SYNTHSIG'
const SECRETS = [SID, KEY, TOKEN, JWT]

const CREDENTIAL: ComateCredential = {
  baseUrl: 'https://comate.wps.cn/llmproxy/v1/user',
  apiKey: 'placeholder-key',
  cookie: `wps_sid=${SID}`,
  authHeader: true,
  models: [{ id: 'model-a', name: 'A', contextWindow: 1_000_000 }],
  configFile: 'C:/fake/config.json',
}

const MODELS = [{ id: 'model-a', name: 'A', contextWindow: 1_000_000 }]

interface Harness {
  shim: ComateShim
  warnings: string[]
}

let running: ComateShim | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

/** Boot a real shim with a stubbed upstream, credential store and catalog. */
async function boot(options: {
  chatStream?: (body: string) => Promise<ComateChatResult>
  resolveThrows?: unknown
  catalogThrows?: unknown
}): Promise<Harness> {
  const warnings: string[] = []
  const shim = createComateShim({
    store: {
      resolve: async () => {
        if (options.resolveThrows !== undefined) throw options.resolveThrows
        return CREDENTIAL
      },
    },
    client: {
      chatStream: async (_credential: ComateCredential, body: string): Promise<ComateChatResult> =>
        options.chatStream === undefined
          ? { ok: false, status: 401, kind: 'session_dead', message: 'unset' }
          : options.chatStream(body),
    },
    catalog: {
      current: () => {
        if (options.catalogThrows !== undefined) throw options.catalogThrows
        return MODELS
      },
    },
    logger: {
      warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')),
      error: (...args: unknown[]) => warnings.push(args.map(String).join(' ')),
    },
  } as unknown as Parameters<typeof createComateShim>[0])
  await shim.ready
  running = shim
  return { shim, warnings }
}

/** POST one chat request the way pi-ai does. */
async function chat(shim: ComateShim, body = '{"model":"model-a","messages":[]}'): Promise<string> {
  const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
    body,
  })
  return response.text()
}

/** Assert no synthetic credential survived into the bytes that left the host. */
function expectNoSecrets(raw: string): void {
  for (const secret of SECRETS) expect(raw).not.toContain(secret)
}

describe('shim error boundary redaction', () => {
  it('redacts an upstream error body before it reaches the client', async () => {
    // 真机复现的那一幕：上游 401 的正文里回显了请求凭据。
    const { shim } = await boot({
      chatStream: async () => ({
        ok: false,
        status: 401,
        kind: 'session_dead',
        message: `{"code":"12153","message":"Offline user session not found",`
          + `"echo":{"cookie":"wps_sid=${SID}","Authorization":"Bearer ${KEY}"},`
          + `"token":"${TOKEN}","jwt":"${JWT}"}`,
      }),
    })
    const raw = await chat(shim)
    expectNoSecrets(raw)
    // 分类与诊断信息必须还在：脱敏不该把「为什么失败」也一起抹掉。
    expect(raw).toContain('session_dead')
    expect(raw).toContain('Offline user session not found')
    expect(raw).toContain('12153')
  })

  it('redacts a credential-resolution failure', async () => {
    const { shim } = await boot({
      resolveThrows: new Error(`comate: cannot read C:/fake/config.json (cookie: wps_sid=${SID})`),
    })
    const raw = await chat(shim)
    expectNoSecrets(raw)
    expect(raw).toContain('not_signed_in')
    // 路径这类「用户需要知道、但不是凭据」的信息保留下来，否则错误没法排查。
    expect(raw).toContain('C:/fake/config.json')
  })

  it('redacts a handler exception on the internal 500 path', async () => {
    const { shim } = await boot({
      catalogThrows: new Error(`model directory unreadable (Authorization: Bearer ${KEY})`),
    })
    const response = await fetch(`${shim.baseUrl()}/v1/models`, {
      headers: { Authorization: `Bearer ${shim.token()}`, Host: '127.0.0.1' },
    })
    expect(response.status).toBe(500)
    const raw = await response.text()
    expectNoSecrets(raw)
    expect(raw).toContain('internal')
    expect(raw).toContain('model directory unreadable')
  })

  it('leaves the ordinary refusal text intact', async () => {
    const { shim } = await boot({
      chatStream: async () => ({ ok: false, status: 502, kind: 'server', message: 'upstream connect error' }),
    })
    const raw = await chat(shim)
    expect(raw).toContain('comate upstream server (http 502): upstream connect error')
  })

  it('still refuses a wrong bearer without echoing anything', async () => {
    const { shim } = await boot({})
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-the-secret' },
      body: '',
    })
    expect(response.status).toBe(401)
    expect(await response.text()).toContain('missing or invalid Authorization bearer')
  })
})
