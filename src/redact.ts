/**
 * 凭据脱敏：任何**第三方文本**在越过边界（写进下游响应、写进日志）之前，先把里面
 * 长得像令牌的东西抹掉。
 *
 * ## 为什么要有这个模块
 *
 * 上游网关的错误正文是别人写的文本，我们只是搬运工。它里面可能回显请求头、回显
 * `Cookie`、或者干脆把整条 URL 抄回来——那是 `wps_sid`、Bearer、JWT 的真实内容。
 * 这些字节一旦进了下游的 `{error:{message}}`，就等于把凭据交给了 pi-ai、交给了
 * 浏览器面板、交给了任何读日志的人。所以脱敏不是「美化错误信息」，是**安全边界**。
 *
 * 之前只有 `check.ts` 有这层（按按钮时走一次），常驻的聊天数据路径 `shim.ts`
 * 反而没有——低频那条路装了锁，高频那条门开着。现在两处 import 同一份规则。
 * shim 写日志那几行本来就过了 `safeMessage`，缺的只是**下游响应**那三条出口。
 *
 * ## 为什么零依赖、单独一个文件
 *
 * 与 `model-alias.ts` 同理：卡片（浏览器半）与宿主（node 半）必须用**同一份**规则。
 * 各写一份的话，「卡片里看不到凭据」与「日志里看不到凭据」会悄悄分叉。这个文件不
 * import 任何东西，两半都能安全地引。
 *
 * ## 规则是「宁可多抹」，不是「精确识别」
 *
 * 误伤的表现是错误信息里少一个词（可接受），漏抹的表现是真凭据外泄（不可接受）。
 * 所以键名匹配是宽泛的：`token` / `sid` / `key` / `secret` / `auth` 这些词（含
 * `api_key`、`refresh_token` 这类派生写法）后面跟的 `=值` 或 `:值` 一律抹掉，
 * 不区分它是不是真的密钥。
 *
 * 覆盖不到的：**没有键名、也没有已知前缀的裸凭据**（比如上游在散文里直接写
 * `invalid sid 8f7e6d5c4b3a`）。识别它需要猜测「哪个长字符串是秘密」，那必然要么
 * 误伤正常数字、要么仍然漏。这一条限制是自觉的，写在注释里而不是假装不存在。
 * 它也是两处刻意例外的原因：`code=<错误码>`（纯数字或 `not_login` 这类标识，要留着给人搜）
 * 与短的裸 `key: value`（那是英文句子，不是 YAML）。
 *
 * @module dsh-connect-comate/redact
 */

/** Replacement for a keyed value, e.g. `wps_sid=[redacted]`. */
export const REDACTED = '[redacted]'

/** Replacement for a standalone token, e.g. `Bearer [redacted token]`. */
export const REDACTED_TOKEN = '[redacted token]'

/** Length cap for a message that crosses a boundary. */
export const MESSAGE_LIMIT = 500

/**
 * Key names whose value is treated as a secret, matched case-insensitively and
 * allowing `-` / `_` between words (`api-key` / `api_key` / `apiKey`).
 *
 * `wps_sid` comes first so the alternation picks it over the bare `sid` — same
 * output either way, but deterministic.
 *
 * `cookie` / `set-cookie` are deliberately **not** here: they are container
 * headers, not single secrets, so matching them would swallow the whole value
 * (`Cookie: [redacted]`) and hide which member leaked. Their members are always
 * `k=v` pairs, which the same rule redacts one by one — labels intact.
 */
const SECRET_KEYS = 'wps_sid|sid|session[_-]?id|session|token|access[_-]?token|refresh[_-]?token'
  + '|id[_-]?token|api[_-]?key|apikey|app[_-]?key|secret|client[_-]?secret|password|passwd|pwd'
  + '|authorization|auth|code'

/**
 * `code` 是唯一带例外的键，因为这个插件这条链路上的 `code` 几乎总是**错误码**，
 * 而且实测有两种形状：纯数字（网关把会话失效写成 `"code":"12153"`）与符号标识
 * （`"code":"not_login"`，本机真实返回）。两者都是用户要去搜的、也是本插件
 * `classifyUpstreamError` 自己认的标记——抹成 `[redacted]` 等于让错误信息比上游原文
 * 更难用，换来的安全性接近零。
 *
 * 只放行**标识符形状**：纯数字 ≤ 6 位，或字母开头、字母数字/下划线、≤ 32 字符。
 * 凭据形状的值照样过不去：`-` `.` `+` `/` `=` 全不在允许集里（base64、UUID、
 * `sk-live-…` 都不合规），JWT 与已知前缀更是被更早的规则先一步抹掉。
 *
 * 残留缺口（自觉的）：一个纯字母数字、≤ 32 字符的裸令牌恰好出现在 `code` 下会漏。
 * 这与模块开头声明的「无键名、无已知前缀的裸凭据识别不了」是同一类限制。
 */
