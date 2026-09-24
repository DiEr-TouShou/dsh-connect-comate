import { describe, expect, it } from 'vitest'
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
