import { afterEach, describe, expect, it, vi } from 'vitest'
import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { COMATE_THINKING_LEVEL_MAP, comatePiModel } from '../src/adapter.ts'

const MODEL_INFO = { id: 'model-a', name: 'A', contextWindow: 1_000_000 }

/** The real descriptor the adapter builds, pointed at a throwaway origin. */
function model() {
  return comatePiModel(MODEL_INFO, 'http://127.0.0.1:1/v1')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * DSH renders an effort menu from `model.reasoning` + `model.thinkingLevelMap`
 * (`dsh-llm-pi-ai`'s `reasoningInfo()` returns `` when `reasoning` is false, and
 * `getSupportedThinkingLevels()` is what the picker lists). So these assertions
 * are the difference between "the picker shows a thinking level" and "the card
 * silently offers nothing", which is the state this change fixes.
 */
describe('the comate thinking declaration', () => {
  it('declares the models as reasoning-capable', () => {
    // The measured truth: the no-parameter baseline always returns
    // `reasoning_content`, so these models reason whether we ask or not.
    expect(model().reasoning).toBe(true)
  })

  it('asks pi-ai for the OpenAI reasoning_effort wire field', () => {
    const compat = model().compat as { supportsReasoningEffort?: boolean; thinkingFormat?: string }
    expect(compat.supportsReasoningEffort).toBe(true)
    // Named explicitly because pi-ai would otherwise infer the format from
    // `baseUrl`, and this route's baseUrl is a loopback shim that says nothing.
    expect(compat.thinkingFormat).toBe('openai')
  })

  it('offers exactly the levels that can actually reach the wire', () => {
    expect(getSupportedThinkingLevels(model())).toEqual(['minimal', 'low', 'medium', 'high'])
  })

  it('does not offer off, because the harness strips it before pi-ai sees it', () => {
    // `dsh-llm-pi-ai`'s profileOptions() rewrites an `off` choice to "omit the
    // option" (`reasoning === 'off' ? undefined : reasoning`), so pi-ai would
    // send NO reasoning parameter and the gateway would keep thinking ON — its
    // measured default — while the picker claimed "off". Pinning it to null is
    // what keeps the offered list honest; the picker's own "provider default" is
    // the truthful "send nothing" choice.
    expect(getSupportedThinkingLevels(model())).not.toContain('off')
    expect(COMATE_THINKING_LEVEL_MAP.off).toBeNull()
  })

  it('does not offer xhigh or max', () => {
    // The gateway answers 200 for them, but nothing local could establish that
    // they mean anything different from `high` — so they are pinned to null
    // rather than presented as a level whose effect nobody measured.
    const levels = getSupportedThinkingLevels(model())
    expect(levels).not.toContain('xhigh')
    expect(levels).not.toContain('max')
    expect(COMATE_THINKING_LEVEL_MAP.xhigh).toBeNull()
    expect(COMATE_THINKING_LEVEL_MAP.max).toBeNull()
  })

  it('clamps an unsupported level onto a supported one', () => {
    // Guards the "never send a value we did not measure" promise: a caller asking
    // for xhigh must not have it forwarded verbatim.
    expect(getSupportedThinkingLevels(model())).toContain(clampThinkingLevel(model(), 'xhigh'))
  })

  it('offers nothing but off when reasoning is not declared', () => {
    // The pre-change state, kept as the control: this is what the picker saw
    // before the declaration existed.
    expect(getSupportedThinkingLevels({ ...model(), reasoning: false })).toEqual(['off'])
  })

  it('maps every offered level to a non-empty wire value', () => {
    for (const level of getSupportedThinkingLevels(model())) {
      const wire = (COMATE_THINKING_LEVEL_MAP as Record<string, string | null>)[level]
      expect(typeof wire).toBe('string')
      expect(wire).not.toBe('')
    }
  })
})

describe('the request pi-ai builds from that declaration', () => {
  /** Stub fetch and record the JSON bodies the adapter sends. */
  function captureBodies(): Array<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>)
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }))
    return bodies
  }

  /**
   * Drive one real request through the api the adapter registers.
   *
   * The stream is drained so the event queue is not left unread; nothing about
   * the response is asserted, only what went out on the wire.
   */
  async function send(reasoning?: 'minimal' | 'low' | 'medium' | 'high'): Promise<Array<Record<string, unknown>>> {
    const bodies = captureBodies()
    const api = openAICompletionsApi()
    const stream = api.streamSimple(
      model(),
      { messages: [{ role: 'user', content: 'ping', timestamp: 0 }] },
      { apiKey: 'test-key', ...(reasoning === undefined ? {} : { reasoning }) },
    )
    for await (const _event of stream) {
      // deliberately not inspected
    }
    return bodies
  }

  it('sends reasoning_effort=high when the user picks high', async () => {
    const bodies = await send('high')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]?.['reasoning_effort']).toBe('high')
  })

  it('sends the picked level verbatim', async () => {
    expect((await send('low'))[0]?.['reasoning_effort']).toBe('low')
    expect((await send('minimal'))[0]?.['reasoning_effort']).toBe('minimal')
  })

  it('sends no reasoning_effort at all for the provider default', async () => {
    // This is what the picker's "provider default" produces — and, because the
    // harness strips `off`, exactly what an "off" choice would have produced too.
    // Asserting the ABSENCE is what documents why `off` is not offered.
    const bodies = await send()
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')
  })
})
