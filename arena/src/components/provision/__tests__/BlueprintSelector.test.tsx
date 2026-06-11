import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '~/test/mockBlueprintUi';
import { BlueprintSelector } from '../BlueprintSelector';
import type { TradingBlueprintDef } from '~/lib/blueprints';

function blueprint(overrides: Partial<TradingBlueprintDef>): TradingBlueprintDef {
  return {
    id: 'trading-cloud',
    name: 'Trading Cloud',
    description: 'Multi-instance fleet — deploy multiple trading bots per service.',
    icon: 'i-ph:cloud',
    color: 'violet',
    blueprintId: '1',
    isFleet: true,
    isTee: false,
    defaults: { cpuCores: 1n, memoryMb: 512n, maxLifetimeDays: 7n },
    strategyPacks: [],
    encodeProvision: vi.fn(() => '0x' as const),
    ...overrides,
  };
}

const BLUEPRINTS = [
  blueprint({}),
  blueprint({
    id: 'trading-instance',
    name: 'Trading Instance',
    isFleet: false,
    color: 'teal',
    blueprintId: '2',
  }),
  blueprint({
    id: 'trading-tee-instance',
    name: 'Trading Instance TEE',
    isFleet: false,
    isTee: true,
    color: 'blue',
    blueprintId: '3',
  }),
];

describe('BlueprintSelector', () => {
  it('leads with plain-language framing and demotes the technical name', () => {
    render(
      <BlueprintSelector blueprints={BLUEPRINTS} selected={null} onSelect={vi.fn()} />,
    );

    expect(
      screen.getByRole('heading', { name: 'Shared instance' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/runs alongside others on the operator/)).toBeInTheDocument();
    expect(screen.getByText(/cheapest way to run/)).toBeInTheDocument();

    expect(
      screen.getByRole('heading', { name: 'Dedicated instance' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Dedicated + TEE' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/hardware attestation/)).toBeInTheDocument();

    // Technical blueprint names stay visible as secondary text.
    expect(screen.getByText('Trading Cloud')).toBeInTheDocument();
    expect(screen.getByText('Trading Instance TEE')).toBeInTheDocument();

    // Old jargon badges are gone.
    expect(screen.queryByText('Fleet')).not.toBeInTheDocument();
  });

  it('exposes the cards as a radiogroup and reports selection', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <BlueprintSelector
        blueprints={BLUEPRINTS}
        selected="trading-cloud"
        onSelect={onSelect}
      />,
    );

    const group = screen.getByRole('radiogroup', { name: 'Where your bot runs' });
    expect(group).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: /Shared instance/ }),
    ).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('radio', { name: /Dedicated \+ TEE/ }));
    expect(onSelect).toHaveBeenCalledWith('trading-tee-instance');
  });
});
