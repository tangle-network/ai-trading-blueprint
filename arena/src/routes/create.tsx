import { useState, useCallback, useRef, useEffect } from 'react'
import type { MetaFunction } from 'react-router'
import { useNavigate } from 'react-router'
import { useStore } from '@nanostores/react'
import { selectedChainIdStore } from '@tangle-network/blueprint-ui'
import { useAccount, useSwitchChain } from 'wagmi'
import { Button } from '@tangle-network/blueprint-ui/components'
import { networks } from '~/lib/contracts/chains'
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

function normalizeCreateStatus(message: string): string {
  if (message.includes('1003')) {
    return 'Operator authentication is temporarily unavailable from this public app origin.'
  }
  if (message.startsWith('Error: Challenge failed:')) {
    return 'Operator authentication is temporarily unavailable from this public app origin.'
  }
  return message
}

export default function CreateAgent() {
  const [prompt, setPrompt] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [status, setStatus] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const navigate = useNavigate()
  const selectedChainId = useStore(selectedChainIdStore)
  const selectedNetwork = networks[selectedChainId]
  const targetChain = selectedNetwork?.chain
  const { address, chainId, isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const operatorAuth = useOperatorAuth(ALL_TRADING_OPERATOR_API_URLS[0])
  const isWrongChain = Boolean(isConnected && targetChain && chainId !== targetChain.id)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const handleCreate = useCallback(async () => {
    if (!prompt.trim() || isCreating) return
    if (!HAS_TRADING_OPERATOR_API) {
      setStatus('Operator API is not configured for this environment.')
      return
    }
    if (!address) {
      setStatus('Connect your wallet first.')
      return
    }
    if (isWrongChain && targetChain) {
      try {
        await switchChainAsync({ chainId: targetChain.id })
        setStatus(`Switched to ${targetChain.name}. Review the prompt and try again.`)
      } catch {
        setStatus(`Switch to ${targetChain.name} in your wallet before creating an agent.`)
      }
      return
    }

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
      const operatorUrl = ALL_TRADING_OPERATOR_API_URLS[0]
      const token = await operatorAuth.getToken()
      if (!token) {
        const message = operatorAuth.error ?? 'Operator authentication is not available from this app origin yet.'
        throw new Error(message)
      }
      const res = await fetch(`${operatorUrl}/api/bots`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          prompt,
          name: prompt.slice(0, 50),
        }),
      })

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
      setStatus(normalizeCreateStatus(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`))
      setIsCreating(false)
    }
  }, [prompt, isCreating, address, isWrongChain, navigate, operatorAuth, switchChainAsync, targetChain])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleCreate()
    }
  }, [handleCreate])

  return (
    <div className="arena-compose-shell mx-auto max-w-5xl px-4 py-3 sm:px-6 sm:py-4">
      <div className="glass-card flex min-h-[calc(100vh-var(--header-height)-1.5rem)] flex-col rounded-[28px] p-5 sm:p-6">
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center">
          <div className="space-y-5">
            <div className="space-y-3 text-center">
              <h1 className="text-4xl font-display font-bold tracking-tight">
                What do you want to trade?
              </h1>
              <p className="mx-auto max-w-2xl text-base text-arena-elements-textSecondary sm:text-lg">
                Describe your strategy and the agent will translate it into a live deployment flow.
              </p>
            </div>

            {isWrongChain && targetChain && (
              <div className="rounded-[20px] border border-amber-500/20 bg-amber-500/8 px-4 py-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    Your wallet is on chain {chainId}. Switch to <span className="font-semibold">{targetChain.name}</span> before creating an agent.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    className="h-10 px-4"
                    onClick={() => switchChainAsync({ chainId: targetChain.id }).catch(() => {
                      setStatus(`Switch to ${targetChain.name} in your wallet before continuing.`)
                    })}
                  >
                    Switch Network
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-3 pt-4">
            <div className="rounded-[24px] border border-white/10 bg-white/6 p-3 shadow-[0_14px_36px_rgba(15,23,42,0.08)] backdrop-blur-xl">
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="I want an agent that..."
                rows={4}
                disabled={isCreating}
                className="w-full rounded-[20px] border border-transparent bg-transparent px-3 py-3
                       text-base placeholder:text-arena-elements-textTertiary
                       focus:outline-none focus:ring-0 focus:border-transparent
                       resize-none disabled:opacity-50 transition-all"
              />
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-xs text-arena-elements-textTertiary">
                  Paper trading first. You can wire capital and secrets after the agent is provisioned.
                </p>
                <Button
                  onClick={handleCreate}
                  disabled={!prompt.trim() || isCreating || !address || isWrongChain}
                  className="h-11 shrink-0 px-4 text-sm"
                >
                  {isCreating ? 'Creating…' : !address ? 'Connect Wallet' : isWrongChain ? 'Switch Network' : 'Create Agent →'}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-center text-xs text-arena-elements-textTertiary">
                Quick starts
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {STRATEGY_HINTS.map((hint) => (
                  <button
                    key={hint.label}
                    onClick={() => setPrompt(hint.prompt)}
                    disabled={isCreating}
                    className="rounded-full border border-white/8 bg-white/5 px-3 py-2 text-xs font-data text-arena-elements-textSecondary transition-all hover:border-violet-500/20 hover:bg-violet-500/8 hover:text-arena-elements-textPrimary disabled:opacity-50"
                  >
                    {hint.label}
                  </button>
                ))}
              </div>
            </div>

            {status && (
              <div className={`rounded-[20px] px-4 py-3 text-sm ${
	                status.startsWith('Error:')
	                  ? 'border border-crimson-500/20 bg-crimson-500/8 text-crimson-300'
	                  : 'border border-arena-elements-borderColor bg-arena-elements-background-depth-3 text-arena-elements-textSecondary'
	              }`}>
	                {status}
	              </div>
	            )}
	          </div>
	        </div>
	      </div>
	    </div>
  )
}
