/**
 * At-rest protection for the manually pasted `wps_sid`.
 *
 * 背景：v0.4 之前，卡片里填的 `wps_sid` 以**明文**写进 DSH 的设置文档
 * （0.1.7 上就是用户手写的 `cordis.patch.yml`）。那是一个真实的长效凭据，而设置
 * 文件会被分享、同步、备份、截图、误提交进 git——明文躺在里面就等于凭据在漂。
 *
 * 本模块把它变成密文：AES-256-GCM，密钥由**本机密钥文件**（随机 32 字节）与
 * **机器指纹**经 HKDF-SHA256 派生。
 *
 * ## 威胁模型（说清楚，免得当成它做不到的事）
 *
 * 防的是：设置文件单独外流。共享 profile、提交 `cordis.patch.yml`、同步盘、
 * 备份、截图、贴日志——拿到这些的人只看到 `enc:v1:<base64url>`。
 *
 * 不防的是：攻击者已经能读这台机器上当前用户的任意文件。密钥文件就在
 * `~/.wpscomate/dsh-connect-comate/secret.key`，同机同用户可读；这不是
 * 「用户设主密码」那种强度，也刻意不做成那种强度——那会要求每次启动解锁，
 * 破坏无头运行与自启动。
 *
 * 机器指纹进 KDF 是为了堵住「设置文件 + 密钥文件一起被拷走」这条路径：换机、
 * 换用户名、换平台/架构，派生出的密钥就不同，密文解不开（此时插件会明确报告
 * 「已保存但无法解密」，让用户重新粘贴，而不是静默 401）。
 *
 * ## 格式
 *
 * 密钥文件（JSON，0600）：
 *   `{ "v": 1, "alg": "aes-256-gcm+hkdf-sha256", "salt": "<base64url 32B>", "createdAt": "…" }`
 *
 * 密文（一个 YAML/JSON 里都安全的字符串）：
 *   `enc:v1:` + base64url( iv[12] || tag[16] || ciphertext )
 *
 * base64url 而不是标准 base64，是为了让整串**不含 `+` `/` `=`**：它会写进
 * YAML 的 plain scalar 位置，出现这些字符就要靠序列化器正确加引号，而
 * `enc:v1:…` 里的冒号后面没有空格、本身就是合法 plain scalar（真机实测
 * js-yaml dump/load 往返一致）。
 *
 * ## 为什么本模块不 import `auth.ts`
 *
 * `auth.ts` 需要它来解密（`auth → secret`），所以反过来 import 会成环。密钥
 * 文件的**默认路径**因此留给 `auth.ts`（它本来就知道 `~/.wpscomate` 在哪），
 * 这里只收显式路径：一个纯粹「路径进、密码学与文件 IO 出」的模块，也更好测。
 *
 * @module dsh-connect-comate/secret
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { chmod, link, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { arch, hostname, platform, userInfo } from 'node:os'
import { dirname } from 'node:path'
import { COMATE_SEALED_PREFIX, isSealedComateSecret } from './bridge.ts'

/**
 * Env var pointing the key file somewhere else.
 *
 * 存在的理由和 `WPS_COMATE_CONFIG_FILE` 一样：无头/CI 场景要能把密钥放在自己
 * 管得住的目录里。它**不是**「换一把密钥」的开关——换路径就是换密钥，已存的
 * 密文会解不开。
 */
export const COMATE_SECRET_KEY_ENV = 'WPS_COMATE_SECRET_KEY_FILE'

/** Sub-directory of the Comate home that holds this plugin's own key file. */
export const COMATE_SECRET_DIRNAME = 'dsh-connect-comate'

/** File name of the key file inside {@link COMATE_SECRET_DIRNAME}. */
export const COMATE_SECRET_KEY_FILENAME = 'secret.key'

/** Schema version of the key file document. */
export const COMATE_SECRET_SCHEMA_VERSION = 1

/** AES-256. */
const KEY_BYTES = 32

/** GCM nonce length; 12 is the length GCM is specified and fastest for. */
const IV_BYTES = 12

/** GCM tag length; 16 (full) is the default and what we verify against. */
const TAG_BYTES = 16

/** Random salt length in the key file. */
const SALT_BYTES = 32

/**
 * HKDF `info`: binds a derived key to this one purpose.
 *
 * Same string as the GCM additional data, deliberately: both are "this key and
 * this ciphertext belong to the wps_sid of dsh-connect-comate, v1", and using one
 * constant for both means a future v2 changes exactly one place.
 */
const HKDF_INFO = 'dsh-connect-comate/wpsSid/v1'

/** GCM additional authenticated data: never encrypted, but tamper-evident. */
const AAD = Buffer.from(HKDF_INFO, 'utf8')

