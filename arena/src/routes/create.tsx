import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import type { MetaFunction } from 'react-router'
import { useNavigate } from 'react-router'
import { Button } from '@tangle-network/blueprint-ui/components'
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth'
import {
  ALL_TRADING_OPERATOR_API_URLS,
  HAS_TRADING_OPERATOR_API,
} from '~/lib/operator/meta'

export const meta: MetaFunction = () => [
  { title: 'Create Trading Agent - AI Trading Arena' },
]

type StrategyType = 'dex' | 'yield' | 'prediction' | 'perp'

const STRATEGY_HINTS = [
  {
    label: 'DEX Momentum',
    icon: 'i-ph:currency-eth',
    strategyType: 'dex',
    profile: 'DEX spot',
    shorthand: 'ETH/USDC momentum + mean reversion',
    prompt: 'I want an agent that trades ETH/USDC on Uniswap V3, using momentum and mean-reversion signals with strict risk management.',
  },
  {
    label: 'Hyperliquid Perps',
    icon: 'i-ph:pulse',
    strategyType: 'perp',
    profile: 'Perps',
    shorthand: 'ETH-PERP breakout + liquidation buffer',
    prompt: 'I want an agent that trades ETH perps on Hyperliquid, using breakout retests with strict max leverage, liquidation buffer, and drawdown limits.',
  },
  {
    label: 'Prediction Markets',
    icon: 'i-ph:newspaper-clipping',
    strategyType: 'prediction',
    profile: 'Events',
    shorthand: 'Polymarket news edge',
    prompt: 'I want to trade political and news events on Polymarket. Find markets with edge and manage positions.',
  },
  {
    label: 'Yield Router',
    icon: 'i-ph:chart-line-up',
    strategyType: 'yield',
    profile: 'Yield',
    shorthand: 'Aave/Morpho rate rotation',
    prompt: 'Build me an agent that maximizes yield across Aave and Morpho lending protocols, auto-rebalancing between the best rates.',
  },
  {
    label: 'Multi-Book',
    icon: 'i-ph:strategy',
    strategyType: 'dex',
    profile: 'Portfolio',
    shorthand: '60/30/10 diversified mandate',
    prompt: 'Build a diversified trading agent: 60% DEX spot trading, 30% yield farming, 10% prediction markets.',
  },
] satisfies Array<{
  label: string
  icon: string
  strategyType: StrategyType
  profile: string
  shorthand: string
  prompt: string
}>

const DEFAULT_STRATEGY_HINT =
  STRATEGY_HINTS.find((hint) => hint.strategyType === 'perp') ?? STRATEGY_HINTS[0]

const STRATEGY_PROFILES: Record<StrategyType, {
  label: string
  venue: string
  route: string
  envelope: string
  icon: string
}> = {
  dex: {
    label: 'DEX Spot',
    venue: 'Uniswap V3 / Base',
    route: 'Signal replay -> paper start -> workspace',
    envelope: 'Small probes, slippage cap, drawdown guard',
    icon: 'i-ph:currency-eth',
  },
  yield: {
    label: 'Yield Router',
    venue: 'Aave / Morpho',
    route: 'Rate scan -> risk check -> workspace',
    envelope: 'Protocol allowlist, liquidity guard, rebalance cap',
    icon: 'i-ph:chart-line-up',
  },
  prediction: {
    label: 'Prediction Markets',
    venue: 'Polymarket / event books',
    route: 'Scenario search -> tiny paper/live path -> workspace',
    envelope: 'Bounded downside, market depth, no mandate drift',
    icon: 'i-ph:newspaper-clipping',
  },
  perp: {
    label: 'Perp Strategy',
    venue: 'Hyperliquid Perps',
    route: 'Fast replay -> margin check -> workspace',
    envelope: 'Leverage cap, liquidation buffer, latency check',
    icon: 'i-ph:pulse',
  },
}

function inferStrategyType(strategyPrompt: string): StrategyType {
  const promptLower = strategyPrompt.toLowerCase()
  if (promptLower.includes('yield') || promptLower.includes('lending') || promptLower.includes('aave')) {
    return 'yield'
  }
  if (promptLower.includes('polymarket') || promptLower.includes('prediction') || promptLower.includes('politics')) {
    return 'prediction'
  }
  if (promptLower.includes('perp') || promptLower.includes('leverage') || promptLower.includes('futures')) {
    return 'perp'
  }
  return 'dex'
}

