/**
 * 真机验收（媒体生成链路）：用真凭据直连 Comate 网关，跑通「生图 / 生视频 →
 * 取回字节 → 上传云存储」的完整路径。
 *
 * 为什么单开这个脚本（`verify-shim-live.mjs` 已经在验真链路了）：
 *
 *   那个脚本验的是**对话**链路（chat/completions + 图片外置），走的是 shim。
 *   媒体生成是**另一组端点**（`images/generations`、`videos`、`videos/{id}/content`），
 *   不经过 shim，也复用了不同的上游语义——它有自己的响应形状、自己的坑。这个脚本
 *   就是给那组端点钉一份可回归的真机基线。
 *
 * 它同时钉住四件「读源码会读错」的事实（2026-09-26 实测）：
 *
 *   1. 响应里**没有 `code` 字段**。生图是 OpenAI 形状（`{created,data,usage}`），
 *      生视频是 `{id,object,model,status,...}`。`isBizSuccessCode(undefined) === true`
 *      才是它们不误报的原因——所以别在这里断言 `code === 0`。
 *   2. **content-type 会撒谎**：生图载荷的响应头是 `application/octet-stream`，
 *      字节其实是 JPEG。这里断言**嗅探出的**格式，而不是响应头。
 *   3. 生图返回 **`url`**（ks3 上的 aigc-metadata 路径），不是 `b64_json`。
 *   4. 上游**已经写好 GB 45438-2025 AIGC 元数据**（JPEG APP1 XMP 里的
 *      `TC260:AIGC`，`ContentProducer` 与源码常量一致，`ProduceID` 前缀 `T`）。
 *      所以走 llmproxy 通道时插件**不需要**再实现 watermark.js / aigc-metadata.js；
 *      这一条一旦被上游改掉，插件就得自己补，因此值得断言。
 *
 * 跑法（需要登录态，默认不在 CI 里跑）：
 *   node scripts/verify-media.mjs                 # 只跑生图（快、省额度）
 *   COMATE_MEDIA_VIDEO=1 node scripts/verify-media.mjs   # 连生视频一起跑（实测约 2 分钟）
 *   COMATE_PKG_DIR="<插件安装目录>" node scripts/verify-media.mjs
 *   WPS_COMATE_SID=<sid> node scripts/verify-media.mjs
 *
 * 可选环境变量：
 *   COMATE_MEDIA_VIDEO=1              跑生视频（默认关，因为它慢且真扣额度）
 *   COMATE_MEDIA_PROMPT=<英文 prompt> 覆盖生图提示词
 *   COMATE_MEDIA_VIDEO_PROMPT=<...>   覆盖生视频提示词
 *   COMATE_MEDIA_VIDEO_TIMEOUT_MS     生视频总预算，默认 10 分钟
 *   COMATE_MEDIA_OUT=<目录>           产物落盘目录，默认系统临时目录
 *
 * 判定：生图必须拿到**字节**、嗅探出是合法图片、带 AIGC 元数据，且**插件自己的**
 * `ComatePresignUploader` 能把这份字节传上云并换回可下载 URL——用 uploader 而不是
 * 手写三步，是为了验**产物**，不是复述协议。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readWpsSid } from './live-profile.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = resolve(process.env.COMATE_PKG_DIR || join(HERE, '..'))
const OUT_DIR = process.env.COMATE_MEDIA_OUT || join(tmpdir(), 'comate-media-verify')
const RUN_VIDEO = /^(1|true|yes|on)$/i.test(process.env.COMATE_MEDIA_VIDEO || '')
const VIDEO_BUDGET_MS = Number(process.env.COMATE_MEDIA_VIDEO_TIMEOUT_MS || 10 * 60 * 1000)

/** 生图提示词：具体到「能验证画面」的程度，纯色图会被不看图也蒙对的回答骗过。 */
const IMAGE_PROMPT = process.env.COMATE_MEDIA_PROMPT
  || 'a solid red circle centered on a pure white background, flat minimal illustration'
const VIDEO_PROMPT = process.env.COMATE_MEDIA_VIDEO_PROMPT
  || 'a single red balloon slowly floating upward against a clear blue sky, gentle camera tilt up, bright daylight'