/** Cap on the derived-key cache; a handful of key files is already unusual. */
const DERIVED_CACHE_LIMIT = 8

/** Why a sealed value could not be turned back into a sid. */
export type ComateOpenFailure =
  /** The key file does not exist (fresh machine, deleted, or another user). */
  | 'key-missing'
  /** The key file exists but is not a document this module can use. */
  | 'key-unreadable'
  /** The stored string is not a well-formed sealed value. */
  | 'malformed'
  /** GCM authentication failed: wrong key (other machine/user) or altered bytes. */
  | 'auth-failed'

/** The result of opening a stored value. */
export type ComateOpenResult =
  | { ok: true; value: string }
  | { ok: false; reason: ComateOpenFailure }

/** One key file and the fingerprint the derived key is bound to. */
export interface ComateSecretOptions {
  /** Path of the key file. Created on seal, only read on open. */
  keyFile: string
  /**
   * Machine binding mixed into the KDF. Defaults to
   * {@link machineFingerprint}; tests pass a literal so they do not depend on
   * the machine they run on.
   */
  fingerprint?: string
}

/** A loaded key document plus the identity of the file it came from. */
interface LoadedKeyDocument {
  salt: Buffer
  /** `mtimeMs:size` — invalidates the derived-key cache when the file changes. */
  stamp: string
}

/**
 * A stable, non-secret description of this machine and user.
 *
 * Every component is case-folded: Windows treats host names and user names
 * case-insensitively, so a differently-cased read of the same machine must not
 * derive a different key.
 *
 * `homedir()` is deliberately NOT part of it — it usually embeds the user name
 * already, and a home directory that moves (a remapped drive, a renamed profile
 * folder) would then silently invalidate every stored secret.
 *
 * @returns the fingerprint string used as HKDF salt.
 */
export function machineFingerprint(): string {
  let user = ''
  try {
    user = userInfo().username
  } catch {
    // A process with no user info (some containers) must still work; the rest of
    // the fingerprint still binds the key to the machine.
  }
  return [
    platform(),
    arch(),
    hostname().toLowerCase(),
    user.toLowerCase(),
  ].join('|')
}

/** Derived keys by `path|stamp|fingerprint`, so a read does not re-run HKDF. */
const derivedKeys = new Map<string, Buffer>()

/**
 * Derive the AES key from the key file's salt and the machine fingerprint.
 *
 * `hkdfSync(digest, ikm, salt, info, keylen)`: the key file's random bytes are
 * the input keying material (the secret), the fingerprint is the HKDF salt (not
 * secret), and {@link HKDF_INFO} separates this key from any future use of the
 * same file.
 */
function deriveKey(salt: Buffer, fingerprint: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', salt, Buffer.from(fingerprint, 'utf8'), AAD, KEY_BYTES),
  )
}

