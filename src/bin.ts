#!/usr/bin/env node
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

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  COMATE_CONFIG_ENV,
  COMATE_HOME_ENV,
  COMATE_SID_ENV,
  ComateCredentialStore,
  defaultComateHome,
  defaultConfigCandidates,
} from './auth.ts'
import { isSealedComateSecret } from './bridge.ts'
import { COMATE_CHECK_MAX_TOKENS, runComateCheck, safeMessage } from './check.ts'
import { ComateUpstreamClient } from './upstream.ts'
import { COMATE_CONNECT_VERSION } from './version.ts'

type Action = 'check' | 'doctor' | 'logout' | 'seal' | 'status'

const JSON_SCHEMA_VERSION = 1

function printHelp(): void {
  process.stdout.write([
    'Usage: dsh-connect-comate <check|doctor|seal|status|logout> [--json]',
    '',
    '  check    send one minimal chat request; verifies the credential works',
    '  doctor   secret-free sign-in and environment diagnostics',
    '  seal     encrypt a wps_sid into the value to store (reads stdin, or WPS_COMATE_SID)',
    '  status   sign-in state and model directory summary',
    '  logout   v0.1 keeps no plugin-owned credential copy; reports only',
    '  --json   emit one secret-free JSON document (doctor/status/seal only)',
    '',
    'Env: WPS_COMATE_SID (manual wps_sid cookie; a sealed value works too) applies',
    '     to check/status/doctor/seal. WPS_COMATE_SECRET_KEY_FILE points the key',
    '     file elsewhere (default ~/.wpscomate/dsh-connect-comate/secret.key).',
    '',
    'seal prints ONLY the sealed value on stdout, so it can be redirected straight',
    'into a settings file; notes and errors go to stderr.',
    '',
  ].join('\n'))
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function makeStore(): ComateCredentialStore {
  return new ComateCredentialStore()
}

async function doctor(jsonOutput: boolean): Promise<number> {
  const store = makeStore()
  const report = await store.doctor(COMATE_CONNECT_VERSION)
  if (jsonOutput) {
    printJson(report)
  } else {
    process.stdout.write([
      `WPS Comate Connect ${COMATE_CONNECT_VERSION} on ${process.version}`,
      `Comate home: ${defaultComateHome()}`,
      `Sign-in state: ${report.signIn}`,
      ...report.candidates.map(candidate =>
        `  - ${candidate.path}\n    present=${candidate.present} valid=${candidate.valid}`
        + `${candidate.baseUrl === undefined ? '' : ` baseUrl=${candidate.baseUrl}`}`
        + `${candidate.modelCount === undefined ? '' : ` models=${candidate.modelCount}`}`
        + `${candidate.error === undefined ? '' : ` (${candidate.error})`}`,
      ),
      `user_auth.json present: ${report.userAuthPresent}`,
      `Manual wps_sid: ${report.wpsSid} (storage=${report.wpsSidStorage}`
      + `${report.wpsSidProblem === undefined ? '' : `, problem=${report.wpsSidProblem}`})`,
      `wps_sid key file: ${report.wpsSidKeyFile}`,
      ...report.hints.map(hint => `Hint: ${hint}`),
      '',
    ].join('\n'))
  }
  return report.signIn === 'signed-in' ? 0 : 1
}

async function status(jsonOutput: boolean): Promise<number> {
  const store = makeStore()
  const authStatus = await store.status()
  if (authStatus.state !== 'signed-in') {
    if (jsonOutput) {
      printJson({
        schemaVersion: JSON_SCHEMA_VERSION,
        package: 'dsh-connect-comate',
        version: COMATE_CONNECT_VERSION,
        status: 'signed-out',
      })
    } else {
      process.stdout.write(`WPS Comate Connect: signed out\n`)
    }
    return 1
  }
  if (jsonOutput) {
    printJson({
      schemaVersion: JSON_SCHEMA_VERSION,
      package: 'dsh-connect-comate',
      version: COMATE_CONNECT_VERSION,
      status: 'signed-in',
      baseUrl: authStatus.baseUrl,
      modelCount: authStatus.modelCount,
    })
    return 0
  }
  process.stdout.write([
    `WPS Comate Connect: signed in`,
    `Upstream baseUrl: ${authStatus.baseUrl}`,
    `Local models: ${authStatus.modelCount}`,
    'Models and credentials are read from the Comate desktop config; the desktop files are never written.',
    '',
  ].join('\n'))
  return 0
}

/**
 * Send one minimal chat request to verify the resolved credential.
 * Reads the manual sid from the store (options/env), so it doubles as the
 * fastest way to validate a pasted wps_sid before using it in DSH.
 *
 * The request itself lives in `./check.ts`, shared with the plugin card's
 * 「测试连接」 action: the command line and the button must not be able to
 * disagree about what "the connection works" means.
 */
async function check(): Promise<number> {
  const store = makeStore()
  let credential
  try {
    credential = await store.resolve()
  } catch (error: unknown) {
    process.stderr.write(`dsh-connect-comate: check failed: ${safeMessage(error)}\n`)
    return 1
  }
  const model = credential.models[0]
  if (model === undefined) {
    process.stderr.write('dsh-connect-comate: no models in credential; cannot check\n')
    return 1
  }
  const outcome = await runComateCheck({
    credential,
    client: new ComateUpstreamClient(),
    model: model.id,
  })
  if (outcome.ok) {
    process.stdout.write(
      outcome.content === true
        ? `OK: credential accepted, stream completed, content received (model=${model.id})\n`
        : `OK: credential accepted, stream completed, but no text arrived`
          + ` (model=${model.id}; the probe caps output at ${COMATE_CHECK_MAX_TOKENS} tokens`
          + `${outcome.reasoning === true ? ', reasoning only' : ''})\n`,
    )
    return 0
  }
  // 「凭据已通过」与「探测失败」是两件事：上游可能收下了凭据，然后在流里报错（积分
  // 不足、会话失效），也可能收了凭据什么都不回。前者能给出的 actionable 信息是上游
  // 那句话，不该被一句笼统的 FAIL 盖掉。
  if (outcome.accepted === true) {
    process.stdout.write(
      `INCOMPLETE: the credential was accepted, but the probe did not finish`
      + ` — HTTP ${outcome.status} [${outcome.kind}]: ${(outcome.message ?? '').slice(0, 300)}\n`,
    )
    return 1
  }
  process.stdout.write(`FAIL: HTTP ${outcome.status} [${outcome.kind}]: ${(outcome.message ?? '').slice(0, 300)}\n`)
  process.stdout.write('If the cookie looks right and this still 401s, try cookieOnly (cookie-only auth) or re-copy the sid.\n')
  return 1
}

/**
 * Read all of stdin as UTF-8 text.
 *
 * Used by `seal` instead of an argument on purpose: a sid passed as an argv lands
 * in the shell history and in every process listing on the machine.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Encrypt a plaintext sid into the value the settings document should hold.
 *
 * The command-line counterpart of the card's save — same store, same key file,
 * same envelope. It exists for the two cases the card cannot serve: a deployment
 * with no host web route (so the card has nothing to call), and a hand-edited
 * `cordis.patch.yml` where the user wants to paste the ciphertext themselves.
 */
async function seal(jsonOutput: boolean): Promise<number> {
  const store = makeStore()
  const keyFile = store.keyFile()
  const fromEnv = (process.env[COMATE_SID_ENV] ?? '').trim()
  let raw = fromEnv
  if (raw === '') {
    if (process.stdin.isTTY === true) {
      process.stderr.write('Paste the wps_sid value, then press Enter (Ctrl+D / Ctrl+Z to cancel):\n')
    }
    raw = await readStdin()
  }
  // Pasting the whole cookie is the common mistake; the value is what follows "=".
  const stripped = raw.replace(/^wps_sid=/iu, '').trim()
  if (stripped !== raw.trim()) {
    process.stderr.write('dsh-connect-comate: stripped the "wps_sid=" prefix from the pasted cookie\n')
  }
  if (stripped === '') {
    process.stderr.write('dsh-connect-comate: nothing to seal (no sid on stdin or in WPS_COMATE_SID)\n')
    return 1
  }
  if (isSealedComateSecret(stripped)) {
    process.stderr.write('dsh-connect-comate: that value is already sealed; nothing to do\n')
    return 1
  }
  const answer = await store.seal(stripped)
  if (jsonOutput) {
    printJson({
      schemaVersion: JSON_SCHEMA_VERSION,
      package: 'dsh-connect-comate',
      version: COMATE_CONNECT_VERSION,
      sealed: answer.sealed,
      length: answer.length,
      keyFile,
    })
    return 0
  }
  process.stdout.write(`${answer.sealed}\n`)
  process.stderr.write([
    `sealed ${answer.length} character(s); key file: ${keyFile}`,
    'Store it as the wpsSid value of the dsh-connect-comate entry in cordis.patch.yml,',
    'or just paste the plaintext in the plugin card (it seals on save).',
    'It only decrypts on this machine and user account while that key file exists;',
    'if the key file is lost, paste the sid again to store a new one.',
    '',
  ].join('\n'))
  return 0
}

/** Execute one boot-free command. */
export async function run(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }
  const [rawAction, ...flags] = argv
  const actions: readonly Action[] = ['check', 'doctor', 'logout', 'seal', 'status']
  if (!actions.includes(rawAction as Action)) {
    process.stderr.write(`dsh-connect-comate: expected check, doctor, logout, seal, or status; got ${JSON.stringify(rawAction)}\n`)
    return 1
  }
  const action = rawAction as Action
  const jsonOutput = flags.includes('--json')
  const unknown = flags.filter(flag => flag !== '--json')
  if (unknown.length > 0 || (jsonOutput && action !== 'doctor' && action !== 'status' && action !== 'seal')) {
    process.stderr.write(`dsh-connect-comate: invalid options for ${action}: ${flags.join(' ')}\n`)
    return 1
  }
  try {
    switch (action) {
      case 'check':
        return await check()
      case 'doctor':
        return await doctor(jsonOutput)
      case 'seal':
        return await seal(jsonOutput)
      case 'status':
        return await status(jsonOutput)
      case 'logout': {
        const store = makeStore()
        await store.logout()
        process.stdout.write(
          `WPS Comate Connect: v0.1 keeps no plugin-owned credential copy; the Comate desktop files were never touched.\n`,
        )
        return 0
      }
    }
  } catch (error: unknown) {
    process.stderr.write(`dsh-connect-comate: ${action} failed: ${safeMessage(error)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2))
}
