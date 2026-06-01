import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  getTokenMock: vi.fn(),
}))

vi.mock('react-router', () => ({
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
})
