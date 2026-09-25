import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMATE_SEALED_PREFIX, isSealedComateSecret } from '../src/bridge.ts'
import {
  COMATE_SECRET_SCHEMA_VERSION,
  isSealed,
  machineFingerprint,
  openSecret,
  resetSecretKeyCache,
  sealSecret,
} from '../src/secret.ts'

/**
 * A literal fingerprint keeps these tests independent of the machine they run
 * on — the derivation is exercised, the environment is not.
 */
const FINGERPRINT = 'test|machine|fingerprint'

/** A fresh key-file path in its own temp directory, so no test sees another's key. */
function keyFileIn(): string {
  return join(mkdtempSync(join(tmpdir(), 'comate-secret-')), 'secret.key')
}

/** The documented envelope shape: prefix + base64url, nothing else. */
const ENVELOPE = /^enc:v1:[A-Za-z0-9_-]+$/

describe('sealSecret / openSecret', () => {
  it('round-trips a sid through the documented envelope', async () => {
    const keyFile = keyFileIn()
    const sealed = await sealSecret('V02SWTsC-example_sid.value', { keyFile, fingerprint: FINGERPRINT })

    // The envelope has to be safe to drop into a YAML plain scalar: no `+`, `/`
    // or `=`, and a colon that is not followed by a space.
    expect(sealed).toMatch(ENVELOPE)
    expect(sealed.startsWith(COMATE_SEALED_PREFIX)).toBe(true)
    expect(isSealed(sealed)).toBe(true)
    expect(isSealedComateSecret(sealed)).toBe(true)
    expect(sealed).not.toContain('V02SWTsC')

    const opened = await openSecret(sealed, { keyFile, fingerprint: FINGERPRINT })
    expect(opened).toEqual({ ok: true, value: 'V02SWTsC-example_sid.value' })
  })

  it('never produces the same ciphertext twice for one plaintext', async () => {
    const keyFile = keyFileIn()
    const first = await sealSecret('same-sid', { keyFile, fingerprint: FINGERPRINT })
    const second = await sealSecret('same-sid', { keyFile, fingerprint: FINGERPRINT })

    // A fresh IV per seal: equal ciphertexts would leak that two profiles hold
    // the same credential, and would make the format reusable as an oracle.
    expect(second).not.toBe(first)
    for (const sealed of [first, second]) {
      expect(await openSecret(sealed, { keyFile, fingerprint: FINGERPRINT }))
        .toEqual({ ok: true, value: 'same-sid' })
    }
  })

  it('handles a sid at the sizes and alphabets a real one uses', async () => {
    const keyFile = keyFileIn()
    // Real sids are long ASCII blobs; a non-ASCII one must survive too, since the
    // plaintext is encoded as UTF-8 and the length the card reports is characters.
    const values = ['a', 'x'.repeat(4096), 'sid+with/symbols=and spaces', '会话-标识-✓']
    for (const value of values) {
      const sealed = await sealSecret(value, { keyFile, fingerprint: FINGERPRINT })
      expect(await openSecret(sealed, { keyFile, fingerprint: FINGERPRINT }))
        .toEqual({ ok: true, value })
    }
  })

  it('refuses to seal an empty secret', async () => {
    const keyFile = keyFileIn()
    await expect(sealSecret('', { keyFile, fingerprint: FINGERPRINT })).rejects.toThrow(/empty/)
    // …and does not leave a key file behind for a request that was never valid.
    expect(() => statSync(keyFile)).toThrow()
  })

  it('refuses tampered ciphertext instead of returning a corrupted sid', async () => {
    const keyFile = keyFileIn()
    const sealed = await sealSecret('original-sid', { keyFile, fingerprint: FINGERPRINT })
    const payload = Buffer.from(sealed.slice(COMATE_SEALED_PREFIX.length), 'base64url')

    for (const index of [0, 12, payload.length - 1]) {
      const altered = Buffer.from(payload)
      altered[index] = (altered[index] ?? 0) ^ 0x01
      const result = await openSecret(
        COMATE_SEALED_PREFIX + altered.toString('base64url'),
        { keyFile, fingerprint: FINGERPRINT },
      )
      // GCM's tag check is the whole point: iv, tag and body are all covered, and
      // a wrong key or a flipped bit both land on the same refusal.
      expect(result).toEqual({ ok: false, reason: 'auth-failed' })
    }
  })

  it('refuses a value sealed on another machine', async () => {
    const keyFile = keyFileIn()
    const sealed = await sealSecret('machine-bound-sid', { keyFile, fingerprint: FINGERPRINT })
    // The settings file and the key file both travelled to a new machine: the
    // fingerprint is what makes the ciphertext unusable there.
    expect(await openSecret(sealed, { keyFile, fingerprint: 'other|machine|fingerprint' }))
      .toEqual({ ok: false, reason: 'auth-failed' })
  })

  it('refuses a value sealed under a different key file', async () => {
    const sealed = await sealSecret('sid', { keyFile: keyFileIn(), fingerprint: FINGERPRINT })
    // The other key file is a real one, just not this ciphertext's: a replaced or
    // restored key file must fail the tag check, never yield a wrong sid.
    const otherKeyFile = keyFileIn()
    await sealSecret('another-sid', { keyFile: otherKeyFile, fingerprint: FINGERPRINT })
    expect(await openSecret(sealed, { keyFile: otherKeyFile, fingerprint: FINGERPRINT }))
      .toEqual({ ok: false, reason: 'auth-failed' })
  })

  it('picks up a replaced key file rather than serving a cached key', async () => {
    const keyFile = keyFileIn()
    const sealed = await sealSecret('sid-before-replacement', { keyFile, fingerprint: FINGERPRINT })
    expect((await openSecret(sealed, { keyFile, fingerprint: FINGERPRINT })).ok).toBe(true)

    // A new key file at the same path (the user restored a different backup). The
    // derived-key cache is keyed by the file's stamp, so a stale entry here would
    // hand back the old key and silently keep decrypting what it should not.
    const document = JSON.parse(readFileSync(keyFile, 'utf8')) as Record<string, unknown>
    document['salt'] = Buffer.from('replacement-salt-of-32-bytes!!!!').toString('base64url')
    writeFileSync(keyFile, `${JSON.stringify(document)}\n`, 'utf8')
    const future = new Date(Date.now() + 60_000)
    utimesSync(keyFile, future, future)

    expect(await openSecret(sealed, { keyFile, fingerprint: FINGERPRINT }))
      .toEqual({ ok: false, reason: 'auth-failed' })
  })
})

