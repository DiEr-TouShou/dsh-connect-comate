/**
 * presign 上传链的离线测试：请求形状、缓存、降级。
 *
 * 真机形状来自本机实测（2026-09-25，见 `src/assets.ts` 模块头）；这里的 stub
 * 逐字复刻实测响应，所以「接口改了我这边会先红」。
 */
import { describe, expect, it } from 'vitest'
import {
  ComatePresignUploader,
  COMATE_ASSET_BASE_ENV,
  COMATE_ASSET_PATH,
  decodeImageDataUrl,
  downloadUrlExpiry,
  resolveAssetBase,
} from '../src/assets.ts'
import type { ComateCredential } from '../src/auth.ts'

const CREDENTIAL: ComateCredential = {
  baseUrl: 'https://comate.wps.cn/llmproxy/v1/user',
  apiKey: 'placeholder',
  cookie: 'wps_sid=test-sid',
  authHeader: true,
  models: [],
  configFile: 'test-config.json',
}

/** 8 字节的假 PNG（只要求非空且稳定）。 */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`

/** 记录每次请求的 stub；按 URL 后缀给出实测形状的响应。 */
function stubFetch(options: { uploadStatus?: number; downloadUrl?: string } = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url)
    calls.push({ url: target, init: init ?? {} })
    if (target.endsWith('/assets/presign-upload')) {
      return json({
        code: 0,
        msg: 'success',
        data: {
          upload_url: 'https://agentspace.ks3-cn-beijing.ksyuncs.com/agentspace/comate/coserve-assets/u/1/abc.png?sign=1',
          method: 'PUT',
          headers: { Host: 'agentspace.ks3-cn-beijing.ksyuncs.com' },
          relative_key: 'u/1/abc.png',
        },
      })
    }
    if (target.includes('agentspace.ks3-cn-beijing.ksyuncs.com')) {
      return { ok: (options.uploadStatus ?? 200) === 200, status: options.uploadStatus ?? 200 } as Response
    }
    if (target.endsWith('/assets/presign-download')) {
      return json({
        code: 0,
        msg: 'success',
        data: {
          items: [{
            download_url: options.downloadUrl
              ?? 'https://agentspace.ks3-cn-beijing.ksyuncs.com/agentspace/comate/coserve-assets/u/1/abc.png?X-Amz-Expires=900&sign=2',
          }],
        },
      })
    }
    return json({ code: 404, msg: 'not found' }, 404)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function json(body: unknown, status = 200): Response {
  return { ok: status === 200, status, json: async () => body } as Response
}

describe('resolveAssetBase', () => {
  it('derives the asset base from the gateway origin', () => {
    expect(resolveAssetBase('https://comate.wps.cn/llmproxy/v1/user', {})).toBe(`https://comate.wps.cn${COMATE_ASSET_PATH}`)
  })

  it('honours the env override and trims trailing slashes', () => {
    expect(resolveAssetBase('https://comate.wps.cn/llmproxy/v1/user', { [COMATE_ASSET_BASE_ENV]: 'http://127.0.0.1:8080/api/comate/v1/' }))
      .toBe('http://127.0.0.1:8080/api/comate/v1')
  })

  it('returns undefined for an unparsable base url', () => {
    expect(resolveAssetBase('not a url', {})).toBeUndefined()
  })
})

describe('decodeImageDataUrl', () => {
  it('decodes a base64 image data url', () => {
    const decoded = decodeImageDataUrl(DATA_URL)
    expect(decoded?.mime).toBe('image/png')
    expect(decoded?.bytes.equals(PNG_BYTES)).toBe(true)
  })

  it('rejects non-base64, non-image and empty payloads', () => {
    expect(decodeImageDataUrl('data:image/svg+xml,<svg/>')).toBeUndefined()
    expect(decodeImageDataUrl('data:application/pdf;base64,AAAA')).toBeUndefined()
    expect(decodeImageDataUrl('data:image/png;base64,')).toBeUndefined()
    expect(decodeImageDataUrl('https://example.com/a.png')).toBeUndefined()
  })
})

describe('downloadUrlExpiry', () => {
  it('reads X-Amz-Expires seconds', () => {
    const now = 1_700_000_000_000
    expect(downloadUrlExpiry('https://ks3.test/a.png?X-Amz-Expires=900', now)).toBe(now + 900_000)
  })

  it('reads an absolute Expires timestamp', () => {
    const now = 1_700_000_000_000
    expect(downloadUrlExpiry('https://ks3.test/a.png?Expires=1700000900', now)).toBe(1_700_000_900_000)
  })

  it('falls back to a conservative default', () => {
    const now = 1_700_000_000_000
    expect(downloadUrlExpiry('https://ks3.test/a.png', now)).toBe(now + 5 * 60_000)
  })
})

