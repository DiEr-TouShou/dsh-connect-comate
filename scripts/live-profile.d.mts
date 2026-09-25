/**
 * `live-profile.mjs` 的类型声明：真机 spec 是 TS，脚本是纯 JS，两边共用这一份实现。
 * 声明只覆盖 spec 用得到的那两个入口，其余保持 JS。
 */

/** 环境变量表：`process.env` 或测试里手搓的一份。 */
type Env = Record<string, string | undefined>

export declare const WPS_SID_ENV: 'WPS_COMATE_SID'
export declare const WPS_PATCH_ENV: 'WPS_COMATE_PROFILE_PATCH'
export declare const DEFAULT_PROFILE: 'desktop'

/** 候选 patch 路径，按解析顺序、已去重。 */
export declare function profilePatchCandidates(env?: Env, home?: string): string[]

/** 解析 `wps_sid`；找不到抛错（错误信息里带着试过的路径）。 */
export declare function readWpsSid(env?: Env, home?: string): string
