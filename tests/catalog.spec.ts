import { describe, expect, it } from 'vitest'
import { ComateCatalog, selectComateModels } from '../src/catalog.ts'
import type { ComateModel } from '../src/auth.ts'

const models: ComateModel[] = [
  { id: 'a', name: 'A', contextWindow: 1000 },
  { id: 'b', name: 'B', contextWindow: 2000 },
  { id: 'c', name: 'C', contextWindow: 3000 },
]

describe('selectComateModels', () => {
  it('returns the whole directory when the enabled set is empty', () => {
    expect(selectComateModels(models, new Set()).map(m => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps only enabled models and preserves directory order', () => {
    expect(selectComateModels(models, new Set(['c', 'a'])).map(m => m.id)).toEqual(['a', 'c'])
  })

  it('returns an empty list when nothing matches', () => {
    expect(selectComateModels(models, new Set(['zzz']))).toEqual([])
  })

  it('does not mutate the input models', () => {
    const snapshot = JSON.stringify(models)
    selectComateModels(models, new Set(['a']))
    expect(JSON.stringify(models)).toBe(snapshot)
  })
})

describe('ComateCatalog', () => {
  it('starts empty and replaces its entries on set', () => {
    const catalog = new ComateCatalog()
    expect(catalog.current()).toEqual([])
    catalog.set(models)
    expect(catalog.current().map(m => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('copies on set so later caller mutations do not leak in', () => {
    const catalog = new ComateCatalog()
    const source = [...models]
    catalog.set(source)
    source.pop()
    expect(catalog.current()).toHaveLength(3)
  })
})
