import { afterEach, describe, expect, it, vi } from 'vitest'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { comateModelInput, comatePiModel } from '../src/adapter.ts'
import {
  FAKE_BASE64_IMAGE_URL_RE,
  emptyImageStats,
  emptyUploadStats,
  normalizeChatImages,
  sanitizeImageSource,
  uploadChatImages,
} from '../src/multimodal.ts'
import type { ComateAssetUploader } from '../src/assets.ts'
import type { ComateModel, ComateCredential } from '../src/auth.ts'
import { prepareChatBody } from '../src/upstream.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * The module's probe table, asserted.
 *
 * 本机实测（2026-09，`llmproxy/v1/user/chat/completions`，96×96 纯色 PNG）：
 * 真 base64 的对象形状被正确识别，裸字符串被静默丢弃，假 base64 与 svg 得到
 * HTTP 200 + 空正文。下面的用例把「我们发什么」钉在「网关认什么」上。
 */
describe('sanitizeImageSource', () => {
  it('passes a real base64 data URL through untouched', () => {
    const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
    expect(sanitizeImageSource(url)).toEqual({ url })
  })

  it('passes an http(s) URL through untouched', () => {
    expect(sanitizeImageSource('https://comate.wps.cn/a.png')).toEqual({ url: 'https://comate.wps.cn/a.png' })
    expect(sanitizeImageSource('http://127.0.0.1/a.png')).toEqual({ url: 'http://127.0.0.1/a.png' })
  })

  it('strips a fake base64 prefix back to the URL it wraps', () => {
    // 桌面端 fake-base64-image-url.js 认的就是这一种：前缀是 base64，载荷是 URL。
    const verdict = sanitizeImageSource('data:image/png;base64,https://ks3.example.com/a.png?sig=1')
    expect(verdict).toEqual({ url: 'https://ks3.example.com/a.png?sig=1', stripped: true })
    expect(FAKE_BASE64_IMAGE_URL_RE.test('data:image/jpeg;base64,https://x/y.jpg')).toBe(true)
    // …而真 base64 不能被误判成假前缀。
    expect(FAKE_BASE64_IMAGE_URL_RE.test('data:image/png;base64,iVBORw0KGgo=')).toBe(false)
  })

  it('rejects the media types the Comate pipeline does not support', () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`
    expect(sanitizeImageSource(svg)).toEqual({ reason: 'unsupported media type image/svg+xml' })
  })

  it('accepts every media type the desktop client lists as supported', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/x-icon', 'image/avif']) {
      const url = `data:${mime};base64,AAAA`
      expect(sanitizeImageSource(url)).toEqual({ url })
    }
  })

  it('reports empty and non-image sources instead of forwarding them', () => {
    expect(sanitizeImageSource('')).toEqual({ reason: 'empty image source' })
    expect(sanitizeImageSource('   ')).toEqual({ reason: 'empty image source' })
    expect(sanitizeImageSource('data:image/png;base64,')).toEqual({ reason: 'empty image source' })
    expect(sanitizeImageSource('C:/Users/me/a.png')).toEqual({ reason: 'not an http(s) URL or image data URL' })
    expect(sanitizeImageSource('file:///C:/a.png')).toEqual({ reason: 'not an http(s) URL or image data URL' })
  })
})

/** Build a chat body with one user message holding the given parts. */
function bodyWith(parts: unknown[]): Record<string, unknown> {
  return { model: 'm', messages: [{ role: 'user', content: parts }] }
}

/** The content array of the first message of a (mutated) body. */
function contentOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const messages = body['messages'] as Array<Record<string, unknown>>
  return messages[0]?.['content'] as Array<Record<string, unknown>>
}

describe('normalizeChatImages', () => {
  it('rewrites the bare string spelling into the object spelling', () => {
    // 实测：字符串形式返回 200 但模型答 "Unknown"——图片被静默丢弃。
    const url = 'data:image/png;base64,iVBORw0KGgo='
    const body = bodyWith([{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: url }])
    const stats = normalizeChatImages(body)
    expect(contentOf(body)[1]).toEqual({ type: 'image_url', image_url: { url } })
    expect(stats).toEqual({ seen: 1, repaired: 1, stripped: 0, dropped: 0 })
  })

  it('rewrites an input_image part (Responses spelling) onto this wire', () => {
    const url = 'data:image/png;base64,iVBORw0KGgo='
    const body = bodyWith([{ type: 'input_image', image_url: url }])
    const stats = normalizeChatImages(body)
    expect(contentOf(body)[0]).toEqual({ type: 'image_url', image_url: { url } })
    expect(stats.repaired).toBe(1)
  })

  it('leaves an already-correct image part alone and reports nothing', () => {
    const url = 'data:image/png;base64,iVBORw0KGgo='
    const part = { type: 'image_url', image_url: { url, detail: 'auto' } }
    const body = bodyWith([part])
    expect(normalizeChatImages(body)).toEqual({ seen: 1, repaired: 0, stripped: 0, dropped: 0 })
    expect(contentOf(body)[0]).toEqual(part)
  })

  it('strips a fake base64 prefix and keeps the sibling detail field', () => {
    const body = bodyWith([{
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,https://ks3.example.com/a.png', detail: 'high' },
    }])
    const stats = normalizeChatImages(body)
    expect(contentOf(body)[0]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://ks3.example.com/a.png', detail: 'high' },
    })
    expect(stats.stripped).toBe(1)
    expect(stats.repaired).toBe(1)
  })

  it('replaces an unusable image with a text notice rather than emptying the content', () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`
    const body = bodyWith([{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: svg } }])
    const stats = normalizeChatImages(body)
    expect(contentOf(body)[1]).toEqual({ type: 'text', text: '[image omitted: unsupported media type image/svg+xml]' })
    expect(stats).toEqual({ seen: 1, repaired: 0, stripped: 0, dropped: 1 })
  })

  it('keeps a message that held nothing but images non-empty', () => {
    // 桌面端的转换器会 `if (content.length === 0) continue`——把消息整个丢掉，
    // 于是用户看到的是一个没有理由的空回答。这里必须留一条说明。
    const body = bodyWith([{ type: 'image_url', image_url: { url: '' } }])
    normalizeChatImages(body)
    expect(contentOf(body)).toHaveLength(1)
    expect(contentOf(body)[0]?.['text']).toContain('image omitted')
  })

  it('handles parts that carry no source at all', () => {
    const body = bodyWith([{ type: 'image_url' }])
    const stats = normalizeChatImages(body)
    expect(stats.dropped).toBe(1)
    expect(contentOf(body)[0]?.['text']).toContain('missing image source')
  })

  it('ignores messages without array content and bodies without messages', () => {
    const plain = { model: 'm', messages: [{ role: 'user', content: 'hi' }] }
    expect(normalizeChatImages(plain)).toEqual(emptyImageStats())
    expect(plain.messages[0]?.content).toBe('hi')
    expect(normalizeChatImages({ model: 'm' })).toEqual(emptyImageStats())
    expect(normalizeChatImages({ messages: [null, 42, { role: 'user' }] })).toEqual(emptyImageStats())
  })

  it('counts images across several messages', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
        { role: 'user', content: [{ type: 'image_url', image_url: 'data:image/png;base64,AA' }] },
      ],
    }
    const stats = normalizeChatImages(body)
    expect(stats).toEqual({ seen: 2, repaired: 1, stripped: 0, dropped: 0 })
  })
})

