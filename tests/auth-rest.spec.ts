import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COMATE_HOME_DIRNAME,
  ComateCredentialStore,
  defaultSecretKeyFile,
} from '../src/auth.ts'
import { isSealedComateSecret } from '../src/bridge.ts'
import { COMATE_SECRET_DIRNAME, COMATE_SECRET_KEY_FILENAME } from '../src/secret.ts'

/** The same shape `auth.spec.ts` uses: one official provider, cookie `wps_sid=abc`. */
const SAMPLE_CONFIG = JSON.stringify({
  device_uuid: 'd50-test',
  providers: {
    official: {
      api: 'openai-completions',
      apiKey: 'comate-test-key',
      authHeader: true,
      baseUrl: 'https://comate.wps.cn/llmproxy/v1/user',
      headers: { cookie: 'wps_sid=abc' },
      models: [
        { id: 'test/model-chat//public', name: 'model-chat', context_window: 1000000, llm_types: ['llm-chat'], model_source: 'public', model_tier: 'pro' },
      ],
    },
  },
  version: 2,
})

/**
 * A store over a real temp config, with its key file inside the same temp
 * directory: no test ever touches the machine's own `~/.wpscomate` key.
 */
/** What the settings document already holds, before the store reads it. */
interface StoreSeed {
  wpsSid?: string
  secretKeyFile?: string
}

/** A seed that holds nothing: the "nothing saved yet" case. */
const NO_SEED: StoreSeed = {}

function storeWith(options: StoreSeed = NO_SEED): ComateCredentialStore {
  const dir = mkdtempSync(join(tmpdir(), 'comate-sid-'))
  const configFile = join(dir, 'config.json')
  writeFileSync(configFile, SAMPLE_CONFIG, 'utf8')
  const store = new ComateCredentialStore({
    configFile,
    secretKeyFile: options.secretKeyFile ?? join(dir, 'secret.key'),
  })
  // Set through the same setter the host uses, rather than a constructor field:
  // the seeded value is the "already saved in the settings document" state.
  if (options.wpsSid !== undefined) store.setWpsSid(options.wpsSid)
  return store
}

/**
 * The `wps_sid` at rest: what a read of the settings document can learn, and what
 * it must never have to learn.
 *
 * The two halves of the contract are tested together on purpose — sealing without
 * a read path that still works (and still says WHY a sealed value is unusable) is
 * how a credential silently turns into an unexplained 401.
 */
