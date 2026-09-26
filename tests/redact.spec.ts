import { describe, expect, it } from 'vitest'
import { MESSAGE_LIMIT, REDACTED, redactSecrets, safeMessage } from '../src/redact.ts'

/**
 * 脱敏是**安全边界**，不是文案美化。这里的用例都按「这句话会不会把真凭据交出去」
 * 来写：合成凭据必须一个字符都不剩，正常文本必须原样通过。
 */

/** 合成凭据：只用于断言「它不出现」，绝不可能是任何真实值。 */
const SID = 'SYNTHSID9f8e7d6c5b4a'
const KEY = 'sk-live-SYNTHETICKEY123456'
const TOKEN = 'SYNTHTOKENabcdef123456'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aCJ9.SYNTHSIG'
const SECRETS = [SID, KEY, TOKEN, JWT]

/** Assert none of the synthetic credentials survived. */
function expectNoSecrets(text: string): void {
  for (const secret of SECRETS) expect(text).not.toContain(secret)
}

describe('redactSecrets', () => {
  it('redacts a bearer token, keeping the scheme word', () => {
    const out = redactSecrets(`Authorization: Bearer ${KEY}`)
    expect(out).not.toContain(KEY)
    expect(out).toContain(REDACTED)
    expect(out).toContain('Authorization')
  })

  it('redacts a bearer token standing alone in prose', () => {
    const out = redactSecrets(`upstream said: invalid credential Bearer ${KEY} (retry)`)
    expect(out).not.toContain(KEY)
    expect(out).toContain('Bearer [redacted]')
    expect(out).toContain('(retry)')
  })

  it('redacts basic auth and other schemes', () => {
    expect(redactSecrets('Basic dXNlcjpwYXNzd29yZA==')).not.toContain('dXNlcjpwYXNzd29yZA==')
    expect(redactSecrets('Bearer YWJjZGVmZ2hpamts')).not.toContain('YWJjZGVmZ2hpamts')
  })

  it('redacts a JWT, the one shape with no key name', () => {
    const out = redactSecrets(`token rejected: ${JWT}`)
    expect(out).not.toContain(JWT)
    expect(out).toContain('[redacted token]')
  })

  it('redacts JSON credential fields — the shape the old rules missed', () => {
    // 旧规则要求 `key=value`，JSON 的 `"key":"value"` 从缝里漏了过去。
    const out = redactSecrets(JSON.stringify({ token: TOKEN, apiKey: KEY, wps_sid: SID }))
    expectNoSecrets(out)
    expect(out).toContain('"token"')
    expect(out).toContain('"apiKey"')
  })

  it('redacts query-string and form-encoded credentials', () => {
    // 刻意不用 `code`：它现在是唯一带例外的键，见本文件后面的两个用例。
    const out = redactSecrets(`failed?token=${TOKEN}&apiKey=${KEY}&wps_sid=${SID}&session_id=${TOKEN}`)
    expectNoSecrets(out)
    expect(out).toContain('token=[redacted]')
  })

  it('redacts every pair of a cookie header', () => {
    const out = redactSecrets(`Cookie: wps_sid=${SID}; token=${TOKEN}; theme=dark`)
    expectNoSecrets(out)
    expect(out).toContain('wps_sid=[redacted]')
    expect(out).toContain('theme=dark')
  })

  it('redacts header-style spellings with a space after the colon', () => {
    const out = redactSecrets(`x-api-key: ${KEY}\nrefresh_token: ${TOKEN}`)
    expectNoSecrets(out)
  })

  it('leaves prose that merely looks like a bare `key: value` alone', () => {
    // 真机上被这条误伤的：`secret: the` 与一条 YAML 凭据长得一样，而它只是句子。
    const prose = 'comate: cannot seal the secret: the key file is key-missing (C:/k)'
    expect(redactSecrets(prose)).toBe(prose)
  })

  it('redacts a known token prefix with no key name', () => {
    const out = redactSecrets(`leaked ${KEY} in the body`)
    expect(out).not.toContain(KEY)
    expect(out).toContain('[redacted token]')
  })

  it('redacts camelCase and dashed key spellings alike', () => {
    for (const spelling of ['apiKey', 'api_key', 'api-key', 'APIKEY']) {
      expect(redactSecrets(`${spelling}=${KEY}`)).not.toContain(KEY)
    }
  })

  it('keeps an error code visible, in both real shapes', () => {
    // `code` 是唯一带例外的键，因为网关的 `code` 是错误标识而不是凭据：数字形态
    // （会话失效 `12153`）与符号形态（`not_login`，本机真实返回）。两者都是用户要
    // 去搜的、也是本插件自己分类用的标记。抹掉它等于让错误信息更难用。
    expect(redactSecrets('{"code":"12153","message":"Offline user session not found"}'))
      .toContain('12153')
    expect(redactSecrets('code=12153')).toBe('code=12153')
    expect(redactSecrets('{"error":{"message":"未登录，请先登录","type":"authentication_error","code":"not_login"}}'))
      .toContain('"code":"not_login"')
  })

  it('still redacts a credential-shaped value under `code`', () => {
    // 例外只放行**标识符形状**。`-` `.` `+` `/` `=` 全不在允许集里，所以 base64、
    // UUID、JWT、`sk-live-…` 都过不去——`code` 不能成为藏凭据的后门。
    expect(redactSecrets(`code=${KEY}`)).not.toContain(KEY)
    expect(redactSecrets(`code=${JWT}`)).not.toContain(JWT)
    expect(redactSecrets('code=1234567890')).not.toContain('1234567890')
    expect(redactSecrets('code=QWxsaSB5b3VyIGJhc2U2NA==')).not.toContain('QWxsaSB5b3VyIGJhc2U2NA')
    expect(redactSecrets('code=a1b2c3d4-e5f6-7890-abcd-ef1234567890')).not.toContain('a1b2c3d4')
  })

  it('documents the known gap: an identifier-shaped bare token under `code` survives', () => {
    // 这是自觉的残留缺口（见 redact.ts 模块头）：`SYNTHTOKEN…` 既是「裸令牌」也是
    // 「标识符形状」，而 `code` 下只能二选一。选「保留错误码」——它被抹掉是每次
    // 会话失效都会发生的伤害，而 `code` 里出现裸令牌是不现实的形状。
    expect(redactSecrets(`code=${TOKEN}`)).toContain(TOKEN)
  })

  it('is idempotent: a second pass changes nothing', () => {
    const once = redactSecrets(`Bearer ${KEY} token=${TOKEN} wps_sid=${SID} ${JWT}`)
    expect(redactSecrets(once)).toBe(once)
  })

  it('leaves ordinary error text alone', () => {
    const plain = 'comate upstream server (http 502): upstream connect error or disconnect'
    expect(redactSecrets(plain)).toBe(plain)
  })

  it('does not treat a prefix-shaped English word as a token', () => {
    // `\b` 就是为这行存在的：`risk-management-system` 里藏着 `sk-management-…`，
    // 去掉词边界它就会变成 `ri[redacted token]`。
    for (const plain of [
      'the task-42 and ak-7 items',
      'risk-management-system failed to start',
      'disk-full-report written',
    ]) {
      expect(redactSecrets(plain)).toBe(plain)
    }
  })
})

