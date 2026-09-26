/**
 * 脱敏验收（**针对已构建的产物**）：把 shim 当成真机那样跑起来，喂它一个「上游错误
 * 正文里回显了凭据」的响应，然后看**越过边界的那串字节**里还剩不剩凭据。
 *
 * 为什么单开一个脚本：
 *
 *   1. 验的是**产物**而不是源码（默认 import 已安装的 `lib/`，可用
 *      `COMATE_PKG_DIR` 换目录）。源码绿 ≠ 产物绿，0.3.2 就是这么翻车的。
 *   2. 它**不需要登录态**：上游是本地桩，所以可以在任何机器上、任何时候跑。真机验收
 *      （`verify-shim-live.mjs`）需要 sid，而脱敏是安全边界，不该只在有账号的机器上
 *      才被检查。
 *
 * 四个用例：前三个对应 shim 的三条真实出口（上游拒绝、凭据解析失败、handler 内部异常），
 * 第四个钉住一个容易被「顺手抹掉」的诊断：网关真实返回的 `"code":"not_login"`
 * （本机实测形状）必须活着出来——脱敏不是把错误信息抹平。
 * 判定是「合成凭据一个字符都不剩」**且**「分类与原因仍在」。
 *
 * 跑法：
 *   node scripts/verify-redaction.mjs
 *   COMATE_PKG_DIR="<插件安装目录>" node scripts/verify-redaction.mjs
 *
 * 退出码 0 = 4/4 通过。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = resolve(process.env.COMATE_PKG_DIR ?? join(HERE, '..'))
const ENTRY = join(PKG_DIR, 'lib', 'index.js')
if (!existsSync(ENTRY)) {
  console.error(`找不到产物：${ENTRY}\n用 COMATE_PKG_DIR 指定插件目录。`)
  process.exit(2)
}
const lib = await import(pathToFileURL(ENTRY).href)

/** 合成凭据：只用于断言「它不出现」。 */
const SID = 'SYNTHSID9f8e7d6c5b4a'
const KEY = 'sk-live-SYNTHETICKEY123456'
const TOKEN = 'SYNTHTOKENabcdef123456'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aCJ9.SYNTHSIG'
const SECRETS = [SID, KEY, TOKEN, JWT]

const CREDENTIAL = {
  baseUrl: 'https://comate.wps.cn/llmproxy/v1/user',
  apiKey: 'placeholder-key',
  cookie: `wps_sid=${SID}`,
  authHeader: true,
  models: [{ id: 'model-a', name: 'A', contextWindow: 1_000_000 }],
  configFile: 'C:/fake/config.json',
}

console.log(`package : ${PKG_DIR}`)
console.log(`version : ${lib.COMATE_CONNECT_VERSION}\n`)

/** 起一个真 shim，只把上游/凭据/目录换成桩。 */
async function boot({ chatStream, resolveThrows, catalogThrows }) {
  const shim = lib.createComateShim({
    store: {
      resolve: async () => {
        if (resolveThrows !== undefined) throw resolveThrows
        return CREDENTIAL
      },
    },
    client: { chatStream: chatStream ?? (async () => ({ ok: false, status: 401, kind: 'session_dead', message: 'unset' })) },
    catalog: {
      current: () => {
        if (catalogThrows !== undefined) throw catalogThrows
        return CREDENTIAL.models
      },
    },
    logger: { warn: () => undefined, error: () => undefined },
  })
  await shim.ready
  return shim
}

let failures = 0
let total = 0

/** 一条用例：跑一次请求，检查出口字节。 */
async function check(name, { shim, request, mustKeep }) {
  total++
  let raw
  try {
    raw = await request(shim)
  } catch (error) {
    console.log(`FAIL ${name}: 请求本身抛错 ${String(error)}`)
    failures++
    return
  } finally {
    await shim.close()
  }
  const problems = []
  for (const secret of SECRETS) {
    if (raw.includes(secret)) problems.push(`出口含合成凭据 ${secret}`)
  }
  for (const keep of mustKeep) {
    if (!raw.includes(keep)) problems.push(`诊断信息丢了：${keep}`)
  }
  if (problems.length > 0) {
    console.log(`FAIL ${name}: ${problems.join('; ')}`)
    console.log(`     出口字节：${raw.slice(0, 400)}`)
    failures++
  } else {
    console.log(`ok   ${name}`)
  }
}

const chat = (shim) => fetch(`${shim.baseUrl()}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
  body: '{"model":"model-a","messages":[]}',
}).then((response) => response.text())

await check('upstream error body', {
  shim: await boot({
    chatStream: async () => ({
      ok: false,
      status: 401,
      kind: 'session_dead',
      message: '{"code":"12153","message":"Offline user session not found",'
        + `"echo":{"cookie":"wps_sid=${SID}","Authorization":"Bearer ${KEY}"},`
        + `"token":"${TOKEN}","jwt":"${JWT}"}`,
    }),
  }),
  request: chat,
  mustKeep: ['session_dead', 'Offline user session not found', '12153'],
})

// 网关真实的未登录响应（本机实测）：`code` 是符号标识而不是数字。这类值一旦被抹成
// `[redacted]`，用户就失去了那个可以去搜、本插件自己也用来分类的标记。
await check('upstream error with a symbolic code', {
  shim: await boot({
    chatStream: async () => ({
      ok: false,
      status: 401,
      kind: 'session_dead',
      message: '{"error":{"message":"未登录，请先登录","type":"authentication_error",'
        + `"code":"not_login"},"echo":"wps_sid=${SID}"}`,
    }),
  }),
  request: chat,
  mustKeep: ['session_dead', 'not_login', '未登录，请先登录'],
})

await check('credential resolution failure', {
  shim: await boot({ resolveThrows: new Error(`comate: cannot read C:/fake/config.json (cookie: wps_sid=${SID})`) }),
  request: chat,
  mustKeep: ['not_signed_in', 'C:/fake/config.json'],
})

await check('handler exception (internal 500)', {
  shim: await boot({ catalogThrows: new Error(`model directory unreadable (Authorization: Bearer ${KEY})`) }),
  request: (shim) => fetch(`${shim.baseUrl()}/v1/models`, {
    headers: { Authorization: `Bearer ${shim.token()}` },
  }).then((response) => response.text()),
  mustKeep: ['internal', 'model directory unreadable'],
})

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${total - failures}/${total}`)
process.exit(failures === 0 ? 0 : 1)
