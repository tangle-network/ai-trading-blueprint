import { useState, useCallback, useRef, useEffect, useMemo, type CSSProperties } from 'react'
import type { MetaFunction } from 'react-router'
import { useNavigate } from 'react-router'
import { Button } from '@tangle-network/blueprint-ui/components'
import { ArenaHeaderLink, ArenaPageHeader } from '~/components/arena/ArenaPageHeader'
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth'
import {
  ALL_TRADING_OPERATOR_API_URLS,
  HAS_TRADING_OPERATOR_API,
} from '~/lib/operator/meta'
import {
  WorkspaceCollapsedPane,
  WorkspaceControlButton,
  WorkspaceResizeHandle,
  beginWorkspaceResize,
  clampNumber,
  usePersistentWorkspaceLayout,
} from '~/components/arena/WorkspaceResizeControls'

export const meta: MetaFunction = () => [
  { title: 'Create Trading Agent - Tangle Trading' },
]

type StrategyType = 'dex' | 'yield' | 'prediction' | 'perp'

interface CreateWorkspaceLayout {
  railWidth: number
  railCollapsed: boolean
}

const CREATE_WORKSPACE_LAYOUT_KEY = 'arena:create-workspace-layout'
const DEFAULT_CREATE_WORKSPACE_LAYOUT: CreateWorkspaceLayout = {
  railWidth: 360,
  railCollapsed: false,
}

