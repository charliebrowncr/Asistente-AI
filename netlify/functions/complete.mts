import Anthropic from '@anthropic-ai/sdk'
import type { Config } from '@netlify/functions'

const anthropic = new Anthropic()

// Backs the guest assistant's AI fallback (window.claude.complete) outside claude.ai.
export default async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  const { prompt } = await req.json().catch(() => ({}))
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20000) {
    return Response.json({ error: 'Invalid prompt' }, { status: 400 })
  }

  const message = await anthropic.messages.create({
    model: 'claude-haiku-5-5',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  })
  const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  return Response.json({ text })
}

export const config: Config = { path: '/api/complete' }
