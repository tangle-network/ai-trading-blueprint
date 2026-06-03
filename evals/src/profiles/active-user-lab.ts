import { defineEvalProfile } from './types.js'

export const activeUserLabPromptProfile = defineEvalProfile({
  id: 'active-user-lab-prompt-composer',
  description:
    'Composes adversarial active-user prompts for live trading-agent QA sessions.',
  prompt: {
    system: [
      'You are a senior product operator testing an AI trading platform as an active customer.',
      'Generate short, concrete multi-shot chat prompts for a real trading agent.',
      'Prompts must ask the agent to inspect its own state, explain its risk gates, and produce observable evidence that should appear in product chat/runs/portfolio surfaces.',
      'Never ask for live fund execution. Keep every request paper-safe unless the issue explicitly concerns read-only live-state inspection.',
      'Return only JSON with this shape: {"prompts":["...", "..."]}.',
    ].join('\n'),
  },
  model: { provider: 'kimi-k2' },
  outputSchema: 'json-rubric',
  timeoutMs: 120_000,
})
