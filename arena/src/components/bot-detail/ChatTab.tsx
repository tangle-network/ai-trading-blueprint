import { useState, useRef, useEffect, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { motion, AnimatePresence } from 'framer-motion';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { useSessionAuth } from '~/lib/hooks/useSessionAuth';
import { useSessions, useMessages, useSendMessage, useAbortExecution, useDeleteSession, useRenameSession, useCreateSession } from '~/lib/hooks/useSessionApi';
import { useSessionEvents, type SessionEvent } from '~/lib/hooks/useSessionEvents';
import type { Message, MessagePart, Session } from '~/lib/types/session';
import { getApiUrlForBot } from '~/lib/config/botRegistry';

interface ChatTabProps {
  botId: string;
  botName: string;
  operatorAddress: string;
}

// ── Auth Banner ─────────────────────────────────────────────────────────

function AuthBanner({ onAuth, isAuthenticating, error }: {
  onAuth: () => void;
  isAuthenticating: boolean;
  error: string | null;
}) {
  const { isConnected } = useAccount();

  return (
    <div className="glass-card rounded-xl p-6 text-center">
      <div className="i-ph:lock-key text-3xl text-arena-elements-textTertiary mb-3 mx-auto" />
      <h3 className="font-display font-semibold text-lg mb-2">Chat with your agent</h3>
      <p className="text-sm text-arena-elements-textSecondary mb-4">
        {isConnected
          ? 'Sign a message to verify you own this bot and start chatting.'
          : 'Connect your wallet to chat with this bot\'s AI agent.'}
      </p>
      {error && (
        <p className="text-sm text-crimson-400 mb-3">{error}</p>
      )}
      <Button
        onClick={onAuth}
        disabled={!isConnected || isAuthenticating}
        variant="default"
      >
        {isAuthenticating ? (
          <>
            <span className="i-ph:arrow-clockwise text-sm animate-spin mr-1.5" />
            Signing...
          </>
        ) : isConnected ? (
          <>
            <span className="i-ph:signature text-sm mr-1.5" />
            Connect &amp; Sign
          </>
        ) : (
          'Connect Wallet First'
        )}
      </Button>
    </div>
  );
}

// ── Chat Message ────────────────────────────────────────────────────────

function ChatMessage({ message, isStreaming }: { message: Message; isStreaming?: boolean }) {
  const isUser = message.info.role === 'user';
  const isSystem = message.source === 'system' && message.info.role === 'user';
  const isAssistant = message.info.role === 'assistant';

  const sourceBadge = message.source === 'owner'
    ? <Badge variant="success" className="text-[10px] py-0">You</Badge>
    : isAssistant
    ? <Badge variant="accent" className="text-[10px] py-0">Agent</Badge>
    : <Badge variant="secondary" className="text-[10px] py-0">System</Badge>;

  const timestamp = new Date(message.info.timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`flex ${isUser && message.source === 'owner' ? 'justify-end' : 'justify-start'}`}
    >
      <div className={`max-w-[85%] ${
        isUser && message.source === 'owner'
          ? 'bg-violet-500/10 border-violet-500/20'
          : 'bg-arena-elements-background-depth-2 border-arena-elements-borderColor'
      } rounded-xl border px-4 py-3`}>
        <div className="flex items-center gap-2 mb-1.5">
          {sourceBadge}
          <span className="text-[10px] font-data text-arena-elements-textTertiary">{timestamp}</span>
        </div>
        <div className="space-y-2">
          {message.parts.map((part, i) => (
            <MessagePartView key={i} part={part} />
          ))}
          {isStreaming && (
            <span className="inline-block w-1.5 h-4 bg-violet-400 animate-pulse rounded-sm ml-0.5" />
          )}
        </div>
      </div>
    </motion.div>
  );
}

