import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWrapper } from "~/test/mocks";

const authState = {
  token: null as string | null,
  isAuthenticated: false,
  isAuthenticating: false,
  authenticate: vi.fn(),
};

const useBotSessionStreamMock = vi.hoisted(() =>
  vi.fn(() => ({
    messages: [],
    partMap: {},
    isStreaming: false,
    connected: false,
    error: null as string | null,
    refetch: vi.fn(),
    send: vi.fn(),
    abort: vi.fn(),
  })),
);

const chatTranscriptMock = vi.hoisted(() =>
  vi.fn((props: { onSend?: unknown }) => (
    <div data-testid="chat-transcript">
      {props.onSend ? "write-enabled" : "read-visible"}
    </div>
  )),
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

vi.mock("@tangle-network/sandbox-ui/hooks", () => ({
  useSessions: () => ({ data: [] }),
  useCreateSession: () => ({ mutateAsync: vi.fn() }),
  useDeleteSession: () => ({ mutate: vi.fn() }),
  useRenameSession: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));

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

describe("ChatTab", () => {
  beforeEach(() => {
    authState.token = null;
    authState.isAuthenticated = false;
    authState.isAuthenticating = false;
    authState.authenticate.mockReset();
    useBotSessionStreamMock.mockClear();
    chatTranscriptMock.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ runs: [], next_cursor: null })),
    );

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

  it("uses the latest replayable autonomous run for public read-only chat", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        runs: [
          {
            run_id: "run-public-trace",
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
            result: "placed paper trade",
            error: null,
          },
        ],
        next_cursor: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { ChatTab } = await import("../ChatTab");

    render(
      <ChatTab
        botId="bot-1"
        botName="Trend Runner"
        operatorAddress="0x0000000000000000000000000000000000000001"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    expect(await screen.findByTestId("chat-transcript")).toHaveTextContent(
      "read-visible",
    );

    await waitFor(() => {
      expect(useBotSessionStreamMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          token: null,
          sessionId: "run-replay-run-public-trace",
          historyPath: "/runs/run-public-trace/messages?limit=200",
          streamEnabled: false,
          enabled: true,
        }),
      );
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:9201/api/bots/bot-1/runs?limit=25",
    );
  });

  it("keeps the public transcript visible without wallet authentication", async () => {
    const { ChatTab } = await import("../ChatTab");

    render(
      <ChatTab
        botId="bot-1"
        botName="Trend Runner"
        operatorAddress="0x0000000000000000000000000000000000000001"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    expect(await screen.findByTestId("chat-transcript")).toHaveTextContent(
      "read-visible",
    );
    expect(screen.queryByText(/chat stays disabled/i)).not.toBeInTheDocument();

    await waitFor(() => {
      expect(useBotSessionStreamMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          token: null,
          sessionId: "trading-bot-1",
          historyPath:
            "/session/sessions/trading-bot-1/messages?limit=200",
          streamEnabled: false,
          enabled: true,
        }),
      );
    });
  });

  it("does not show auth-only history errors to public readers", async () => {
    useBotSessionStreamMock.mockReturnValueOnce({
      messages: [],
      partMap: {},
      isStreaming: false,
      connected: false,
      error: "HTTP 401:",
      refetch: vi.fn(),
      send: vi.fn(),
      abort: vi.fn(),
    });
    const { ChatTab } = await import("../ChatTab");

    render(
      <ChatTab
        botId="bot-1"
        botName="Trend Runner"
        operatorAddress="0x0000000000000000000000000000000000000001"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    expect(await screen.findByTestId("chat-transcript")).toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(screen.queryByText("HTTP 401:")).not.toBeInTheDocument();
  });

  it("does not enable writes for authenticated non-commandable viewers", async () => {
    authState.isAuthenticated = true;
    authState.token = "owner-token";
    const { ChatTab } = await import("../ChatTab");

    render(
      <ChatTab
        botId="bot-1"
        botName="Trend Runner"
        operatorAddress="0x0000000000000000000000000000000000000001"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
      />,
      { wrapper: createWrapper() },
    );

    expect(await screen.findByTestId("chat-transcript")).toHaveTextContent(
      "read-visible",
    );
    expect(screen.queryByRole("button", { name: /new chat/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /owner sign in/i })).not.toBeInTheDocument();
  });

  it("enables writes for commandable authenticated viewers", async () => {
    authState.isAuthenticated = true;
    authState.token = "owner-token";
    const { ChatTab } = await import("../ChatTab");

    render(
      <ChatTab
        botId="bot-1"
        botName="Trend Runner"
        operatorAddress="0x0000000000000000000000000000000000000001"
        operatorApiUrl="http://localhost:9201"
        operatorKind="cloud"
        verificationState="authoritative"
        canCommand
      />,
      { wrapper: createWrapper() },
    );

    expect(await screen.findByTestId("chat-transcript")).toHaveTextContent(
      "write-enabled",
    );
    expect(screen.getByRole("button", { name: /new chat/i })).toBeInTheDocument();
  });
});