/** Read and validate the key document, or say why it is unusable. */
async function readKeyDocument(
  path: string,
): Promise<LoadedKeyDocument | 'missing' | 'unreadable'> {
  let text: string
  let stamp: string
  try {
    const [content, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    text = content
    stamp = `${info.mtimeMs}:${info.size}`
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'missing' : 'unreadable'
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return 'unreadable'
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unreadable'
  const raw = parsed as Record<string, unknown>
  if (typeof raw['salt'] !== 'string') return 'unreadable'
  const salt = Buffer.from(raw['salt'], 'base64url')
  if (salt.length !== SALT_BYTES) return 'unreadable'
  return { salt, stamp }
}

/**
 * Publish a fresh key document at `path`, never replacing an existing one.
 *
 * Temp file + `link()`: `link` fails with `EEXIST` instead of overwriting, which
 * is what makes "two processes seal at the same instant" safe — the loser reads
 * the winner's key rather than installing a second one and orphaning the
 * ciphertext the winner already produced. A plain `writeFile` would also leave a
 * truncated file behind if the process died mid-write, and a truncated key file
 * is unrecoverable (it can decrypt nothing, and overwriting it would orphan
 * everything already sealed).
 *
 * On filesystems where hard links are unavailable the fallback is an exclusive
 * create (`flag: 'wx'`), which keeps the "never replace" property.
 */
async function createKeyDocument(
  path: string,
): Promise<LoadedKeyDocument | 'missing' | 'unreadable'> {
  const salt = randomBytes(SALT_BYTES)
  const document = `${JSON.stringify({
    v: COMATE_SECRET_SCHEMA_VERSION,
    alg: 'aes-256-gcm+hkdf-sha256',
    salt: salt.toString('base64url'),
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    // Inside the try on purpose: a path that cannot hold a key file (a file where
    // the directory belongs, a read-only parent) is a key-file failure like any
    // other, and the caller should report that rather than a bare errno.
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(temp, document, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    // Best effort: on Windows `chmod` only toggles the read-only bit, and the
    // inherited ACL of the user's own home already excludes other users.
    await chmod(temp, 0o600).catch(() => {})
    try {
      await link(temp, path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'EEXIST') return await readKeyDocument(path)
      // No hard links here (or no permission to create one): fall back to an
      // exclusive create, which still refuses to replace an existing key.
      try {
        await writeFile(path, document, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        await chmod(path, 0o600).catch(() => {})
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException | null)?.code !== 'EEXIST') return 'unreadable'
      }
    }
    return await readKeyDocument(path)
  } catch {
    return 'unreadable'
  } finally {
    await unlink(temp).catch(() => {})
  }
}

/**
 * Load the derived key, optionally creating the key file.
 *
 * @param options - key file path and fingerprint.
 * @param create - `true` when sealing (a missing key file is created), `false`
 * when opening (a missing key file means the ciphertext is unrecoverable —
 * creating one there would silently produce a key that can never decrypt it).
 * @returns the key, or the failure to report.
 */
async function loadKey(
  options: ComateSecretOptions,
  create: boolean,
): Promise<Buffer | ComateOpenFailure> {
  const fingerprint = options.fingerprint ?? machineFingerprint()
  let document = await readKeyDocument(options.keyFile)
  if (document === 'missing') {
    if (!create) return 'key-missing'
    document = await createKeyDocument(options.keyFile)
  }
  if (document === 'missing') return 'key-missing'
  if (document === 'unreadable') return 'key-unreadable'
  const cacheId = `${options.keyFile}|${document.stamp}|${fingerprint}`
  const cached = derivedKeys.get(cacheId)
  if (cached !== undefined) return cached
  const key = deriveKey(document.salt, fingerprint)
  // A bounded map, not an LRU: the only way to grow past a handful is a caller
  // that keeps switching key files, and then clearing is the right answer.
  if (derivedKeys.size >= DERIVED_CACHE_LIMIT) derivedKeys.clear()
  derivedKeys.set(cacheId, key)
  return key
}

/** Whether a value is already sealed (never re-seals, never double-wraps). */
export function isSealed(value: string): boolean {
  return isSealedComateSecret(value)
}

/**
 * Encrypt one plaintext secret into its storable form.
 *
 * @param plaintext - the sid, already trimmed by the caller.
 * @param options - key file path and optional fingerprint override.
 * @returns `enc:v1:<base64url>`, safe to put in a settings document.
 * @throws {Error} when the key file cannot be created or read. Callers must not
 * fall back to writing the plaintext: the whole point is that it never lands.
 */
export async function sealSecret(
  plaintext: string,
  options: ComateSecretOptions,
): Promise<string> {
  if (plaintext === '') throw new Error('comate: refusing to seal an empty secret')
  const key = await loadKey(options, true)
  if (typeof key === 'string') {
    throw new Error(`comate: cannot seal the secret: the key file is ${key} (${options.keyFile})`)
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(AAD)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return COMATE_SEALED_PREFIX
    + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
}

/**
 * Decrypt a stored value.
 *
 * Never throws: "the stored sid cannot be opened" is a state the caller renders
 * (the card explains it, `doctor` reports it), not an exception to guess at.
 *
 * @param sealed - the stored string, expected to carry the sealed prefix.
 * @param options - key file path and optional fingerprint override.
 * @returns the plaintext, or the reason it is unavailable.
 */
export async function openSecret(
  sealed: string,
  options: ComateSecretOptions,
): Promise<ComateOpenResult> {
  if (!isSealedComateSecret(sealed)) return { ok: false, reason: 'malformed' }
  const raw = Buffer.from(sealed.slice(COMATE_SEALED_PREFIX.length), 'base64url')
  // A payload shorter than iv+tag cannot hold even one byte, so it is malformed
  // rather than "encrypted empty string" — nothing ever seals an empty secret.
  if (raw.length <= IV_BYTES + TAG_BYTES) return { ok: false, reason: 'malformed' }
  const key = await loadKey(options, false)
  if (typeof key === 'string') return { ok: false, reason: key }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES))
    decipher.setAAD(AAD)
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    const value = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8')
    return value === '' ? { ok: false, reason: 'malformed' } : { ok: true, value }
  } catch {
    // GCM's tag check is the whole point: a wrong key or a single flipped byte
    // both land here, and neither yields a "mostly right" plaintext.
    return { ok: false, reason: 'auth-failed' }
  }
}

/**
 * Clear the derived-key cache.
 *
 * Exists for tests and for a future "the user replaced the key file" action; the
 * cache is keyed by file stamp, so a replaced file is picked up without this.
 */
export function resetSecretKeyCache(): void {
  derivedKeys.clear()
}
