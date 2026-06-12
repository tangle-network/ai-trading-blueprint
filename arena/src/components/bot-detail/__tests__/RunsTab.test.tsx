import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWrapper } from "~/test/mocks";

const authState = {
  token: "test-token" as string | null,
  isAuthenticated: true,
  isAuthenticating: false,
  authenticate: vi.fn(),
  error: null as string | null,
};

const streamRefetchMock = vi.hoisted(() => vi.fn(async () => {}));

const defaultStreamState = vi.hoisted(() => () => ({
  messages: [] as Array<Record<string, unknown>>,
  partMap: {} as Record<string, Array<Record<string, unknown>>>,
  isStreaming: false,
  connected: false,
  isReconnecting: false,
  attempt: 0,
  retryInSeconds: 0,
  error: null as string | null,
  refetch: streamRefetchMock,
}));

const useBotSessionStreamMock = vi.hoisted(() => vi.fn(defaultStreamState));

const chatTranscriptMock = vi.hoisted(() =>
  vi.fn(
    ({
      partMap = {},
      onSend,
      footerNotice,
    }: {
      partMap?: Record<string, Array<Record<string, unknown>>>;
      onSend?: (text: string) => void | Promise<void>;
      footerNotice?: React.ReactNode;
    }) => (
      <div data-testid="chat-transcript">
        {Object.entries(partMap).flatMap(([messageId, parts]) =>
          parts.map((part, index) => {
            if (part.type === "tool" && typeof part.tool === "string") {
              return (
                <div key={`${messageId}-${index}`} data-testid="tool-part">
                  {part.tool}
                </div>
              );
            }
            const text = typeof part.text === "string" ? part.text : null;
            return text ? <div key={`${messageId}-${index}`}>{text}</div> : null;
          }),
        )}
        {footerNotice}
        {onSend ? (
          <button
            type="button"
            data-testid="composer-send"
            onClick={() => void onSend("test message")}
          >
            send
          </button>
        ) : null}
      </div>
    ),
  ),
);

vi.mock("~/lib/hooks/useOperatorAuth", () => ({
  useOperatorAuth: () => authState,
}));

vi.mock("~/lib/hooks/useBotSessionStream", () => ({
  useBotSessionStream: useBotSessionStreamMock,
}));

vi.mock("~/components/bot-detail/chat/ChatTranscript", () => ({
  ChatTranscript: chatTranscriptMock,
}));

vi.mock("../chat/ChatTranscript", () => ({
  ChatTranscript: chatTranscriptMock,
}));

vi.mock(
  "@tangle-network/sandbox-ui/hooks",
  () => ({
    useAutoScroll: () => ({
      containerRef: { current: null },
      endRef: { current: null },
    }),
    useRunCollapseState: () => ({
      collapsedRuns: new Set(),
      toggleRun: vi.fn(),
    }),
    useRunGroups: () => [],
  }),
);

vi.mock(
  "@tangle-network/sandbox-ui/utils",
  () => ({
    cn: (...classes: Array<string | false | null | undefined>) =>
      classes.filter(Boolean).join(" "),
  }),
);

