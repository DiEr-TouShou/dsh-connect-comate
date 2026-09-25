import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { COMATE_PROVIDER, createComateAdapter, type ComateAttachmentService } from '../src/adapter.ts'
import { ComateCatalog } from '../src/catalog.ts'
import { ComateCredentialStore } from '../src/auth.ts'
import { createComateShim } from '../src/shim.ts'
import type { ComateAssetUploader } from '../src/assets.ts'
import type { ComateChatResult } from '../src/upstream.ts'

/**
 * 图片模态真正的接缝：**带图片的 DSH 历史**，而不是请求体。
 *
 * 真机故障（2026-09）：DSH 报 `pi-ai image input requires the durable attachment
 * service` / `UNSUPPORTED_CONTENT`。根因既不在图片编码、也不在网关，而在装配：
 * pi-ai 的 context builder 只能通过**宿主的 durable attachment service** 拿到图片
 * 字节（`readImageRequest`），本插件构造 `PiAiAdapter` 时没有把 `resolveAttachments`
 * 接上，于是任何带图片的请求都掉进 text-only 回退分支并整轮失败——而所有纯文本
 * 请求照常工作，所以这个缺口在文本测试里完全不可见。
 *
 * 这里跑的是**真的** `PiAiAdapter` + **真的** shim（真 HTTP 回环），只有宿主的
 * 字节来源被桩替代：图片 → 请求体这一段全是真的。两条断言各钉住一半：
 * 不接钩子要能复现真机报错，接上钩子要把图片按对象形式 base64 送到转发层。
 */

const MODEL_ID = 'test/model-multimodal//public'

/**
 * 2×2 PNG 的头部字节。真实内容无关紧要——要验证的是「宿主存的字节原样到了线上」，
 * 所以断言的是这段字节的 base64。
 */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const PNG_B64 = Buffer.from(PNG).toString('base64')

/** 与真机同形：`llm_types` 是数组，且这个模型带 `llm-multimodal`。 */
const CONFIG = JSON.stringify({
  device_uuid: 'd50-test',
  providers: {
    official: {
      api: 'openai-completions',
      apiKey: 'comate-test-key',
      authHeader: true,
      baseUrl: 'https://comate.wps.cn/llmproxy/v1/user',
      headers: { cookie: 'wps_sid=abc' },
      models: [{
        id: MODEL_ID,
        name: 'model-multimodal',
        context_window: 1000000,
        llm_types: ['llm-chat', 'llm-multimodal'],
      }],
    },
  },
  version: 2,
})

/**
 * 宿主的附件服务，缩到 pi-ai 真正会调的入口。
 *
 * `readImageRequest` 是唯一的字节来源；`imageHostPath` 只喂图片旁边那行文字句柄。
 * 接口其余二十来个方法（写入、校验、限额）在这条路径上永不触达，所以这里只造用到
 * 的两个，再按类型断言交出——桩要是把整张接口都实现了，反而看不出哪几个才是依赖。
 */
function stubAttachments(): ComateAttachmentService {
  return {
    imageHostPath: (ref: { attachmentId: string }) =>
      `C:/dsh/attachments/v1/objects/${String(ref.attachmentId)}`,
    readImageRequest: async (ref: Record<string, unknown>) => ({
      variantId: 'variant-1',
      attachment: ref,
      data: PNG,
      mediaType: 'image/png',
      bytes: PNG.length,
      width: 2,
      height: 2,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: false,
    }),
  } as unknown as ComateAttachmentService
}

/**
 * One image block exactly as the harness stores it in a user message.
 *
 * `AttachmentId` is a compile-time brand the harness's own attachment service
 * mints; on the wire it is the plain string, which is also what the stub's
 * `readImageRequest` receives back.
 */
const IMAGE_BLOCK = {
  type: 'image',
  attachment: {
    attachmentId: 'sha256:deadbeef',
    mediaType: 'image/png',
    bytes: PNG.length,
    width: 2,
    height: 2,
    name: 'shot.png',
  },
} as unknown as ContentBlock

interface RunResult {
  /** Bodies the shim handed to the upstream client, in order. */
  forwarded: string[]
  /** Warnings the shim logged (its only channel for "the pass changed something"). */
  warnings: string[]
  /** The error the adapter surfaced, if the request failed. */
  failure: unknown
}

/**
 * Drive one real request carrying an image through the adapter, the shim, and
 * the (stubbed) upstream client. `wireAttachments: false` builds the adapter the
 * way it was built when the machine failed.
 */