const ERROR_CODE_SHAPE = /^(?:\d{1,6}|[A-Za-z][A-Za-z0-9_]{0,31})$/u

/**
 * Minimum value length for the **bare** `key: value` spelling (no quotes, no `=`).
 *
 * 只有这一种拼写会和正常英文撞车：`cannot seal the secret: the key file is …`
 * 里的 `secret: the` 长得和一条 YAML 凭据一模一样，而它只是句子。JSON（`"k":"v"`）
 * 和 `k=v` 不会有这种歧义，所以只给裸冒号拼写加一个门槛：值得像凭据
 * （无空格——这由正则保证——且至少 8 个字符）。
 *
 * 代价写清楚：`Authorization: abc123` 这种又短又没前缀、还没写 scheme 的值会漏过去。
 * 真机上不会遇到（header 里的凭据都是长串），而这属于本模块开头就声明的
 * 「无键名、无已知前缀的裸凭据识别不了」那一类限制。
 */
const BARE_COLON_MIN_VALUE = 8

/** Well-known token prefixes that identify a secret even without a key name. */
const TOKEN_PREFIXES = 'sk|ak|pk|glpat|gh[pousr]|xox[abprs]'

/**
 * Keyed secrets in all three spellings: `k=v` (query, cookie, form), `"k":"v"`
 * (JSON) and `k: v` (header, prose). The value stops at the first
 * quote/comma/semicolon/ampersand/space/brace, which is what keeps a redacted
 * JSON field from swallowing its neighbours.
 *
 * Kept apart from {@link TEMPLATE_RULES} because this one needs a replacer (the
 * `code` carve-out below), not a `$n` template.
 */
const KEYED_SECRET = new RegExp(
  String.raw`(\b"?)(` + SECRET_KEYS + String.raw`)(\b"?\s*[=:]\s*"?)([^"',;&\s}]+)`,
  'giu',
)

/**
 * One pass per shape, applied in order. Order matters in one place: the
 * `Bearer <value>` rule runs before {@link KEYED_SECRET} so the scheme word is
 * consumed as a scheme rather than mistaken for the value. Every rule is
 * idempotent (`[redacted]` matches nothing), so a second pass over already
 * redacted text is a no-op.
 */
const TEMPLATE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // `Authorization: Bearer <blob>` / `Bearer <blob>` / `Basic <blob>`.
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{4,}/giu, `$1 ${REDACTED}`],
  // JWT: header.payload[.signature], the one shape with no key name at all.
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]+)?/gu, REDACTED_TOKEN],
  // A known token prefix with no key name: `sk-live-…`, `ghp_…`, `xoxb-…`.
  // The leading `\b` is load-bearing: without it `risk-management-system` would
  // match `sk-management-system` and ordinary English would start disappearing.
  [new RegExp(String.raw`\b(?:` + TOKEN_PREFIXES + String.raw`)[-_][A-Za-z0-9_-]{8,}`, 'gu'), REDACTED_TOKEN],
]

/**
 * Remove token-shaped substrings from arbitrary text.
 *
 * Pure and idempotent: `redactSecrets(redactSecrets(x)) === redactSecrets(x)`.
 *
 * @param text - any text about to cross a boundary.
 * @returns the same text with credential-shaped substrings replaced.
 */
export function redactSecrets(text: string): string {
  let out = text
  for (const [pattern, replacement] of TEMPLATE_RULES) out = out.replace(pattern, replacement)
  return out.replace(
    KEYED_SECRET,
    // The groups arrive in capture order after the whole match; the labels are
    // preserved (`wps_sid=` stays), only the value is swapped.
    (match: string, lead: string, key: string, separator: string, value: string): string => {
      // 裸冒号（既没有引号也没有 `=`）只在值像凭据时才动，见 BARE_COLON_MIN_VALUE。
      const bareColon = !separator.includes('=') && !separator.includes('"')
      if (bareColon && value.length < BARE_COLON_MIN_VALUE) return match
      if (key.toLowerCase() === 'code' && ERROR_CODE_SHAPE.test(value)) return match
      return `${lead}${key}${separator}${REDACTED}`
    },
  )
}

/**
 * Redact an unexpected value and cap its length, for a message that leaves the
 * host.
 *
 * Redaction runs BEFORE the cap: a cap-first order could cut a token in half and
 * leave the first half of a real secret on display.
 *
 * @param error - any thrown value or third-party excerpt.
 * @returns a single-line, redacted, length-capped message.
 */
export function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return redactSecrets(message).slice(0, MESSAGE_LIMIT)
}