vi.mock("~/lib/operator/meta", async () => {
  const actual = await vi.importActual<typeof import("~/lib/operator/meta")>(
    "~/lib/operator/meta",
  );
  return {
    ...actual,
    useOperatorMeta: () => ({
      data: {
        api_version: "1",
        deployment_kind: "fleet",
        features: {
          chat: true,
          terminal: true,
        },
      },
    }),
  };
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("RunsTab", () => {
  beforeEach(() => {
    authState.token = "test-token";
    authState.isAuthenticated = true;
    authState.isAuthenticating = false;
    authState.error = null;
    authState.authenticate.mockReset();
    useBotSessionStreamMock.mockReset();
    useBotSessionStreamMock.mockImplementation(defaultStreamState);
    chatTranscriptMock.mockClear();
    streamRefetchMock.mockClear();

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it("loads older run pages without changing the selected run", async () => {
    const { RunsTab } = await import("../RunsTab");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/runs?limit=100")) {
        return jsonResponse({
          runs: [
            {
              run_id: "run-new",
              workflow_id: 101,
              workflow_kind: "trading",
              status: "completed",
              started_at: 1_775_824_500,
              completed_at: 1_775_824_560,
              session_id: null,
              transcript_available: false,
              trace_id: null,
              duration_ms: 60_000,
              input_tokens: 10,
              output_tokens: 6,
              result: "latest result",
              error: null,
            },
          ],
          next_cursor: "1775824500:run-new",
        });
      }
      if (url.endsWith("/runs?limit=100&cursor=1775824500%3Arun-new")) {
        return jsonResponse({
          runs: [
            {
              run_id: "run-old",
              workflow_id: 102,
              workflow_kind: "research",
              status: "completed",
              started_at: 1_775_824_000,
              completed_at: 1_775_824_060,
              session_id: null,
              transcript_available: false,
              trace_id: null,
              duration_ms: 60_000,
              input_tokens: 8,
              output_tokens: 4,
              result: "older result",
              error: null,
            },
          ],
          next_cursor: null,
        });
      }

      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <RunsTab
        botId="bot-1"
        botName="Trend Runner"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    expect((await screen.findAllByText("Trading Run")).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText("latest result").length).toBeGreaterThan(0);
    expect(screen.getByTestId("chat-transcript")).toBeInTheDocument();
    await waitFor(() => {
      expect(useBotSessionStreamMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sessionId: "run-replay-run-new",
          historyPath: "/runs/run-new/messages?limit=200",
          streamEnabled: false,
        }),
      );
    });

    await userEvent.click(screen.getByRole("button", { name: /load older/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:9201/api/bots/bot-1/runs?limit=100&cursor=1775824500%3Arun-new",
        expect.objectContaining({
          headers: {},
        }),
      );
    });
    expect(await screen.findByText("Research Run")).toBeInTheDocument();
    expect(screen.getAllByText("latest result").length).toBeGreaterThan(0);
  });

  it("defaults to agent runs and visualizes loaded AI spend by run type, model, and time bucket", async () => {
    const { RunsTab } = await import("../RunsTab");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          runs: [
            {
              run_id: "run-agentic",
              workflow_id: 101,
              workflow_kind: "trading",
              status: "completed",
              started_at: 1_775_824_500,
              completed_at: 1_775_824_560,
              session_id: null,
              transcript_available: false,
              trace_id: null,
              duration_ms: 60_000,
              input_tokens: 900,
              output_tokens: 100,
              result: "agentic result",
              error: null,
              model: "glm-5.1",
              provider: "zai",
              cost_usd: 0.0421,
              loop_mode: "agentic",
            },
            {
              run_id: "run-chat",
              workflow_id: 103,
              workflow_kind: "conversation",
              status: "completed",
              started_at: 1_775_828_100,
              completed_at: 1_775_828_140,
              session_id: null,
              transcript_available: false,
              trace_id: null,
              duration_ms: 40_000,
              input_tokens: 200,
              output_tokens: 300,
              result: "chat result",
              error: null,
              model: "gpt-5",
              provider: "openai",
              cost_usd: 0.0079,
              loop_mode: "agentic",
            },
            {
              run_id: "run-tick",
              workflow_id: 102,
              workflow_kind: "trading",
              status: "completed",
              started_at: 1_775_824_000,
              completed_at: 1_775_824_002,
              session_id: null,
              transcript_available: false,
              trace_id: null,
              duration_ms: 2_000,
              input_tokens: 0,
              output_tokens: 0,
              result: "tick result",
              error: null,
              model: null,
              provider: null,
              cost_usd: null,
              loop_mode: "deterministic",
            },
          ],
          next_cursor: null,
        }),
      ),
    );

    render(
      <RunsTab
        botId="bot-1"
        botName="Trend Runner"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    // Defaults to the agent-run filter: the deterministic tick is not listed.
    const sidebar = await screen.findByLabelText("Autonomous runs");
    expect(within(sidebar).getAllByText("glm-5.1").length).toBeGreaterThan(0);
    expect(within(sidebar).getAllByText("$0.042").length).toBeGreaterThan(0);
    expect(screen.getByText("2 entries")).toBeInTheDocument();

    const spendPanel = screen.getByTestId("intelligence-spend-panel");
    expect(within(spendPanel).getByText("Intelligence Spend")).toBeInTheDocument();
    expect(within(spendPanel).getByText("$0.050")).toBeInTheDocument();
    expect(within(spendPanel).getByText("1.5k tok")).toBeInTheDocument();
    expect(within(spendPanel).getByTestId("usage-workflow-trading")).toHaveTextContent("Trading");
    expect(within(spendPanel).getByTestId("usage-workflow-trading")).toHaveTextContent("$0.042");
    expect(within(spendPanel).getByTestId("usage-workflow-conversation")).toHaveTextContent("Chats");
    expect(within(spendPanel).getByTestId("usage-model-zai/glm-5.1")).toHaveTextContent("zai/glm-5.1");
    expect(within(spendPanel).getByTestId("usage-model-openai/gpt-5")).toHaveTextContent("openai/gpt-5");
    expect(screen.getByText("AI spend")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Intelligence spend metric" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Intelligence spend time bucket" })).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: /filter runs by loop mode/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agent runs" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await userEvent.click(screen.getByRole("button", { name: "Tokens" }));
    expect(screen.getByRole("button", { name: "Tokens" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Hour" }));
    expect(screen.getByRole("button", { name: "Hour" })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: "All" }));
    expect(await screen.findByText("3 entries")).toBeInTheDocument();
  });

  it("hides the loop-mode filter when the operator does not report loop modes", async () => {
    const { RunsTab } = await import("../RunsTab");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          runs: [
            {
              run_id: "run-legacy",
              workflow_id: 101,
              workflow_kind: "trading",
              status: "completed",
              started_at: 1_775_824_500,
              completed_at: 1_775_824_560,
              session_id: null,
              transcript_available: false,
              trace_id: null,
              duration_ms: 60_000,
              input_tokens: 10,
              output_tokens: 6,
              result: "legacy result",
              error: null,
            },
          ],
          next_cursor: null,
        }),
      ),
    );

    render(
      <RunsTab
        botId="bot-1"
        botName="Trend Runner"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    expect((await screen.findAllByText("legacy result")).length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("group", { name: /filter runs by loop mode/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("LLM spend (loaded window)")).not.toBeInTheDocument();
  });

  it("loads public fleet run summaries without wallet authentication", async () => {
    authState.token = null;
    authState.isAuthenticated = false;

    const { RunsTab } = await import("../RunsTab");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/runs?limit=100")) {
        return jsonResponse({
          runs: [
            {
              run_id: "run-public",
              workflow_id: 101,
              workflow_kind: "trading",
              status: "completed",
              started_at: 1_775_824_500,
              completed_at: 1_775_824_560,
              session_id: null,
              transcript_available: false,
              trace_id: null,
              duration_ms: 60_000,
              input_tokens: 10,
              output_tokens: 6,
              result: "public result",
              error: null,
            },
          ],
          next_cursor: null,
        });
      }

      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <RunsTab
        botId="bot-1"
        botName="Trend Runner"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    expect((await screen.findAllByText("public result")).length).toBeGreaterThan(0);
    expect(screen.getByTestId("chat-transcript")).toBeInTheDocument();
    await waitFor(() => {
      expect(useBotSessionStreamMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          token: null,
          sessionId: "run-replay-run-public",
          historyPath: "/runs/run-public/messages?limit=200",
          streamEnabled: false,
        }),
      );
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:9201/api/bots/bot-1/runs?limit=100",
      expect.objectContaining({ headers: {} }),
    );
  });

  it("keeps public run history visible when operator verification is pending", async () => {
    authState.token = null;
    authState.isAuthenticated = false;

    const { RunsTab } = await import("../RunsTab");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          runs: [
            {
              run_id: "run-public-unverified",
              workflow_id: 101,
              workflow_kind: "trading",
              status: "completed",
              started_at: 1_775_824_500,
              completed_at: 1_775_824_560,
              session_id: null,
              transcript_available: false,
              trace_id: null,
              duration_ms: 60_000,
              input_tokens: 10,
              output_tokens: 6,
              result: "public result",
              error: null,
            },
          ],
          next_cursor: null,
        }),
      ),
    );

    render(
      <RunsTab
        botId="bot-1"
        botName="Trend Runner"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="unverified"
      />,
      { wrapper: createWrapper() },
    );

    expect(await screen.findByText("Operator verification pending")).toBeInTheDocument();
    expect((await screen.findAllByText("public result")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Runs unavailable")).not.toBeInTheDocument();
  });

  it("tries public instance run summaries before asking for owner auth", async () => {
    authState.token = null;
    authState.isAuthenticated = false;

    const { RunsTab } = await import("../RunsTab");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/bot/runs?limit=100")) {
        return jsonResponse({
          runs: [
            {
              run_id: "run-instance-public",
              workflow_id: 101,
              workflow_kind: "trading",
              status: "completed",
              started_at: 1_775_824_500,
              completed_at: 1_775_824_560,
              session_id: null,
              transcript_available: false,
              trace_id: null,
              duration_ms: 60_000,
              input_tokens: 10,
              output_tokens: 6,
              result: "instance public result",
              error: null,
            },
          ],
          next_cursor: null,
        });
      }

      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <RunsTab
        botId="bot-1"
        botName="Trend Runner"
        operatorApiUrl="http://localhost:9301"
        operatorKind="instance"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    expect((await screen.findAllByText("instance public result")).length).toBeGreaterThan(0);
    expect(screen.getByTestId("chat-transcript")).toBeInTheDocument();
    await waitFor(() => {
      expect(useBotSessionStreamMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          token: null,
          sessionId: "run-replay-run-instance-public",
          historyPath: "/runs/run-instance-public/messages?limit=200",
          streamEnabled: false,
        }),
      );
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:9301/api/bot/runs?limit=100",
      expect.objectContaining({ headers: {} }),
    );
  });

  it("shows saved trading run JSON as structured evidence when no full transcript was captured", async () => {
    const { RunsTab } = await import("../RunsTab");
    const result = JSON.stringify({
      result_schema_version: 1,
      run_started_at: "2026-05-27T06:00:01.100Z",
      run_completed_at: "2026-05-27T06:02:28.046Z",
      checked_state: {
        nav_status: "fresh",
        mode: "normal",
        total_nav_usdc: 11,
        hyperliquid_equity_usdc: 11,
        perp_margin_usdc: 11,
        positions_count: 0,
        open_orders_count: 0,
      },
      decision: {
        action: "skip",
        reason: "api-wallet-approval-not-verified",
        setup: {
          action: "open_long",
          asset: "ETH",
          amount_in: "11",
          rationale: "rsi-oversold",
        },
        approval: {
          status: "submitted_corewriter_approval",
          api_wallet_address: "0x030999fbbcb39976413805a09c6b5a93f010ed80",
          tx_hash: "0xbeeb",
          verified_corewriter_approval: false,
          extra_agents: [],
        },
      },
      funding_action: { attempted: false },
      api_wallet_approval_action: {
        attempted: true,
        status: 200,
        response: {
          status: "submitted_corewriter_approval",
          verified_corewriter_approval: false,
          tx_hash: "0xbeeb",
        },
      },
      trade_action: { attempted: false },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          runs: [
            {
              run_id: "run-json",
              workflow_id: 101,
              workflow_kind: "trading",
              status: "completed",
              started_at: 1_775_849_924,
              completed_at: 1_775_850_048,
              session_id: "direct-hyperliquid-fast-bot-1",
              transcript_available: false,
              trace_id: null,
              duration_ms: 128_000,
              input_tokens: 0,
              output_tokens: 0,
              result,
              error: null,
            },
          ],
          next_cursor: null,
        }),
      ),
    );

    render(
      <RunsTab
        botId="bot-1"
        botName="Trend Runner"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    expect(await screen.findByTestId("chat-transcript")).toBeInTheDocument();
    expect(screen.getByText(/Checked State/)).toBeInTheDocument();
    expect(screen.getAllByText(/Decision/).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(useBotSessionStreamMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sessionId: "direct-hyperliquid-fast-bot-1",
        }),
      );
    });
    expect(screen.getByTestId("chat-transcript")).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /decision inspector/i })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Decision/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/api-wallet-approval-not-verified/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/result_schema_version/)).not.toBeInTheDocument();
    expect(screen.queryByText("Transcript unavailable")).not.toBeInTheDocument();
  });

  it("renders observatory agentic reflection results as readable sections", async () => {
    const { RunsTab } = await import("../RunsTab");
    const result = JSON.stringify({
      agentic_reflection: {
        assistant_text:
          "**Observed**\nBot `harness-canary2` processed 1 world signal and executed 4 delegated work sessions.\n\n**Concern**\nDelegations produced zero strategy ideas.\n\n**Next safe action**\nInspect the research-to-idea conversion.",
        status: "completed",
        session_id: "ses_reflect_1",
        trace_id: "trace_reflect_1",
        input_tokens: 1200,
        output_tokens: 450,
        cost_usd: 0.015,
      },
      records: {
        reflection_runs: [
          {
            trigger: "manual",
            mode: "poke",
            conclusions: ["research is running"],
            uncertainties: ["idea synthesis is missing"],
            findings: [
              {
                severity: "warning",
                code: "NO_IDEAS",
                summary: "Delegated research did not become strategy output.",
              },
            ],
          },
        ],
        world_signal_digests: [{ id: "sig-1" }],
        ideas: [],
        research_tasks: [{ id: "task-1" }],
        delegated_work_sessions: [
          { summary: "Fetch ETH macro signal", status: "completed", source: "research" },
          { summary: "Check venue liquidity", status: "completed", source: "research" },
          { summary: "Compare drawdown constraints", status: "completed", source: "research" },
          { summary: "Inspect paper-trade gap", status: "running", source: "analysis" },
        ],
        delegation_pressure: {
          pressure_level: "low",
          active_sessions: 4,
          unique_sessions: 4,
          allows_new_delegation: true,
        },
        usage_summary: {
          reporting_status: "partial",
          event_count: 4,
          input_tokens: 1200,
          output_tokens: 450,
          total_tokens: 1650,
          cost_usd: 0.015,
          providers: ["openai"],
          models: ["gpt-5"],
        },
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          runs: [
            {
              run_id: "obs_902241ba89627d5da466",
              workflow_id: 404,
              workflow_kind: "observatory",
              status: "completed",
              started_at: 1_775_849_924,
              completed_at: 1_775_850_048,
              session_id: null,
              transcript_available: false,
              trace_id: "trace_reflect_1",
              duration_ms: 128_000,
              input_tokens: 1200,
              output_tokens: 450,
              result,
              error: null,
            },
          ],
          next_cursor: null,
        }),
      ),
    );

    render(
      <RunsTab
        botId="bot-1"
        botName="Trend Runner"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    expect(await screen.findByText(/Agentic Reflection/)).toBeInTheDocument();
    expect(screen.getByTestId("chat-transcript")).toBeInTheDocument();
    expect(screen.getByText(/Delegation Pressure/)).toBeInTheDocument();
    expect(screen.getByText(/Observatory Records/)).toBeInTheDocument();
    expect(screen.getAllByText(/processed 1 world signal/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Fetch ETH macro signal/)).toBeInTheDocument();
    expect(screen.queryByText(/agentic_reflection/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\{"agentic_reflection/)).not.toBeInTheDocument();
  });

  it("loads public run replay through the transcript surface without owner auth", async () => {
    const { RunsTab } = await import("../RunsTab");
    authState.token = null;
    authState.isAuthenticated = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          runs: [
            {
              run_id: "run-public-replay",
              workflow_id: 101,
              workflow_kind: "trading",
              status: "completed",
              started_at: 1_775_849_924,
              completed_at: 1_775_850_048,
              session_id: null,
              transcript_available: false,
              trace_id: null,
              duration_ms: 128_000,
              input_tokens: 0,
              output_tokens: 0,
              result: JSON.stringify({
                checked_state: { nav_status: "fresh" },
                decision: { action: "trade", reason: "rebalance" },
              }),
              error: null,
            },
          ],
          next_cursor: null,
        }),
      ),
    );

    render(
      <RunsTab
        botId="bot-1"
        botName="Trend Runner"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    expect((await screen.findAllByText(/Action: trade/i)).length).toBeGreaterThan(0);
    expect(screen.getByTestId("chat-transcript")).toBeInTheDocument();
    await waitFor(() => {
      expect(useBotSessionStreamMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          token: null,
          sessionId: "run-replay-run-public-replay",
          historyPath: "/runs/run-public-replay/messages?limit=200",
          streamEnabled: false,
        }),
      );
    });
    expect(screen.queryByText("Run history owner-only")).not.toBeInTheDocument();
  });

  it("uses stored ses run ids so the operator can recover archived transcripts", async () => {
    const { RunsTab } = await import("../RunsTab");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          runs: [
            {
              run_id: "run-with-sidecar-id",
              workflow_id: 101,
              workflow_kind: "trading",
              status: "completed",
              started_at: 1_775_849_924,
              completed_at: 1_775_849_924,
              session_id: "ses_1b67cbb3cffey7L46b5A1X15w6",
              transcript_available: true,
              trace_id: null,
              duration_ms: 60_000,
              input_tokens: 10,
              output_tokens: 6,
              result: "summary",
              error: null,
            },
          ],
          next_cursor: null,
        }),
      ),
    );

    render(
      <RunsTab
        botId="bot-1"
        botName="Trend Runner"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    expect((await screen.findAllByText("Trading Run")).length).toBeGreaterThan(
      0,
    );
    await waitFor(() => {
      expect(useBotSessionStreamMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sessionId: "ses_1b67cbb3cffey7L46b5A1X15w6",
        }),
      );
    });
  });

  it("replays archived run messages instead of streaming derived session ids", async () => {
    const { RunsTab } = await import("../RunsTab");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          runs: [
            {
              run_id: "run-transcript-archive",
              workflow_id: 101,
              workflow_kind: "trading",
              status: "completed",
              started_at: 1_775_849_924,
              completed_at: 1_775_849_984,
              session_id: null,
              transcript_available: true,
              trace_id: "trace-archive",
              duration_ms: 60_000,
              input_tokens: 10,
              output_tokens: 6,
              result: "archived summary",
              error: null,
            },
          ],
          next_cursor: null,
        }),
      ),
    );

    render(
      <RunsTab
        botId="bot-1"
        botName="Trend Runner"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    expect((await screen.findAllByText("Trading Run")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(useBotSessionStreamMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sessionId: "run-replay-run-transcript-archive",
          historyPath: "/runs/run-transcript-archive/messages?limit=200",
          streamEnabled: false,
        }),
      );
    });
  });

  it("uses a full-height shell without card chrome in immersive mode", async () => {
    const { RunsTab } = await import("../RunsTab");
    const result = JSON.stringify({
      checked_state: { nav_status: "fresh", total_nav_usdc: 11 },
      decision: { action: "trade", reason: "rsi-oversold" },
      trade_action: { attempted: true, execution_status: "paper_recorded" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          runs: [
            {
              run_id: "run-immersive",
              workflow_id: 101,
              workflow_kind: "trading",
              status: "completed",
              started_at: 1_775_849_924,
              completed_at: 1_775_849_984,
              session_id: null,
              transcript_available: false,
              trace_id: null,
              duration_ms: 60_000,
              input_tokens: 10,
              output_tokens: 6,
              result,
              error: null,
            },
          ],
          next_cursor: null,
        }),
      ),
    );

    const { container } = render(
      <RunsTab
        botId="bot-1"
        botName="Trend Runner"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
        immersive
      />,
      { wrapper: createWrapper() },
    );

    expect((await screen.findAllByText("rsi-oversold")).length).toBeGreaterThan(0);
    expect(screen.getByTestId("chat-transcript")).toBeInTheDocument();
    const shell = container.querySelector('[data-sandbox-ui="true"]');
    expect(shell).toHaveClass("h-full");
    expect(shell).not.toHaveClass("glass-card");
    expect(shell).not.toHaveClass("rounded-xl");
    expect(screen.getByLabelText("Autonomous runs")).toBeInTheDocument();
    expect(screen.queryByTestId("decision-activity-strip")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /decision inspector/i })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Decision/).length).toBeGreaterThan(0);
  });

  it("shows the immersive trace cockpit from run and tool evidence", async () => {
    const { RunsTab } = await import("../RunsTab");
    useBotSessionStreamMock.mockReturnValue({
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          time: { created: 1_775_850_000 },
        },
      ],
      partMap: {
        "assistant-1": [
          {
            type: "tool",
            id: "tool-fast-backtest",
            tool: "fast_backtest",
            state: "completed",
          },
          {
            type: "tool",
            id: "tool-risk-gate",
            tool: "risk_gate",
            state: "completed",
          },
        ],
      },
      isStreaming: false,
      connected: false,
      isReconnecting: false,
      attempt: 0,
      retryInSeconds: 0,
      error: null,
      refetch: streamRefetchMock,
    });
    const result = JSON.stringify({
      checked_state: {
        nav_status: "fresh",
        protocol: "hyperliquid",
      },
      decision: {
        action: "open_long",
        reason: "Breakout retest passed with liquidity inside the risk cap.",
        setup: {
          asset: "ETH-PERP",
          amount_in: "913",
        },
      },
      trade_action: {
        attempted: true,
        validation_status: "approved",
        execution_status: "paper_recorded",
        target_protocol: "hyperliquid",
        notional_usd: 913,
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          runs: [
            {
              run_id: "run-trace-cockpit",
              workflow_id: 101,
              workflow_kind: "trading",
              status: "completed",
              started_at: 1_775_849_924,
              completed_at: 1_775_850_052,
              session_id: null,
              transcript_available: false,
              trace_id: "trace-smoke-1",
              duration_ms: 128_000,
              input_tokens: 1_200,
              output_tokens: 576,
              result,
              error: null,
            },
          ],
          next_cursor: null,
        }),
      ),
    );

    render(
      <RunsTab
        botId="bot-1"
        botName="Trend Runner"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
        immersive
      />,
      { wrapper: createWrapper() },
    );

    const cockpit = await screen.findByRole("region", { name: /selected run summary/i });
    expect(cockpit).toHaveTextContent("Completed");
    expect(cockpit).toHaveTextContent("OPEN LONG");
    expect(cockpit).not.toHaveTextContent("Trading Trace");
    expect(cockpit).toHaveTextContent("ETH-PERP");
    expect(cockpit).toHaveTextContent("$913");
    expect(cockpit).toHaveTextContent("Breakout retest passed");
    expect(cockpit).toHaveTextContent("1.8k tok");
    expect(cockpit).toHaveTextContent("2 tools");
    expect(cockpit).toHaveTextContent("trace-smoke-1");
  });

  it("renders agentic run transcripts with tool call and reasoning evidence", async () => {
    const { RunsTab } = await import("../RunsTab");
    useBotSessionStreamMock.mockReturnValue({
      messages: [
        { id: "assistant-1", role: "assistant", time: { created: 1_775_850_000_000 } },
      ],
      partMap: {
        "assistant-1": [
          { type: "reasoning", text: "Momentum still positive, scaling in." },
          {
            type: "tool",
            id: "tool-1",
            tool: "fast_backtest",
            state: { status: "completed", input: {}, output: {} },
          },
          { type: "text", text: "Opened the position." },
        ],
      },
      isStreaming: false,
      connected: false,
      isReconnecting: false,
      attempt: 0,
      retryInSeconds: 0,
      error: null,
      refetch: streamRefetchMock,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          runs: [
            {
              run_id: "run-agentic-tools",
              workflow_id: 101,
              workflow_kind: "trading",
              status: "completed",
              started_at: 1_775_849_924,
              completed_at: 1_775_850_048,
              session_id: "ses-agentic-tools",
              transcript_available: true,
              trace_id: "trace-agentic",
              duration_ms: 128_000,
              input_tokens: 1_200,
              output_tokens: 480,
              result: "agentic summary",
              error: null,
              model: "glm-5.1",
              provider: "zai",
              cost_usd: 0.02,
              loop_mode: "agentic",
            },
          ],
          next_cursor: null,
        }),
      ),
    );

    render(
      <RunsTab
        botId="bot-1"
        botName="Trend Runner"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    expect(await screen.findByTestId("chat-transcript")).toBeInTheDocument();
    expect(screen.getByTestId("tool-part")).toHaveTextContent("fast_backtest");
    expect(
      screen.getByText("Momentum still positive, scaling in."),
    ).toBeInTheDocument();
    expect(screen.getByText("Opened the position.")).toBeInTheDocument();
  });

  it("renders deterministic tick runs as decisions and offers a context-seeded follow-up thread", async () => {
    const { RunsTab } = await import("../RunsTab");
    const result = JSON.stringify({
      checked_state: { nav_status: "fresh", total_nav_usdc: 10_000 },
      decision: { action: "skip", reason: "no-clear-entry-signal" },
      trade_action: { attempted: false },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          runs: [
            {
              run_id: "run-tick-decision",
              workflow_id: 101,
              workflow_kind: "trading",
              status: "completed",
              started_at: 1_775_849_924,
              completed_at: 1_775_849_926,
              session_id: null,
              transcript_available: false,
              trace_id: null,
              duration_ms: 2_000,
              input_tokens: 0,
              output_tokens: 0,
              result,
              error: null,
              model: null,
              provider: null,
              cost_usd: null,
              loop_mode: "deterministic",
            },
          ],
          next_cursor: null,
        }),
      ),
    );

    render(
      <RunsTab
        botId="bot-1"
        botName="Trend Runner"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    expect(
      (await screen.findAllByText(/no-clear-entry-signal/)).length,
    ).toBeGreaterThan(0);
    // Honest continuation labeling: no live session to resume.
    expect(
      screen.getByText(
        "This run kept no live agent session — replies start a follow-up thread seeded with the saved run record.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("composer-send")).toBeInTheDocument();
  });

  it("keeps the composer for unauthenticated viewers and surfaces the server rejection", async () => {
    authState.token = null;
    authState.isAuthenticated = false;

    const { RunsTab } = await import("../RunsTab");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/runs/run-anon/messages")) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (url.includes("/runs?limit=100")) {
        return jsonResponse({
          runs: [
            {
              run_id: "run-anon",
              workflow_id: 101,
              workflow_kind: "trading",
              status: "completed",
              started_at: 1_775_824_500,
              completed_at: 1_775_824_560,
              session_id: null,
              transcript_available: false,
              trace_id: null,
              duration_ms: 60_000,
              input_tokens: 10,
              output_tokens: 6,
              result: "public result",
              error: null,
            },
          ],
          next_cursor: null,
        });
      }

      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <RunsTab
        botId="bot-1"
        botName="Trend Runner"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    // Composer stays visible without authentication, with honest copy.
    const sendButton = await screen.findByTestId("composer-send");
    expect(
      screen.getByText(
        "Anyone can read this run. Sending a message requires the creator wallet.",
      ),
    ).toBeInTheDocument();

    await userEvent.click(sendButton);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Connect the creator wallet to talk to this agent.",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:9201/api/bots/bot-1/runs/run-anon/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "test message" }),
      }),
    );
  });

  it("continues a permitted conversation through the run messages endpoint", async () => {
    const { RunsTab } = await import("../RunsTab");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/runs/run-owner/messages")) {
        return jsonResponse({
          ok: true,
          run_id: "run-owner",
          session_id: "ses-owner-run",
          mode: "resumed",
          status: "accepted",
        });
      }
      if (url.includes("/runs?limit=100")) {
        return jsonResponse({
          runs: [
            {
              run_id: "run-owner",
              workflow_id: 101,
              workflow_kind: "trading",
              status: "completed",
              started_at: 1_775_824_500,
              completed_at: 1_775_824_560,
              session_id: "ses-owner-run",
              transcript_available: true,
              trace_id: null,
              duration_ms: 60_000,
              input_tokens: 900,
              output_tokens: 120,
              result: "owner result",
              error: null,
              model: "glm-5.1",
              provider: "zai",
              cost_usd: 0.01,
              loop_mode: "agentic",
            },
          ],
          next_cursor: null,
        });
      }

      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <RunsTab
        botId="bot-1"
        botName="Trend Runner"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    expect(
      await screen.findByText("Replies continue this run's original agent session."),
    ).toBeInTheDocument();

    await userEvent.click(await screen.findByTestId("composer-send"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:9201/api/bots/bot-1/runs/run-owner/messages",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
          }),
          body: JSON.stringify({ message: "test message" }),
        }),
      );
    });
    expect(
      await screen.findByText(
        /Continuing run run-owner in its original agent session/,
      ),
    ).toBeInTheDocument();
    expect(streamRefetchMock).toHaveBeenCalled();
  });
});
