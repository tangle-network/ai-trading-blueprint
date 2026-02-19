import { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChatContainer, useSessionStream,
  useSessions, useCreateSession, useDeleteSession, useRenameSession,
  type AgentBranding, type SessionInfo, type Session,
} from '@tangle/agent-ui';
import { Button } from '@tangle/blueprint-ui/components';
import { AuthBanner } from '~/components/bot-detail/AuthBanner';
import { useWagmiSidecarAuth } from '@tangle/blueprint-ui';
import { getApiUrlForBot } from '~/lib/config/botRegistry';

interface ChatTabProps {
  botId: string;
  botName: string;
  operatorAddress: string;
}

// ── Branding ────────────────────────────────────────────────────────────

const TRADING_BRANDING: AgentBranding = {
  label: 'Trading Agent',
  accentClass: 'text-emerald-400',
  bgClass: 'bg-emerald-500/5',
  containerBgClass: 'bg-neutral-950/60',
  borderClass: 'border-emerald-500/20',
  iconClass: 'i-ph:chart-line-up',
  textClass: 'text-emerald-400',
};

// ── Agent Status ────────────────────────────────────────────────────────

function AgentStatus({ status, onAbort, isAborting }: {
  status: 'idle' | 'running' | 'error';
  onAbort: () => void;
  isAborting: boolean;
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 border-t border-arena-elements-dividerColor bg-arena-elements-background-depth-3/50 dark:bg-arena-elements-background-depth-4/50">
      <span className={`w-2 h-2 rounded-full ${
        status === 'running' ? 'bg-amber-400 animate-pulse' : status === 'error' ? 'bg-crimson-400' : 'bg-emerald-700 dark:bg-emerald-400'
      }`} />
      <span className="text-xs font-data text-arena-elements-textSecondary">
        {status === 'running' ? 'Agent working...' : status === 'error' ? 'Agent error' : 'Agent idle'}
      </span>
      {status === 'running' && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onAbort}
          disabled={isAborting}
          className="ml-auto text-xs h-6 px-2"
        >
          <span className="i-ph:stop-circle text-sm mr-1" />
          {isAborting ? 'Stopping...' : 'Stop'}
        </Button>
      )}
    </div>
  );
}

// ── Session Selector ────────────────────────────────────────────────────

interface SessionItem {
  id: string;
  title: string;
}