describe('ComateCredentialStore wps_sid at rest', () => {
  it('reports nothing stored as unset, with the key file it would use', async () => {
    const resolution = await storeWith().resolveSid({})
    expect(resolution.storage).toBe('unset')
    expect(resolution.sid).toBeUndefined()
    expect(resolution.problem).toBeUndefined()
    expect(resolution.keyFile).toContain('secret.key')
  })

  it('still reads a plaintext value written before 0.4', async () => {
    const store = storeWith({ wpsSid: 'legacy-plain-sid' })
    expect(await store.resolveSid({})).toMatchObject({ sid: 'legacy-plain-sid', storage: 'plaintext' })
    // An upgrade must not break the credential that is already working.
    expect((await store.current())?.cookie).toBe('wps_sid=legacy-plain-sid')
  })

  it('seals a typed sid and reads it back for the upstream request', async () => {
    const store = storeWith()
    const { sealed, length } = await store.seal('V02SWTsC-fresh-value')
    expect(sealed.startsWith('enc:v1:')).toBe(true)
    // The length is the only property of the credential the card ever showed, and
    // after sealing it can no longer be read off the stored string.
    expect(length).toBe('V02SWTsC-fresh-value'.length)

    store.setWpsSid(sealed)
    expect(await store.resolveSid({})).toMatchObject({ sid: 'V02SWTsC-fresh-value', storage: 'sealed' })
    expect((await store.current())?.cookie).toBe('wps_sid=V02SWTsC-fresh-value')
  })

  it('never lets the plaintext reach the stored string', async () => {
    const { sealed } = await storeWith().seal('V02SWTsC-secret-part')
    expect(sealed).not.toContain('V02SWTsC')
    expect(sealed).not.toContain('secret-part')
    expect(isSealedComateSecret(sealed)).toBe(true)
  })

  it('trims what it seals and refuses an empty sid', async () => {
    const store = storeWith()
    const { sealed, length } = await store.seal('  padded-sid  ')
    expect(length).toBe('padded-sid'.length)
    store.setWpsSid(sealed)
    expect((await store.current())?.cookie).toBe('wps_sid=padded-sid')
    // A blank sid is never a credential; sealing one would write a value that
    // authenticates nothing while looking configured.
    await expect(store.seal('   ')).rejects.toThrow(/empty/)
  })

  it('reports a sealed value it cannot open, and still serves the config', async () => {
    const { sealed } = await storeWith().seal('sealed-under-another-key')
    // The settings document was restored, the key file was not: the ciphertext is
    // intact and unusable, which is a state to report, not to guess at.
    const other = storeWith()
    await other.seal('a-value-under-this-key')
    const store = storeWith({ wpsSid: sealed, secretKeyFile: other.keyFile({}) })

    const resolution = await store.resolveSid({})
    expect(resolution).toMatchObject({ storage: 'unreadable', problem: 'auth-failed' })
    expect(resolution.sid).toBeUndefined()
    // The read itself still succeeds: the config's own cookie answers, rather than
    // the whole credential vanishing because a manual override went unusable.
    expect((await store.current())?.cookie).toBe('wps_sid=abc')
  })

  it('reports a deleted key file as missing rather than creating one', async () => {
    const store = storeWith()
    const { sealed } = await store.seal('sid-before-the-key-was-lost')
    rmSync(store.keyFile({}))
    store.setWpsSid(sealed)

    expect(await store.resolveSid({})).toMatchObject({ storage: 'unreadable', problem: 'key-missing' })
    // Opening must not install a fresh key: it could only decrypt nothing, while
    // making the state look recoverable.
    expect(() => statSync(store.keyFile({}))).toThrow()
  })

  it('upgrades the stored plaintext without the plaintext entering the browser', async () => {
    const store = storeWith({ wpsSid: 'stored-plain-sid' })
    const { sealed, length } = await store.sealStored({})
    expect(length).toBe('stored-plain-sid'.length)

    store.setWpsSid(sealed)
    expect(await store.resolveSid({})).toMatchObject({ sid: 'stored-plain-sid', storage: 'sealed' })
    // Sealing again is a no-op the caller must not mistake for progress.
    await expect(store.sealStored({})).rejects.toThrow(/already sealed/)
  })

  it('refuses to seal an env-only sid into the settings document', async () => {
    // `WPS_COMATE_SID` is a one-shell override, not a credential the user asked to
    // persist; sealing it and writing it back would do exactly that.
    const store = storeWith()
    expect((await store.current())?.cookie).toBe('wps_sid=abc')
    await expect(store.sealStored({ WPS_COMATE_SID: 'env-only-sid' })).rejects.toThrow(/no stored/)
    expect(await store.resolveSid({ WPS_COMATE_SID: 'env-only-sid' }))
      .toMatchObject({ sid: 'env-only-sid', storage: 'plaintext' })
  })

  it('resolves the key file as override, then env, then the Comate home', () => {
    const store = storeWith()
    const explicit = store.keyFile({})
    expect(explicit).toContain('secret.key')
    // A store handed a key file keeps using it, whatever the environment says.
    expect(store.keyFile({ WPS_COMATE_SECRET_KEY_FILE: 'D:/env/secret.key' })).toBe(explicit)
    expect(new ComateCredentialStore({}).keyFile({ WPS_COMATE_SECRET_KEY_FILE: 'D:/env/secret.key' }))
      .toBe('D:/env/secret.key')
    // The default lives beside the Comate home, never in the DSH profile — the
    // ciphertext and the key must not travel in the same directory tree.
    expect(defaultSecretKeyFile({}, 'C:/Users/u')).toBe(
      join('C:/Users/u', COMATE_HOME_DIRNAME, COMATE_SECRET_DIRNAME, COMATE_SECRET_KEY_FILENAME),
    )
    expect(new ComateCredentialStore({}).keyFile({ WPS_COMATE_HOME: 'D:/comate' })).toBe(
      join('D:/comate', COMATE_SECRET_DIRNAME, COMATE_SECRET_KEY_FILENAME),
    )
  })
})

/**
 * `doctor` is the only place a user can see WHY a configured sid is not working;
 * collapsing "sealed", "still plaintext" and "cannot be decrypted" into "set" is
 * how that question becomes unanswerable.
 */
describe('ComateCredentialStore.doctor wps_sid storage', () => {
  it('reports unset with no storage problem', async () => {
    const report = await storeWith().doctor('0.4.0', {}, 'C:/home')
    expect(report.wpsSid).toBe('unset')
    expect(report.wpsSidStorage).toBe('unset')
    expect(report.wpsSidProblem).toBeUndefined()
  })

  it('flags a plaintext value and says how to upgrade it', async () => {
    const report = await storeWith({ wpsSid: 'plain-sid' }).doctor('0.4.0', {}, 'C:/home')
    expect(report.wpsSid).toBe('set')
    expect(report.wpsSidStorage).toBe('plaintext')
    expect(report.hints.join(' ')).toMatch(/PLAINTEXT/)
    expect(report.wpsSidKeyFile).toContain('secret.key')
  })

  it('reports a sealed value as sealed and hint-free', async () => {
    const store = storeWith()
    store.setWpsSid((await store.seal('a-sid')).sealed)
    const report = await store.doctor('0.4.0', {}, 'C:/home')
    expect(report.wpsSid).toBe('set')
    expect(report.wpsSidStorage).toBe('sealed')
    expect(report.wpsSidProblem).toBeUndefined()
    expect(report.hints.join(' ')).not.toMatch(/PLAINTEXT/)
  })

  it('names the reason and the key file when a sealed value cannot be opened', async () => {
    const store = storeWith()
    const { sealed } = await store.seal('a-sid')
    rmSync(store.keyFile({}))
    store.setWpsSid(sealed)

    const report = await store.doctor('0.4.0', {}, 'C:/home')
    // Still "set": the user DID configure a sid, and saying "unset" would send
    // them looking for a missing value that is right there.
    expect(report.wpsSid).toBe('set')
    expect(report.wpsSidStorage).toBe('unreadable')
    expect(report.wpsSidProblem).toBe('key-missing')
    expect(report.hints.join(' ')).toMatch(/cannot be decrypted/)
    expect(report.hints.join(' ')).toContain('WPS_COMATE_SECRET_KEY_FILE')
    // A path, never the key itself.
    expect(report.wpsSidKeyFile).toContain('secret.key')
  })
})