/**
 * The capability switch: DSH only offers an image attachment when the model
 * descriptor says `input: ['text', 'image']`, and that answer comes from
 * `llm_types`. The array shape is the one the real config ships.
 */
describe('comateModelInput', () => {
  function model(llmTypes?: string[]): ComateModel {
    const base: ComateModel = { id: 'a', name: 'A', contextWindow: 1_000_000 }
    return llmTypes === undefined ? base : { ...base, llmTypes }
  }

  it('offers images only for llm-multimodal models', () => {
    expect(comateModelInput(model(['llm-chat', 'llm-multimodal']))).toEqual(['text', 'image'])
    expect(comateModelInput(model(['llm-chat']))).toEqual(['text'])
    expect(comateModelInput(model())).toEqual(['text'])
  })
})

/**
 * The seam that matters: what DSH's pi-ai actually puts on the wire for an
 * attached image, and whether this plugin's pass leaves it alone.
 *
 * 两端都实测过了——网关认对象形式的真 base64（见模块头部表），而这里断言的是
 * 中间那一跳：pi-ai 的 openai-completions 编码器产出的就是那个形状。两边对齐、
 * 归一化在正常路径上是零改动，这三点合起来才是「图片真的能进去」。
 */
describe('the request pi-ai builds for an attached image', () => {
  /** A tiny but real base64 payload (the bytes are never decoded here). */
  const B64 = 'iVBORw0KGgoAAAANSUhEUg=='

  /** Stub fetch and record the JSON bodies the api sends. */
  function captureBodies(): Array<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>)
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }))
    return bodies
  }

  /** Drive one real request carrying an image through the registered api. */
  async function sendWithImage(llmTypes?: string[]): Promise<Array<Record<string, unknown>>> {
    const bodies = captureBodies()
    const info: ComateModel = { id: 'model-a', name: 'A', contextWindow: 1_000_000 }
    const descriptor = comatePiModel(
      llmTypes === undefined ? info : { ...info, llmTypes },
      'http://127.0.0.1:1/v1',
    )
    const stream = openAICompletionsApi().streamSimple(
      descriptor,
      {
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 'what is this' }, { type: 'image', data: B64, mimeType: 'image/png' }],
          timestamp: 0,
        }],
      },
      { apiKey: 'test-key' },
    )
    for await (const _event of stream) {
      // deliberately not inspected
    }
    return bodies
  }

  it('encodes the image as an object-form base64 data URL', async () => {
    const bodies = await sendWithImage(['llm-chat', 'llm-multimodal'])
    expect(bodies).toHaveLength(1)
    const content = (bodies[0]?.['messages'] as Array<Record<string, unknown>>)[0]?.['content']
    expect(content).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${B64}` } },
    ])
  })

  it('sends a body this plugin\'s pass leaves completely alone', async () => {
    const bodies = await sendWithImage(['llm-chat', 'llm-multimodal'])
    const stats = emptyImageStats()
    const prepared = prepareChatBody(JSON.stringify(bodies[0]), stats)
    expect(stats).toEqual({ seen: 1, repaired: 0, stripped: 0, dropped: 0 })
    const content = (JSON.parse(prepared) as { messages: Array<Record<string, unknown>> }).messages[0]?.['content']
    expect(content).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${B64}` } },
    ])
  })

  it('drops the image entirely when the descriptor says text-only', async () => {
    // 控制组：描述符不给 `image` 时 pi-ai 就不发图片。这就是 `llmTypes` 解析错
    // 误的代价——图片在客户端就被丢掉了，插件根本看不到。
    const bodies = await sendWithImage(['llm-chat'])
    expect(JSON.stringify(bodies[0])).not.toContain('image_url')
  })
})

