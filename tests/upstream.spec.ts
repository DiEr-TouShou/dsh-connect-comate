import { describe, expect, it } from 'vitest'
import { emptyImageStats } from '../src/multimodal.ts'
import { classifyUpstreamError, prepareChatBody } from '../src/upstream.ts'

describe('prepareChatBody', () => {
  it('forces stream: true', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({ model: 'm', messages: [] }))) as Record<string, unknown>
    expect(body['stream']).toBe(true)
  })

  it('rewrites the developer role to system', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }, { role: 'developer', content: 'sys' }],
    }))) as { messages: Array<{ role: string }> }
    expect(body.messages.map(message => message.role)).toEqual(['user', 'system'])
  })

  it('flattens object tool_choice into the string form', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      tool_choice: { type: 'function', function: { name: 'read_file' } },
    }))) as Record<string, unknown>
    expect(body['tool_choice']).toBe('read_file')
  })

  it('drops tool_choice none and the tool definitions with it', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      tool_choice: { type: 'none' },
      tools: [{ type: 'function' }],
    }))) as Record<string, unknown>
    expect(body['tool_choice']).toBeUndefined()
    expect(body['tools']).toBeUndefined()
  })

  it('passes non-JSON bodies through untouched', () => {
    expect(prepareChatBody('plain text')).toBe('plain text')
  })

  /**
   * 出站图片是这条链上最容易静默失败的一环：网关对裸字符串 `image_url`、
   * 假 base64 前缀、svg 都回 HTTP 200 + 空正文。所以归一化必须发生在 shim 里、
   * 也就是本函数里，并且要能被统计到（统计供日志用）。
   */
  it('normalizes image parts and reports what it changed', () => {
    const stats = emptyImageStats()
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,https://ks3.example.com/a.png' } },
          { type: 'image_url', image_url: { url: 'data:image/svg+xml;base64,PHN2Zy8+' } },
        ],
      }],
    }), stats)) as { messages: Array<{ content: Array<Record<string, unknown>> }> }
    expect(stats).toEqual({ seen: 3, repaired: 2, stripped: 1, dropped: 1 })
    expect(body.messages[0]?.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
    })
    expect(body.messages[0]?.content[2]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://ks3.example.com/a.png' },
    })
    expect(body.messages[0]?.content[3]?.['text']).toContain('image omitted')
  })

  it('leaves a body without images byte-identical to before', () => {
    const source = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    const stats = emptyImageStats()
    expect(prepareChatBody(source, stats)).toBe(prepareChatBody(source))
    expect(stats).toEqual(emptyImageStats())
  })
})

describe('classifyUpstreamError', () => {
  it('classifies credit and session failures', () => {
    expect(classifyUpstreamError(402, '')).toBe('hard_credit')
    expect(classifyUpstreamError(200, 'insufficient credit')).toBe('hard_credit')
    expect(classifyUpstreamError(200, '积分不足')).toBe('hard_credit')
    expect(classifyUpstreamError(200, 'Offline user session not found')).toBe('session_dead')
    expect(classifyUpstreamError(429, '')).toBe('soft_rate')
    expect(classifyUpstreamError(503, '')).toBe('server')
    expect(classifyUpstreamError(400, 'bad request')).toBe('client')
  })
})
