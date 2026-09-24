/**
 * Package version, injected at build time by `tsdown.config.ts`.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT）—— 版本由构建期 define
 * 注入而非运行时读取 package.json（发布包只含 lib/）。
 *
 * @module dsh-connect-comate/version
 */

declare const __DSH_COMATE_VERSION__: string

/** The npm package version this build was produced from. */
export const COMATE_CONNECT_VERSION: string =
  typeof __DSH_COMATE_VERSION__ === 'string' && __DSH_COMATE_VERSION__ !== ''
    ? __DSH_COMATE_VERSION__
    : '0.0.0-dev'
