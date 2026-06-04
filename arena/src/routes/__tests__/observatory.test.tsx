import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWrapper } from '~/test/mocks';

const hoisted = vi.hoisted(() => ({
  useTradingRouteAutoAuthMock: vi.fn(),
  triggerMutateMock: vi.fn(),
  feedbackMutateMock: vi.fn(),
}));

const accountState = {
  isConnected: true,
};

const overviewState = {
  isLoading: false,
  isFetching: false,
  isError: false,
  data: {
    schema_version: 1,
    bot_count: 1,
    totals: {
      reflection_runs: 1,
      ideas: 1,
      delegated_work_sessions: 1,
    },
    bots: [
      {
        bot_id: 'bot-1',
        bot_name: 'ETH Perp Sentinel',
        strategy_type: 'hyperliquid_perp',
        trading_active: true,
        paper_trade: true,
        error: null,
        records: {
          schema_version: 1,
          world_signal_digests: [
            {
              digest_id: 'digest-1',
              bot_id: 'bot-1',
              created_at: '2026-06-04T10:00:00.000Z',
              source_status: 'missing',
              freshness: '2026-06-04T09:59:00.000Z',
              confidence: 'low',
              source_count: 0,
              signals: [],
              unavailable_reason: null,
              evidence_ref: 'artifact://memory/decision-contexts.jsonl#ctx-1',
            },
          ],
          reflection_runs: [
            {
              run_id: 'obs-1',
              bot_id: 'bot-1',
              bot_name: 'ETH Perp Sentinel',
              created_at: '2026-06-04T10:00:00.000Z',
              trigger: 'manual',
              requested_by: '0xowner',
              mode: 'deterministic-observatory',
              world_model_questions: [],
              evidence: {},
              conclusions: ['External signal coverage is not proven.'],
              uncertainties: ['External signal coverage is not proven.'],
              findings: [
                {
                  code: 'external-signal-not-checked',
                  severity: 'high',
                  summary: 'The mandate needs external signal evidence, but it was not checked.',
                },
              ],
              idea_ids: ['idea-1'],
              delegated_session_ids: ['pending-idea-1'],
              usage_summary: {
                event_count: 0,
                reporting_status: 'not_applicable',
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
                cost_usd: 0,
                providers: [],
                models: [],
              },
            },
          ],
          ideas: [
            {
              idea_id: 'idea-1',
              bot_id: 'bot-1',
              created_at: '2026-06-04T10:00:00.000Z',
              title: 'Research ETH Perp Sentinel signal gap',
              thesis: 'The mandate needs external signal evidence, but it was not checked.',
              evidence_refs: ['artifact://memory/decision-contexts.jsonl#ctx-1'],
              expected_value: 'Give the bot a fresher market/world-model input.',
              risk: 'paper_only_until_existing_promotion_gates_pass',
              proposed_action: 'delegate_research',
              status: 'open',
              source_run_id: 'obs-1',
            },
          ],
          delegated_work_sessions: [
            {
              session_id: 'pending-idea-1',
              bot_id: 'bot-1',
              source: 'observatory-idea',
              status: 'awaiting_owner_feedback',
              created_at: '2026-06-04T10:00:00.000Z',
              idea_id: 'idea-1',
              task_id: null,
              summary: 'Idea is ready for owner review.',
              artifact_ref: 'artifact://observatory/ideas#idea-1',
            },
          ],
          owner_feedback: [],
        },
      },
    ],
  },
};

vi.mock('react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock('wagmi', () => ({
  useAccount: () => accountState,
}));

vi.mock('~/lib/hooks/useTradingRouteAutoAuth', () => ({
  useTradingRouteAutoAuth: hoisted.useTradingRouteAutoAuthMock,
}));

vi.mock('~/lib/operator/meta', () => ({
  ALL_TRADING_OPERATOR_API_URLS: ['https://operator.test'],
  HAS_TRADING_OPERATOR_API: true,
}));

vi.mock('~/components/operator/OperatorAccessCard', () => ({
  OperatorAccessCard: ({ title }: any) => <div>{title}</div>,
  OperatorSessionBanner: () => null,
}));

vi.mock('~/components/layout/ConnectWalletPanel', () => ({
  ConnectWalletPanel: ({ title }: any) => <div>{title}</div>,
}));

vi.mock('~/components/ui/Skeleton', () => ({
  SkeletonCard: () => <div>skeleton</div>,
}));

vi.mock('~/lib/hooks/useBotApi', () => ({
  useObservatoryOverview: () => overviewState,
  useTriggerBotObservatory: () => ({
    mutate: hoisted.triggerMutateMock,
    isPending: false,
  }),
  useObservatoryIdeaFeedback: () => ({
    mutate: hoisted.feedbackMutateMock,
    isPending: false,
  }),
}));

describe('ObservatoryPage', () => {
  beforeEach(() => {
    accountState.isConnected = true;
    overviewState.isLoading = false;
    overviewState.isFetching = false;
    overviewState.isError = false;
    hoisted.useTradingRouteAutoAuthMock.mockClear();
    hoisted.triggerMutateMock.mockClear();
    hoisted.feedbackMutateMock.mockClear();
  });

  it('renders fleet observability records and immediate trigger control', async () => {
    const { default: ObservatoryPage } = await import('../observatory');
    render(<ObservatoryPage />, { wrapper: createWrapper() });

    expect(hoisted.useTradingRouteAutoAuthMock).toHaveBeenCalledWith({
      enabled: true,
      routeKey: 'observatory',
    });
    expect(screen.getByRole('heading', { name: 'Observatory' })).toBeInTheDocument();
    expect(screen.getAllByText('ETH Perp Sentinel').length).toBeGreaterThan(0);
    expect(screen.getByText('external-signal-not-checked')).toBeInTheDocument();
    expect(screen.getByText('Research ETH Perp Sentinel signal gap')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /observe now/i }));
    expect(hoisted.triggerMutateMock).toHaveBeenCalledWith('manual');
  });

  it('records owner feedback from idea actions', async () => {
    const { default: ObservatoryPage } = await import('../observatory');
    render(<ObservatoryPage />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByRole('button', { name: 'Delegate research' }));
    expect(hoisted.feedbackMutateMock).toHaveBeenCalledWith({
      ideaId: 'idea-1',
      action: 'delegate_research',
    });
  });
});
