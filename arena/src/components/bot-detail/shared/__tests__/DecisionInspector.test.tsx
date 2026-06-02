import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DecisionActivityStrip } from '../DecisionActivityStrip';
import { DecisionInspector } from '../DecisionInspector';
import type { DecisionFeedItem } from '~/lib/decisionFeed';

const decisionItem: DecisionFeedItem = {
  id: 'run:run-1',
  source: 'run',
  sourceId: 'run-1',
  title: 'TRADE / Completed',
  subtitle: 'May 27, 06:00 AM',
  timestampMs: 1_775_849_924_000,
  statusLabel: 'Completed',
  statusTone: 'success',
  actionLabel: 'TRADE',
  instrumentLabel: 'ETH',
  reason: 'rsi-oversold',
  notionalLabel: '$11',
  venueLabel: 'hyperliquid',
  validationLabel: 'approved',
  executionLabel: 'filled',
  provenance: [
    { label: 'Run', value: 'run-1' },
    { label: 'Trace', value: 'trace-1' },
  ],
  stages: [
    {
      key: 'state',
      label: 'State',
      value: 'fresh',
      tone: 'success',
      iconClass: 'i-ph:activity',
    },
    {
      key: 'decision',
      label: 'Decision',
      value: 'trade',
      detail: 'rsi-oversold',
      tone: 'neutral',
      iconClass: 'i-ph:brain',
    },
    {
      key: 'validation',
      label: 'Validation',
      value: 'approved',
      tone: 'success',
      iconClass: 'i-ph:shield-check',
    },
    {
      key: 'execution',
      label: 'Execution',
      value: 'filled',
      tone: 'success',
      iconClass: 'i-ph:lightning',
    },
  ],
};

describe('decision inspector surfaces', () => {
  it('renders decision reason, stages, stats, and provenance', () => {
    render(<DecisionInspector item={decisionItem} />);

    expect(screen.getByRole('complementary', { name: /decision inspector/i })).toBeInTheDocument();
    expect(screen.getByText('TRADE')).toBeInTheDocument();
    expect(screen.getByText('ETH')).toBeInTheDocument();
    expect(screen.getAllByText('rsi-oversold').length).toBeGreaterThan(0);
    expect(screen.getByText('$11')).toBeInTheDocument();
    expect(screen.getAllByText('Validation').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Execution').length).toBeGreaterThan(0);
    expect(screen.getByTitle('Run: run-1')).toBeInTheDocument();
  });

  it('emits the selected decision from the activity strip', async () => {
    const onSelect = vi.fn();
    render(
      <DecisionActivityStrip
        items={[decisionItem]}
        selectedId={decisionItem.id}
        onSelect={onSelect}
      />,
    );

    const button = screen.getByRole('button', { name: /trade/i });
    expect(button).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(button);

    expect(onSelect).toHaveBeenCalledWith(decisionItem);
  });
});
