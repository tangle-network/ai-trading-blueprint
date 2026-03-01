import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  truncateAddress,
  truncateSignature,
  SimulationBadge,
  SimulationDetail,
} from '../ValidatorComponents';
import { mockBlueprintUi, mockFramerMotion } from '~/test/mocks';

mockBlueprintUi();
mockFramerMotion();

// ── Utility tests ───────────────────────────────────────────────────────

describe('truncateAddress', () => {
  it('returns short strings unchanged', () => {
    expect(truncateAddress('0x1234')).toBe('0x1234');
  });

  it('truncates long addresses', () => {
    const addr = '0x1234567890abcdef1234567890abcdef12345678';
    expect(truncateAddress(addr)).toBe('0x1234...5678');
  });
});

describe('truncateSignature', () => {
  it('returns short strings unchanged', () => {
    expect(truncateSignature('0x1234')).toBe('0x1234');
  });

  it('truncates long signatures', () => {
    const sig = '0x' + 'ab'.repeat(65);
    const result = truncateSignature(sig);
    expect(result).toMatch(/^0x.+\.\.\..+$/);
  });
});

// ── SimulationBadge ─────────────────────────────────────────────────────

describe('SimulationBadge', () => {
  it('renders risk score', () => {
    render(
      <SimulationBadge
        simulation={{
          success: true,
          gasUsed: 21000,
          riskScore: 25,
          warnings: [],
          outputAmount: '1000',
        }}
      />,
    );
    expect(screen.getByText('25')).toBeInTheDocument();
  });

  it('shows warning count when warnings present', () => {
    render(
      <SimulationBadge
        simulation={{
          success: true,
          gasUsed: 50000,
          riskScore: 45,
          warnings: ['SlippageHigh', 'LowLiquidity'],
          outputAmount: '500',
        }}
      />,
    );
    expect(screen.getByText('!2')).toBeInTheDocument();
  });

  it('does not show warning indicator when no warnings', () => {
    const { container } = render(
      <SimulationBadge
        simulation={{
          success: false,
          gasUsed: 0,
          riskScore: 80,
          warnings: [],
          outputAmount: '0',
        }}
      />,
    );
    expect(container.textContent).not.toContain('!');
  });
});

// ── SimulationDetail ────────────────────────────────────────────────────

describe('SimulationDetail', () => {
  it('renders PASS for successful simulation', () => {
    render(
      <SimulationDetail
        simulation={{
          success: true,
          gasUsed: 150000,
          riskScore: 20,
          warnings: [],
          outputAmount: '2500',
        }}
      />,
    );
    expect(screen.getByText('PASS')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText('150,000')).toBeInTheDocument();
  });

  it('renders FAIL for failed simulation', () => {
    render(
      <SimulationDetail
        simulation={{
          success: false,
          gasUsed: 0,
          riskScore: 95,
          warnings: ['ExecutionReverted'],
          outputAmount: '0',
        }}
      />,
    );
    expect(screen.getByText('FAIL')).toBeInTheDocument();
    expect(screen.getByText('95')).toBeInTheDocument();
  });

  it('renders warnings list', () => {
    render(
      <SimulationDetail
        simulation={{
          success: true,
          gasUsed: 80000,
          riskScore: 55,
          warnings: ['PriceImpactHigh', 'SandwichRisk'],
          outputAmount: '1200',
        }}
      />,
    );
    expect(screen.getByText('PriceImpactHigh')).toBeInTheDocument();
    expect(screen.getByText('SandwichRisk')).toBeInTheDocument();
  });

  it('shows output amount when non-zero', () => {
    render(
      <SimulationDetail
        simulation={{
          success: true,
          gasUsed: 21000,
          riskScore: 10,
          warnings: [],
          outputAmount: '5000.50',
        }}
      />,
    );
    expect(screen.getByText('5000.50')).toBeInTheDocument();
  });
});
