/**
 * `scripts/live-profile.mjs` 的解析规则单测：**不联网、不碰真 home**。
 *
 * 为什么值得单测：真机套件默认跳过（要 `WPS_COMATE_LIVE=1`），所以这段「上哪找 sid」
 * 的逻辑平时没人跑；它一旦认错路，表现是 live 套件报 ENOENT 或者读到别人的 sid，
 * 而**默认套件照样全绿**——正是 0.3.2 那类「源码绿、真机废」的形状。这里用临时目录
 * 搭出各种 profile 布局，把解析顺序钉死。
 *
 * 尤其钉住两条：
 *   - 用户名字面量必须绝迹（`~` 一律来自传入的 home，不是进程的真 home）。
 *   - 真 home 必须排在 `DSH_HOME` 前面——`vitest.config.ts` 把 `DSH_HOME` 指到临时
 *     目录，顺序反了的话真机套件就会去临时目录里找 sid。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE, profilePatchCandidates, readWpsSid, WPS_PATCH_ENV, WPS_SID_ENV } from '../scripts/live-profile.mjs'

/** 一个临时「家目录」，用完即弃（不进 process.env，不碰真 home）。 */
function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-live-profile-'))
}

/** 在 `<home>/.dsh/profiles/<name>/cordis.patch.yml` 写一份 patch；返回该文件路径。 */
function writePatch(home: string, name: string, body: string): string {
  const dir = join(home, '.dsh', 'profiles', name)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'cordis.patch.yml')
  writeFileSync(path, body, 'utf8')
  return path
}

/** 真机上 patch 的形状：sid 就一行，前后还有别的条目。 */
function patchWith(sid: string): string {
  return `- id: dsh-connect-comate\n  config:\n    wpsSid: ${sid}\n    other: 1\n`
}

describe('live-profile: 解析 wps_sid 的路径', () => {
  it('WPS_COMATE_SID 优先，且空白串当作没设', () => {
    const home = fakeHome()
    writePatch(home, DEFAULT_PROFILE, patchWith('from-patch'))
    expect(readWpsSid({ [WPS_SID_ENV]: 'from-env' }, home)).toBe('from-env')
    expect(readWpsSid({ [WPS_SID_ENV]: '   ' }, home)).toBe('from-patch')
    expect(readWpsSid({ [WPS_SID_ENV]: '' }, home)).toBe('from-patch')
  })

  it(`${WPS_PATCH_ENV} 指的 patch 会被读，引号会被剥掉`, () => {
    const home = fakeHome()
    const patch = writePatch(home, 'elsewhere', patchWith("'quoted-sid'"))
    expect(readWpsSid({ [WPS_PATCH_ENV]: patch }, home)).toBe('quoted-sid')
  })

  it('DSH_PROFILE_DIR（DSH 注入的受信事实）指哪读哪', () => {
    const home = fakeHome()
    const patch = writePatch(home, 'named-by-dsh', patchWith('from-profile-dir'))
    expect(readWpsSid({ DSH_PROFILE_DIR: join(home, '.dsh', 'profiles', 'named-by-dsh') }, home))
      .toBe('from-profile-dir')
    expect(profilePatchCandidates({ DSH_PROFILE_DIR: join(home, '.dsh', 'profiles', 'named-by-dsh') }, home)[0])
      .toBe(patch)
  })

  it('没给环境变量时，按 DSH_PROFILE（默认 desktop）在 home 下找', () => {
    const home = fakeHome()
    writePatch(home, DEFAULT_PROFILE, patchWith('desktop-sid'))
    expect(readWpsSid({}, home)).toBe('desktop-sid')

    const webHome = fakeHome()
    writePatch(webHome, 'web', patchWith('web-sid'))
    expect(readWpsSid({ DSH_PROFILE: 'web' }, webHome)).toBe('web-sid')
  })

  it('profile 不叫 desktop 也找得到：兜底扫描取含 wpsSid 的那个', () => {
    const home = fakeHome()
    // 一个没有 wpsSid 的邻居（真机上很常见：别的插件也有 profile）不该被误取。
    writePatch(home, 'aaa-other-plugin', '- id: something\n  config:\n    enabled: true\n')
    writePatch(home, 'zzz-real', patchWith('scanned-sid'))
    expect(readWpsSid({}, home)).toBe('scanned-sid')
  })

  it('真 home 排在 DSH_HOME 前面（vitest 把 DSH_HOME 指到临时目录）', () => {
    const home = fakeHome()
    const scratch = fakeHome()
    writePatch(home, DEFAULT_PROFILE, patchWith('real-home-sid'))
    writePatch(scratch, DEFAULT_PROFILE, patchWith('scratch-sid'))
    // `DSH_HOME` 指的是 `.dsh` 目录**本身**（DSH 里默认 `~/.dsh`），所以其下直接是 `profiles/`。
    const dshHome = join(scratch, '.dsh')
    expect(readWpsSid({ DSH_HOME: dshHome }, home)).toBe('real-home-sid')

    // 真 home 里没有时，DSH_HOME 才算数。
    const emptyHome = fakeHome()
    expect(readWpsSid({ DSH_HOME: dshHome }, emptyHome)).toBe('scratch-sid')
  })

  it('哪里都没有：抛错，且报错里带试过的路径与两条设置途径', () => {
    const home = fakeHome()
    let message = ''
    try {
      readWpsSid({}, home)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain(WPS_SID_ENV)
    expect(message).toContain(WPS_PATCH_ENV)
    expect(message).toContain(join(home, '.dsh', 'profiles', DEFAULT_PROFILE, 'cordis.patch.yml'))
  })

  it('候选表去重，且不含任何用户名字面量', () => {
    const home = fakeHome()
    const candidates = profilePatchCandidates({}, home)
    expect(new Set(candidates).size).toBe(candidates.length)
    expect(candidates.every(path => path.startsWith(home))).toBe(true)
  })
})
