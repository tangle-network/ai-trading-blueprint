import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWrapper } from "~/test/mocks";

const authState = {
  token: "test-token",
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

vi.mock("~/lib/hooks/useOperatorAuth", () => ({
  useOperatorAuth: () => authState,
}));

vi.mock("~/lib/hooks/useBotSessionStream", () => ({
  useBotSessionStream: useBotSessionStreamMock,
}));

vi.mock("~/components/bot-detail/chat/ChatTranscript", () => ({
  ChatTranscript: () => <div data-testid="chat-transcript" />,
}));

vi.mock("../chat/ChatTranscript", () => ({
  ChatTranscript: () => <div data-testid="chat-transcript" />,
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
    expect(screen.getByText("latest result")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /load older/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:9201/api/bots/bot-1/runs?limit=100&cursor=1775824500%3Arun-new",
        expect.objectContaining({
          headers: {
            Authorization: "Bearer test-token",
          },
        }),
      );
    });
    expect(await screen.findByText("Research Run")).toBeInTheDocument();
    expect(screen.getByText("latest result")).toBeInTheDocument();
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
});
