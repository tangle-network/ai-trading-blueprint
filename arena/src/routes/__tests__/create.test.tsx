import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  HAS_TRADING_OPERATOR_API: true,
}))

describe('create agent route', () => {
  beforeEach(() => {
    hoisted.navigateMock.mockReset()
    hoisted.getTokenMock.mockReset().mockResolvedValue('token')
  })

  it('opens on a Hyperliquid perp mandate so the compiler matches the visible default prompt', async () => {
    const { default: CreateAgent } = await import('../create')
    render(<CreateAgent />)

    expect(screen.getByLabelText('Trading agent strategy prompt')).toHaveValue(
      'I want an agent that trades ETH perps on Hyperliquid, using breakout retests with strict max leverage, liquidation buffer, and drawdown limits.',
    )
    expect(screen.getByRole('button', { name: /hyperliquid perp/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByText('Hyperliquid Perps').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText(/Leverage cap/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/liquidation buffer/i).length).toBeGreaterThanOrEqual(1)
  })

  it('does not double-submit when create is triggered twice before the request resolves', async () => {
    let resolveFetch: (response: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })))
    const { default: CreateAgent } = await import('../create')
    render(<CreateAgent />)

    const textbox = screen.getByLabelText('Trading agent strategy prompt')
    fireEvent.change(textbox, { target: { value: 'Create a paper ETH strategy' } })
    fireEvent.keyDown(textbox, { key: 'Enter' })
    fireEvent.keyDown(textbox, { key: 'Enter' })
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))

    resolveFetch(new Response(JSON.stringify({ bot_id: 'bot-1', status: 'active' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    await waitFor(() => expect(hoisted.navigateMock).toHaveBeenCalledWith('/arena/bot/bot-1/performance'))
  })

  it('uses the selected strategy module to submit the inferred strategy type', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      bot_id: 'prediction-bot',
      status: 'active',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))))
    const { default: CreateAgent } = await import('../create')
    render(<CreateAgent />)

    fireEvent.click(screen.getByRole('button', { name: /prediction markets/i }))
    expect(screen.getByLabelText('Trading agent strategy prompt')).toHaveValue(
      'I want to trade political and news events on Polymarket. Find markets with edge and manage positions.',
    )

    fireEvent.click(screen.getByRole('button', { name: /create paper agent/i }))

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    const [, request] = vi.mocked(fetch).mock.calls[0]
    const body = JSON.parse(String((request as RequestInit).body))
    expect(body.strategy_type).toBe('prediction')
    expect(body.name).toBe('Polymarket Event Scout')
    expect(body.prompt).toContain('Polymarket')
    expect(body.prompt).toContain('Launch draft:')
    expect(body.strategy_config).toMatchObject({
      paper_trade: true,
      paper_safe: true,
      initial_capital_usd: '10000',
      launch_ticket: {
        market: 'Political events',
        venue: 'Polymarket',
        mode: 'Paper start',
      },
    })
  })

  it('supports launching a Hyperliquid perp tactic from the strategy book', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      bot_id: 'perp-bot',
      status: 'active',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))))
    const { default: CreateAgent } = await import('../create')
    render(<CreateAgent />)

    fireEvent.click(screen.getByRole('button', { name: /hyperliquid perp/i }))
    expect(screen.getByLabelText('Trading agent strategy prompt')).toHaveValue(
      'I want an agent that trades ETH perps on Hyperliquid, using breakout retests with strict max leverage, liquidation buffer, and drawdown limits.',
    )

    fireEvent.click(screen.getByRole('button', { name: /create paper agent/i }))

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    const [, request] = vi.mocked(fetch).mock.calls[0]
    const body = JSON.parse(String((request as RequestInit).body))
    expect(body.strategy_type).toBe('hyperliquid_perp')
    expect(body.name).toBe('ETH Perp Breakout')
    expect(body.prompt).toContain('Hyperliquid')
    expect(body.strategy_config).toMatchObject({
      paper_trade: true,
      initial_capital_usd: '10000',
      launch_ticket: {
        market: 'ETH-PERP',
        venue: 'Hyperliquid',
      },
    })
  })

  it('keeps the blueprint path rail as a contiguous stack without spacer gutters', async () => {
    const { default: CreateAgent } = await import('../create')
    render(<CreateAgent />)

    const rail = screen.getByText('Path').closest('aside')

    expect(rail).not.toBeNull()
    expect(rail).toHaveClass('border', 'overflow-hidden')
    expect(rail).not.toHaveClass('gap-2.5')
    expect(rail).toContainElement(screen.getByText('Strategy Presets'))
    expect(rail).toContainElement(screen.getByText('Execution'))
  })
})
