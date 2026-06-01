import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWrapper } from "~/test/mocks";

const authState = {
  token: "test-token",
  isAuthenticated: true,
  isAuthenticating: false,
  authenticate: vi.fn(),
  error: null as string | null,
  authCacheKey: "test-token",
  getCachedToken: () => "test-token" as string | null,
  getToken: vi.fn(async () => "test-token"),
};

vi.mock("~/lib/hooks/useOperatorAuth", () => ({
  useOperatorAuth: () => authState,
}));

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("RevisionArenaTab", () => {
  beforeEach(() => {
    authState.token = "test-token";
    authState.authCacheKey = "test-token";
    authState.getCachedToken = () => "test-token";
    authState.isAuthenticated = true;
    authState.isAuthenticating = false;
    authState.error = null;
    authState.authenticate.mockReset();
    authState.getToken.mockClear();
  });

  it("renders revision zero and candidate capability state", async () => {
    const { RevisionArenaTab } = await import("../RevisionArenaTab");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe(
          "http://localhost:9201/api/bots/bot-1/evolution/revision-arena",
        );
        return jsonResponse({
          bot_id: "bot-1",
          invariant:
            "Only the active live/canary revision may touch execution keys or vault funds; candidate revisions are paper, shadow, backtest, or research only.",
          active_revision_id: "rev-0",
          live_revision_id: null,
          revisions: [
            {
              revision_id: "rev-0",
              display_name: "Revision 0",
              source: "initial_baseline",
              status: "active",
              run_mode: "paper",
              can_execute_live: false,
              parent_revision_id: null,
              run_id: null,
              created_at: null,
              user_intent:
                "Initial activated bot code, config, prompt, and memory baseline.",
              patch_sha256: null,
              files_changed: [],
              tests: [],
              promotion_approved: true,
              promotion_blockers: [],
              paper_evidence: null,
            },
            {
              revision_id: "sr-1",
              display_name: "Revision 1",
              source: "mcp_candidate",
              status: "blocked",
              run_mode: "research",
              can_execute_live: false,
              parent_revision_id: "rev-0",
              run_id: "sir-1",
              created_at: "2026-05-20T10:00:00Z",
              user_intent: "Add a safer paper-only strategy change.",
              patch_sha256: "sha256:abcdef1234567890",
              files_changed: ["strategy.rs"],
              tests: ["cargo test -p trading-runtime --lib"],
              promotion_approved: false,
              promotion_blockers: ["missing persisted paper trading evidence"],
              paper_evidence: null,
            },
          ],
          modes: [
            {
              mode: "live",
              can_touch_funds: true,
              description: "Active approved revision with normal execution authority.",
            },
            {
              mode: "paper",
              can_touch_funds: false,
              description: "Paper ledger execution only.",
            },
          ],
        });
      }),
    );

    render(
      <RevisionArenaTab
        botId="bot-1"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    expect(await screen.findByText("Evolution Arena")).toBeInTheDocument();
    expect(screen.getAllByText("Revision 0").length).toBeGreaterThan(0);
    expect(screen.getByText("Revision 1")).toBeInTheDocument();
    expect(screen.getByText("missing persisted paper trading evidence")).toBeInTheDocument();
    expect(screen.getByText("strategy.rs")).toBeInTheDocument();
    expect(screen.getAllByText("none").length).toBeGreaterThan(0);
  });

  it("shows fleet revisions publicly without exposing approval controls", async () => {
    authState.isAuthenticated = false;
    authState.token = "";
    authState.authCacheKey = "anonymous";
    authState.getCachedToken = () => null;
    const { RevisionArenaTab } = await import("../RevisionArenaTab");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          bot_id: "bot-1",
          invariant: "Only approved revisions can touch funds.",
          active_revision_id: "rev-0",
          live_revision_id: null,
          revisions: [
            {
              revision_id: "mcp-sr-1",
              display_name: "Candidate 1",
              source: "self-improvement-mcp",
              status: "candidate",
              run_mode: "paper",
              can_execute_live: false,
              parent_revision_id: "rev-0",
              run_id: "sr-1",
              created_at: "2026-05-20T10:00:00Z",
              user_intent: "Improve the strategy after backtesting.",
              patch_sha256: "sha256:abcdef1234567890",
              files_changed: ["strategy.rs"],
              tests: ["cargo test"],
              promotion_approved: false,
              promotion_blockers: [],
              paper_evidence: null,
            },
          ],
          modes: [],
        }),
      ),
    );

    render(
      <RevisionArenaTab
        botId="bot-1"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    expect(await screen.findByText("Evolution Arena")).toBeInTheDocument();
    expect(screen.getByText("Candidate 1")).toBeInTheDocument();
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
    expect(screen.queryByText("Reject")).not.toBeInTheDocument();

    authState.token = "test-token";
    authState.authCacheKey = "test-token";
    authState.getCachedToken = () => "test-token";
  });

  it("hides raw authorization errors when public revision reads are denied", async () => {
    authState.isAuthenticated = false;
    authState.token = "";
    authState.authCacheKey = "anonymous";
    authState.getCachedToken = () => null;
    const { RevisionArenaTab } = await import("../RevisionArenaTab");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("Missing Authorization header", { status: 401 }),
      ),
    );

    render(
      <RevisionArenaTab
        botId="bot-1"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    expect(await screen.findByText("Revision arena owner-only")).toBeInTheDocument();
    expect(screen.queryByText("Missing Authorization header")).not.toBeInTheDocument();
  });

  it("lets the user approve or reject candidate revisions", async () => {
    const { RevisionArenaTab } = await import("../RevisionArenaTab");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        expect(url).toBe(
          "http://localhost:9201/api/bots/bot-1/evolution/revision-arena/decision",
        );
        expect(JSON.parse(String(init.body))).toMatchObject({
          revision_id: "mcp-sr-1",
          action: "approve",
          confirm_live: true,
        });
        return jsonResponse({ status: "canary_promoted" });
      }
      return jsonResponse({
        bot_id: "bot-1",
        invariant:
          "Only the active approved revision may touch execution keys or vault funds.",
        active_revision_id: "rev-0",
        live_revision_id: null,
        revisions: [
          {
            revision_id: "mcp-sr-1",
            display_name: "Candidate 1",
            source: "self-improvement-mcp",
            status: "candidate",
            run_mode: "paper",
            can_execute_live: false,
            parent_revision_id: "rev-0",
            run_id: "sr-1",
            created_at: "2026-05-20T10:00:00Z",
            user_intent: "Improve the strategy after backtesting.",
            patch_sha256: "sha256:abcdef1234567890",
            files_changed: ["strategy.rs"],
            tests: ["cargo test"],
            promotion_approved: false,
            promotion_blockers: ["User approval can stage this candidate."],
            paper_evidence: {
              trades: 12,
              total_return_pct: 3.4,
              max_drawdown_pct: 1.2,
            },
          },
        ],
        modes: [],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <RevisionArenaTab
        botId="bot-1"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(await screen.findByText("Approve"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:9201/api/bots/bot-1/evolution/revision-arena/decision",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(screen.getByText("Reject")).toBeInTheDocument();
  });
});
