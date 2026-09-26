/**
 * 标题预算修复（方案 A）：识别 DSH 标题请求并提升 max_tokens。
 *
 * 重点防两类坏法：
 *   1. **不误伤**：普通任务请求（DSH agent prompt、用户聊天、多模态消息）的
 *      system 不含 `Create a concise title`，必须一字不动——shim 是透明代理，
 *      只有明确识别出的标题请求才允许改写。
 *   2. **不抛错**：body 解析失败、结构怪异的请求必须原样放行（matched=false），
 *      聊天数据路径不许因辅助改写挂掉整个请求。
 */
import { describe, expect, it } from 'vitest'
import {
  COMATE_TITLE_MAX_TOKENS,
  applyTitleBudgetFix,
} from '../src/title-fix.ts'

const TITLE_SYSTEM = [
  'Create a concise title for an AI coding-assistant session from the supplied human messages.',
  'Return only the title on one line, in plain text, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes.',
  'Aim for about 5 words in non-CJK languages or 10 CJK characters.',
].join('\n')
const USER_TEXT = 'Generate the session title from this JSON array of human messages:\n[{"seq":10,"text":"测试模型连接状态"}]'

function titleBody(maxTokens: number | undefined): string {
  const body: Record<string, unknown> = {
    model: '600085158/zhipu/glm-5.3//public',
    messages: [
      { role: 'system', content: TITLE_SYSTEM },
      { role: 'user', content: USER_TEXT },
    ],
    stream: true,
  }
  if (maxTokens !== undefined) body['max_tokens'] = maxTokens
  return JSON.stringify(body)
}

describe('applyTitleBudgetFix', () => {
  it('raises max_tokens on the DSH title request (64 -> 1024)', () => {
    const r = applyTitleBudgetFix(titleBody(64))
    expect(r.matched).toBe(true)
    expect(r.before).toBe(64)
    expect(r.after).toBe(COMATE_TITLE_MAX_TOKENS)
    const parsed = JSON.parse(r.body) as { max_tokens: number }
    expect(parsed.max_tokens).toBe(COMATE_TITLE_MAX_TOKENS)
  })

  it('raises any small budget, not only 64', () => {
    const r = applyTitleBudgetFix(titleBody(1))
    expect(r.after).toBe(COMATE_TITLE_MAX_TOKENS)
    expect(JSON.parse(r.body)['max_tokens']).toBe(COMATE_TITLE_MAX_TOKENS)
  })

  it('leaves a budget that is already large enough untouched', () => {
    const r = applyTitleBudgetFix(titleBody(2048))
    expect(r.matched).toBe(true)
    expect(r.before).toBe(2048)
    expect(r.after).toBeUndefined()
    expect(r.body).toBe(titleBody(2048))
  })

  it('leaves the request untouched when max_tokens is missing', () => {
    const source = titleBody(undefined)
    const r = applyTitleBudgetFix(source)
    expect(r.matched).toBe(true)
    expect(r.before).toBeUndefined()
    expect(r.body).toBe(source)
  })

  it('leaves a non-number max_tokens untouched', () => {
    const source = titleBody(undefined).replace(
      '"stream": true',
      '"max_tokens": "64", "stream": true',
    )
    const r = applyTitleBudgetFix(source)
    expect(r.matched).toBe(true)
    expect(r.before).toBeUndefined()
    expect(r.body).toBe(source)
  })

  it('does not touch a normal task request (agent system prompt)', () => {
    const body = JSON.stringify({
      model: 'x',
      messages: [
        { role: 'system', content: 'You are an AI coding assistant. Help the user solve their task step by step.' },
        { role: 'user', content: '测试模型连接状态' },
      ],
      stream: true,
      max_tokens: 64,
    })
    const r = applyTitleBudgetFix(body)
    expect(r.matched).toBe(false)
    expect(r.body).toBe(body)
  })

  it('does not touch a request whose system mentions "title" in passing', () => {
    const body = JSON.stringify({
      model: 'x',
      messages: [
        { role: 'system', content: 'Never put a title in the output. Answer directly.' },
        { role: 'user', content: 'hi' },
      ],
      max_tokens: 64,
    })
    const r = applyTitleBudgetFix(body)
    expect(r.matched).toBe(false)
    expect(r.body).toBe(body)
  })

  it('matches the title system regardless of case and whitespace', () => {
    const body = JSON.stringify({
      model: 'x',
      messages: [
        { role: 'system', content: '  CREATE   a   concise  TITLE for this session. ' },
        { role: 'user', content: 'hi' },
      ],
      max_tokens: 64,
    })
    const r = applyTitleBudgetFix(body)
    expect(r.matched).toBe(true)
    expect(r.after).toBe(COMATE_TITLE_MAX_TOKENS)
  })

  it('matches when system content is an OpenAI content-block array', () => {
    const body = JSON.stringify({
      model: 'x',
      messages: [
        { role: 'system', content: [{ type: 'text', text: TITLE_SYSTEM }] },
        { role: 'user', content: 'hi' },
      ],
      max_tokens: 64,
    })
    const r = applyTitleBudgetFix(body)
    expect(r.matched).toBe(true)
    expect(r.after).toBe(COMATE_TITLE_MAX_TOKENS)
  })

  it('matches the first system message even if there are several', () => {
    const body = JSON.stringify({
      model: 'x',
      messages: [
        { role: 'system', content: 'Context: the user tests models.' },
        { role: 'system', content: TITLE_SYSTEM },
        { role: 'user', content: 'hi' },
      ],
      max_tokens: 64,
    })
    const r = applyTitleBudgetFix(body)
    expect(r.matched).toBe(true)
    expect(r.after).toBe(COMATE_TITLE_MAX_TOKENS)
  })

  it('returns the source unchanged on malformed JSON', () => {
    const r = applyTitleBudgetFix('not json{')
    expect(r.matched).toBe(false)
    expect(r.body).toBe('not json{')
  })

  it('returns the source unchanged on a non-object body', () => {
    const source = JSON.stringify(['array', 'body'])
    const r = applyTitleBudgetFix(source)
    expect(r.matched).toBe(false)
    expect(r.body).toBe(source)
  })

  it('returns the source unchanged when messages is not an array', () => {
    const source = JSON.stringify({ model: 'x', messages: 'oops', max_tokens: 64 })
    const r = applyTitleBudgetFix(source)
    expect(r.matched).toBe(false)
    expect(r.body).toBe(source)
  })
})
