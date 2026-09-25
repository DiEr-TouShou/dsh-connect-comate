/**
 * 安装产物验收：`wps_sid` 密文链路（直接 import 已构建的 `lib/`，不是 `src/`）。
 *
 * 为什么单开一个：源码树跑绿 ≠ 产物跑绿。密文这条路尤其如此——密钥文件、指纹、
 * 原子创建都依赖真实文件系统，而「解不开」的四种成因（malformed / key-missing /
 * key-unreadable / auth-failed）在单测里是打桩造出来的，这里是真的把文件改坏、
 * 移走、换掉，再看产物自己怎么判。
 *
 * 用法：
 *   node scripts/verify-sid-cipher.mjs
 *   COMATE_PLUGIN_DIR="<插件安装目录>" node scripts/verify-sid-cipher.mjs
 *
 * 全程用**临时目录里的密钥文件**和一个合成 sid，不碰真实凭据、不碰真实密钥文件。
 * 退出码 0 = 全部通过。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 同 `verify-installed.mjs`：`USERPROFILE` 只有 Windows 有，换平台会拼出假路径。
const pluginDir = process.env['COMATE_PLUGIN_DIR']
  ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-connect-comate')
const entry = join(pluginDir, 'lib', 'index.js')
if (!existsSync(entry)) {
  console.error(`找不到安装产物：${entry}\n用 COMATE_PLUGIN_DIR 指定插件安装目录。`)
  process.exit(2)
}
const pkg = await import(pathToFileURL(entry).href)
const { COMATE_SEALED_PREFIX, ComateCredentialStore, isSealedComateSecret } = pkg

const work = mkdtempSync(join(tmpdir(), 'comate-sid-'))
const keyFile = join(work, 'secret.key')
const settingsDoc = join(work, 'cordis.patch.yml')
const PLAINTEXT = 'V02verifyCipherPayload0000000000000000000000'

let failures = 0
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

console.log(`package   : ${pluginDir}`)
console.log(`version   : ${pkg.COMATE_CONNECT_VERSION}`)
console.log(`envelope  : ${COMATE_SEALED_PREFIX}`)
console.log(`workdir   : ${work}\n`)

// ---------- 1. 信封判定的边界 ----------
check('明文值不被当成密文', isSealedComateSecret(PLAINTEXT) === false)
check('空串不被当成密文', isSealedComateSecret('') === false)
check('只有前缀、没有载荷 → 不是密文', isSealedComateSecret(COMATE_SEALED_PREFIX) === false)
check('前缀对、载荷短 → 不是密文', isSealedComateSecret(`${COMATE_SEALED_PREFIX}AAAA`) === false)

// ---------- 2. 明文 → 密文 → 明文，值必须逐字节回来 ----------
const store = new ComateCredentialStore({ wpsSid: PLAINTEXT, secretKeyFile: keyFile })
const before = await store.resolveSid({})
check('0.4 之前的明文值仍然可读（升级路径不能丢凭据）', before.storage === 'plaintext' && before.sid === PLAINTEXT, before.storage)

const sealed = await store.sealStored({})
check('sealStored 产出带前缀的密文', sealed.sealed.startsWith(COMATE_SEALED_PREFIX))
check('密文里不含明文', sealed.sealed.includes(PLAINTEXT) === false)
check('回传的明文长度正确（卡片靠它显示「N 字符已保存」）', sealed.length === PLAINTEXT.length)
check('密钥文件已落盘', existsSync(keyFile))

store.setWpsSid(sealed.sealed)
const after = await store.resolveSid({})
check('密文解开后与原明文逐字节相同', after.storage === 'sealed' && after.sid === PLAINTEXT, after.storage)

// 真正落进设置文档的那行，必须是密文而不是明文。
writeFileSync(settingsDoc, `config:\n  wpsSid: ${sealed.sealed}\n`, 'utf8')
const docText = readFileSync(settingsDoc, 'utf8')
check('设置文档里只有密文，没有明文', docText.includes(PLAINTEXT) === false && docText.includes(COMATE_SEALED_PREFIX))

// 同一明文加密两次：密文不同（IV 随机），但都能解开。
const again = await store.seal(PLAINTEXT, {})
check('两次加密的密文不同（IV 随机，不是 ECB）', again.sealed !== sealed.sealed)

// ---------- 3. 「解不开」的四种成因，产物自己要能分辨 ----------
// (a) 载荷被改一个字节 → auth-failed。GCM 认证失败**分不出**「被篡改」和「钥匙不对」
//     （AEAD 的固有性质），所以这两者共用同一个原因码；malformed 只留给字符串结构本身
//     不成立的情况（见 (d)）。指望这里报 malformed 是把「值坏了」和「打不开」搞混了。
const body = sealed.sealed.slice(COMATE_SEALED_PREFIX.length)
const flipped = body[10] === 'A' ? 'B' : 'A'
store.setWpsSid(`${COMATE_SEALED_PREFIX}${body.slice(0, 10)}${flipped}${body.slice(11)}`)
const tampered = await store.resolveSid({})
check('载荷被改一个字符 → unreadable/auth-failed（GCM 拒绝）', tampered.storage === 'unreadable' && tampered.problem === 'auth-failed', tampered.problem)

// (b) 密钥文件被移走 → key-missing。
store.setWpsSid(sealed.sealed)
renameSync(keyFile, `${keyFile}.gone`)
const missing = await store.resolveSid({})
check('密钥文件被移走 → unreadable/key-missing', missing.storage === 'unreadable' && missing.problem === 'key-missing', missing.problem)
check('密钥文件不会因为读失败而被重新创建（否则会把可恢复变成永久损坏）', existsSync(keyFile) === false)

// (c) 换了一把**结构合法**的钥匙（同一个路径、不同的盐）→ auth-failed，而不是「明文」。
//     钥匙文件的形状必须与真实的一致（32 字节盐），否则测的就是「文件坏了」而不是
//     「钥匙不对」——那正是 (d)。
renameSync(`${keyFile}.gone`, keyFile)
rmSync(keyFile, { force: true })
writeFileSync(keyFile, JSON.stringify({
  v: 1,
  alg: 'aes-256-gcm+hkdf-sha256',
  salt: randomBytes(32).toString('base64url'),
  createdAt: new Date().toISOString(),
}), 'utf8')
const wrongKey = await store.resolveSid({})
check('换了一把钥匙 → unreadable/auth-failed', wrongKey.storage === 'unreadable' && wrongKey.problem === 'auth-failed', wrongKey.problem)

// (d) 密钥文件本身不是能用的文档 → key-unreadable，与「钥匙不对」区分开。
writeFileSync(keyFile, 'not json at all', 'utf8')
const junkKey = await store.resolveSid({})
check('密钥文件内容不成形 → unreadable/key-unreadable', junkKey.storage === 'unreadable' && junkKey.problem === 'key-unreadable', junkKey.problem)

// (e) 存储串结构不成立（前缀对、载荷不是 base64url）→ malformed。
store.setWpsSid(`${COMATE_SEALED_PREFIX}${'A'.repeat(40)}!!!`)
const structural = await store.resolveSid({})
check('载荷不是 base64url → unreadable/malformed', structural.storage === 'unreadable' && structural.problem === 'malformed', structural.problem)

// ---------- 4. doctor 的字段：报状态，不报密钥 ----------
rmSync(keyFile, { force: true })
const freshSealed = await store.seal(PLAINTEXT, {})
store.setWpsSid(freshSealed.sealed)
const report = await store.doctor(pkg.COMATE_CONNECT_VERSION)
const reportJson = JSON.stringify(report)
check('doctor 报 sealed', report.wpsSidStorage === 'sealed', report.wpsSidStorage)
check('doctor 报的是密钥文件**路径**', report.wpsSidKeyFile === keyFile, report.wpsSidKeyFile)
check('doctor 的 JSON 里没有明文', reportJson.includes(PLAINTEXT) === false)
check('doctor 的 JSON 里没有密钥本身', reportJson.includes('salt') === false && reportJson.includes('"key"') === false)
check('健康状态下没有 problem 字段', report.wpsSidProblem === undefined)

rmSync(keyFile, { force: true })
const brokenReport = await store.doctor(pkg.COMATE_CONNECT_VERSION)
check('密钥文件没了 → doctor 报 unreadable + key-missing', brokenReport.wpsSidStorage === 'unreadable' && brokenReport.wpsSidProblem === 'key-missing', brokenReport.wpsSidProblem)
check('并且给出可执行的 hint', brokenReport.hints.some(hint => hint.includes('secret.key')))

// ---------- 5. 升级路径的拒绝条件 ----------
rmSync(keyFile, { force: true })
const plainStore = new ComateCredentialStore({ wpsSid: PLAINTEXT, secretKeyFile: keyFile })
const upgraded = await plainStore.sealStored({})
// 存储层不自更新：把密文写回设置文档是调用方（卡片 / 宿主路由）的事，所以这里要
// 显式模拟那次写回——不然测的是「同一个明文又被加密了一遍」，不是「重复升级」。
plainStore.setWpsSid(upgraded.sealed)
let refused = ''
try {
  await plainStore.sealStored({})
} catch (error) {
  refused = error instanceof Error ? error.message : String(error)
}
check('已是密文时拒绝再次加密（不重复套娃）', refused.includes('already sealed'), refused)

// 载荷被改坏的密文：拒绝「再加密一次」，因为那会把仅存的一份密文换成对垃圾的加密。
plainStore.setWpsSid(`${COMATE_SEALED_PREFIX}${'A'.repeat(40)}!!!`)
let damagedRefused = ''
try {
  await plainStore.sealStored({})
} catch (error) {
  damagedRefused = error instanceof Error ? error.message : String(error)
}
check('坏掉的密文拒绝被再次加密（保住唯一一份拷贝）', damagedRefused.includes('damaged sealed value'), damagedRefused)

const envOnly = new ComateCredentialStore({ secretKeyFile: keyFile })
let envRefused = ''
try {
  await envOnly.sealStored({})
} catch (error) {
  envRefused = error instanceof Error ? error.message : String(error)
}
check('没有存储值（只有 env）时拒绝落盘', envRefused.includes('no stored'), envRefused)

// ---------- 6. 密钥文件权限（POSIX 才有意义） ----------
if (process.platform === 'win32') {
  console.log('SKIP  密钥文件权限位（win32 无 POSIX mode，靠目录 ACL）')
} else {
  const mode = statSync(keyFile).mode & 0o777
  check('密钥文件权限是 0600', mode === 0o600, `0o${mode.toString(8)}`)
}

rmSync(work, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