/**
 * 网关的错误形状：图片类错误塞在 **HTTP 200 的 SSE** 里。
 *
 * 本机实测（2026-09，无效 PNG）：网关回 `200` + `data: {"error":{...}}`。这个形状
 * 如果被静默吞掉，用户在 DSH 里只会看到一个没有理由的空回答——所以这里把「它确实
 * 会浮上来」钉住：pi-ai 用 openai SDK 读流，SDK 见到带 `error` 字段的分片就
 * `throw APIError`（`openai/core/streaming.js`），pi-ai 再把它转成 `error` 事件并
 * 保留网关原文。
 *
 * 这条依赖是外部契约：openai SDK 若改了这段行为，本用例会先红，而不是等到用户
 * 报「图片发了没反应」。
 */
describe('in-stream error events', () => {
  /** 本机实测拿到的错误原文。 */
  const GATEWAY_ERROR = '模型参数有误(image data 0 failed: Unsupported image format or invalid image data.'
    + ' Please upload a supported image. Request id: 021790318623405a5cf16cfa3c4ebff37e7c43914719d1a80283a)'

  it('surfaces a 200 + SSE error event instead of an empty answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `data: ${JSON.stringify({ error: { message: GATEWAY_ERROR, type: 'invalid_request_error', code: 'ModelParamsError' } })}\n\n`
      + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )))
    const info: ComateModel = { id: 'model-a', name: 'A', contextWindow: 1_000_000, llmTypes: ['llm-multimodal'] }
    const stream = openAICompletionsApi().streamSimple(
      comatePiModel(info, 'http://127.0.0.1:1/v1'),
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this' }], timestamp: 0 }] },
      { apiKey: 'test-key' },
    )

    const events: Array<{ type: string; message: string }> = []
    for await (const event of stream) {
      events.push({
        type: event.type,
        message: event.type === 'error'
          ? (event as { error?: { errorMessage?: string } }).error?.errorMessage ?? ''
          : '',
      })
    }
    expect(events.map(event => event.type)).toContain('error')
    // 网关原文要能到用户眼前，不能被 `Unknown` 或空串替换掉。
    expect(events.find(event => event.type === 'error')?.message).toContain('image data 0 failed')
  })
})

/** 一个只记调用的上传器；默认返回一个稳定的假 URL。 */
function stubUploader(url: string | undefined = 'https://ks3.test/up.png'): ComateAssetUploader & { seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    async upload(dataUrl: string) {
      seen.push(dataUrl)
      return url
    },
  }
}