function formatOperatorLabel(operatorUrl: string | undefined) {
  if (!operatorUrl) return 'No operator'
  if (operatorUrl.startsWith('/')) return operatorUrl
  try {
    return new URL(operatorUrl).host
  } catch {
    return operatorUrl
  }
}

interface CreateBotResponse {
  bot_id?: unknown
  id?: unknown
  status?: unknown
  activation_error?: unknown
}

export default function CreateAgent() {
  const [prompt, setPrompt] = useState(DEFAULT_STRATEGY_HINT.prompt)
  const [isCreating, setIsCreating] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const errorRef = useRef<HTMLParagraphElement>(null)
  const navigate = useNavigate()
  const { getToken } = useOperatorAuth(ALL_TRADING_OPERATOR_API_URLS[0])
  const detectedStrategyType = useMemo(() => inferStrategyType(prompt), [prompt])
  const detectedProfile = STRATEGY_PROFILES[detectedStrategyType]
  const launchSteps = useMemo(() => detectedProfile.route.split(' -> '), [detectedProfile.route])
  const operatorLabel = formatOperatorLabel(ALL_TRADING_OPERATOR_API_URLS[0])
  const exactHint = STRATEGY_HINTS.find((hint) => prompt.trim() === hint.prompt)
  const selectedHint = exactHint ?? STRATEGY_HINTS.find((hint) => hint.strategyType === detectedStrategyType) ?? STRATEGY_HINTS[0]
  const compilerRows = useMemo(() => [
    {
      icon: 'i-ph:clock-countdown',
      label: 'Replay',
      value: launchSteps[0] ?? 'Signal replay',
    },
    {
      icon: 'i-ph:shield-check',
      label: 'Envelope',
      value: detectedProfile.envelope,
    },
    {
      icon: 'i-ph:map-trifold',
      label: 'Venue',
      value: detectedProfile.venue,
    },
  ], [detectedProfile.envelope, detectedProfile.venue, launchSteps])
  const compilerSpecRows = useMemo(() => [
    ['Strategy', selectedHint.label],
    ['Profile', detectedProfile.label],
    ['Venue', detectedProfile.venue],
    ['Replay', launchSteps[0] ?? 'Signal replay'],
    ['Promotion', 'Paper Start'],
    ['Workspace', '/performance'],
  ], [detectedProfile.label, detectedProfile.venue, launchSteps, selectedHint.label])
  const envelopeChecks = useMemo(
    () => detectedProfile.envelope.split(',').map((item) => item.trim()).filter(Boolean),
    [detectedProfile.envelope],
  )
  const launchPathRows = useMemo(() => [
    ['01', 'Parse Mandate', selectedHint.label],
    ['02', launchSteps[0] ?? 'Signal replay', detectedProfile.venue],
    ['03', 'Risk Envelope', detectedProfile.envelope],
    ['04', 'Open Workspace', '/performance'],
  ], [detectedProfile.envelope, detectedProfile.venue, launchSteps, selectedHint.label])
  const readinessRows = useMemo(() => [
    ['Operator', operatorLabel],
    ['Chain', 'Base Sepolia'],
    ['Mode', 'Paper Start'],
    ['Risk', 'Gated'],
  ], [operatorLabel])
  const routeStatus = error ? error : status || `${detectedProfile.venue} / ${detectedProfile.envelope}`

  useEffect(() => {
    if (typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 768px)').matches) {
      textareaRef.current?.focus()
    }
  }, [])

  useEffect(() => {
    if (error) errorRef.current?.focus()
  }, [error])

  const handleCreate = useCallback(async () => {
    if (!prompt.trim() || isCreating) return
    setIsCreating(true)
    setStatus('Parsing mandate…')
    setError('')

    try {
      const strategyType = inferStrategyType(prompt)

      setStatus('Provisioning agent…')

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
          strategy_type: strategyType,
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
            strategy_type: strategyType,
          }),
        })
      }

      if (!res.ok) {
        const err = await res.text()
        throw new Error(err || `Provision failed: ${res.status}`)
      }

      const data = await res.json() as CreateBotResponse
      const botId = typeof data.bot_id === 'string'
        ? data.bot_id
        : typeof data.id === 'string'
          ? data.id
          : ''
      if (!botId) {
        throw new Error('Operator created a bot but did not return a bot id')
      }
      const activationError = typeof data.activation_error === 'string' ? data.activation_error : ''
      setStatus(activationError ? 'Agent created. Activation needs attention…' : 'Agent created. Opening workspace…')

      setTimeout(() => {
        navigate(`/arena/bot/${encodeURIComponent(botId)}/performance`)
      }, 500)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      setStatus('Create failed')
      setError(message)
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
    <div className="arena-trace-terminal flex h-full min-h-0 overflow-hidden bg-[#081013] text-[#f6fefd]">
      <section className="mx-auto flex h-full min-h-0 w-full max-w-[1220px] flex-1 flex-col gap-3 px-3 py-3 sm:px-4 lg:px-6">
        <header className="grid shrink-0 gap-3 border-b border-[#273035] pb-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <div className="min-w-0">
            <h1 className="text-pretty font-display text-3xl font-semibold tracking-tight text-[#f6fefd]">
              Launch Agent
            </h1>
            <p className="mt-1 max-w-2xl font-mono text-xs text-[#949e9c]">
              Mandate / replay / envelope / workspace
            </p>
          </div>
          <div className="grid grid-cols-3 overflow-hidden rounded-[5px] border border-[#273035] bg-[#0f1a1f] font-mono text-[11px] uppercase tracking-[0.12em] text-[#949e9c] md:w-[430px]">
            <span className="min-w-0 truncate border-r border-[#273035] px-3 py-2 text-center">{operatorLabel}</span>
            <span className="border-r border-[#273035] px-3 py-2 text-center">Base Sepolia</span>
            <span className="px-3 py-2 text-center text-[#50d2c1]">Risk Gated</span>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_378px]">
          <form
            id="create-agent-form"
            className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden rounded-[5px] border border-[#273035] bg-[#0b1418]"
            onSubmit={(event) => {
              event.preventDefault()
              handleCreate()
            }}
          >
            <div className="grid shrink-0 gap-3 border-b border-[#273035] px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <label
                htmlFor="agent-strategy-prompt"
                className="font-display text-base font-semibold text-[#f6fefd]"
              >
                Mandate
              </label>
              <div className="inline-flex w-fit items-center gap-2 rounded-[5px] border border-[#273035] bg-[#081013] px-2.5 py-1.5 font-mono text-xs text-[#d2dad7]">
                <span className={`${detectedProfile.icon} text-base text-[#50d2c1]`} aria-hidden="true" />
                <span>{detectedProfile.label}</span>
              </div>
            </div>

            <div className="grid shrink-0 bg-[#081013]">
              <textarea
                id="agent-strategy-prompt"
                ref={textareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Trade ETH-PERP momentum with 3x max leverage, 5% max drawdown, and a liquidation buffer…"
                disabled={isCreating}
                name="agent-strategy-prompt"
                autoComplete="off"
                aria-label="Trading agent strategy prompt"
                aria-describedby="agent-create-status"
                className="h-[148px] resize-none bg-[#081013] px-4 py-4 font-mono text-[15px] leading-7 text-[#f6fefd] placeholder:text-[#697371] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#50d2c1]/60 disabled:opacity-50 min-[1440px]:h-[168px]"
              />
            </div>

            <div className="grid min-h-0 gap-3 border-t border-[#273035] bg-[#081013] p-3 xl:grid-cols-[minmax(0,1fr)_320px]">
              <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-[5px] border border-[#273035] bg-[#0b1418]">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[#273035] px-3 py-2">
                  <div className="min-w-0">
                    <h2 className="truncate font-display text-sm font-semibold text-[#f6fefd]">
                      Strategy Compiler
                    </h2>
                    <p className="truncate font-mono text-[11px] text-[#949e9c]">
                      {selectedHint.shorthand}
                    </p>
                  </div>
                  <span className="rounded-[4px] border border-[#1d5b52] bg-[#0d302c] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[#50d2c1]">
                    Ready
                  </span>
                </div>
                <div className="grid min-h-0 grid-cols-1 overflow-auto [scrollbar-gutter:stable] min-[1440px]:grid-cols-2">
                  {compilerSpecRows.map(([label, value]) => (
                    <CompilerSpecRow key={label} label={label} value={value} />
                  ))}
                </div>
              </section>

              <section className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden rounded-[5px] border border-[#273035] bg-[#0b1418]">
                <div className="border-b border-[#273035] px-3 py-2">
                  <h2 className="truncate font-display text-sm font-semibold text-[#f6fefd]">
                    Envelope
                  </h2>
                  <p className="truncate font-mono text-[11px] text-[#949e9c]">
                    Pre-trade checks
                  </p>
                </div>
                <div className="grid gap-2 border-b border-[#273035] p-2">
                  {envelopeChecks.map((check) => (
                    <RiskCheck key={check} label={check} />
                  ))}
                </div>
                <div className="grid min-h-0 gap-2 overflow-auto p-2 [scrollbar-gutter:stable]">
                  {compilerRows.map((row) => (
                    <RouteChip key={row.label} icon={row.icon} label={row.label} value={row.value} />
                  ))}
                </div>
              </section>
            </div>
          </form>

          <aside className="grid min-h-0 grid-rows-[auto_auto_auto_auto] gap-3 overflow-hidden">
            <section className="grid overflow-hidden rounded-[5px] border border-[#273035] bg-[#0b1418]">
              <div className="grid grid-cols-[34px_minmax(0,1fr)] items-center gap-3 border-b border-[#273035] px-3 py-2">
                <span className="flex h-[34px] w-[34px] items-center justify-center rounded-[5px] bg-[#143c38] text-[#50d2c1]">
                  <span className={`${detectedProfile.icon} text-lg`} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h2 className="truncate font-display text-base font-semibold text-[#f6fefd]">Strategy Book</h2>
                  <p className="truncate font-mono text-xs text-[#949e9c]">{detectedProfile.label} / {detectedProfile.venue}</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-1.5 p-2">
                {STRATEGY_HINTS.map((hint) => {
                  const active = selectedHint.label === hint.label

                  return (
                    <StrategyBookButton
                      key={hint.label}
                      hint={hint}
                      active={active}
                      disabled={isCreating}
                      onSelect={() => {
                        setPrompt(hint.prompt)
                        setError('')
                        setStatus('')
                        textareaRef.current?.focus()
                      }}
                    />
                  )
                })}
              </div>
            </section>

            <section className="overflow-hidden rounded-[5px] border border-[#273035] bg-[#0b1418]">
              <div className="grid grid-cols-[2.25rem_minmax(0,1fr)_8rem] border-b border-[#273035] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#697371]">
                <span>#</span>
                <span>Path</span>
                <span className="text-right">Surface</span>
              </div>
              <div>
                {launchPathRows.map(([index, action, output]) => (
                  <LedgerRow key={index} index={index} action={action} output={output} />
                ))}
              </div>
            </section>

            <section className="overflow-hidden rounded-[5px] border border-[#273035] bg-[#0b1418]">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[#273035] px-3 py-2">
                <h2 className="truncate font-display text-sm font-semibold text-[#f6fefd]">Ready</h2>
                <span className="font-mono text-xs text-[#50d2c1]">Online</span>
              </div>
              <div className="grid grid-cols-2">
                {readinessRows.map(([label, value]) => (
                  <ReadinessRow key={label} label={label} value={value} />
                ))}
              </div>
            </section>

            <section className="grid gap-2 overflow-hidden rounded-[5px] border border-[#273035] bg-[#0f1a1f] p-2.5">
              <div
                id="agent-create-status"
                aria-live="polite"
                className="min-h-5 min-w-0 font-mono text-xs text-[#949e9c]"
              >
                {error ? (
                  <p
                    ref={errorRef}
                    tabIndex={-1}
                    role="alert"
                    className="break-words text-[#ff7f7f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff7f7f]/45"
                  >
                    {routeStatus}
                  </p>
                ) : (
                  <p role="status" className="line-clamp-2">{routeStatus}</p>
                )}
              </div>
              <Button
                type="submit"
                form="create-agent-form"
                disabled={!prompt.trim() || isCreating}
                className="h-10 w-full rounded-[5px] bg-[#50d2c1] px-5 font-display text-sm font-semibold text-[#06100e] transition-[background-color,opacity,transform] duration-150 hover:bg-[#7ce6d9] active:scale-[0.98] disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
              >
                {isCreating ? 'Creating…' : 'Deploy Agent'}
              </Button>
            </section>
          </aside>
        </div>
      </section>
    </div>
  )
}

function StrategyBookButton({
  hint,
  active,
  disabled,
  onSelect,
}: {
  hint: typeof STRATEGY_HINTS[number]
  active: boolean
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={active}
      className={`grid min-h-[50px] w-full grid-cols-[26px_minmax(0,1fr)] items-center gap-2 rounded-[5px] border px-2 py-1.5 text-left transition-[background-color,border-color,opacity,transform] duration-150 active:scale-[0.99] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60 ${
        active
          ? 'border-[#50d2c1]/70 bg-[#143c38] shadow-[inset_3px_0_0_rgba(80,210,193,0.86)]'
          : 'border-[#273035] bg-[#0f1a1f] hover:border-[#50d2c1]/60 hover:bg-[#132329]'
      }`}
    >
      <span className="flex h-[26px] w-[26px] items-center justify-center rounded-[5px] bg-[#081013] text-[#50d2c1]">
        <span className={`${hint.icon} text-base`} aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-display text-[13px] font-semibold text-[#f6fefd]">{hint.label}</span>
        <span className="block truncate font-mono text-[10px] text-[#949e9c]">{hint.shorthand}</span>
      </span>
    </button>
  )
}

function CompilerSpecRow({
  label,
  value,
}: {
  label: string
  value: string
}) {
  return (
    <div className="min-w-0 border-b border-[#273035] px-3 py-3 last:border-b-0 min-[1440px]:border-r min-[1440px]:even:border-r-0">
      <span className="block truncate font-mono text-[10px] uppercase tracking-[0.12em] text-[#697371]">
        {label}
      </span>
      <span className="mt-1 block min-w-0 truncate font-mono text-[13px] font-semibold text-[#f6fefd]">
        {value}
      </span>
    </div>
  )
}

function RiskCheck({ label }: { label: string }) {
  return (
    <div className="grid grid-cols-[22px_minmax(0,1fr)] items-center gap-2 rounded-[4px] border border-[#273035] bg-[#081013] px-2 py-1.5">
      <span className="flex h-[22px] w-[22px] items-center justify-center rounded-[4px] bg-[#0d302c] text-[#50d2c1]">
        <span className="i-ph:check-bold text-xs" aria-hidden="true" />
      </span>
      <span className="min-w-0 truncate font-mono text-[12px] text-[#d2dad7]">
        {label}
      </span>
    </div>
  )
}

function RouteChip({
  icon,
  label,
  value,
}: {
  icon: string
  label: string
  value: string
}) {
  return (
    <div className="grid min-h-[66px] content-between gap-2 rounded-[5px] border border-[#273035] bg-[#0f1a1f] p-3">
      <span className="flex items-center justify-between gap-3">
        <span className={`${icon} text-base text-[#50d2c1]`} aria-hidden="true" />
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#697371]">{label}</span>
      </span>
      <span className="line-clamp-2 font-mono text-xs leading-4 text-[#d2dad7]">{value}</span>
    </div>
  )
}

function LedgerRow({
  index,
  action,
  output,
}: {
  index: string
  action: string
  output: string
}) {
  return (
    <div className="grid grid-cols-[2.25rem_minmax(0,1fr)_8rem] items-center border-b border-[#273035] px-3 py-2 last:border-b-0">
      <span className="font-mono text-xs text-[#50d2c1]">{index}</span>
      <span className="min-w-0 truncate font-display text-sm font-semibold text-[#f6fefd]">{action}</span>
      <span className="min-w-0 truncate text-right font-mono text-xs text-[#949e9c]">{output}</span>
    </div>
  )
}

function ReadinessRow({
  label,
  value,
}: {
  label: string
  value: string
}) {
  return (
    <div className="min-w-0 border-t border-[#273035] px-3 py-2 odd:border-r">
      <span className="block truncate font-mono text-[10px] uppercase tracking-[0.12em] text-[#697371]">{label}</span>
      <span className="mt-0.5 block min-w-0 truncate font-mono text-xs text-[#d2dad7]">{value}</span>
    </div>
  )
}