function normalizeCreateWorkspaceLayout(value: Partial<CreateWorkspaceLayout>): CreateWorkspaceLayout {
  return {
    railWidth: clampNumber(
      Number(value.railWidth) || DEFAULT_CREATE_WORKSPACE_LAYOUT.railWidth,
      300,
      480,
    ),
    railCollapsed: value.railCollapsed === true,
  }
}

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
  const workspaceRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const errorRef = useRef<HTMLParagraphElement>(null)
  const [layout, setLayout] = usePersistentWorkspaceLayout(
    CREATE_WORKSPACE_LAYOUT_KEY,
    DEFAULT_CREATE_WORKSPACE_LAYOUT,
    normalizeCreateWorkspaceLayout,
  )
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
      label: 'Signal',
      value: launchSteps[0] ?? 'Signal replay',
    },
    {
      icon: 'i-ph:shield-check',
      label: 'Risk',
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
    ['Class', detectedProfile.label],
    ['Venue', detectedProfile.venue],
    ['Signal', launchSteps[0] ?? 'Signal replay'],
    ['Mode', 'Paper Start'],
    ['Opens', '/performance'],
  ], [detectedProfile.label, detectedProfile.venue, launchSteps, selectedHint.label])
  const envelopeChecks = useMemo(
    () => detectedProfile.envelope.split(',').map((item) => item.trim()).filter(Boolean),
    [detectedProfile.envelope],
  )
  const launchPathRows = useMemo(() => [
    ['01', 'Parse Mandate', selectedHint.label],
    ['02', 'Select Venue', detectedProfile.venue],
    ['03', 'Apply Risk', detectedProfile.envelope],
    ['04', 'Open Workspace', '/performance'],
  ], [detectedProfile.envelope, detectedProfile.venue, selectedHint.label])
  const readinessRows = useMemo(() => [
    ['Operator', operatorLabel],
    ['Network', 'Base Sepolia'],
    ['Mode', 'Paper Start'],
    ['Risk', 'Gated'],
  ], [operatorLabel])
  const routeStatus = error ? error : status || `${detectedProfile.venue} / ${detectedProfile.envelope}`
  const workspaceStyle = {
    '--create-rail-width': `${layout.railWidth}px`,
  } as CSSProperties
  const workspaceGridClass = layout.railCollapsed
    ? 'lg:grid-cols-[minmax(0,1fr)_8px_44px]'
    : 'lg:grid-cols-[minmax(0,1fr)_8px_minmax(300px,var(--create-rail-width))]'
  const startRailResize = (event: Parameters<typeof beginWorkspaceResize>[0]) => {
    const workspace = workspaceRef.current
    if (!workspace) return
    const rect = workspace.getBoundingClientRect()
    setLayout((current) => ({ ...current, railCollapsed: false }))
    beginWorkspaceResize(event, {
      cursor: 'col-resize',
      onMove: (moveEvent) => {
        const maxWidth = Math.min(480, Math.max(360, rect.width * 0.4))
        const nextWidth = clampNumber(rect.right - moveEvent.clientX, 300, maxWidth)
        setLayout((current) => ({
          ...current,
          railWidth: nextWidth,
          railCollapsed: false,
        }))
      },
    })
  }

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

      setStatus('Creating paper agent…')

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
        throw new Error(err || `Create failed: ${res.status}`)
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
    <div className="arena-trace-terminal flex min-h-full overflow-y-auto bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-text)] lg:h-full lg:min-h-0 lg:overflow-hidden">
      <section className="mx-auto flex w-full max-w-[1560px] flex-1 flex-col gap-2 px-2 py-2 sm:px-3 lg:h-full lg:min-h-0">
        <ArenaPageHeader
          title="Create"
          titleWidthClassName="min-[1180px]:w-[11rem]"
          metrics={[
            { label: 'Draft', value: detectedProfile.label },
            { label: 'Venue', value: detectedProfile.venue },
            { label: 'Route', value: 'Paper' },
          ]}
          controls={(
            <>
              <WorkspaceControlButton
                label={layout.railCollapsed ? 'Restore strategy rail' : 'Minimize strategy rail'}
                icon={layout.railCollapsed ? 'i-ph:sidebar-simple' : 'i-ph:minus-bold'}
                onClick={() => setLayout((current) => ({
                  ...current,
                  railCollapsed: !current.railCollapsed,
                }))}
              />
              <WorkspaceControlButton
                label="Reset workspace"
                icon="i-ph:arrow-counter-clockwise"
                onClick={() => setLayout(DEFAULT_CREATE_WORKSPACE_LAYOUT)}
              />
              <ArenaHeaderLink to="/leaderboard" icon="i-ph:table">Agents</ArenaHeaderLink>
              <ArenaHeaderLink to="/provision" icon="i-ph:rocket-launch" variant="primary">Deploy</ArenaHeaderLink>
            </>
          )}
        />

        <div
          ref={workspaceRef}
          className={`grid gap-0 lg:min-h-0 lg:flex-1 ${workspaceGridClass}`}
          style={workspaceStyle}
        >
          <form
            id="create-agent-form"
            className="grid content-start rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] lg:col-start-1 lg:min-h-0 lg:self-start lg:grid-rows-[auto_auto_auto] lg:overflow-hidden"
            onSubmit={(event) => {
              event.preventDefault()
              handleCreate()
            }}
          >
            <div className="grid shrink-0 gap-3 border-b border-[var(--arena-terminal-border)] px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <label
                htmlFor="agent-strategy-prompt"
                className="font-display text-base font-semibold text-[var(--arena-terminal-text)]"
              >
                Mandate
              </label>
              <div className="inline-flex w-fit items-center gap-2 rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-2.5 py-1.5 font-mono text-xs text-[var(--arena-terminal-text-secondary)]">
                <span className={`${detectedProfile.icon} text-base text-[var(--arena-terminal-accent)]`} aria-hidden="true" />
                <span>{detectedProfile.label}</span>
              </div>
            </div>

            <div className="grid shrink-0 bg-[var(--arena-terminal-bg)]">
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
                className="h-[150px] resize-none bg-[var(--arena-terminal-bg)] px-4 py-3 font-mono text-[15px] leading-6 text-[var(--arena-terminal-text)] placeholder:text-[var(--arena-terminal-text-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--arena-terminal-accent)] disabled:opacity-50 md:h-[136px] lg:h-[124px] min-[1440px]:h-[136px]"
              />
            </div>

            <div className="grid items-start gap-3 border-t border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] p-3 xl:grid-cols-[minmax(0,1fr)_320px]">
              <section className="grid overflow-hidden rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--arena-terminal-border)] px-3 py-2">
                  <div className="min-w-0">
                    <h2 className="truncate font-display text-sm font-semibold text-[var(--arena-terminal-text)]">
                      Compiled Brief
                    </h2>
                    <p className="truncate font-mono text-[11px] text-[var(--arena-terminal-text-muted)]">
                      {selectedHint.shorthand}
                    </p>
                  </div>
                  <span className="rounded-[4px] border border-[var(--arena-terminal-border-hover)] bg-[var(--arena-terminal-accent-soft)] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--arena-terminal-accent)]">
                    Draft
                  </span>
                </div>
                <div className="grid grid-cols-1 min-[1440px]:grid-cols-2">
                  {compilerSpecRows.map(([label, value]) => (
                    <CompilerSpecRow key={label} label={label} value={value} />
                  ))}
                </div>
              </section>

              <section className="grid overflow-hidden rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]">
                <div className="border-b border-[var(--arena-terminal-border)] px-3 py-2">
                  <h2 className="truncate font-display text-sm font-semibold text-[var(--arena-terminal-text)]">
                    Risk Envelope
                  </h2>
                  <p className="truncate font-mono text-[11px] text-[var(--arena-terminal-text-muted)]">
                    Pre-trade checks
                  </p>
                </div>
                <div className="grid gap-2 border-b border-[var(--arena-terminal-border)] p-2">
                  {envelopeChecks.map((check) => (
                    <RiskCheck key={check} label={check} />
                  ))}
                </div>
                <div className="grid gap-2 p-2 lg:min-h-0 lg:overflow-auto lg:[scrollbar-gutter:stable]">
                  {compilerRows.map((row) => (
                    <RouteChip key={row.label} icon={row.icon} label={row.label} value={row.value} />
                  ))}
                </div>
              </section>
            </div>
          </form>

          <WorkspaceResizeHandle
            orientation="vertical"
            className="hidden lg:col-start-2 lg:row-start-1 lg:flex"
            ariaLabel="Resize strategy rail"
            title="Drag to resize strategy rail"
            onPointerDown={startRailResize}
          />

          {layout.railCollapsed ? (
            <WorkspaceCollapsedPane
              label="Strategy"
              icon="i-ph:strategy"
              orientation="vertical"
              className="hidden lg:col-start-3 lg:row-start-1 lg:flex"
              onClick={() => setLayout((current) => ({ ...current, railCollapsed: false }))}
            />
          ) : (
          <aside className="grid gap-2.5 lg:col-start-3 lg:row-start-1 lg:min-h-0 lg:grid-rows-[auto_auto_auto_auto] lg:overflow-hidden">
            <section className="grid overflow-hidden rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]">
              <div className="grid grid-cols-[34px_minmax(0,1fr)] items-center gap-3 border-b border-[var(--arena-terminal-border)] px-3 py-2">
                <span className="flex h-[34px] w-[34px] items-center justify-center rounded-[5px] bg-[var(--arena-terminal-accent-soft)] text-[var(--arena-terminal-accent)]">
                  <span className={`${detectedProfile.icon} text-lg`} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h2 className="truncate font-display text-base font-semibold text-[var(--arena-terminal-text)]">Strategy Presets</h2>
                  <p className="truncate font-mono text-xs text-[var(--arena-terminal-text-muted)]">{detectedProfile.label} / {detectedProfile.venue}</p>
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

            <section className="overflow-hidden rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]">
              <div className="grid grid-cols-[2.25rem_minmax(0,1fr)_8rem] border-b border-[var(--arena-terminal-border)] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--arena-terminal-text-subtle)]">
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

            <section className="overflow-hidden rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)]">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--arena-terminal-border)] px-3 py-2">
                <h2 className="truncate font-display text-sm font-semibold text-[var(--arena-terminal-text)]">Execution</h2>
                <span className="font-mono text-xs text-[var(--arena-terminal-accent)]">Paper</span>
              </div>
              <div className="grid grid-cols-2">
                {readinessRows.map(([label, value]) => (
                  <ReadinessRow key={label} label={label} value={value} />
                ))}
              </div>
            </section>

            <section className="grid gap-2 overflow-hidden rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] p-2.5">
              <div
                id="agent-create-status"
                aria-live="polite"
                className="min-h-5 min-w-0 font-mono text-xs text-[var(--arena-terminal-text-muted)]"
              >
                {error ? (
                  <p
                    ref={errorRef}
                    tabIndex={-1}
                    role="alert"
                    className="break-words text-[var(--arena-terminal-danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-danger)]"
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
                className="h-10 w-full rounded-[5px] bg-[var(--arena-terminal-accent)] px-5 font-display text-sm font-semibold text-[#06100e] transition-[background-color,opacity,transform] duration-150 hover:bg-[color-mix(in_srgb,var(--arena-terminal-accent)_82%,var(--arena-terminal-text))] active:scale-[0.98] disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)]"
              >
                {isCreating ? 'Creating…' : 'Create Paper Agent'}
              </Button>
            </section>
          </aside>
          )}
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
      className={`grid min-h-[50px] w-full grid-cols-[26px_minmax(0,1fr)] items-center gap-2 rounded-[5px] border px-2 py-1.5 text-left transition-[background-color,border-color,opacity,transform] duration-150 active:scale-[0.99] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)] ${
        active
          ? 'border-[var(--arena-terminal-border-hover)] bg-[var(--arena-terminal-accent-soft)] shadow-[inset_3px_0_0_var(--arena-terminal-accent)]'
          : 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] hover:border-[var(--arena-terminal-border-hover)] hover:bg-[var(--arena-terminal-panel-strong)]'
      }`}
    >
      <span className="flex h-[26px] w-[26px] items-center justify-center rounded-[5px] bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-accent)]">
        <span className={`${hint.icon} text-base`} aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-display text-[13px] font-semibold text-[var(--arena-terminal-text)]">{hint.label}</span>
        <span className="block truncate font-mono text-[10px] text-[var(--arena-terminal-text-muted)]">{hint.shorthand}</span>
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
    <div className="min-w-0 border-b border-[var(--arena-terminal-border)] px-3 py-3 last:border-b-0 min-[1440px]:border-r min-[1440px]:even:border-r-0">
      <span className="block truncate font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--arena-terminal-text-subtle)]">
        {label}
      </span>
      <span className="mt-1 block min-w-0 truncate font-mono text-[13px] font-semibold text-[var(--arena-terminal-text)]">
        {value}
      </span>
    </div>
  )
}

