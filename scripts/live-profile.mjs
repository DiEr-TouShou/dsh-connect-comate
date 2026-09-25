/**
 * 真机脚本共用的「wps_sid 上哪找」解析：`scripts/*.mjs` 与 `tests/*-live.spec.ts` 都从这里取。
 *
 * 为什么单开一个文件：这台机器上真会话只写在 DSH profile 的 `cordis.patch.yml` 里，
 * 而 profile 的绝对路径里带着**用户名**。把那个路径写进源码，换台机器（同事的机器、
 * CI、另开一个 Windows 账户）必挂——而它挂的方式是 `ENOENT: C:\Users\ASUS\...`，
 * 看起来像插件坏了，其实只是脚本认路认死了。所以路径**一律从环境推导**，
 * 这个文件里没有任何用户名字面量。
 *
 * 解析顺序（先命中先用）：
 *   1. `WPS_COMATE_SID`            直接给 sid。CI 与一次性跑用这个，最短路径。
 *   2. `WPS_COMATE_PROFILE_PATCH`  直接给 patch 文件的绝对路径。
 *   3. `DSH_PROFILE_DIR`           DSH 给 shell 调用注入的 profile 目录（插件作者文档里的
 *                                  受信事实，和 `DSH_PROFILE` 一起下发），其下找 patch。
 *   4. `<home>/.dsh/profiles/<DSH_PROFILE 或 desktop>/cordis.patch.yml`。
 *   5. 兜底扫描 `<DSH_HOME 或 <home>/.dsh>/profiles/<name>/cordis.patch.yml`，
 *      取第一个含 `wpsSid` 的（`desktop` 优先）——profile 不叫 desktop、或者名字
 *      猜错时还有救。
 *
 * 全都不命中就抛错，并把**试过的每一个路径**与两个环境变量一起印出来：现场换机时
 * 最需要的就是这句话，而不是一个裸的 ENOENT。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 直接给 sid 的环境变量。 */
export const WPS_SID_ENV = 'WPS_COMATE_SID'
/** 直接给 patch 文件路径的环境变量。 */
export const WPS_PATCH_ENV = 'WPS_COMATE_PROFILE_PATCH'
/** 没给 `DSH_PROFILE` 时默认猜的 profile 名：桌面端。 */
export const DEFAULT_PROFILE = 'desktop'

const PATCH_FILENAME = 'cordis.patch.yml'
const SID_PATTERN = /wpsSid:\s*(\S+)/

/** 空白串当没设：`VAR=` 与 `VAR= ` 在真机上都很常见。 */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 一个 patch 文件里的 wps_sid；文件不在、没有这一项、或读不动，都算「这里没有」。 */
function sidInPatch(path) {
  if (!existsSync(path)) return undefined
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const match = SID_PATTERN.exec(raw)
  if (match === null) return undefined
  return match[1].replace(/^['"]|['"]$/g, '')
}

/** 扫出来的 profile 名，`desktop` 排最前（这台机器上真会话就在它里面）。 */
function scanProfiles(root) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const names = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  return [DEFAULT_PROFILE, ...names.filter(name => name !== DEFAULT_PROFILE)]
}

/**
 * 候选 patch 路径，按解析顺序、已去重。
 * 调用方按序试；不存在的位置不算错（多平台下总有几个不存在）。
 */
export function profilePatchCandidates(env = process.env, home = homedir()) {
  const profileName = nonEmpty(env['DSH_PROFILE']) ?? DEFAULT_PROFILE
  const candidates = []

  const explicitPatch = nonEmpty(env[WPS_PATCH_ENV])
  if (explicitPatch !== undefined) candidates.push(explicitPatch)

  const profileDir = nonEmpty(env['DSH_PROFILE_DIR'])
  if (profileDir !== undefined) candidates.push(join(profileDir, PATCH_FILENAME))

  // `DSH_HOME` 在 vitest 下被指到临时目录（见 vitest.config.ts），所以真 home 排前面：
  // 命中顺序错了的话，真机套件会去临时目录里找 sid，然后报「没找到」。
  const profilesRoots = [join(home, '.dsh', 'profiles')]
  const dshHome = nonEmpty(env['DSH_HOME'])
  if (dshHome !== undefined) profilesRoots.push(join(dshHome, 'profiles'))

  for (const root of profilesRoots) {
    candidates.push(join(root, profileName, PATCH_FILENAME))
  }
  for (const root of profilesRoots) {
    for (const name of scanProfiles(root)) {
      if (name !== profileName) candidates.push(join(root, name, PATCH_FILENAME))
    }
  }
  return [...new Set(candidates)]
}

/**
 * 解析出 `wps_sid`：先看环境变量，再按 {@link profilePatchCandidates} 找 patch 文件。
 * 找不到就抛错——带着试过的路径与两条设置途径。
 */
export function readWpsSid(env = process.env, home = homedir()) {
  const fromEnv = nonEmpty(env[WPS_SID_ENV])
  if (fromEnv !== undefined) return fromEnv

  const tried = profilePatchCandidates(env, home)
  for (const path of tried) {
    const sid = sidInPatch(path)
    if (sid !== undefined && sid !== '') return sid
  }

  throw new Error([
    `拿不到 wps_sid：${WPS_SID_ENV} 没设，profile 的 ${PATCH_FILENAME} 也没找到。`,
    '试过这些位置：',
    ...tried.map(path => `  - ${path}`),
    '设置任意一条即可：',
    `  ${WPS_SID_ENV}=<sid>                    直接给会话 sid`,
    `  ${WPS_PATCH_ENV}=<patch 绝对路径>  指向含 wpsSid 的 ${PATCH_FILENAME}`,
    '（在 DSH 里跑时 DSH_PROFILE_DIR / DSH_PROFILE 会自动指路，通常不用手设。）',
  ].join('\n'))
}
