import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { clearCreatePreviewCache } from '~/lib/createPreview'

const DRAFT_STORAGE_KEY = 'arena:create-strategy-draft:v1'

const SUPPORTED_PREVIEW = {
  strategy_type: 'perp',
  supported: true,
  summary: {
    generated_at: 1765500000,
    lookback_days: 30,
    candles_processed: 1440,
    total_trades: 18,
    profitable_trades: 11,
    win_rate: 0.611,
    total_return_pct: 4.2,
    sharpe_ratio: 1.3,
    max_drawdown_pct: 8.2,
    realized_pnl: '412.55',
    tokens_traded: ['ETH', 'BTC'],
    harness_version: 4,
  },
  note: 'Baseline strategy class replayed over the trailing window. Historical evidence, not a forecast.',
}

function mockPreviewFetch(response: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => response,
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const hoisted = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  getTokenMock: vi.fn(),
}))

vi.mock('react-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  useNavigate: () => hoisted.navigateMock,
}))

vi.mock('@tangle-network/blueprint-ui/components', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))

vi.mock('~/lib/hooks/useOperatorAuth', () => ({
  useOperatorAuth: () => ({ getToken: hoisted.getTokenMock }),
}))

vi.mock('~/lib/operator/meta', () => ({
  ALL_TRADING_OPERATOR_API_URLS: ['http://operator.test'],
}))