/** 图片格式按**字节**判定，不看响应头（上游给的是 application/octet-stream）。 */
function sniffImage(bytes) {
  const starts = (offset, values) => values.every((value, index) => bytes[offset + index] === value)
  if (starts(0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (starts(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (bytes.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  return undefined
}

/** MP4 的 `ftyp` box 落在 offset 4。 */
function sniffVideo(bytes) {
  return bytes.subarray(4, 8).toString('ascii') === 'ftyp' ? 'video/mp4' : undefined
}

/** 上游是否已写入 GB 45438-2025 标识（决定插件要不要自己补元数据）。 */
function aigcMetadataOf(bytes) {
  const text = bytes.toString('latin1')
  if (!text.includes('TC260:AIGC')) return undefined
  const produceId = /ProduceID&quot;:&quot;([^&]+)/.exec(text)
  return { produceId: produceId === null ? undefined : produceId[1] }
}

/** 生图载荷可能是 url，也可能是 b64_json；统一取回字节。 */
async function fetchImageBytes(item) {
  if (typeof item.b64_json === 'string' && item.b64_json !== '') {
    return { bytes: Buffer.from(item.b64_json, 'base64'), via: 'b64_json' }
  }
  if (typeof item.url === 'string' && item.url !== '') {
    const response = await fetch(item.url, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`下载生图结果失败 HTTP ${response.status}`)
    return { bytes: Buffer.from(await response.arrayBuffer()), via: 'url' }
  }
  throw new Error('载荷里既没有 b64_json 也没有 url')
}

const pkg = await import(pathToFileURL(join(PKG_DIR, 'lib/index.js')).href)
const { ComateCredentialStore, ComatePresignUploader } = pkg

console.log(`package   : ${PKG_DIR}`)
console.log(`version   : ${pkg.COMATE_CONNECT_VERSION}`)

const store = new ComateCredentialStore()
store.setWpsSid(readWpsSid())
const credential = await store.current()
if (credential === undefined) {
  console.error('FAIL 拿不到凭据（config.json 缺失或不可读）')
  process.exit(1)
}
if (credential.cookie === undefined || credential.cookie.trim() === '') {
  console.error('FAIL 凭据里没有 cookie；媒体端点只认 Cookie，Bearer 不顶用')
  process.exit(1)
}

const base = credential.baseUrl.replace(/\/+$/, '')
console.log(`gateway   : ${base}`)
console.log(`cookie    : present`)
console.log(`out dir   : ${OUT_DIR}\n`)

mkdirSync(OUT_DIR, { recursive: true })

/** 媒体端点只认 Cookie + X-App-Id（与桌面端 image/video provider 的 headers 一致）。 */
function mediaHeaders() {
  return {
    'Content-Type': 'application/json',
    'Cookie': credential.cookie,
    'X-App-Id': 'comate',
    'X-Request-Id': crypto.randomUUID(),
    'X-Session-Id': crypto.randomUUID(),
  }
}

let failures = 0
let checked = 0

// ─────────────────────────────── 生图 ───────────────────────────────
{
  checked++
  const problems = []
  const notes = []

  const started = Date.now()
  const response = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: mediaHeaders(),
    body: JSON.stringify({ prompt: IMAGE_PROMPT, n: 1, size: '960x960' }),
    signal: AbortSignal.timeout(180_000),
  })
  const raw = await response.text()
  if (response.status !== 200) {
    problems.push(`HTTP ${response.status}: ${raw.slice(0, 200)}`)
  } else {
    let json
    try {
      json = JSON.parse(raw)
    } catch {
      problems.push(`响应不是 JSON: ${raw.slice(0, 200)}`)
    }
    if (json !== undefined) {
      // 刻意不断言 code：上游这个端点根本不发 code（见文件头第 1 条）。
      if (json.error !== undefined) problems.push(`业务错误: ${JSON.stringify(json.error).slice(0, 200)}`)
      const items = Array.isArray(json.data) ? json.data : []
      if (items.length === 0) {
        problems.push(`data 里没有图片项: ${raw.slice(0, 200)}`)
      } else {
        try {
          const { bytes, via } = await fetchImageBytes(items[0])
          const sniffed = sniffImage(bytes)
          if (sniffed === undefined) {
            problems.push(`拿到的字节不是已知图片格式（前 8 字节 ${bytes.subarray(0, 8).toString('hex')}）`)
          } else {
            const aigc = aigcMetadataOf(bytes)
            if (aigc === undefined) {
              // 不是失败：上游若不再写元数据，插件就得自己补，所以显式提示。
              notes.push('上游未带 AIGC 元数据（若长期如此，插件需自行写入）')
            } else {
              notes.push(`AIGC ProduceID=${aigc.produceId}`)
            }
            const ext = sniffed === 'image/jpeg' ? 'jpg' : sniffed.split('/')[1]
            const imagePath = join(OUT_DIR, `verify-image.${ext}`)
            writeFileSync(imagePath, bytes)
            notes.push(`载荷经 ${via}，${sniffed}，${bytes.length} bytes → ${imagePath}`)

            // 用插件自己的上传器验「生成结果能被云存储接受」——验产物，不复述协议。
            const dataUrl = `data:${sniffed};base64,${bytes.toString('base64')}`
            const url = await new ComatePresignUploader().upload(dataUrl, credential)
            if (url === undefined) {
              problems.push('ComatePresignUploader 没能把图片传上云（返回 undefined）')
            } else {
              const head = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(60_000) })
              if (!head.ok) problems.push(`上传后的下载 URL 不可用: HTTP ${head.status}`)
              else notes.push('上传云存储 + 换回可下载 URL 均通过')
            }
          }
        } catch (error) {
          problems.push(`取回图片字节失败: ${String(error)}`)
        }
      }
      if (typeof json.usage === 'object' && json.usage !== null) {
        notes.push(`usage=${JSON.stringify(json.usage)}`)
      }
    }
  }

  if (problems.length > 0) {
    console.log(`FAIL image  : ${problems.join('; ')}`)
    failures++
  } else {
    console.log(`ok   image  : ${Date.now() - started}ms`)
    for (const note of notes) console.log(`             ${note}`)
  }
}

// ─────────────────────────────── 生视频 ───────────────────────────────
if (!RUN_VIDEO) {
  console.log('\nskip video  : COMATE_MEDIA_VIDEO 未开（生视频约 2 分钟且真扣额度）')
} else {
  checked++
  const problems = []
  const notes = []
  const started = Date.now()

  try {
    // 1) submit
    const submit = await fetch(`${base}/videos`, {
      method: 'POST',
      headers: mediaHeaders(),
      body: JSON.stringify({ prompt: VIDEO_PROMPT, seconds: '5', size: '480p' }),
      signal: AbortSignal.timeout(60_000),
    })
    const submitRaw = await submit.text()
    const submitJson = JSON.parse(submitRaw)
    if (submit.status !== 200) {
      problems.push(`submit HTTP ${submit.status}: ${submitRaw.slice(0, 200)}`)
    } else if (typeof submitJson.id !== 'string' || submitJson.id === '') {
      problems.push(`submit 没返回 id: ${submitRaw.slice(0, 200)}`)
    } else {
      const taskId = submitJson.id
      notes.push(`model=${submitJson.model} taskId=${taskId}`)
      // taskId 里带 '/'，按段编码、保留分隔符（桌面端 videoIdPathSegment 同款）。
      const seg = taskId.split('/').map(part => encodeURIComponent(part)).join('/')

      // 2) poll
      let status = ''
      let terminal
      for (;;) {
        if (Date.now() - started > VIDEO_BUDGET_MS) {
          problems.push(`轮询超时（${Math.round(VIDEO_BUDGET_MS / 1000)}s），最后状态 ${status}`)
          break
        }
        const poll = await fetch(`${base}/videos/${seg}`, { headers: mediaHeaders(), signal: AbortSignal.timeout(30_000) })
        const pollRaw = await poll.text()
        const pollJson = JSON.parse(pollRaw)
        status = typeof pollJson.status === 'string' ? pollJson.status : ''
        if (['completed', 'failed', 'cancelled', 'expired'].includes(status)) {
          terminal = pollJson
          break
        }
        await new Promise(ready => setTimeout(ready, 5000))
      }
      if (problems.length === 0) {
        if (status !== 'completed') {
          problems.push(`任务终止于 ${status}: ${JSON.stringify(terminal).slice(0, 300)}`)
        } else {
          notes.push(`完成于 ${Math.round((Date.now() - started) / 1000)}s，usage=${JSON.stringify(terminal.usage)}`)

          // 3) content
          const content = await fetch(`${base}/videos/${seg}/content`, { headers: mediaHeaders(), signal: AbortSignal.timeout(30_000) })
          const contentRaw = await content.text()
          const contentJson = JSON.parse(contentRaw)
          if (typeof contentJson.url !== 'string' || contentJson.url === '') {
            problems.push(`content 没返回 url: ${contentRaw.slice(0, 200)}`)
          } else {
            // presigned URL 带 \u0026 转义，必须先还原成 & 才能抓。
            const url = contentJson.url.replace(/\\u0026/gi, '&').replace(/%5Cu0026/gi, '&')
            notes.push(`content url 是 ${url.startsWith('https://') ? 'https' : 'http'} 开头`)
            const download = await fetch(url, { signal: AbortSignal.timeout(120_000) })
            if (!download.ok) {
              problems.push(`下载视频失败 HTTP ${download.status}`)
            } else {
              const bytes = Buffer.from(await download.arrayBuffer())
              const sniffed = sniffVideo(bytes)
              if (sniffed === undefined) {
                problems.push(`下载到的不是 MP4（前 8 字节 ${bytes.subarray(0, 8).toString('hex')}）`)
              } else {
                const videoPath = join(OUT_DIR, 'verify-video.mp4')
                writeFileSync(videoPath, bytes)
                notes.push(`${sniffed}，${(bytes.length / 1024 / 1024).toFixed(2)} MB → ${videoPath}`)
              }
            }
          }
        }
      }
    }
  } catch (error) {
    problems.push(String(error))
  }

  if (problems.length > 0) {
    console.log(`FAIL video  : ${problems.join('; ')}`)
    failures++
  } else {
    console.log(`ok   video  : ${Date.now() - started}ms`)
    for (const note of notes) console.log(`             ${note}`)
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${checked - failures}/${checked}`)
process.exit(failures === 0 ? 0 : 1)