describe('ComatePresignUploader', () => {
  it('walks presign-upload → PUT → presign-download and returns the download url', async () => {
    const { fetchImpl, calls } = stubFetch()
    const uploader = new ComatePresignUploader({ env: {}, fetch: fetchImpl })

    const url = await uploader.upload(DATA_URL, CREDENTIAL)

    expect(url).toContain('agentspace.ks3-cn-beijing.ksyuncs.com')
    expect(calls.map((call) => call.init.method)).toEqual(['POST', 'PUT', 'POST'])
    expect(calls[0]?.url).toBe(`https://comate.wps.cn${COMATE_ASSET_PATH}/assets/presign-upload`)
    expect(calls[2]?.url).toBe(`https://comate.wps.cn${COMATE_ASSET_PATH}/assets/presign-download`)

    // 凭据只用 Cookie，与桌面端 video-upload 的 presign 分支一致。
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['Cookie']).toBe('wps_sid=test-sid')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ filename: 'image.png', content_type: 'image/png' })

    // Step2 原样带上服务端给的预签名头，并补齐 Content-Length。
    const putHeaders = calls[1]?.init.headers as Record<string, string>
    expect(putHeaders['Host']).toBe('agentspace.ks3-cn-beijing.ksyuncs.com')
    expect(putHeaders['Content-Length']).toBe(String(PNG_BYTES.length))
    expect(Buffer.from(calls[1]?.init.body as Buffer).equals(PNG_BYTES)).toBe(true)

    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ relative_keys: ['u/1/abc.png'] })
  })

  it('uploads identical bytes once and reuses the presigned url', async () => {
    const { fetchImpl, calls } = stubFetch()
    const uploader = new ComatePresignUploader({ env: {}, fetch: fetchImpl })

    const first = await uploader.upload(DATA_URL, CREDENTIAL)
    const second = await uploader.upload(DATA_URL, CREDENTIAL)

    expect(second).toBe(first)
    expect(calls).toHaveLength(3)
  })

  it('re-presigns (without re-uploading) once the download url is near expiry', async () => {
    // TTL 只有 1 秒，已落在 30s 提前量内，所以每次取值都会重新预签名——但字节
    // 只在第一次传。这里断言的就是这条不变量：第二次没有第二次 PUT。
    const { fetchImpl, calls } = stubFetch({ downloadUrl: 'https://ks3.test/a.png?X-Amz-Expires=1' })
    const uploader = new ComatePresignUploader({ env: {}, fetch: fetchImpl })

    const first = await uploader.upload(DATA_URL, CREDENTIAL)
    const second = await uploader.upload(DATA_URL, CREDENTIAL)

    expect(second).toBe(first)
    expect(calls.filter((call) => call.init.method === 'PUT')).toHaveLength(1)
    expect(calls.filter((call) => call.url.endsWith('/assets/presign-download')).length).toBeGreaterThanOrEqual(2)
  })

  it('keeps the last known url when the refresh fails', async () => {
    let downloadCalls = 0
    const fetchImpl = (async (url: string | URL | Request) => {
      const target = String(url)
      if (target.endsWith('/assets/presign-upload')) {
        return json({ code: 0, data: { upload_url: 'https://ks3.test/put?sign=1', method: 'PUT', headers: {}, relative_key: 'k.png' } })
      }
      if (target.startsWith('https://ks3.test/put')) return { ok: true, status: 200 } as Response
      if (target.endsWith('/assets/presign-download')) {
        downloadCalls += 1
        return downloadCalls === 1
          ? json({ code: 0, data: { items: [{ download_url: 'https://ks3.test/a.png?X-Amz-Expires=1' }] } })
          : json({ code: 500, msg: 'boom' }, 500)
      }
      return json({ code: 404, msg: 'not found' }, 404)
    }) as unknown as typeof fetch
    const uploader = new ComatePresignUploader({ env: {}, fetch: fetchImpl })

    const first = await uploader.upload(DATA_URL, CREDENTIAL)
    const second = await uploader.upload(DATA_URL, CREDENTIAL)

    expect(first).toBe('https://ks3.test/a.png?X-Amz-Expires=1')
    // 刷新失败时保留旧 URL，而不是退回对 mimo 必失败的 base64。
    expect(second).toBe(first)
  })

  it('returns undefined without a cookie or with a non-base64 source', async () => {
    const { fetchImpl, calls } = stubFetch()
    const uploader = new ComatePresignUploader({ env: {}, fetch: fetchImpl })

    expect(await uploader.upload(DATA_URL, { ...CREDENTIAL, cookie: '' })).toBeUndefined()
    expect(await uploader.upload('https://example.com/a.png', CREDENTIAL)).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('returns undefined when a step fails, and retries on the next call', async () => {
    const { fetchImpl, calls } = stubFetch({ uploadStatus: 403 })
    const uploader = new ComatePresignUploader({ env: {}, fetch: fetchImpl })

    expect(await uploader.upload(DATA_URL, CREDENTIAL)).toBeUndefined()
    expect(await uploader.upload(DATA_URL, CREDENTIAL)).toBeUndefined()
    // 失败不进缓存：两次都完整走了一遍（POST + PUT）。
    expect(calls).toHaveLength(4)
  })

  it('treats a non-zero code as failure', async () => {
    const fetchImpl = (async () => json({ code: 40001, msg: '未登录' })) as unknown as typeof fetch
    const uploader = new ComatePresignUploader({ env: {}, fetch: fetchImpl })
    expect(await uploader.upload(DATA_URL, CREDENTIAL)).toBeUndefined()
  })

  it('treats a thrown fetch as failure', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    const uploader = new ComatePresignUploader({ env: {}, fetch: fetchImpl })
    expect(await uploader.upload(DATA_URL, CREDENTIAL)).toBeUndefined()
  })
})
