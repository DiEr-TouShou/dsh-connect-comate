import { describe, expect, it, vi } from 'vitest'
import { asVolatile, unwrapVolatile, unwrapVolatileDeep } from '../src/bridge.ts'

/**
 * DSH 0.1.7 delivers a volatile field as a frozen `{ get(): T }` live reference.
 * Modelled here exactly as the harness shapes it, because the shape is the whole
 * point: a live reference is still `typeof === 'object'`, so every reader that
 * decides "it is an object, therefore it is my section/map" is wrong in a way no
 * plain-object test double would ever reveal.
 */
function live<T>(value: T): { get(): T } {
  return Object.freeze({ get: () => value })
}

describe('asVolatile', () => {
  it('calls volatile() when the schema supports it', () => {
    const marked = { meta: { volatile: true } }
    const volatile = vi.fn(() => marked)
    expect(asVolatile({ volatile })).toBe(marked)
    expect(volatile).toHaveBeenCalledTimes(1)
  })

  it('returns the very same object when volatile() is absent', () => {
    const schema = { meta: {} }
    expect(asVolatile(schema)).toBe(schema)
  })

  it('never hand-writes the meta.volatile marker', () => {
    // Hand-writing it bypasses schemastery's own validateVolatileSchema checks
    // and produces a schema its tooling does not understand — so the fallback
    // must be an identity no-op, not a marker.
    const schema: { meta: Record<string, unknown> } = { meta: {} }
    asVolatile(schema)
    expect(schema.meta).toEqual({})
  })

  it('preserves the schema type through the no-op branch', () => {
    const schema = { meta: {}, type: 'string' as const }
    expect(asVolatile(schema).type).toBe('string')
  })
})

describe('unwrapVolatile', () => {
  it('peels exactly one live reference', () => {
    expect(unwrapVolatile(live('sid'))).toBe('sid')
  })

  it('passes primitives, null, and undefined through', () => {
    expect(unwrapVolatile('sid')).toBe('sid')
    expect(unwrapVolatile(0)).toBe(0)
    expect(unwrapVolatile(false)).toBe(false)
    expect(unwrapVolatile(null)).toBeNull()
    expect(unwrapVolatile(undefined)).toBeUndefined()
  })

  it('leaves an object whose get is not a function alone', () => {
    const plain = { get: 'not a function' }
    expect(unwrapVolatile(plain)).toBe(plain)
  })

  it('reads through a live reference instead of treating it as the section', () => {
    const section = live({ wpsSid: 'sid' })
    expect(unwrapVolatile(section)).toEqual({ wpsSid: 'sid' })
  })
})

describe('unwrapVolatileDeep', () => {
  it('peels nested references and rebuilds arrays', () => {
    const input = { sid: live('sid'), models: [live('a'), { id: live('b') }] }
    expect(unwrapVolatileDeep(input)).toEqual({ sid: 'sid', models: ['a', { id: 'b' }] })
  })

  it('returns a structure that survives structuredClone', () => {
    // The 0.1.5 line validates and structuredClones the whole config before
    // registering the namespace: one surviving reference there makes every field
    // fail validation and the card's settings disappear silently.
    const input = { sid: live('sid'), list: [live('a'), live('b')] }
    expect(() => structuredClone(unwrapVolatileDeep(input))).not.toThrow()
    expect(() => structuredClone(input)).toThrow()
  })

  it('does not mutate the caller object', () => {
    const input = { sid: live('sid'), list: [live(1)] }
    unwrapVolatileDeep(input)
    expect(typeof input.sid.get).toBe('function')
    expect(typeof input.list[0]?.get).toBe('function')
  })

  it('rebuilds arrays rather than reusing them', () => {
    const list = [live('a')]
    const out = unwrapVolatileDeep({ list }).list
    expect(out).not.toBe(list)
    expect(out).toEqual(['a'])
  })

  it('leaves non-plain objects at their identity', () => {
    class Box {
      constructor(readonly id: string) {}
    }
    const box = new Box('x')
    expect(unwrapVolatileDeep({ box }).box).toBe(box)
  })

  it('passes scalars through unchanged', () => {
    expect(unwrapVolatileDeep('sid')).toBe('sid')
    expect(unwrapVolatileDeep(7)).toBe(7)
  })
})
