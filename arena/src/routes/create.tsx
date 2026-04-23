import { useState, useCallback, useRef, useEffect } from 'react'
import type { MetaFunction } from 'react-router'
import { useNavigate } from 'react-router'
import { Button } from '@tangle-network/blueprint-ui/components'
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth'
import {
  ALL_TRADING_OPERATOR_API_URLS,
  HAS_TRADING_OPERATOR_API,
} from '~/lib/operator/meta'

export const meta: MetaFunction = () => [
  { title: 'Create Trading Agent — AI Trading Arena' },
]

const STRATEGY_HINTS = [
  {
    label: 'DEX Trading',
    prompt: 'I want an agent that trades ETH/USDC on Uniswap V3, using momentum and mean-reversion signals with strict risk management.',
  },
  {
    label: 'Yield Farming',
    prompt: 'Build me an agent that maximizes yield across Aave and Morpho lending protocols, auto-rebalancing between the best rates.',
  },
  {
    label: 'Prediction Markets',
    prompt: 'I want to trade political and news events on Polymarket. Find markets with edge and manage positions.',
  },
  {
    label: 'Multi-Strategy',
    prompt: 'Build a diversified trading agent: 60% DEX spot trading, 30% yield farming, 10% prediction markets.',
  },
]

export default function CreateAgent() {
  const [prompt, setPrompt] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [status, setStatus] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const navigate = useNavigate()
  const { getToken } = useOperatorAuth(ALL_TRADING_OPERATOR_API_URLS[0])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const handleCreate = useCallback(async () => {
    if (!prompt.trim() || isCreating) return
    setIsCreating(true)
    setStatus('Parsing your strategy...')

    try {
      // Determine strategy type from prompt
      const promptLower = prompt.toLowerCase()
      let strategyType = 'dex'
      if (promptLower.includes('yield') || promptLower.includes('lending') || promptLower.includes('aave')) {
        strategyType = 'yield'
      } else if (promptLower.includes('polymarket') || promptLower.includes('prediction') || promptLower.includes('politics')) {
        strategyType = 'prediction'
      } else if (promptLower.includes('perp') || promptLower.includes('leverage') || promptLower.includes('futures')) {
        strategyType = 'perp'
      }

      setStatus('Provisioning your trading agent...')

      // Call the operator API to provision a bot with the user's prompt
      if (!HAS_TRADING_OPERATOR_API || !ALL_TRADING_OPERATOR_API_URLS[0]) {
        throw new Error('Trading operator API is not configured')
      }
      const operatorUrl = ALL_TRADING_OPERATOR_API_URLS[0]
      let token = await getToken()
      if (!token) {
        throw new Error('Wallet authentication is required before creating a bot')
      }

      let res = await fetch(`${operatorUrl}/api/bots`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          prompt,
          name: prompt.slice(0, 50),
        }),
      })

      if (res.status === 401) {
        token = await getToken(true)
        if (!token) {
          throw new Error('Authentication expired and refresh failed')
        }
        res = await fetch(`${operatorUrl}/api/bots`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            prompt,
            name: prompt.slice(0, 50),
          }),
        })
      }

      if (!res.ok) {
        const err = await res.text()
        throw new Error(err || `Provision failed: ${res.status}`)
      }

      const data = await res.json()
      setStatus('Agent created! Opening chat...')

      // Navigate to the bot's chat view
      setTimeout(() => {
        navigate(`/arena/bot/${data.bot_id || data.id}`)
      }, 500)
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
      setIsCreating(false)
    }
  }, [prompt, isCreating, getToken, navigate])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleCreate()
    }
  }, [handleCreate])

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-2xl space-y-8">
        {/* Header */}
        <div className="text-center space-y-3">
          <h1 className="text-4xl font-display font-bold tracking-tight">
            What do you want to trade?
          </h1>
          <p className="text-lg text-arena-elements-textSecondary">
            Describe your strategy. Your AI agent will build itself, learn, and evolve.
          </p>
        </div>

        {/* Main prompt input */}
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="I want an agent that..."
            rows={4}
            disabled={isCreating}
            className="w-full px-5 py-4 rounded-xl bg-arena-elements-bg border border-arena-elements-border
                       text-base placeholder:text-arena-elements-textTertiary
                       focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/40
                       resize-none disabled:opacity-50 transition-all"
          />
          <div className="absolute bottom-3 right-3">
            <Button
              onClick={handleCreate}
              disabled={!prompt.trim() || isCreating}
              className="px-4 py-2 text-sm"
            >
              {isCreating ? status : 'Create Agent →'}
            </Button>
          </div>
        </div>

        {/* Strategy hints */}
        <div className="space-y-3">
          <p className="text-sm text-arena-elements-textTertiary text-center">
            Or try one of these:
          </p>
          <div className="grid grid-cols-2 gap-3">
            {STRATEGY_HINTS.map((hint) => (
              <button
                key={hint.label}
                onClick={() => setPrompt(hint.prompt)}
                disabled={isCreating}
                className="text-left px-4 py-3 rounded-lg border border-arena-elements-border
                           hover:border-violet-500/30 hover:bg-violet-500/5
                           transition-all text-sm disabled:opacity-50"
              >
                <span className="font-semibold block mb-1">{hint.label}</span>
                <span className="text-arena-elements-textTertiary text-xs line-clamp-2">
                  {hint.prompt}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-arena-elements-textTertiary">
          Your agent starts in paper trading mode. It will build its own tools,
          backtest strategies, and evolve over time. You can chat with it anytime.
        </p>
      </div>
    </div>
  )
}
