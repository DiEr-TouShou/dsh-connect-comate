import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { asVolatile } from '../src/bridge.ts'

/**
 * The decisive runtime fact for DSH 0.1.7's settings write gate.
 *
 * `SettingsForms.write` rejects every write to an entry whose Config declares no
 * volatile field, and `volatile()` only exists from schemastery 3.18.3. The
 * plugin resolves schemastery from its OWN dependency tree, so a dev tree pinned
 * below the version the plugin ships would turn `asVolatile` into a silent
 * no-op here — and a rejected save on the user's machine. workbuddy 2.0.12 lost
 * a release to exactly that gap, which is why these assertions exist instead of
 * a comment.
 */
describe('runtime dependency pins', () => {
  it('resolves a schemastery that supports volatile()', () => {
    expect(typeof z.string().volatile).toBe('function')
  })

  it('really marks a Config field on the schemastery the plugin ships', () => {
    const schema = z.object({ sid: asVolatile(z.string()), plain: z.string() })
    expect(schema.dict?.sid?.meta.volatile).toBe(true)
    expect(schema.dict?.plain?.meta.volatile).toBeUndefined()
  })

  it('keeps the installed version equal to the pinned runtime dependency', () => {
    const own = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>
    }
    const pinned = own.dependencies['@deepseek-ai/schemastery']
    expect(pinned).toBe('3.18.4')
    const require = createRequire(import.meta.url)
    const installed = JSON.parse(
      readFileSync(require.resolve('@deepseek-ai/schemastery/package.json'), 'utf8'),
    ) as { version: string }
    expect(installed.version).toBe(pinned)
  })
})