async function runImageRequest(wireAttachments: boolean, uploader?: ComateAssetUploader): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), 'comate-attach-'))
  const configFile = join(dir, 'config.json')
  writeFileSync(configFile, CONFIG, 'utf8')

  const store = new ComateCredentialStore({ configFile })
  // The gateway requires a session cookie; the desktop config ships a
  // placeholder, so the plugin's own field is what a signed-in machine uses.
  store.setWpsSid('test-sid')

  const catalog = new ComateCatalog()
  catalog.set([{
    id: MODEL_ID,
    name: 'model-multimodal',
    contextWindow: 1_000_000,
    llmTypes: ['llm-chat', 'llm-multimodal'],
  }])

  const forwarded: string[] = []
  const warnings: string[] = []
  const shim = createComateShim({
    store,
    catalog,
    ...(uploader === undefined ? {} : { uploader }),
    logger: {
      warn: (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) },
      error: () => {},
    },
    client: {
      async chatStream(_credential: unknown, bodyJson: string): Promise<ComateChatResult> {
        forwarded.push(bodyJson)
        return {
          ok: true,
          response: new Response('data: [DONE]\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
        }
      },
    },
  })

  try {
    await shim.ready
    const comate = createComateAdapter({
      shim,
      catalog,
      ...wireAttachments
        ? { attachments: () => stubAttachments(), toProcessPath: (hostPath: string) => hostPath }
        : {},
    })
    let failure: unknown
    try {
      const stream = comate.adapter.stream({
        provider: COMATE_PROVIDER,
        model: MODEL_ID,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 'what is this' }, IMAGE_BLOCK],
        }],
      })
      for await (const _chunk of stream) {
        // The wire body is the subject; the decoded chunks are not.
      }
    } catch (error: unknown) {
      failure = error
    }
    return { forwarded, warnings, failure }
  } finally {
    await shim.close()
  }
}

describe('an image in the message history', () => {
  it('fails the whole request when the durable attachment service is not wired', async () => {
    // 控制组：这就是 2026-09 真机上的那一行报错，一字不差。
    const { failure, forwarded } = await runImageRequest(false)
    expect(forwarded).toHaveLength(0)
    expect(String(failure)).toContain('pi-ai image input requires the durable attachment service')
    expect((failure as { code?: string }).code).toBe('UNSUPPORTED_CONTENT')
  })

  it('reaches the wire as an object-form base64 data URL of the stored bytes', async () => {
    const { forwarded, failure } = await runImageRequest(true)
    expect(failure).toBeUndefined()
    expect(forwarded).toHaveLength(1)
    const messages = (JSON.parse(forwarded[0] ?? '') as {
      messages: Array<{ role: string; content: unknown }>
    }).messages
    const content = messages[0]?.content as Array<Record<string, unknown>>
    // 三块：原文、pi-ai 自己插的图片句柄、真 base64。
    expect(content).toHaveLength(3)
    expect(content[0]).toEqual({ type: 'text', text: 'what is this' })
    // 句柄是 `resolveImageAccess` 的证据：它把模型看到的图和一条只读路径绑在一起，
    // 路径就是 `toProcessPath` 映射出来的那个。
    expect(String(content[1]?.['text'])).toContain('C:/dsh/attachments/v1/objects/sha256:deadbeef')
    expect(content[2]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${PNG_B64}` },
    })
  })

  it('leaves the body untouched, so the image pass logs nothing', async () => {
    // 归一化是给「网关不认的形状」兜底的；正常路径必须零改动，否则每次发图都刷
    // 一条 warn，真正需要那条日志的那次就淹了。
    const { warnings } = await runImageRequest(true)
    expect(warnings).toEqual([])
  })
})

/** 取 forwarded[0] 里第一条消息的 content 数组。 */
function imageContentOf(forwarded: string[]): Array<Record<string, unknown>> {
  const messages = (JSON.parse(forwarded[0] ?? '') as {
    messages: Array<{ content: unknown }>
  }).messages
  return messages[0]?.content as Array<Record<string, unknown>>
}

/**
 * 图片外置：`mimo-v2.5` 只收 URL 载荷（本机实测，见 `src/assets.ts` 模块头）。
 *
 * 这里验的是「接线是否真的接上了」：上传器在 shim 里、在归一化之后被调到，
 * 失败也不影响请求。上传器自身的三步与缓存由 `tests/assets.spec.ts` 单独验。
 */
describe('image externalization', () => {
  it('forwards the uploaded url instead of inline base64', async () => {
    const uploaded: string[] = []
    const uploader: ComateAssetUploader = {
      async upload(dataUrl: string) {
        uploaded.push(dataUrl)
        return 'https://ks3.test/up.png?X-Amz-Expires=900'
      },
    }

    const { forwarded, failure, warnings } = await runImageRequest(true, uploader)

    expect(failure).toBeUndefined()
    // 上传器拿到的是归一化之后的真 base64（顺序：先归一化，再外置）。
    expect(uploaded).toHaveLength(1)
    expect(uploaded[0]).toBe(`data:image/png;base64,${PNG_B64}`)
    const content = imageContentOf(forwarded)
    expect(content[2]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://ks3.test/up.png?X-Amz-Expires=900' },
    })
    expect(warnings.join('\n')).toContain('externalized=1')
  })

  it('falls back to inline base64 when the upload fails', async () => {
    const uploader: ComateAssetUploader = { async upload() { return undefined } }

    const { forwarded, failure, warnings } = await runImageRequest(true, uploader)

    // 上传失败只是少一次优化：请求照发，base64 照旧（4/5 个模型吃它）。
    expect(failure).toBeUndefined()
    expect(imageContentOf(forwarded)[2]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${PNG_B64}` },
    })
    expect(warnings.join('\n')).toContain('upload_failed=1')
  })

  it('keeps the request alive when the uploader throws', async () => {
    const uploader: ComateAssetUploader = {
      async upload() { throw new Error('uploader exploded') },
    }

    const { forwarded, failure, warnings } = await runImageRequest(true, uploader)

    expect(failure).toBeUndefined()
    expect(forwarded).toHaveLength(1)
    expect(imageContentOf(forwarded)[2]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${PNG_B64}` },
    })
    expect(warnings.join('\n')).toContain('image externalization failed')
  })
})
