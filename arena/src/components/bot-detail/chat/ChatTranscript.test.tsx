import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatTranscript } from './ChatTranscript';

const hoisted = vi.hoisted(() => ({
  chatContainerMock: vi.fn((props: any) => (
    <div data-testid="sandbox-chat" data-message-count={props.messages.length} />
  )),
  useRunGroupsMock: vi.fn(() => []),
}));

vi.mock('@tangle-network/sandbox-ui/chat', () => ({
  ChatContainer: hoisted.chatContainerMock,
}));

vi.mock('@tangle-network/sandbox-ui/hooks', () => ({
  useAutoScroll: () => ({
    isAtBottom: true,
    scrollToBottom: vi.fn(),
  }),
  useRunCollapseState: () => ({
    isCollapsed: () => false,
    toggleCollapse: vi.fn(),
  }),
  useRunGroups: hoisted.useRunGroupsMock,
}));

vi.mock('@tangle-network/sandbox-ui/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) =>
    classes.filter(Boolean).join(' '),
}));

const branding = {
  label: 'Agent',
  accentClass: 'text-amber-300',
  bgClass: 'bg-amber-500/8',
  containerBgClass: 'bg-[#0b1418]',
  borderClass: 'border-amber-500/20',
  iconClass: 'i-ph:robot',
  textClass: 'text-amber-300',
};

describe('ChatTranscript', () => {
  beforeEach(() => {
    hoisted.chatContainerMock.mockClear();
    hoisted.useRunGroupsMock.mockReset();
    hoisted.useRunGroupsMock.mockReturnValue([]);
  });

  it('renders a terminal empty state instead of raw no-message copy', () => {
    render(
      <ChatTranscript
        messages={[]}
        partMap={{}}
        isStreaming={false}
        branding={branding}
        variant="terminal"
      />,
    );

    expect(screen.getByText('Transcript Idle')).toBeInTheDocument();
    expect(screen.getByText(/tool calls/i)).toBeInTheDocument();
    expect(screen.queryByText('No messages yet')).not.toBeInTheDocument();
  });

  it('uses a command-oriented empty state when the transcript is writable', () => {
    render(
      <ChatTranscript
        messages={[]}
        partMap={{}}
        isStreaming={false}
        onSend={vi.fn()}
        branding={branding}
        variant="terminal"
      />,
    );

    expect(screen.getByText('Open Trading Thread')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /message input/i })).toBeInTheDocument();
  });

  it('uses sandbox chat primitives for non-empty trace payloads', () => {
    const userMessage = {
      id: 'user-1',
      role: 'user',
    } as any;
    const assistantMessage = {
      id: 'assistant-1',
      role: 'assistant',
    } as any;
    const reasoningPart = {
      type: 'reasoning',
      text: 'Check liquidity before placing the bounded probe.',
    } as any;
    const toolPart = {
      type: 'tool',
      name: 'hyperliquid.place_order',
      input: { market: 'ETH-PERP' },
      output: { status: 'paper-filled' },
    } as any;
    const finalTextPart = {
      type: 'text',
      text: 'Placed bounded ETH probe after liquidity check.',
    } as any;
    const messages = [userMessage, assistantMessage];
    const partMap: Record<string, any[]> = {
      'user-1': [{ type: 'text', text: 'Place a bounded ETH probe.' }],
      'assistant-1': [
        { type: 'text', text: 'Place a bounded ETH probe.' },
        reasoningPart,
        toolPart,
        finalTextPart,
      ],
    };

    hoisted.useRunGroupsMock.mockReturnValue([
      { type: 'user', message: userMessage },
      {
        type: 'run',
        run: {
          id: 'run-1',
          isStreaming: false,
          messages: [assistantMessage],
          stats: { toolCount: 1 },
        },
      },
    ] as any);

    render(
      <ChatTranscript
        messages={messages}
        partMap={partMap as any}
        isStreaming={false}
        branding={branding}
        variant="terminal"
      />,
    );

    expect(screen.getByTestId('sandbox-chat')).toHaveAttribute('data-message-count', '2');
    expect(hoisted.chatContainerMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatContainerMock.mock.calls[0]?.[0]).toMatchObject({
      branding,
      hideInput: true,
      isStreaming: false,
      messages,
      presentation: 'runs',
    });
    expect(hoisted.chatContainerMock.mock.calls[0]?.[0].partMap).toEqual({
      'user-1': [{ type: 'text', text: 'Place a bounded ETH probe.' }],
      'assistant-1': [reasoningPart, toolPart, finalTextPart],
    });
  });
});