describe('safeMessage', () => {
  it('reads the message off an Error', () => {
    expect(safeMessage(new Error('plain failure'))).toBe('plain failure')
  })

  it('stringifies a non-Error', () => {
    expect(safeMessage('just a string')).toBe('just a string')
  })

  it('redacts before capping, so half a token never survives', () => {
    // 先截断再脱敏的话，跨在 500 字处的令牌会被切掉一半，而「半个真凭据」同样是
    // 泄露——这正是 shim 之前 `slice(0, 400)` 的错法。
    // 令牌前面必须有一个非单词字符：`\b` 是故意的（见 redact.ts），否则
    // `risk-management-system` 这种正常英文也会被当成令牌。
    const out = safeMessage(`${'x'.repeat(400)} token=sk-live-${'A'.repeat(200)}`)
    expect(out).not.toMatch(/A{10,}/u)
    expect(out).toContain('token=[redacted]')
    expect(out.length).toBeLessThanOrEqual(MESSAGE_LIMIT)
  })

  it('caps the length', () => {
    expect(safeMessage('x'.repeat(5000)).length).toBe(MESSAGE_LIMIT)
  })

  it('redacts every synthetic credential in one realistic upstream body', () => {
    const body = JSON.stringify({
      code: '12153',
      message: `Offline user session not found (cookie: wps_sid=${SID}; Authorization: Bearer ${KEY})`,
      trace: { token: TOKEN, jwt: JWT },
    })
    expectNoSecrets(safeMessage(body))
  })
})
