import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const DRAFT_STORAGE_KEY = 'arena:create-strategy-draft:v1'

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
    expect(fetch).not.toHaveBeenCalled()
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

  it('shows a derived runtime plan instead of a numbered blueprint path rail', async () => {
    const { default: CreateAgent } = await import('../create')
    render(<CreateAgent />)

    const rail = screen.getByText('Runtime Plan').closest('aside')

    expect(rail).not.toBeNull()
    expect(rail).toHaveClass('border', 'overflow-hidden')
    expect(rail).not.toHaveClass('gap-2.5')
    expect(rail).toContainElement(screen.getByText('Starting Points'))
    expect(rail).toContainElement(screen.getByText('Runtime Plan'))
    expect(rail).toContainElement(screen.getByText('Execution'))
    expect(screen.queryByText('Path')).not.toBeInTheDocument()
    expect(screen.queryByText('Parse Mandate')).not.toBeInTheDocument()
  })
})
