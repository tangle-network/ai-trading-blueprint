import { render, screen, waitFor } from "@testing-library/react";
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

const useBotSessionStreamMock = vi.hoisted(() =>
  vi.fn(() => ({
    messages: [],
    partMap: new Map(),
    isStreaming: false,
    error: null,
  })),
);

const chatTranscriptMock = vi.hoisted(() =>
  vi.fn(() => <div data-testid="chat-transcript" />),
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
    useBotSessionStreamMock.mockClear();
    chatTranscriptMock.mockClear();

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

    expect((await screen.findAllByText("Trading Trace")).length).toBeGreaterThan(
      0,
    );
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
    expect(await screen.findByText("Research Trace")).toBeInTheDocument();
    expect(screen.getByTestId("chat-transcript")).toBeInTheDocument();
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

    expect(await screen.findByTestId("chat-transcript")).toBeInTheDocument();
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
    expect(await screen.findByTestId("chat-transcript")).toBeInTheDocument();
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

    expect(await screen.findByTestId("chat-transcript")).toBeInTheDocument();
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

  it("replays saved trading run JSON through the chat transcript when no full transcript was captured", async () => {
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
    await waitFor(() => {
      expect(useBotSessionStreamMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sessionId: "direct-hyperliquid-fast-bot-1",
        }),
      );
    });
    expect(screen.queryByText("Trading run details")).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: /decision inspector/i })).toBeInTheDocument();
    expect(screen.getByText("Decision")).toBeInTheDocument();
    expect(screen.getAllByText("api-wallet-approval-not-verified").length).toBeGreaterThan(0);
    expect(screen.queryByText(/result_schema_version/)).not.toBeInTheDocument();
    expect(screen.queryByText("Transcript unavailable")).not.toBeInTheDocument();
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

    expect(await screen.findByTestId("chat-transcript")).toBeInTheDocument();
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

    expect((await screen.findAllByText("Trading Trace")).length).toBeGreaterThan(
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

  it("uses a full-height shell without card chrome in immersive mode", async () => {
    const { RunsTab } = await import("../RunsTab");
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
              result: "summary",
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

    expect(await screen.findByTestId("chat-transcript")).toBeInTheDocument();
    const shell = container.querySelector('[data-sandbox-ui="true"]');
    expect(shell).toHaveClass("h-full");
    expect(shell).not.toHaveClass("glass-card");
    expect(shell).not.toHaveClass("rounded-xl");
    expect(screen.queryByRole("complementary", { name: /decision inspector/i })).not.toBeInTheDocument();
  });
});