function MessagePartView({ part }: { part: MessagePart }) {
  const [toolExpanded, setToolExpanded] = useState(false);

  if (part.type === 'text' && part.text) {
    return (
      <p className="text-sm text-arena-elements-textPrimary leading-relaxed whitespace-pre-wrap break-words">
        {part.text}
      </p>
    );
  }

  if (part.type === 'reasoning' && part.text) {
    return (
      <div className="text-xs text-arena-elements-textTertiary italic border-l-2 border-violet-500/30 pl-2">
        {part.text}
      </div>
    );
  }

  if (part.type === 'tool' && part.tool) {
    const status = part.state?.status ?? 'running';
    return (
      <div className="rounded-lg border border-arena-elements-borderColor overflow-hidden">
        <button
          onClick={() => setToolExpanded(!toolExpanded)}
          className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-arena-elements-background-depth-3 transition-colors cursor-pointer"
        >
          <span className={`w-1.5 h-1.5 rounded-full ${
            status === 'completed' ? 'bg-emerald-400' : status === 'error' ? 'bg-crimson-400' : 'bg-amber-400 animate-pulse'
          }`} />
          <span className="font-data text-arena-elements-textSecondary">{part.tool}</span>
          <Badge variant={status === 'completed' ? 'success' : status === 'error' ? 'destructive' : 'amber'} className="text-[9px] py-0 ml-auto">
            {status}
          </Badge>
          <span className={`i-ph:caret-down text-arena-elements-textTertiary transition-transform ${toolExpanded ? 'rotate-180' : ''}`} />
        </button>
        <AnimatePresence>
          {toolExpanded && part.state && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="overflow-hidden"
            >
              <div className="px-3 pb-2 border-t border-arena-elements-dividerColor pt-2">
                {part.state.input != null && (
                  <div className="mb-2">
                    <span className="text-[10px] font-data uppercase tracking-wider text-arena-elements-textTertiary">Input</span>
                    <pre className="text-[11px] text-arena-elements-textSecondary mt-0.5 overflow-x-auto max-h-32 font-data">
                      {typeof part.state.input === 'string' ? part.state.input : JSON.stringify(part.state.input, null, 2)}
                    </pre>
                  </div>
                )}
                {part.state.output != null && (
                  <div>
                    <span className="text-[10px] font-data uppercase tracking-wider text-arena-elements-textTertiary">Output</span>
                    <pre className="text-[11px] text-arena-elements-textSecondary mt-0.5 overflow-x-auto max-h-32 font-data">
                      {typeof part.state.output === 'string' ? part.state.output : JSON.stringify(part.state.output, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return null;
}

// ── Agent Status ────────────────────────────────────────────────────────

function AgentStatus({ status, onAbort, isAborting }: {
  status: 'idle' | 'running' | 'error';
  onAbort: () => void;
  isAborting: boolean;
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 border-t border-arena-elements-dividerColor bg-arena-elements-background-depth-2/50">
      <span className={`w-2 h-2 rounded-full ${
        status === 'running' ? 'bg-amber-400 animate-pulse' : status === 'error' ? 'bg-crimson-400' : 'bg-emerald-400'
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

function SessionSelector({ sessions, activeSessionId, primarySessionId, onSelect, onDelete, onRename, onCreate }: {
  sessions: Session[];
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
            className="absolute top-full left-0 mt-1 w-72 rounded-xl border border-arena-elements-borderColor bg-arena-elements-background-depth-2 shadow-xl z-50 overflow-hidden"
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
  const { token, isAuthenticated, isAuthenticating, authenticate, error: authError } = useSessionAuth(botId, apiUrl);

  const primarySessionId = `trading-${botId}`;
  const [activeSessionId, setActiveSessionId] = useState(primarySessionId);
  const [showSystemMessages, setShowSystemMessages] = useState(true);
  const [agentStatus, setAgentStatus] = useState<'idle' | 'running' | 'error'>('idle');
  const [streamingMessage, setStreamingMessage] = useState<Message | null>(null);
  const [inputValue, setInputValue] = useState('');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  // API hooks
  const { data: sessions = [] } = useSessions(apiUrl, token);
  const { data: messages = [], refetch: refetchMessages } = useMessages(apiUrl, token, activeSessionId);
  const sendMutation = useSendMessage(apiUrl, token, activeSessionId);
  const abortMutation = useAbortExecution(apiUrl, token, activeSessionId);
  const deleteMutation = useDeleteSession(apiUrl, token);
  const renameMutation = useRenameSession(apiUrl, token);
  const createMutation = useCreateSession(apiUrl, token);

  // SSE event handler
  const handleEvent = useCallback((event: SessionEvent) => {
    const props = event.properties;

    if (event.type === 'message.part.updated' || event.type === 'message.updated') {
      // Streaming text delta — update or create streaming message
      setStreamingMessage(prev => {
        const role = (props.role as string) ?? 'assistant';
        const text = (props.text as string) ?? (props.content as string) ?? '';
        if (!prev) {
          return {
            info: { id: 'streaming', role: role as 'assistant', timestamp: new Date().toISOString() },
            parts: [{ type: 'text', text }],
            source: 'system',
          };
        }
        const parts = [...prev.parts];
        if (parts.length > 0 && parts[parts.length - 1].type === 'text') {
          parts[parts.length - 1] = { ...parts[parts.length - 1], text };
        }
        return { ...prev, parts };
      });
      setAgentStatus('running');
    } else if (event.type === 'session.idle') {
      setStreamingMessage(null);
      setAgentStatus('idle');
      refetchMessages();
    } else if (event.type === 'session.error') {
      setStreamingMessage(null);
      setAgentStatus('error');
      refetchMessages();
    }
  }, [refetchMessages]);

  useSessionEvents(apiUrl, token, activeSessionId, handleEvent);

  // Auto-scroll
  const scrollToBottom = useCallback(() => {
    if (!userScrolledUpRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingMessage, scrollToBottom]);

  // Track scroll position
  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    userScrolledUpRef.current = scrollHeight - scrollTop - clientHeight > 100;
  }, []);

  // Send message
  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || sendMutation.isPending) return;
    setInputValue('');
    await sendMutation.mutateAsync(text);
    setAgentStatus('running');
  }, [inputValue, sendMutation]);

  // Filter messages
  const displayMessages = showSystemMessages
    ? messages
    : messages.filter(m => m.source === 'owner' || m.info.role === 'assistant');

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
          sessions={sessions.length > 0 ? sessions : [{ id: primarySessionId, title: 'Main Session' }]}
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
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSystemMessages(!showSystemMessages)}
            className={`text-xs font-data px-2 py-1 rounded-md transition-colors cursor-pointer ${
              showSystemMessages
                ? 'bg-arena-elements-item-backgroundActive text-arena-elements-textPrimary'
                : 'text-arena-elements-textTertiary hover:text-arena-elements-textSecondary'
            }`}
          >
            {showSystemMessages ? 'Hide System' : 'Show System'}
          </button>
        </div>
      </div>

      {/* Message thread */}
      <div
        ref={messagesContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
      >
        {displayMessages.length === 0 && !streamingMessage && (
          <div className="text-center text-arena-elements-textTertiary text-sm py-12">
            <div className="i-ph:chat-circle-dots text-3xl mb-3 mx-auto" />
            <p>No messages yet. Send a message to start chatting with the agent.</p>
          </div>
        )}
        {displayMessages.map((msg) => (
          <ChatMessage key={msg.info.id} message={msg} />
        ))}
        {streamingMessage && (
          <ChatMessage message={streamingMessage} isStreaming />
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Agent status bar */}
      <AgentStatus
        status={agentStatus}
        onAbort={() => abortMutation.mutate()}
        isAborting={abortMutation.isPending}
      />

      {/* Input bar */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-arena-elements-dividerColor">
        <Input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={agentStatus === 'running' ? 'Agent is working...' : `Message ${botName}...`}
          disabled={agentStatus === 'running'}
          className="flex-1 h-10"
        />
        <Button
          onClick={handleSend}
          disabled={!inputValue.trim() || sendMutation.isPending || agentStatus === 'running'}
          size="sm"
          className="h-10 px-4"
        >
          {sendMutation.isPending ? (
            <span className="i-ph:arrow-clockwise text-sm animate-spin" />
          ) : (
            <span className="i-ph:paper-plane-right text-sm" />
          )}
        </Button>
      </div>
    </div>
  );
}
