import { useMemo, useCallback, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AgentBranding, Run, SessionPart } from '@tangle-network/sandbox-ui/types';
import {
  useAutoScroll,
  useRunCollapseState,
  useRunGroups,
} from '@tangle-network/sandbox-ui/hooks';
import { cn } from '@tangle-network/sandbox-ui/utils';
import type { AppSessionMessage } from '~/lib/hooks/useBotSessionStream';
import { AppMarkdown, ReasoningRow, ToolRow, UserBubble } from './SessionChatParts';
import {
  collectSessionTimelineParts,
  collectVisibleSessionTimelineParts,
  filterLeadingPromptEcho,
} from './sessionChatTimeline';

function getSafeText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getUserText(parts: SessionPart[]): string {
  return parts
    .filter((part): part is Extract<SessionPart, { type: 'text' }> => part.type === 'text')
    .map((part) => getSafeText(part.text))
    .join('\n')
    .trim();
}

function getRunFailureState(run: Run): { errorText: string | null } | null {
  for (let index = run.messages.length - 1; index >= 0; index -= 1) {
    const message = run.messages[index] as AppSessionMessage;
    if (message.role !== 'assistant') {
      continue;
    }
    if (message.success === false || typeof message.error === 'string') {
      return {
        errorText: typeof message.error === 'string' ? message.error : null,
      };
    }
  }
  return null;
}

