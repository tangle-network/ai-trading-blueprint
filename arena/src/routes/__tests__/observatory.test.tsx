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

const operatorAuthState = {
  authCacheKey: '0xowner::https://operator.test' as string | null,
  cachedToken: 'token' as string | null,
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
              delegation_pressure: {
                unique_sessions: 1,
                active_sessions: 1,
                terminal_sessions: 0,
                duplicate_rows_removed: 1,
                by_status: { queued_research: 1 },
                by_source: { 'owner-feedback:research': 1 },
                usage_reporting_status: 'not_applicable',
                usage_event_count: 0,
                total_tokens: 0,
                cost_usd: 0,
                limits: { max_active_delegations: 3, max_cpu_pressure: 0.85, min_free_memory_mb: 512 },
                pressure_level: 'high',
                allows_new_delegation: false,
                deny_reasons: ['active_delegation_cap'],
              },
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
              category: 'research',
              finding_code: 'external-signal-not-checked',
              finding_severity: 'high',
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
          research_tasks: [
            {
              task_id: 'research-1',
              bot_id: 'bot-1',
              idea_id: 'idea-1',
              feedback_id: 'feedback-1',
              owner: '0xowner',
              created_at: '2026-06-04T10:00:00.000Z',
              updated_at: '2026-06-04T10:00:00.000Z',
              status: 'queued_research',
              worker: 'observatory-research-queue',
              worker_launch: 'manual_or_research_tick',
              title: 'Research ETH Perp Sentinel signal gap',
              thesis: 'The mandate needs external signal evidence, but it was not checked.',
              evidence_refs: ['artifact://memory/decision-contexts.jsonl#ctx-1'],
              prompt: 'Research-only Observatory task for bot bot-1.',
              acceptance_criteria: ['Source-grounded finding is recorded.'],
              safety_limits: { can_touch_funds: false, can_trade: false, can_promote: false },
              result_ref: null,
              result_summary: null,
            },
          ],
          delegated_work_sessions: [
            {
              session_id: 'research-session-1',
              bot_id: 'bot-1',
              source: 'owner-feedback:research',
              status: 'queued_research',
              created_at: '2026-06-04T10:00:00.000Z',
              idea_id: 'idea-1',
              task_id: 'research-1',
              summary: 'Owner queued read-only research.',
              artifact_ref: 'artifact://observatory/research-tasks#research-1',
            },
            {
              session_id: 'research-session-1',
              bot_id: 'bot-1',
              source: 'observatory-idea',
              status: 'awaiting_owner_feedback',
              created_at: '2026-06-04T09:00:00.000Z',
              idea_id: 'idea-1',
              task_id: null,
              summary: 'Duplicate historical row.',
              artifact_ref: 'artifact://observatory/ideas#idea-1',
            },
          ],
          owner_feedback: [],
          delegation_pressure: {
            unique_sessions: 1,
            active_sessions: 1,
            terminal_sessions: 0,
            duplicate_rows_removed: 1,
            by_status: { queued_research: 1 },
            by_source: { 'owner-feedback:research': 1 },
            usage_reporting_status: 'not_applicable',
            usage_event_count: 0,
            total_tokens: 0,
            cost_usd: 0,
            limits: { max_active_delegations: 3, max_cpu_pressure: 0.85, min_free_memory_mb: 512 },
            pressure_level: 'high',
            allows_new_delegation: false,
            deny_reasons: ['active_delegation_cap'],
          },
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

vi.mock('~/lib/hooks/useOperatorAuth', () => ({
  useOperatorAuth: () => ({
    authCacheKey: operatorAuthState.authCacheKey,
    getCachedToken: () => operatorAuthState.cachedToken,
  }),
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
    operatorAuthState.authCacheKey = '0xowner::https://operator.test';
    operatorAuthState.cachedToken = 'token';
    overviewState.isLoading = false;
    overviewState.isFetching = false;
    overviewState.isError = false;
    overviewState.data.bots[0].records.ideas[0].proposed_action = 'delegate_research';
    overviewState.data.bots[0].records.owner_feedback = [] as any;
    hoisted.useTradingRouteAutoAuthMock.mockClear();
    hoisted.triggerMutateMock.mockClear();
    hoisted.feedbackMutateMock.mockClear();
  });

  it('renders fleet observability records and immediate trigger control', async () => {
    const { default: ObservatoryPage } = await import('../observatory');
    const { container } = render(<ObservatoryPage />, { wrapper: createWrapper() });

    expect(hoisted.useTradingRouteAutoAuthMock).toHaveBeenCalledWith({
      enabled: true,
      routeKey: 'observatory',
    });
    expect(screen.getByRole('heading', { name: 'Observatory' })).toBeInTheDocument();
    expect(screen.getAllByText('ETH Perp Sentinel').length).toBeGreaterThan(0);
    expect(screen.getByText('Active/Work')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Output' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Work session transcript')).toBeInTheDocument();
    expect(container.querySelector('[data-sandbox-run-group]')).not.toBeNull();
    expect(container.querySelector('[data-sandbox-run-group]')).toHaveAttribute('data-collapsed', 'true');
    expect(container.querySelector('[data-observatory-trace-role="user"]')).not.toBeNull();
    expect(container.querySelector('[data-observatory-trace-role="assistant"]')).not.toBeNull();
    expect(container.querySelector('[data-chat-role="user"]')).not.toBeNull();
    expect(container.querySelector('[data-chat-role="assistant"]')).not.toBeNull();
    expect(screen.getByText(/Research-only Observatory task for bot bot-1\./)).toBeInTheDocument();
    expect(screen.getByText('Output pending. Current status: queued_research.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand run' }));
    expect(screen.getByText('Source-grounded finding is recorded.')).toBeInTheDocument();
    expect(screen.getByText('can_trade')).toBeInTheDocument();
    expect(screen.getAllByText('false').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('tab', { name: 'Findings 1' }));
    expect(screen.getByText('external-signal-not-checked')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Trace 1' }));
    expect(screen.getByText('Dedupe')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('active_delegation_cap')).toBeInTheDocument();
    expect(screen.getAllByText(/research-1/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /observe now/i }));
    expect(hoisted.triggerMutateMock).toHaveBeenCalledWith('manual');
  });

  it('records owner feedback from idea actions', async () => {
    const { default: ObservatoryPage } = await import('../observatory');
    render(<ObservatoryPage />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByRole('tab', { name: 'Ideas 1' }));
    expect(screen.getByText('external-signal-not-checked')).toBeInTheDocument();
    expect(screen.getByText('high severity')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delegate research' }));
    expect(hoisted.feedbackMutateMock).toHaveBeenCalledWith({
      ideaId: 'idea-1',
      action: 'delegate_research',
    });
  });

  it('keeps delegated idea status and primary action visually consistent', async () => {
    overviewState.data.bots[0].records.ideas[0].proposed_action = 'delegate_build';
    overviewState.data.bots[0].records.owner_feedback = [
      {
        feedback_id: 'feedback-1',
        idea_id: 'idea-1',
        bot_id: 'bot-1',
        owner: '0xowner',
        action: 'delegate_research',
        note: null,
        created_at: '2026-06-04T10:01:00.000Z',
      },
    ] as any;

    const { default: ObservatoryPage } = await import('../observatory');
    render(<ObservatoryPage />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByRole('tab', { name: 'Ideas 1' }));
    expect(screen.getByText('Delegate Research')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delegate research' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delegate build' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delegate research' }));
    expect(hoisted.feedbackMutateMock).toHaveBeenCalledWith({
      ideaId: 'idea-1',
      action: 'delegate_research',
    });
  });

  it('renders records from a cached operator session without a connected wallet', async () => {
    accountState.isConnected = false;
    operatorAuthState.authCacheKey = '0xowner::https://operator.test';
    operatorAuthState.cachedToken = 'token';

    const { default: ObservatoryPage } = await import('../observatory');
    render(<ObservatoryPage />, { wrapper: createWrapper() });

    expect(screen.getByRole('heading', { name: 'Observatory' })).toBeInTheDocument();
    expect(screen.getAllByText('ETH Perp Sentinel').length).toBeGreaterThan(0);
    expect(screen.queryByText('Connect owner wallet')).not.toBeInTheDocument();
  });
});
