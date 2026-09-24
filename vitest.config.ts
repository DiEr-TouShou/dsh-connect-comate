import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Tests must never touch the real Comate config: v0.1 reads the desktop
 * client's own files and writes nothing, but an isolated home still keeps
 * every test hermetic and the credential redaction honest.
 */
const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-connect-comate-test-'))

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    env: {
      DSH_HOME: isolatedHome,
    },
    testTimeout: 30_000,
  },
})
