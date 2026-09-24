import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COMATE_DEFAULT_CONTEXT_WINDOW,
  COMATE_HOME_DIRNAME,
  defaultComateHome,
  parseComateConfig,
  parseComateModel,
} from '../src/auth.ts'

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
        { id: 'test/model-chat//public', name: 'model-chat', context_window: 1000000, llm_types: 'llm-chat', model_source: 'public', model_tier: 'pro' },
        { id: 'test/model-multimodal//public', name: 'model-multimodal', context_window: 1000000, llm_types: 'llm-chat llm-multimodal', model_source: 'public', model_tier: 'pro' },
      ],
    },
  },
  version: 2,
})

describe('parseComateConfig', () => {
  it('parses the observed desktop config shape', () => {
    const credential = parseComateConfig(SAMPLE_CONFIG, 'C:/fake/config.json')
    expect(credential).toBeDefined()
    expect(credential?.baseUrl).toBe('https://comate.wps.cn/llmproxy/v1/user')
    expect(credential?.apiKey).toBe('comate-test-key')
    expect(credential?.cookie).toBe('wps_sid=abc')
    expect(credential?.authHeader).toBe(true)
    expect(credential?.configFile).toBe('C:/fake/config.json')
    expect(credential?.models).toHaveLength(2)
    expect(credential?.models[0]).toMatchObject({ id: 'test/model-chat//public', contextWindow: 1_000_000, llmTypes: 'llm-chat' })
  })

  it('rejects documents without providers.official', () => {
    expect(parseComateConfig('{"version": 2}', 'p')).toBeUndefined()
    expect(parseComateConfig('not json', 'p')).toBeUndefined()
    expect(parseComateConfig(JSON.stringify({ providers: {} }), 'p')).toBeUndefined()
  })

  it('rejects empty baseUrl or apiKey', () => {
    const broken = JSON.parse(SAMPLE_CONFIG) as Record<string, unknown>
    const providers = (broken['providers'] as Record<string, unknown>)
    const official = (providers['official'] as Record<string, unknown>)
    official['baseUrl'] = ''
    expect(parseComateConfig(JSON.stringify(broken), 'p')).toBeUndefined()
    official['baseUrl'] = 'https://comate.wps.cn/llmproxy/v1/user'
    official['apiKey'] = ''
    expect(parseComateConfig(JSON.stringify(broken), 'p')).toBeUndefined()
  })
})

describe('parseComateModel', () => {
  it('defaults missing context_window and tolerates alias fields', () => {
    const model = parseComateModel({ id: 'x/y//public', name: 'z', contextWindow: 512000 })
    expect(model?.contextWindow).toBe(512000)
    const bare = parseComateModel({ id: 'a', name: 'b' })
    expect(bare?.contextWindow).toBe(COMATE_DEFAULT_CONTEXT_WINDOW)
  })

  it('drops entries without an id', () => {
    expect(parseComateModel({ name: 'no-id' })).toBeUndefined()
    expect(parseComateModel(42)).toBeUndefined()
  })
})

describe('defaultComateHome', () => {
  it('honors the env override and defaults to ~/.wpscomate', () => {
    expect(defaultComateHome({ WPS_COMATE_HOME: 'D:/comate' }, 'C:/Users/u')).toBe('D:/comate')
    expect(defaultComateHome({}, 'C:/Users/u')).toBe(join('C:/Users/u', COMATE_HOME_DIRNAME))
  })
})