function SessionSelector({ sessions, activeSessionId, primarySessionId, onSelect, onDelete, onRename, onCreate }: {
  sessions: SessionItem[];
  activeSessionId: string;
  primarySessionId: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onCreate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');

  const activeSession = sessions.find(s => s.id === activeSessionId);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-arena-elements-borderColor hover:border-arena-elements-borderColorActive/40 transition-colors text-sm cursor-pointer"
      >
        <span className="i-ph:chat-dots text-arena-elements-textTertiary" />
        <span className="font-data text-arena-elements-textPrimary truncate max-w-[200px]">
          {activeSession?.id === primarySessionId ? 'Main Session' : activeSession?.title ?? activeSessionId}
        </span>
        <span className={`i-ph:caret-down text-arena-elements-textTertiary transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute top-full left-0 mt-1 w-72 rounded-xl border border-arena-elements-borderColor bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-4 shadow-xl z-50 overflow-hidden"
          >
            <div className="max-h-60 overflow-y-auto">
              {sessions.map(s => (
                <div
                  key={s.id}
                  className={`flex items-center gap-2 px-3 py-2 hover:bg-arena-elements-item-backgroundHover transition-colors ${
                    s.id === activeSessionId ? 'bg-arena-elements-item-backgroundActive' : ''
                  }`}
                >
                  {editingId === s.id ? (
                    <input
                      className="flex-1 text-sm bg-transparent border-b border-arena-elements-borderColor outline-none text-arena-elements-textPrimary font-data"
                      value={editTitle}
                      onChange={e => setEditTitle(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          onRename(s.id, editTitle);
                          setEditingId(null);
                        } else if (e.key === 'Escape') {
                          setEditingId(null);
                        }
                      }}
                      onBlur={() => {
                        onRename(s.id, editTitle);
                        setEditingId(null);
                      }}
                      autoFocus
                    />
                  ) : (
                    <button
                      className="flex-1 text-left text-sm font-data text-arena-elements-textPrimary truncate cursor-pointer"
                      onClick={() => { onSelect(s.id); setOpen(false); }}
                    >
                      {s.id === primarySessionId ? 'Main Session' : s.title || s.id}
                    </button>
                  )}
                  {s.id !== primarySessionId && editingId !== s.id && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => { setEditingId(s.id); setEditTitle(s.title || s.id); }}
                        className="text-arena-elements-textTertiary hover:text-arena-elements-textSecondary p-0.5 cursor-pointer"
                        title="Rename"
                      >
                        <span className="i-ph:pencil-simple text-xs" />
                      </button>
                      <button
                        onClick={() => onDelete(s.id)}
                        className="text-arena-elements-textTertiary hover:text-crimson-400 p-0.5 cursor-pointer"
                        title="Delete"
                      >
                        <span className="i-ph:trash text-xs" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="border-t border-arena-elements-dividerColor">
              <button
                onClick={() => { onCreate(); setOpen(false); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm font-data text-violet-700 dark:text-violet-400 hover:bg-arena-elements-item-backgroundHover transition-colors cursor-pointer"
              >
                <span className="i-ph:plus text-sm" />
                New Session
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Main Chat Tab ───────────────────────────────────────────────────────

export function ChatTab({ botId, botName, operatorAddress }: ChatTabProps) {
  const apiUrl = getApiUrlForBot(botId) ?? '';
  const { token, isAuthenticated, isAuthenticating, authenticate, error: authError } = useWagmiSidecarAuth(botId, apiUrl);

  const primarySessionId = `trading-${botId}`;
  const [activeSessionId, setActiveSessionId] = useState(primarySessionId);
  const [isAborting, setIsAborting] = useState(false);

  // Session CRUD hooks
  const { data: sessions = [] } = useSessions(apiUrl, token);
  const deleteMutation = useDeleteSession(apiUrl, token);
  const renameMutation = useRenameSession(apiUrl, token);
  const createMutation = useCreateSession(apiUrl, token);

  // agent-ui streaming hook — replaces manual SSE + message state
  const stream = useSessionStream({
    apiUrl,
    token,
    sessionId: activeSessionId,
    enabled: isAuthenticated && !!apiUrl,
  });

  const agentStatus = stream.isStreaming ? 'running' : stream.error ? 'error' : 'idle';

  const handleAbort = useCallback(async () => {
    setIsAborting(true);
    await stream.abort();
    setIsAborting(false);
  }, [stream]);

  // Map session data to simple items for the selector
  const sessionItems: SessionItem[] = sessions.length > 0
    ? sessions.map((s: Session) => ({ id: s.id, title: s.title }))
    : [{ id: primarySessionId, title: 'Main Session' }];

  if (!apiUrl) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:chat-slash text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
        No API configured for this bot. Chat requires a running bot API.
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <AuthBanner
        onAuth={authenticate}
        isAuthenticating={isAuthenticating}
        error={authError}
      />
    );
  }

  return (
    <div className="glass-card rounded-xl overflow-hidden flex flex-col" style={{ height: 'calc(100vh - 400px)', minHeight: '480px' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-arena-elements-dividerColor">
        <SessionSelector
          sessions={sessionItems}
          activeSessionId={activeSessionId}
          primarySessionId={primarySessionId}
          onSelect={setActiveSessionId}
          onDelete={(id) => {
            if (confirm('Delete this session?')) {
              deleteMutation.mutate(id);
              if (id === activeSessionId) setActiveSessionId(primarySessionId);
            }
          }}
          onRename={(id, title) => renameMutation.mutate({ sessionId: id, title })}
          onCreate={() => {
            createMutation.mutate(`Session ${sessions.length + 1}`, {
              onSuccess: (session) => setActiveSessionId(session.id),
            });
          }}
        />
      </div>

      {/* Message area — @tangle/agent-ui ChatContainer */}
      <ChatContainer
        messages={stream.messages}
        partMap={stream.partMap}
        isStreaming={stream.isStreaming}
        onSend={stream.send}
        branding={TRADING_BRANDING}
        placeholder={stream.isStreaming ? 'Agent is working...' : `Message ${botName}...`}
        className="flex-1 min-h-0"
      />

      {/* Agent status bar */}
      <AgentStatus
        status={agentStatus}
        onAbort={handleAbort}
        isAborting={isAborting}
      />
    </div>
  );
}