function RiskCheck({ label }: { label: string }) {
  return (
    <div className="grid grid-cols-[22px_minmax(0,1fr)] items-center gap-2 rounded-[4px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-2 py-1.5">
      <span className="flex h-[22px] w-[22px] items-center justify-center rounded-[4px] bg-[var(--arena-terminal-accent-soft)] text-[var(--arena-terminal-accent)]">
        <span className="i-ph:check-bold text-xs" aria-hidden="true" />
      </span>
      <span className="min-w-0 truncate font-mono text-[12px] text-[var(--arena-terminal-text-secondary)]">
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
    <div className="grid min-h-[54px] content-between gap-1.5 rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] p-2.5">
      <span className="flex items-center justify-between gap-3">
        <span className={`${icon} text-base text-[var(--arena-terminal-accent)]`} aria-hidden="true" />
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--arena-terminal-text-subtle)]">{label}</span>
      </span>
      <span className="line-clamp-2 font-mono text-[11px] leading-4 text-[var(--arena-terminal-text-secondary)]">{value}</span>
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
    <div className="grid grid-cols-[2.25rem_minmax(0,1fr)_8rem] items-center border-b border-[var(--arena-terminal-border)] px-3 py-2 last:border-b-0">
      <span className="font-mono text-xs text-[var(--arena-terminal-accent)]">{index}</span>
      <span className="min-w-0 truncate font-display text-sm font-semibold text-[var(--arena-terminal-text)]">{action}</span>
      <span className="min-w-0 truncate text-right font-mono text-xs text-[var(--arena-terminal-text-muted)]">{output}</span>
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
    <div className="min-w-0 border-t border-[var(--arena-terminal-border)] px-3 py-2 odd:border-r">
      <span className="block truncate font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--arena-terminal-text-subtle)]">{label}</span>
      <span className="mt-0.5 block min-w-0 truncate font-mono text-xs text-[var(--arena-terminal-text-secondary)]">{value}</span>
    </div>
  )
}
