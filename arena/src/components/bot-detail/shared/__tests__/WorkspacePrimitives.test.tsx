import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceMetric, WorkspaceNavStrip } from '../WorkspacePrimitives';

describe('WorkspacePrimitives', () => {
  it('marks the selected workspace nav item and emits route values', async () => {
    const onSelect = vi.fn();
    render(
      <WorkspaceNavStrip
        ariaLabel="Agent workspace sections"
        activeValue="runs"
        onSelect={onSelect}
        items={[
          { value: 'performance', label: 'Performance', icon: 'i-ph:chart-line' },
          { value: 'runs', label: 'Runs', icon: 'i-ph:list-checks' },
        ]}
      />,
    );

    expect(screen.getByRole('navigation', { name: /agent workspace sections/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /runs/i })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: /performance/i })).not.toHaveAttribute('aria-current');

    await userEvent.click(screen.getByRole('button', { name: /performance/i }));

    expect(onSelect).toHaveBeenCalledWith('performance');
  });

  it('renders metric label and value with stable text roles', () => {
    render(
      <WorkspaceMetric
        label="Sharpe"
        value="1.42"
        valueClassName="text-emerald-500"
      />,
    );

    expect(screen.getByText('Sharpe')).toBeInTheDocument();
    expect(screen.getByText('1.42')).toBeInTheDocument();
  });
});
