import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatTranscript } from './ChatTranscript';

vi.mock('@tangle-network/sandbox-ui/hooks', () => ({
  useAutoScroll: () => ({
    isAtBottom: true,
    scrollToBottom: vi.fn(),
  }),
  useRunCollapseState: () => ({
    isCollapsed: () => false,
    toggleCollapse: vi.fn(),
  }),
  useRunGroups: () => [],
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
});