describe('the key file', () => {
  it('is created once and reused, and stays a valid document', async () => {
    const keyFile = keyFileIn()
    const first = await sealSecret('sid-one', { keyFile, fingerprint: FINGERPRINT })
    const before = readFileSync(keyFile, 'utf8')
    const second = await sealSecret('sid-two', { keyFile, fingerprint: FINGERPRINT })

    // Re-sealing must never install a second key: everything sealed under the
    // first one would become undecryptable.
    expect(readFileSync(keyFile, 'utf8')).toBe(before)
    expect(await openSecret(first, { keyFile, fingerprint: FINGERPRINT }))
      .toEqual({ ok: true, value: 'sid-one' })
    expect(await openSecret(second, { keyFile, fingerprint: FINGERPRINT }))
      .toEqual({ ok: true, value: 'sid-two' })

    const document = JSON.parse(before) as Record<string, unknown>
    expect(document['v']).toBe(COMATE_SECRET_SCHEMA_VERSION)
    expect(document['alg']).toBe('aes-256-gcm+hkdf-sha256')
    expect(Buffer.from(document['salt'] as string, 'base64url')).toHaveLength(32)
  })

  it('is created owner-only where the platform supports modes', async () => {
    const keyFile = keyFileIn()
    await sealSecret('sid', { keyFile, fingerprint: FINGERPRINT })
    if (platform() === 'win32') {
      // Windows chmod only toggles the read-only bit; the inherited ACL of the
      // user's own home is what excludes other users there.
      expect(statSync(keyFile).isFile()).toBe(true)
      return
    }
    expect(statSync(keyFile).mode & 0o777).toBe(0o600)
  })

  it('reports a missing key file instead of creating one while opening', async () => {
    const keyFile = keyFileIn()
    const sealed = await sealSecret('sid', { keyFile, fingerprint: FINGERPRINT })
    // Deleting the key file is the "fresh machine, copied settings" case. Opening
    // must NOT create a new key: it could only produce one that decrypts nothing,
    // while making the state look recoverable.
    const { rmSync } = await import('node:fs')
    rmSync(keyFile)

    expect(await openSecret(sealed, { keyFile, fingerprint: FINGERPRINT }))
      .toEqual({ ok: false, reason: 'key-missing' })
    expect(() => statSync(keyFile)).toThrow()
  })

  it('reports an unusable key file rather than guessing', async () => {
    const cases: Array<[string, string]> = [
      ['not a document', 'garbage'],
      ['not JSON', '{"salt":'],
      ['an array', '[]'],
      ['a salt of the wrong length', JSON.stringify({ v: 1, salt: 'AAAA' })],
      ['no salt at all', JSON.stringify({ v: COMATE_SECRET_SCHEMA_VERSION })],
    ]
    for (const [label, content] of cases) {
      const keyFile = keyFileIn()
      writeFileSync(keyFile, content, 'utf8')
      resetSecretKeyCache()
      const result = await openSecret(`${COMATE_SEALED_PREFIX}${'A'.repeat(64)}`, {
        keyFile,
        fingerprint: FINGERPRINT,
      })
      expect(result, label).toEqual({ ok: false, reason: 'key-unreadable' })
    }
  })

  it('reports a key file it cannot create instead of sealing anyway', async () => {
    // A directory where the key file belongs: creation fails, and sealing must
    // fail with it — falling back to the plaintext is the one thing this module
    // exists to prevent.
    const dir = mkdtempSync(join(tmpdir(), 'comate-secret-'))
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory', 'utf8')
    await expect(
      sealSecret('sid', { keyFile: join(blocker, 'secret.key'), fingerprint: FINGERPRINT }),
    ).rejects.toThrow(/key-unreadable/)
  })
})

