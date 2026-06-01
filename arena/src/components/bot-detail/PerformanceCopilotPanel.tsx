import { useCallback, useMemo, useState } from 'react';
import {
  useCreateSession,
  useSessions,
} from '@tangle-network/sandbox-ui/hooks';
import type { AgentBranding } from '@tangle-network/sandbox-ui/types';
import { ChatTranscript } from '~/components/bot-detail/chat/ChatTranscript';
import { useBotSessionStream } from '~/lib/hooks/useBotSessionStream';
import {
  buildBotScopedPathForDeploymentKind,
  getDeploymentKindForOperatorKind,
  useOperatorMeta,
} from '~/lib/operator/meta';
import { normalizeSessionList } from '~/lib/sandboxSessions';
import type { BotOperatorKind } from '~/lib/types/bot';

interface PerformanceCopilotPanelProps {
  botId: string;
  botName: string;
  operatorApiUrl?: string | null;
  operatorKind?: BotOperatorKind;
  token: string;
}

const PERFORMANCE_COPILOT_BRANDING: AgentBranding = {
  label: 'Copilot',
  accentClass: 'text-emerald-700 dark:text-emerald-300',
  bgClass: 'bg-emerald-500/8',
  containerBgClass: 'bg-arena-elements-background-depth-2/30',
  borderClass: 'border-emerald-500/20',
  iconClass: 'i-ph:brain',
  textClass: 'text-emerald-700 dark:text-emerald-300',
};

function formatPanelError(error: unknown): string | null {
  if (!error) return null;
  const raw = error instanceof Error ? error.message : String(error);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string }; message?: string };
    return parsed.error?.message ?? parsed.message ?? raw;
  } catch {
    return raw;
  }
}

export function PerformanceCopilotPanel({
  botId,
  botName,
  operatorApiUrl,
  operatorKind,
  token,
}: PerformanceCopilotPanelProps) {
  const [sendError, setSendError] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState(`trading-${botId}`);
  const baseApiUrl = operatorApiUrl ?? '';
  const { data: operatorMeta } = useOperatorMeta(baseApiUrl);
  const deploymentKind = getDeploymentKindForOperatorKind(operatorKind);
  const apiUrl = operatorMeta && baseApiUrl
    ? `${baseApiUrl}${buildBotScopedPathForDeploymentKind(deploymentKind, botId)}`
    : '';
  const primarySessionId = `trading-${botId}`;
  const { data: rawSessions } = useSessions(apiUrl, token);
  const sessions = useMemo(() => normalizeSessionList(rawSessions), [rawSessions]);
  const createSession = useCreateSession(apiUrl, token);
  const hasActiveSession = sessions.some((session) => session.id === activeSessionId);
  const streamSessionId = hasActiveSession
    ? activeSessionId
    : sessions.find((session) => session.id === primarySessionId)?.id
      ?? sessions[0]?.id
      ?? activeSessionId;
  const stream = useBotSessionStream({
    apiUrl,
    token,
    sessionId: streamSessionId,
    enabled: Boolean(apiUrl && token),
    cacheKey: `${baseApiUrl}::${botId}::performance-copilot`,
    streamEnabled: true,
  });
  const panelError = formatPanelError(sendError ?? stream.error);

  const handleSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setSendError(null);

      const existingSessionId = sessions.some((session) => session.id === streamSessionId)
        ? streamSessionId
        : null;

      try {
        if (existingSessionId && existingSessionId === streamSessionId) {
          await stream.send(trimmed);
          return;
        }

        const created = await createSession.mutateAsync('Performance Copilot');
        setActiveSessionId(created.id);
        const response = await fetch(
          `${apiUrl}/session/sessions/${encodeURIComponent(created.id)}/messages`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            credentials: 'include',
            body: JSON.stringify({ parts: [{ type: 'text', text: trimmed }] }),
          },
        );

        if (!response.ok) {
          throw new Error((await response.text()) || `Failed to send message: ${response.status}`);
        }
      } catch (error) {
        setSendError(error instanceof Error ? error.message : 'Failed to send message');
      }
    },
    [apiUrl, createSession, sessions, stream, streamSessionId, token],
  );

  return (
    <div className="glass-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl">
      <div className="shrink-0 border-b border-arena-elements-dividerColor/50 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate font-display text-lg font-semibold text-arena-elements-textPrimary">
              Copilot
            </h3>
            <div className="mt-0.5 truncate text-xs font-data text-arena-elements-textTertiary">
              {botName}
            </div>
          </div>
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              stream.isStreaming ? 'animate-pulse bg-amber-400' : 'bg-emerald-500'
            }`}
            aria-label={stream.isStreaming ? 'Copilot running' : 'Copilot idle'}
          />
        </div>
        {panelError && (
          <div className="mt-2 truncate rounded-md border border-crimson-500/20 bg-crimson-500/5 px-2 py-1 text-xs text-crimson-600 dark:text-crimson-300">
            {panelError}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 bg-arena-elements-background-depth-1/15">
        <ChatTranscript
          messages={stream.messages}
          partMap={stream.partMap}
          isStreaming={stream.isStreaming}
          onSend={handleSend}
          branding={PERFORMANCE_COPILOT_BRANDING}
          placeholder={`Ask ${botName} about this chart...`}
        />
      </div>
    </div>
  );
}