const CREDENTIAL = {
  baseUrl: 'https://comate.wps.cn/llmproxy/v1/user',
  apiKey: 'k',
  cookie: 'wps_sid=x',
  authHeader: true,
  models: [],
  configFile: 'c.json',
} as unknown as ComateCredential

/** 一个带图片的请求体（已归一化的形状）。 */
function imageBody(dataUrl: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: dataUrl } }] }],
    ...extra,
  })
}

const REAL_PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64')}`

describe('uploadChatImages', () => {
  it('replaces inline base64 with the uploaded url and keeps sibling keys', async () => {
    const uploader = stubUploader('https://ks3.test/up.png?sig=1')
    const stats = emptyUploadStats()
    const source = JSON.stringify({
      model: 'm',
      temperature: 0.3,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image_url', image_url: { url: REAL_PNG, detail: 'high' } },
        ],
      }],
    })

    const out = await uploadChatImages(source, uploader, CREDENTIAL, stats)
    const body = JSON.parse(out) as { temperature: number; messages: { content: unknown[] }[] }

    expect(uploader.seen).toEqual([REAL_PNG])
    expect(stats).toEqual({ externalized: 1, failed: 0 })
    // 非图片字段原样保留（只是重新序列化，语义不变）。
    expect(body.temperature).toBe(0.3)
    expect(body.messages[0]?.content[1]).toEqual({
      type: 'image_url',
      image_url: { detail: 'high', url: 'https://ks3.test/up.png?sig=1' },
    })
  })

  it('returns the original string untouched when there is nothing to upload', async () => {
    const uploader = stubUploader()
    const stats = emptyUploadStats()
    const source = imageBody('https://example.com/already-a-url.png')

    expect(await uploadChatImages(source, uploader, CREDENTIAL, stats)).toBe(source)
    expect(uploader.seen).toEqual([])
    expect(stats).toEqual({ externalized: 0, failed: 0 })
  })

  it('does not touch bodies without images (no parse, no re-serialize)', async () => {
    const uploader = stubUploader()
    const source = '{  "model" : "m" , "messages" : [] }'
    expect(await uploadChatImages(source, uploader, CREDENTIAL)).toBe(source)
    expect(uploader.seen).toEqual([])
  })

  it('uploads each distinct image once per request, and counts every part', async () => {
    const uploader = stubUploader()
    const stats = emptyUploadStats()
    const source = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: REAL_PNG } }] },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: REAL_PNG } }] },
      ],
    })

    await uploadChatImages(source, uploader, CREDENTIAL, stats)

    expect(uploader.seen).toHaveLength(1)
    expect(stats).toEqual({ externalized: 2, failed: 0 })
  })

  it('keeps base64 for the image whose upload failed, and still rewrites the others', async () => {
    const ok = REAL_PNG
    const other = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 1, 2]).toString('base64')}`
    const uploader: ComateAssetUploader = {
      async upload(dataUrl: string) { return dataUrl === other ? undefined : 'https://ks3.test/ok.png' },
    }
    const stats = emptyUploadStats()
    const source = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: ok } }] },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: other } }] },
      ],
    })

    const out = await uploadChatImages(source, uploader, CREDENTIAL, stats)
    const body = JSON.parse(out) as { messages: { content: { image_url: { url: string } }[] }[] }

    expect(stats).toEqual({ externalized: 1, failed: 1 })
    expect(body.messages[0]?.content[0]?.image_url.url).toBe('https://ks3.test/ok.png')
    expect(body.messages[1]?.content[0]?.image_url.url).toBe(other)
  })

  it('is a no-op without an uploader or credential (feature off)', async () => {
    const source = imageBody(REAL_PNG)
    expect(await uploadChatImages(source, undefined, CREDENTIAL)).toBe(source)
    expect(await uploadChatImages(source, stubUploader(), undefined)).toBe(source)
  })

  it('survives an unparsable body', async () => {
    const source = 'not json data:image/png;base64,AAAA'
    expect(await uploadChatImages(source, stubUploader(), CREDENTIAL)).toBe(source)
  })

  it('normalizes a bare-string image_url before uploading it', async () => {
    // 未经归一化的形状（字符串拼法）：也应能外置，且升成对象形状。
    const uploader = stubUploader('https://ks3.test/up.png')
    const source = JSON.stringify({
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: REAL_PNG }] }],
    })

    const out = await uploadChatImages(source, uploader, CREDENTIAL)
    const body = JSON.parse(out) as { messages: { content: unknown[] }[] }
    expect(body.messages[0]?.content[0]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://ks3.test/up.png' },
    })
  })
})