describe('openSecret input validation', () => {
  it('treats anything without the envelope as malformed', async () => {
    const keyFile = keyFileIn()
    const values = [
      'plain-sid',
      COMATE_SEALED_PREFIX,
      `${COMATE_SEALED_PREFIX}AAAA`,
      // iv+tag is the minimum a payload must exceed; exactly that much cannot
      // hold a single byte of plaintext.
      COMATE_SEALED_PREFIX + Buffer.alloc(28).toString('base64url'),
    ]
    for (const value of values) {
      expect(await openSecret(value, { keyFile, fingerprint: FINGERPRINT }), value)
        .toEqual({ ok: false, reason: 'malformed' })
    }
    // Malformed input is refused before the key file is even touched.
    expect(() => statSync(keyFile)).toThrow()
  })
})

describe('machineFingerprint', () => {
  it('is stable, non-empty, and describes the platform', () => {
    const fingerprint = machineFingerprint()
    expect(fingerprint).toBe(machineFingerprint())
    expect(fingerprint).toContain(platform())
    expect(fingerprint).toContain(arch())
    expect(fingerprint.split('|')).toHaveLength(4)
    // Case-folded: Windows reports the same host and user in either case, and a
    // differently-cased read must not derive a different key.
    const [host, user] = fingerprint.split('|').slice(2)
    expect(host).toBe((host ?? '').toLowerCase())
    expect(user).toBe((user ?? '').toLowerCase())
  })
})