describe('create agent route', () => {
  beforeEach(() => {
    hoisted.navigateMock.mockReset()
    hoisted.getTokenMock.mockReset().mockResolvedValue('token')
    window.localStorage.clear()
    clearCreatePreviewCache()
    // Default: operator preview unreachable. Tests that exercise the evidence
    // card stub their own response.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function readStoredDraft() {
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY)
    expect(raw).toBeTruthy()
    return JSON.parse(raw!)
  }

  it('opens on a Hyperliquid perp mandate so the compiler matches the visible default prompt', async () => {
    const { default: CreateAgent } = await import('../create')
    render(<CreateAgent />)

    expect(screen.getByLabelText('Trading agent mandate prompt')).toHaveValue(
      'I want an agent that trades ETH perps on Hyperliquid, using breakout retests with strict max leverage, liquidation buffer, and drawdown limits.',
    )
    expect(screen.getAllByRole('button', { name: /hyperliquid perp/i }).some((button) => button.getAttribute('aria-pressed') === 'true')).toBe(true)
    expect(screen.getAllByText('Hyperliquid Perps').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Capabilities')).toBeInTheDocument()
    expect(screen.getAllByText(/Leverage cap/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/liquidation buffer/i).length).toBeGreaterThanOrEqual(1)
  })

  it('does not double-submit when create is triggered twice before navigation completes', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const { default: CreateAgent } = await import('../create')
    render(<CreateAgent />)

    const textbox = screen.getByLabelText('Trading agent mandate prompt')
    fireEvent.change(textbox, { target: { value: 'Create a paper ETH strategy' } })
    fireEvent.keyDown(textbox, { key: 'Enter' })
    fireEvent.keyDown(textbox, { key: 'Enter' })

    await waitFor(() => expect(hoisted.navigateMock).toHaveBeenCalledTimes(1))
    expect(hoisted.navigateMock).toHaveBeenCalledWith('/provision?draft=create')
    // The evidence preview may fetch; creation itself must not POST anything.
    const nonPreviewCalls = (globalThis.fetch as Mock).mock.calls.filter(
      ([url]) => !String(url).includes('/api/create/preview'),
    )
    expect(nonPreviewCalls).toHaveLength(0)
  })

  it('uses the selected strategy module to persist the activation draft', async () => {
    const { default: CreateAgent } = await import('../create')
    render(<CreateAgent />)

    fireEvent.click(screen.getByText('Polymarket news edge').closest('button')!)
    expect(screen.getByLabelText('Trading agent mandate prompt')).toHaveValue(
      'I want to trade political and news events on Polymarket. Find markets with edge and manage positions.',
    )

    fireEvent.click(screen.getByRole('button', { name: /launch paper agent/i }))

    await waitFor(() => expect(hoisted.navigateMock).toHaveBeenCalledWith('/provision?draft=create'))
    const draft = readStoredDraft()
    expect(draft.provisionStrategyType).toBe('prediction')
    expect(draft.name).toBe('Polymarket Event Scout')
    expect(draft.prompt).toContain('Polymarket')
    expect(draft.prompt).toContain('Agent profile:')
    expect(draft.prompt).toContain('Venue access: all wired protocols')
    expect(draft.agentProfile).toMatchObject({
      schema: 'tangle.trading.agent-profile.v1',
      name: 'Polymarket Event Scout',
      objective: {
        primary: 'make_money',
      },
      mandate: {
        market: 'Political events',
        preferredVenue: 'Polymarket',
      },
      capabilities: {
        focus: ['Prediction Markets'],
        availableProtocols: expect.arrayContaining(['hyperliquid', 'uniswap_v3', 'polymarket_clob']),
        preferredProtocols: ['polymarket_clob'],
        venueAccessMode: 'all_wired_with_preferences',
      },
      autonomy: {
        selfImprovement: 'enabled',
      },
      telemetry: {
        trackTokenUsage: true,
        trackCost: true,
      },
      activation: {
        paperFirst: true,
        projectedStrategyType: 'prediction',
      },
    })
    expect(draft.availableProtocols).toEqual(expect.arrayContaining(['hyperliquid', 'uniswap_v3', 'polymarket_clob']))
    expect(draft.preferredProtocols).toEqual(['polymarket_clob'])
    expect(draft.protocolChainIds).toMatchObject({
      hyperliquid: 998,
      polymarket_clob: 137,
    })
  })

  it('supports launching a Hyperliquid perp tactic from a mandate template', async () => {
    const { default: CreateAgent } = await import('../create')
    render(<CreateAgent />)

    fireEvent.click(
      screen
        .getAllByText('ETH-PERP breakout + liquidation buffer')
        .map((element) => element.closest('button'))
        .find(Boolean)!,
    )
    expect(screen.getByLabelText('Trading agent mandate prompt')).toHaveValue(
      'I want an agent that trades ETH perps on Hyperliquid, using breakout retests with strict max leverage, liquidation buffer, and drawdown limits.',
    )

    fireEvent.click(screen.getByRole('button', { name: /launch paper agent/i }))

    await waitFor(() => expect(hoisted.navigateMock).toHaveBeenCalledWith('/provision?draft=create'))
    const draft = readStoredDraft()
    expect(draft.provisionStrategyType).toBe('hyperliquid_perp')
    expect(draft.name).toBe('ETH Perp Breakout')
    expect(draft.prompt).toContain('Hyperliquid')
    expect(draft.agentProfile).toMatchObject({
      schema: 'tangle.trading.agent-profile.v1',
      name: 'ETH Perp Breakout',
      capabilities: {
        focus: ['Hyperliquid Perps'],
        preferredProtocols: ['hyperliquid'],
      },
      activation: {
        projectedStrategyType: 'hyperliquid_perp',
      },
    })
    expect(draft.availableProtocols).toEqual(expect.arrayContaining(['hyperliquid', 'uniswap_v3', 'gmx_v2', 'vertex']))
    expect(draft.preferredProtocols).toEqual(['hyperliquid'])
  })

  it('persists a multi-capability AgentProfile as the activation draft', async () => {
    const { default: CreateAgent } = await import('../create')
    render(<CreateAgent />)

    fireEvent.click(screen.getByText('Multi-Venue').closest('button')!)
    fireEvent.click(screen.getByRole('button', { name: /launch paper agent/i }))

    await waitFor(() => expect(hoisted.navigateMock).toHaveBeenCalledWith('/provision?draft=create'))
    expect(screen.queryByText('Review Activation')).not.toBeInTheDocument()

    const draft = readStoredDraft()
    expect(draft.capabilityFocus).toEqual([
      'Hyperliquid Perps',
      'DEX Spot',
      'DeFi Yield',
      'Prediction Markets',
      'EVM Perps',
    ])
    expect(draft.preferredProtocols).toEqual([
      'hyperliquid',
      'uniswap_v3',
      'aerodrome',
      'aave_v3',
      'morpho_vault',
      'polymarket_clob',
      'gmx_v2',
      'vertex',
    ])
    expect(draft.agentProfile.capabilities).toMatchObject({
      focus: [
        'Hyperliquid Perps',
        'DEX Spot',
        'DeFi Yield',
        'Prediction Markets',
        'EVM Perps',
      ],
      venueAccessMode: 'all_wired_with_preferences',
    })
  })

  it('replaces the static runtime plan with the evidence rail and never blocks launch on it', async () => {
    const { default: CreateAgent } = await import('../create')
    render(<CreateAgent />)

    const rail = screen.getByText('Evidence').closest('aside')

    expect(rail).not.toBeNull()
    expect(rail).toHaveClass('border', 'overflow-hidden')
    expect(rail).toContainElement(screen.getByText('Mandate Seeds'))
    expect(rail).toContainElement(screen.getByText('Execution'))
    expect(screen.queryByText('Runtime Plan')).not.toBeInTheDocument()
    expect(screen.queryByText('Path')).not.toBeInTheDocument()
    expect(screen.queryByText('Parse Mandate')).not.toBeInTheDocument()

    // Default fetch stub 503s: the card states the gap honestly and the
    // launch button stays enabled.
    expect(
      await screen.findByText(/still launches into paper trading/i, {}, { timeout: 3000 }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /launch paper agent/i })).toBeEnabled()
  })

  it('renders the evidence card from the operator preview, including the drawdown tension line', async () => {
    const fetchMock = mockPreviewFetch(SUPPORTED_PREVIEW)
    const { default: CreateAgent } = await import('../create')
    render(<CreateAgent />)

    expect(await screen.findByText('+4.2%', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByText('61%')).toBeInTheDocument()
    expect(screen.getByText('18')).toBeInTheDocument()
    expect(screen.getByText('last 30d')).toBeInTheDocument()
    expect(screen.getByText(/Baseline strategy class replayed/)).toBeInTheDocument()
    // Evidence max DD 8.2% vs the default perp mandate's 5% limit.
    expect(
      screen.getByText(/Historical max DD 8\.2% exceeds your 5\.0% limit — the breaker would have fired\./),
    ).toBeInTheDocument()

    // The default perp mandate carries the strategy family and stop into the call.
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body).toMatchObject({
      strategy_type: 'perp',
      lookback_days: 30,
      max_drawdown_pct: 5,
    })
  })

  it('renders the honest no-preview state for unsupported families', async () => {
    mockPreviewFetch({
      strategy_type: 'prediction',
      supported: false,
      note: 'This strategy family has no public kline source for a preview; it launches straight into paper trading.',
    })
    const { default: CreateAgent } = await import('../create')
    render(<CreateAgent />)

    fireEvent.click(screen.getByText('Polymarket news edge').closest('button')!)

    expect(
      await screen.findByText(/no public kline source/, {}, { timeout: 3000 }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Win rate')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /launch paper agent/i })).toBeEnabled()
  })

  it('persists the captured evidence into the activation draft', async () => {
    mockPreviewFetch(SUPPORTED_PREVIEW)
    const { default: CreateAgent } = await import('../create')
    render(<CreateAgent />)

    await screen.findByText('+4.2%', {}, { timeout: 3000 })
    fireEvent.click(screen.getByRole('button', { name: /launch paper agent/i }))

    await waitFor(() => expect(hoisted.navigateMock).toHaveBeenCalledWith('/provision?draft=create'))
    const draft = readStoredDraft()
    expect(draft.evidence).toMatchObject({
      strategy_type: 'perp',
      supported: true,
      note: expect.stringContaining('not a forecast'),
      summary: {
        lookback_days: 30,
        total_trades: 18,
        win_rate: 0.611,
        total_return_pct: 4.2,
        max_drawdown_pct: 8.2,
      },
    })
    expect(typeof draft.evidence.capturedAt).toBe('number')
    expect(draft.evidence.capturedAt).toBeGreaterThan(0)
  })
})
