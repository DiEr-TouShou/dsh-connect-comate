/**
 * 发版门禁：**tag 里必须真的带着构建产物 `lib/`**。
 *
 * 为什么需要这个脚本（一次真实事故）：
 *
 *   `lib/` 长期在 `.gitignore` 里、靠 `prepare` 在安装时现场构建。于是「`github:` 形式的
 *   git 依赖」在**任何干净机器**上都会依次撞两堵墙，且报错都指向别处：
 *
 *     1. `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` —— pnpm 认为这个包「需要构建」，
 *        必须写进 `allowBuilds` 白名单（长 key，绑 commit sha）；
 *     2. `ERR_PNPM_PREPARE_PACKAGE` / `pnpm: command not found` —— 放行后 pnpm 在临时
 *        目录里跑 `pnpm install`（因为仓库里跟踪了 `pnpm-lock.yaml`，`preferred-pm`
 *        选中 pnpm），而这要求 PATH 上有 `pnpm` 可执行文件，DSH 自带的 `runtime/bin`
 *        只暴露了 `node`。
 *
 *   两堵墙的根因是同一个：**git 依赖需要现场构建**。修法是让 git 依赖根本不需要构建 ——
 *   删掉 `prepare`、把 `lib/` 提交进 tag。pnpm 的判定（pnpm 11.7 `packageShouldBeBuilt`）
 *   是：
 *
 *     - `scripts.prepare` 非空  → 需要构建（短路，后面的判断都不看）；
 *     - 否则若有 `prepack`/`prepublish`/`publish` → 看 `main` 指向的文件**是否已在包内**：
 *       在 → 不需要构建；不在 → 需要构建。
 *
 *   所以「`main`（`lib/index.js`）必须进 tag」不是洁癖，是让 `allowBuilds` 与 PATH 上的
 *   pnpm 双双不再被需要的那把钥匙。本脚本就是把这把钥匙钉死，防止将来有人顺手把 `lib/`
 *   加回 `.gitignore`、或把 `prepare` 加回来。
 *
 * 检查项（默认对 `v<package.json version>` 这个 tag）：
 *
 *   1. tag 里存在 `lib/index.js`；
 *   2. tag 里的 `package.json` 没有非空 `prepare`；
 *   3. `main` 指向的文件在 tag 里；
 *   4. `bin` 的每个目标在 tag 里；
 *   5. tag 名与 tag 内 `package.json` 的 `version` 一致（`v0.5.1` ↔ `0.5.1`）；
 *   6. `files` 白名单含 `lib`，且白名单里的每个文件都在 tag 里；
 *   7. 工作树里 `lib/` **未被 `.gitignore` 忽略**（防止把产物又藏回去）；
 *   8. tag 里的 `lib/` 与工作树 `lib/` **逐字节一致**（blob hash 比对）—— 提醒你
 *      「先 `pnpm run build`，再把 `lib/` 一起提交」，而不是提交一份旧产物；
 *   9. `--remote` 时：origin 上确实有这个 tag（推之前会 FAIL，属预期）。
 *
 * 跑法：
 *   node scripts/verify-release-tag.mjs                 # 校验 v<package.json version>
 *   node scripts/verify-release-tag.mjs v0.5.1          # 校验指定 tag
 *   node scripts/verify-release-tag.mjs v0.5.1 --remote # 顺带确认 origin 已有该 tag
 *
 * 退出码 0 = 全过。只读，不改任何文件。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(process.env.COMATE_REPO_DIR ?? join(HERE, '..'))

const argv = process.argv.slice(2)
const CHECK_REMOTE = argv.includes('--remote')
const tagArg = argv.find((a) => !a.startsWith('--'))

/** git 包装：失败即抛出，由调用点决定是「检查失败」还是「环境缺失」。 */
function git(...args) {
  return execFileSync('git', ['-C', REPO, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function gitQuiet(...args) {
  const r = spawnSync('git', ['-C', REPO, ...args], { stdio: 'ignore' })
  return r.status === 0
}

let pkg
try {
  pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
} catch (err) {
  console.error(`读不到 ${join(REPO, 'package.json')}：${err.message}`)
  process.exit(2)
}

const TAG = tagArg ?? `v${pkg.version}`

try {
  git('--version')
} catch {
  console.error('PATH 上找不到 git，本脚本依赖 git 读取 tag 内容。')
  process.exit(2)
}

console.log(`repo : ${REPO}`)
console.log(`tag  : ${TAG}${tagArg ? '' : '（由 package.json 的 version 推导）'}\n`)

if (!gitQuiet('rev-parse', '--verify', '--quiet', `refs/tags/${TAG}`)) {
  console.error(
    `本地没有 tag ${TAG}。\n` +
      `  - 还没打：先 commit（含 lib/），再 git tag -a ${TAG} -m "..."\n` +
      `  - 打过了但没拉：git fetch --tags origin`,
  )
  process.exit(2)
}

const tagFiles = new Set(git('ls-tree', '-r', '--name-only', TAG).split('\n').filter(Boolean))
const tagPkg = JSON.parse(git('show', `${TAG}:package.json`))

/** 每项：{ name, ok, detail, why } */
const results = []
const EMPTY_OBJ = Object.freeze({})
const add = (name, ok, detail, why) => results.push({ name, ok, detail, why })

// 1) 关键项：lib/index.js 必须在 tag 里
add(
  'tag 内含 lib/index.js',
  tagFiles.has('lib/index.js'),
  tagFiles.has('lib/index.js') ? '存在' : '缺失',
  'pnpm 的 packageShouldBeBuilt() 靠「main 指向的文件是否已在包内」早退；缺了它，git 依赖又要现场构建',
)

// 2) prepare 不能回来
const prepare = tagPkg.scripts?.prepare
add(
  'tag 内 package.json 无非空 prepare',
  prepare == null || prepare === '',
  prepare ? `prepare = ${JSON.stringify(prepare)}` : '无 prepare',
  'prepare 非空会让 packageShouldBeBuilt() 短路返回「需要构建」，lib/ 进 tag 也救不了',
)

// 3) main 指向的文件存在
const mainPath = (tagPkg.main ?? 'index.js').replace(/^\.\//, '')
add(
  'main 指向的文件在 tag 内',
  tagFiles.has(mainPath),
  `${tagPkg.main} → ${tagFiles.has(mainPath) ? '存在' : '缺失'}`,
  'packageShouldBeBuilt() 检查的就是这个文件',
)

// 4) bin 目标存在
const bins = Object.values(tagPkg.bin || EMPTY_OBJ).map((p) => String(p).replace(/^\.\//, ''))
const missingBins = bins.filter((p) => !tagFiles.has(p))
add(
  'bin 的每个目标在 tag 内',
  missingBins.length === 0,
  bins.length === 0 ? '无 bin' : missingBins.length === 0 ? `${bins.length} 个目标齐全` : `缺 ${missingBins.join(', ')}`,
  'bin 指向未提交的产物时，安装后命令行入口是坏的',
)

// 5) tag 名 ↔ version
const expectedTag = `v${tagPkg.version}`
add(
  'tag 名与 tag 内 version 一致',
  TAG === expectedTag,
  `tag=${TAG} version=${tagPkg.version}`,
  '不一致会让「按 tag 安装」拿到的版本号对不上，排查时极易误判',
)

// 6) files 白名单
const filesList = Array.isArray(tagPkg.files) ? tagPkg.files.map((f) => String(f).replace(/^\.\//, '')) : []
const filesMissing = filesList.filter((f) => !tagFiles.has(f) && !tagFiles.has(`${f}/`))
add(
  'files 白名单含 lib 且条目都在 tag 内',
  filesList.includes('lib') && filesMissing.length === 0,
  filesList.includes('lib')
    ? filesMissing.length === 0
      ? `${filesList.length} 条齐全`
      : `缺 ${filesMissing.join(', ')}`
    : '白名单里没有 lib',
  'npm registry 发布只带 files 白名单；将来上 npm 时这是「产物是否随包走」的判据',
)

// 7) 工作树 lib/ 未被忽略
const libIgnored = gitQuiet('check-ignore', '-q', 'lib/index.js')
add(
  '工作树 lib/ 未被 .gitignore 忽略',
  !libIgnored,
  libIgnored ? 'lib/index.js 仍被忽略' : '未被忽略',
  '被忽略的目录不会被 git add 进 tag —— 这正是本次事故的起点',
)

// 8) tag 内 lib/ 与工作树 lib/ 逐字节一致
let libDetail = '无法比对（工作树无 lib/）'
let libOk = false
if (existsSync(join(REPO, 'lib'))) {
  const tagBlobs = new Map()
  for (const line of git('ls-tree', '-r', TAG, '--', 'lib').split('\n').filter(Boolean)) {
    const [meta, path] = line.split('\t')
    const sha = meta.split(/\s+/)[2]
    if (path) tagBlobs.set(path, sha)
  }
  const mismatched = []
  for (const [path, sha] of tagBlobs) {
    const abs = join(REPO, path)
    if (!existsSync(abs)) {
      mismatched.push(`${path}（工作树缺失）`)
      continue
    }
    const localSha = git('hash-object', path)
    if (localSha !== sha) mismatched.push(path)
  }
  libOk = tagBlobs.size > 0 && mismatched.length === 0
  libDetail =
    tagBlobs.size === 0
      ? 'tag 内 lib/ 为空'
      : mismatched.length === 0
        ? `${tagBlobs.size} 个文件逐字节一致`
        : `不一致：${mismatched.join(', ')}`
}
add(
  'tag 内 lib/ 与工作树 lib/ 逐字节一致',
  libOk,
  libDetail,
  '提交的必须是「本地刚构建出来的那份」；不一致说明忘了 pnpm run build 或漏 add 了文件',
)

// 9) 可选：origin 已有该 tag
if (CHECK_REMOTE) {
  let remoteTags = null
  let remoteErr = null
  try {
    remoteTags = git('ls-remote', '--tags', 'origin', TAG)
  } catch (err) {
    remoteErr = err
  }
  const detail =
    remoteErr != null
      ? `ls-remote 失败：${remoteErr.message}`
      : remoteTags
        ? remoteTags.split('\n')[0]
        : 'origin 上没有该 tag（还没 push）'
  add('origin 已有该 tag', remoteTags != null && remoteTags !== '', detail, '未推送的 tag 装不到远端机器上')
}

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`)
  console.log(`      ${r.detail}`)
  if (!r.ok) console.log(`      ↳ ${r.why}`)
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} ${passed === results.length ? 'PASS' : 'FAIL'}`)
process.exit(passed === results.length ? 0 : 1)
