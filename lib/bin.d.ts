//#region src/bin.d.ts
/**
 * Standalone status/diagnostics CLI for the dsh-connect-comate bundle.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 三个子命令（`doctor` / `status` / `logout`）、`--json` 输出、
 *     `safeMessage` 脱敏、schemaVersion 字段，均由该项目
 *     （转引自 corrinehu/dsh-workbuddy-connect，MIT）设计。
 * 改动：诊断对象从「账号目录扫描」改为「Comate 本地 config 候选文件」；
 *   无插件自有凭据副本，logout 仅报告。
 *
 * @module dsh-connect-comate/bin
 */
/** Execute one boot-free command. */
declare function run(argv: readonly string[]): Promise<number>;
//#endregion
export { run };