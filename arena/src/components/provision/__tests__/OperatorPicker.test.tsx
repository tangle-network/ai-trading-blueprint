import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Address } from 'viem';
import { OperatorPicker, operatorRpcHost } from '../OperatorPicker';

const OP_A = '0x00000000000000000000000000000000000000aa' as Address;
const OP_B = '0x00000000000000000000000000000000000000bb' as Address;
const OP_C = '0x00000000000000000000000000000000000000cc' as Address;

const OPTIONS = [
  { address: OP_A, rpcHost: 'op-a.example', quoteCost: 5_000_000_000n },
  { address: OP_B, rpcHost: 'op-b.example', quoteCost: 7_000_000_000n },
  { address: OP_C, rpcHost: 'op-c.example', failure: 'unreachable' as const },
];

describe('operatorRpcHost', () => {
  it('extracts hostnames from registered RPC addresses', () => {
    expect(operatorRpcHost('https://op.example:9000')).toBe('op.example');
    expect(operatorRpcHost('op.example:9000')).toBe('op.example');
    expect(operatorRpcHost(undefined)).toBeUndefined();
    expect(operatorRpcHost('::::')).toBeUndefined();
  });
});

describe('OperatorPicker', () => {
  it('collapses to the picked operator and price with a change affordance', () => {
    render(
      <OperatorPicker
        options={OPTIONS}
        selected={OP_A}
        cheapest={OP_A}
        onSelect={vi.fn()}
      />,
    );

    const toggle = screen.getByRole('button', { name: /op-a\.example.*\$5\.00.*Change/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('selects an operator with keyboard navigation and collapses after picking', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <OperatorPicker
        options={OPTIONS}
        selected={OP_A}
        cheapest={OP_A}
        onSelect={onSelect}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Change/ }));

    const selected = screen.getByRole('radio', { name: /op-a\.example/ });
    expect(selected).toHaveAttribute('aria-checked', 'true');
    expect(selected).toHaveAttribute('tabindex', '0');

    // Unavailable operators are listed but not selectable or focusable.
    const unavailable = screen.getByRole('radio', { name: /op-c\.example/ });
    expect(unavailable).toBeDisabled();
    expect(unavailable).toHaveTextContent('Unreachable');

    // Arrow moves the roving focus to the next quoted operator; Enter picks it.
    selected.focus();
    await user.keyboard('{ArrowDown}');
    const next = screen.getByRole('radio', { name: /op-b\.example/ });
    expect(next).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledWith(OP_B);
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });
});