function AgentRunGroup({
  run,
  partMap,
  collapsed,
  onToggle,
  branding,
  previousUserText,
}: {
  run: Run;
  partMap: Record<string, SessionPart[]>;
  collapsed: boolean;
  onToggle: () => void;
  branding: AgentBranding;
  previousUserText: string | null;
}) {
  const rawAllParts = useMemo(
    () => collectSessionTimelineParts(run.messages as AppSessionMessage[], partMap),
    [run.messages, partMap],
  );
  const rawVisibleParts = useMemo(
    () => collectVisibleSessionTimelineParts(run.messages as AppSessionMessage[], partMap, collapsed),
    [collapsed, partMap, run.messages],
  );
  const allParts = useMemo(
    () => filterLeadingPromptEcho(rawAllParts, previousUserText, run.isStreaming),
    [previousUserText, rawAllParts, run.isStreaming],
  );
  const visibleParts = useMemo(
    () => filterLeadingPromptEcho(rawVisibleParts, previousUserText, run.isStreaming),
    [previousUserText, rawVisibleParts, run.isStreaming],
  );
  const hasCollapsible = useMemo(
    () => allParts.some(({ part }) => part.type === 'tool' || part.type === 'reasoning'),
    [allParts],
  );
  const hasVisibleParts = visibleParts.length > 0;
  const failureState = useMemo(() => getRunFailureState(run), [run]);

  if (!hasVisibleParts && !run.isStreaming && !failureState) {
    return null;
  }

  return (
    <div>
      <button
        onClick={hasCollapsible ? onToggle : undefined}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-2 text-left rounded-lg transition-colors',
          branding.bgClass,
          hasCollapsible && 'hover:bg-arena-elements-item-backgroundHover/80 cursor-pointer',
          !hasCollapsible && 'cursor-default',
          collapsed && branding.borderClass && `border ${branding.borderClass}`,
          !collapsed && 'border border-transparent',
        )}
      >
        <div className={cn('w-4 h-4 shrink-0', branding.iconClass, branding.accentClass)} />
        <span className={cn('text-xs font-medium shrink-0', branding.textClass)}>
          {branding.label}
        </span>
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {failureState && (
            <span className="rounded-full bg-crimson-500/10 px-2 py-0.5 text-[11px] font-medium text-crimson-600 dark:text-crimson-300">
              Failed
            </span>
          )}
          {run.stats.toolCount > 0 && (
            <span className="text-xs text-arena-elements-textTertiary">
              {run.stats.toolCount} tool{run.stats.toolCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        {hasCollapsible && (
          <div
            className={cn(
              'w-3.5 h-3.5 text-arena-elements-textTertiary transition-transform shrink-0',
              !collapsed ? 'i-ph:caret-down' : 'i-ph:caret-right',
            )}
          />
        )}
      </button>

      {visibleParts.length > 0 && (
        <div className={cn('mt-1 space-y-2 rounded-lg p-1.5', branding.containerBgClass)}>
          {visibleParts.map(({ part, msgId, index }) => {
            const key = `${msgId}-${index}`;
            if (part.type === 'text') {
              const text = getSafeText(part.text);
              if (!text.trim()) {
                return null;
              }
              return (
                <div key={key} className="px-2.5 py-1.5">
                  <AppMarkdown className="text-[14px] leading-6">{text}</AppMarkdown>
                </div>
              );
            }
            if (part.type === 'tool') {
              return <ToolRow key={key} part={part} />;
            }
            if (part.type === 'reasoning') {
              return <ReasoningRow key={key} part={part} />;
            }
            return null;
          })}
        </div>
      )}

      {failureState && (
        <div className="mt-2 rounded-lg border border-crimson-500/20 bg-crimson-500/5 px-3 py-2">
          <div className="text-xs font-medium text-crimson-600 dark:text-crimson-300">
            Generation stopped due to an error. This response may be incomplete.
          </div>
          {failureState.errorText && (
            <p className="mt-1 text-xs text-crimson-600/90 dark:text-crimson-300/90">
              {failureState.errorText}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function ChatTranscript({
  messages,
  partMap,
  isStreaming,
  onSend,
  branding,
  placeholder = 'Ask the agent anything...',
}: {
  messages: AppSessionMessage[];
  partMap: Record<string, SessionPart[]>;
  isStreaming: boolean;
  onSend?: (text: string) => void | Promise<void>;
  branding: AgentBranding;
  placeholder?: string;
}) {
  const [inputValue, setInputValue] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const groups = useRunGroups({ messages, partMap, isStreaming });
  const runs = groups.filter((group) => group.type === 'run').map((group) => group.run);
  const { isCollapsed, toggleCollapse } = useRunCollapseState(runs);
  const { isAtBottom, scrollToBottom } = useAutoScroll(scrollRef, [messages, partMap, isStreaming]);

  const handleSubmit = useCallback((e?: FormEvent) => {
    e?.preventDefault();
    const text = inputValue.trim();
    if (!text || !onSend) {
      return;
    }

    void onSend(text);
    setInputValue('');
    inputRef.current?.focus();
  }, [inputValue, onSend]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  return (
    <div className="flex flex-col h-full flex-1 min-h-0">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-3"
        tabIndex={0}
        aria-label="Conversation transcript"
      >
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-arena-elements-textTertiary">
            No messages yet
          </div>
        ) : (
          <div className="space-y-2.5">
            {groups.map((group, groupIndex) => {
              if (group.type === 'user') {
                return (
                  <UserBubble key={group.message.id} parts={partMap[group.message.id] ?? []} />
                );
              }

              let previousUserGroup: (typeof groups)[number] | null = null;
              for (let index = groupIndex - 1; index >= 0; index -= 1) {
                if (groups[index]?.type === 'user') {
                  previousUserGroup = groups[index];
                  break;
                }
              }
              const previousUserText = previousUserGroup?.type === 'user'
                ? getUserText(partMap[previousUserGroup.message.id] ?? [])
                : null;

              return (
                <AgentRunGroup
                  key={group.run.id}
                  run={group.run}
                  partMap={partMap}
                  collapsed={isCollapsed(group.run.id)}
                  onToggle={() => toggleCollapse(group.run.id)}
                  branding={branding}
                  previousUserText={previousUserText}
                />
              );
            })}
          </div>
        )}
      </div>

      {!isAtBottom && (
        <div className="flex justify-center -mt-10 relative z-10">
          <button
            onClick={scrollToBottom}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/90 dark:bg-arena-elements-background-depth-3 border border-arena-elements-dividerColor shadow-lg text-xs text-arena-elements-textSecondary hover:bg-white dark:hover:bg-arena-elements-background-depth-2 transition-colors"
          >
            <div className="i-ph:arrow-down w-3 h-3" />
            Scroll to bottom
          </button>
        </div>
      )}

      {onSend && (
        <form onSubmit={handleSubmit} className="shrink-0 border-t border-arena-elements-dividerColor/50 p-3">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              rows={1}
              disabled={isStreaming}
              className="flex-1 resize-none rounded-lg px-3 py-2 bg-arena-elements-background-depth-2/70 border border-arena-elements-dividerColor/70 text-sm text-arena-elements-textPrimary placeholder:text-arena-elements-textTertiary focus:outline-none focus:border-violet-500/40 disabled:opacity-50 disabled:cursor-not-allowed max-h-32"
              style={{ minHeight: '2.5rem' }}
            />
            <button
              type="submit"
              disabled={isStreaming || !inputValue.trim()}
              className="flex items-center justify-center w-9 h-9 rounded-lg bg-violet-600 hover:bg-violet-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <div className="i-ph:paper-plane-tilt w-4 h-4 text-white" />
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
