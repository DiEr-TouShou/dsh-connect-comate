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
import { runComateCheck, safeMessage } from './check.ts'
import { ComateUpstreamClient } from './upstream.ts'
import { COMATE_CONNECT_VERSION } from './version.ts'

type Action = 'check' | 'doctor' | 'logout' | 'status'

const JSON_SCHEMA_VERSION = 1

function printHelp(): void {
  process.stdout.write([
    'Usage: dsh-connect-comate <check|doctor|status|logout> [--json]',
    '',
    '  check    send one minimal chat request; verifies the credential works',
    '  doctor   secret-free sign-in and environment diagnostics',
    '  status   sign-in state and model directory summary',
    '  logout   v0.1 keeps no plugin-owned credential copy; reports only',
    '  --json   emit one secret-free JSON document (doctor/status only)',
    '',
    'Env: WPS_COMATE_SID (manual wps_sid cookie) applies to check/status/doctor.',
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
      `Manual wps_sid: ${report.wpsSid}`,
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
    process.stdout.write(`OK: upstream accepted the credential (HTTP 200, SSE stream started; model=${model.id})\n`)
    return 0
  }
  process.stdout.write(`FAIL: HTTP ${outcome.status} [${outcome.kind}]: ${(outcome.message ?? '').slice(0, 300)}\n`)
  process.stdout.write('If the cookie looks right and this still 401s, try cookieOnly (cookie-only auth) or re-copy the sid.\n')
  return 1
}

/** Execute one boot-free command. */
export async function run(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }
  const [rawAction, ...flags] = argv
  const actions: readonly Action[] = ['check', 'doctor', 'logout', 'status']
  if (!actions.includes(rawAction as Action)) {
    process.stderr.write(`dsh-connect-comate: expected check, doctor, logout, or status; got ${JSON.stringify(rawAction)}\n`)
    return 1
  }
  const action = rawAction as Action
  const jsonOutput = flags.includes('--json')
  const unknown = flags.filter(flag => flag !== '--json')
  if (unknown.length > 0 || (jsonOutput && action !== 'doctor' && action !== 'status')) {
    process.stderr.write(`dsh-connect-comate: invalid options for ${action}: ${flags.join(' ')}\n`)
    return 1
  }
  try {
    switch (action) {
      case 'check':
        return await check()
      case 'doctor':
        return await doctor(jsonOutput)
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
