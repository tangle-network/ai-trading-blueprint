import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { ChatContainer } from '@tangle-network/sandbox-ui/chat';
import type { AgentBranding, SessionPart } from '@tangle-network/sandbox-ui/types';
import { useRunGroups } from '@tangle-network/sandbox-ui/hooks';
import { cn } from '@tangle-network/sandbox-ui/utils';
import type { AppSessionMessage } from '~/lib/hooks/useBotSessionStream';
import type { ChatPartVariant } from './SessionChatParts';
import {
  collectSessionTimelineParts,
  filterLeadingPromptEcho,
  isRenderableTextPart,
} from './sessionChatTimeline';
import { TerminalEmptyState } from '../shared/WorkspacePrimitives';

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

function hasVisiblePart(part: SessionPart): boolean {
  return part.type === 'tool'
    || part.type === 'reasoning'
    || isRenderableTextPart(part);
}

function buildVisiblePartMap(
  groups: ReturnType<typeof useRunGroups>,
  partMap: Record<string, SessionPart[]>,
  isStreaming: boolean,
): Record<string, SessionPart[]> {
  const nextPartMap: Record<string, SessionPart[]> = {};

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    if (!group) {
      continue;
    }

    if (group.type === 'user') {
      nextPartMap[group.message.id] = (partMap[group.message.id] ?? []).filter(hasVisiblePart);
      continue;
    }

    let previousUserText: string | null = null;
    for (let index = groupIndex - 1; index >= 0; index -= 1) {
      const candidate = groups[index];
      if (candidate?.type !== 'user') {
        continue;
      }
      previousUserText = getUserText(partMap[candidate.message.id] ?? []);
      break;
    }

    const visibleEntries = filterLeadingPromptEcho(
      collectSessionTimelineParts(group.run.messages as AppSessionMessage[], partMap),
      previousUserText,
      isStreaming || group.run.isStreaming,
    );
    const visibleKeys = new Set(
      visibleEntries.map(({ msgId, index }) => `${msgId}:${index}`),
    );

    for (const message of group.run.messages) {
      const parts = partMap[message.id] ?? [];
      nextPartMap[message.id] = parts.filter((part, index) =>
        visibleKeys.has(`${message.id}:${index}`) && hasVisiblePart(part),
      );
    }
  }

  return nextPartMap;
}

export function ChatTranscript({
  messages,
  partMap,
  isStreaming,
  onSend,
  branding,
  placeholder = 'Ask the agent anything…',
  variant = 'default',
  emptyTitle,
  emptyDescription,
  footerNotice,
}: {
  messages: AppSessionMessage[];
  partMap: Record<string, SessionPart[]>;
  isStreaming: boolean;
  onSend?: (text: string) => void | Promise<void>;
  branding: AgentBranding;
  placeholder?: string;
  variant?: ChatPartVariant;
  emptyTitle?: string;
  emptyDescription?: string;
  /** Status line rendered between the transcript and the composer. */
  footerNotice?: ReactNode;
}) {
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const groups = useRunGroups({ messages, partMap, isStreaming });
  const visiblePartMap = useMemo(
    () => buildVisiblePartMap(groups, partMap, isStreaming),
    [groups, isStreaming, partMap],
  );
  const hasVisibleMessages = messages.some((message) =>
    (visiblePartMap[message.id] ?? []).some(hasVisiblePart),
  );
  const isTerminal = variant === 'terminal';
  const resolvedEmptyTitle = emptyTitle ?? (onSend ? 'Open Trading Thread' : 'Transcript Idle');
  const resolvedEmptyDescription =
    emptyDescription ??
    'Messages, reasoning, tool calls, and decisions will appear here.';

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
    <div
      className={cn(
        'flex h-full min-h-0 flex-1 flex-col',
        'arena-sandbox-transcript',
        isTerminal && 'arena-terminal-transcript arena-sandbox-transcript--terminal bg-[#081013]',
      )}
    >
      <div className="min-h-0 flex-1" aria-label="Conversation transcript">
        {!hasVisibleMessages && !isStreaming ? (
          <TerminalEmptyState
            title={resolvedEmptyTitle}
            description={resolvedEmptyDescription}
            icon={onSend ? 'i-ph:chat-circle-dots' : 'i-ph:list-checks'}
            className={cn(
              'mx-auto max-w-[760px]',
              isTerminal
                ? 'border-[#273035] bg-[#0b1418]'
                : 'border-arena-elements-dividerColor bg-arena-elements-background-depth-1',
            )}
          />
        ) : (
          <ChatContainer
            messages={messages}
            partMap={visiblePartMap}
            isStreaming={isStreaming}
            branding={branding}
            hideInput
            presentation="runs"
            placeholder={placeholder}
            className={cn(
              'h-full min-h-0',
              isTerminal && 'arena-trace-terminal',
            )}
          />
        )}
      </div>

      {footerNotice}

      {onSend && (
        <form onSubmit={handleSubmit} className={cn('shrink-0 border-t border-arena-elements-dividerColor/50 p-3', isTerminal && 'bg-[#0b1418]')}>
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              rows={1}
              disabled={isStreaming}
              aria-label="Message input"
              name="message"
              autoComplete="off"
              className={cn(
                'flex-1 resize-none border px-4 py-3 text-base text-arena-elements-textPrimary placeholder:text-arena-elements-textTertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50 max-h-36',
                isTerminal
                  ? 'rounded-[5px] border-[#273035] bg-[#0f1a1f] focus-visible:border-[#50d2c1]/60 focus-visible:ring-[#50d2c1]/30'
                  : 'rounded-lg border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/70 focus-visible:border-violet-500/40 focus-visible:ring-violet-500/20',
              )}
              style={{ minHeight: '3rem' }}
            />
            <button
              type="submit"
              disabled={isStreaming || !inputValue.trim()}
              aria-label="Send Message"
              className={cn(
                'flex h-12 w-12 items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-30',
                isTerminal ? 'rounded-[5px] bg-[#143c38] hover:bg-[#19524c] focus-visible:ring-[#50d2c1]/60' : 'rounded-lg bg-violet-600 hover:bg-violet-500 focus-visible:ring-violet-500/60',
              )}
            >
              <div className="i-ph:paper-plane-tilt w-4 h-4 text-white" aria-hidden="true" />
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
