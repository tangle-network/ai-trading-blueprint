import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  ReasoningPart,
  SessionPart,
  TextPart,
  ToolPart,
} from '@tangle-network/sandbox-ui/types';
import {
  cn,
  formatDuration,
  getToolCategory,
  getToolDisplayMetadata,
  getToolErrorText,
  truncateText,
} from '@tangle-network/sandbox-ui/utils';

const TOOL_CATEGORY_ICON_CLASS: Record<string, string> = {
  command: 'i-ph:terminal-window',
  write: 'i-ph:file-plus',
  read: 'i-ph:file-text',
  search: 'i-ph:magnifying-glass',
  edit: 'i-ph:pencil-line',
  task: 'i-ph:cpu',
  web: 'i-ph:globe-hemisphere-west',
  todo: 'i-ph:check-square',
  other: 'i-ph:cube',
};

export type ChatPartVariant = 'default' | 'terminal';

function getTextValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\((https?:\/\/[^\s)]+)\))/g;
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const full = match[0];
    const index = match.index ?? 0;

    if (index > lastIndex) {
      nodes.push(text.slice(lastIndex, index));
    }

    if (full.startsWith('`') && full.endsWith('`')) {
      nodes.push(
        <code
          key={`${index}-code`}
          className="rounded-md border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-2/80 px-1.5 py-0.5 font-data text-[0.92em] text-violet-700 dark:text-violet-300"
        >
          {full.slice(1, -1)}
        </code>,
      );
    } else if (full.startsWith('**') && full.endsWith('**')) {
      nodes.push(
        <strong key={`${index}-strong`} className="font-semibold text-arena-elements-textPrimary">
          {full.slice(2, -2)}
        </strong>,
      );
    } else {
      const textMatch = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(full);
      if (textMatch) {
        nodes.push(
          <a
            key={`${index}-link`}
            href={textMatch[2]}
            target="_blank"
            rel="noreferrer"
            className="text-violet-700 underline decoration-violet-500/30 underline-offset-3 hover:text-violet-600 dark:text-violet-300 dark:hover:text-violet-200"
          >
            {textMatch[1]}
          </a>,
        );
      } else {
        nodes.push(full);
      }
    }

    lastIndex = index + full.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes.length > 0 ? nodes : [text];
}

function renderTextWithBreaks(text: string) {
  return text.split('\n').map((line, index) => (
    <Fragment key={`${line}-${index}`}>
      {index > 0 ? <br /> : null}
      {renderInlineMarkdown(line)}
    </Fragment>
  ));
}

function renderCodeBlock(code: string, language?: string) {
  return (
    <pre className="overflow-x-hidden whitespace-pre-wrap break-words rounded-lg border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-2 px-3 py-2 font-data text-sm leading-6 text-arena-elements-textPrimary">
      <code className={language ? `language-${language}` : undefined}>{code}</code>
    </pre>
  );
}

function LiveDuration({ startTime }: { startTime: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-data text-emerald-700 dark:text-emerald-300">
      {formatDuration(Math.max(0, now - startTime))}
    </span>
  );
}

function renderToolValue(value: unknown): ReactNode {
  if (value == null) {
    return <span className="text-arena-elements-textTertiary">None</span>;
  }

  if (typeof value === 'string') {
    return (
      <pre className="overflow-x-hidden whitespace-pre-wrap break-words rounded-lg bg-arena-elements-background-depth-2 px-2.5 py-2 text-sm leading-6 text-arena-elements-textSecondary">
        {value}
      </pre>
    );
  }

  return (
    <pre className="overflow-x-hidden whitespace-pre-wrap break-words rounded-lg bg-arena-elements-background-depth-2 px-2.5 py-2 text-sm leading-6 text-arena-elements-textSecondary">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function DetailSection({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: unknown;
  tone?: 'neutral' | 'error';
}) {
  return (
    <div
      className={cn(
        'rounded-lg border px-2.5 py-2',
        tone === 'error'
          ? 'border-crimson-500/20 bg-crimson-500/5'
          : 'border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-2/60',
      )}
    >
      <div
        className={cn(
          'mb-1 text-[10px] font-display font-semibold uppercase tracking-[0.12em]',
          tone === 'error' ? 'text-crimson-600 dark:text-crimson-300' : 'text-arena-elements-textTertiary',
        )}
      >
        {label}
      </div>
      {renderToolValue(value)}
    </div>
  );
}

export function AppMarkdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const safeChildren = getTextValue(children);
  const lines = safeChildren.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const fenceMatch = /^```(\w+)?\s*$/.exec(trimmed);
    if (fenceMatch) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index].trim())) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push(<div key={`code-${blocks.length}`}>{renderCodeBlock(codeLines.join('\n'), fenceMatch[1])}</div>);
      continue;
    }

    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingClass =
        level === 1
          ? 'text-lg font-display font-semibold text-arena-elements-textPrimary'
          : level === 2
            ? 'text-base font-display font-semibold text-arena-elements-textPrimary'
            : 'text-sm font-display font-semibold uppercase tracking-[0.12em] text-arena-elements-textSecondary';
      blocks.push(
        <div key={`heading-${blocks.length}`} className={headingClass}>
          {renderInlineMarkdown(headingMatch[2])}
        </div>,
      );
      index += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote
          key={`quote-${blocks.length}`}
          className="border-l-2 border-violet-400/40 pl-4 text-arena-elements-textSecondary italic"
        >
          {renderTextWithBreaks(quoteLines.join('\n'))}
        </blockquote>,
      );
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ul key={`ul-${blocks.length}`} className="list-disc space-y-2 pl-5 text-arena-elements-textPrimary">
          {items.map((item, itemIndex) => (
            <li key={`${item}-${itemIndex}`} className="marker:text-violet-500">
              {renderInlineMarkdown(item)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+\.\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ol key={`ol-${blocks.length}`} className="list-decimal space-y-2 pl-5 text-arena-elements-textPrimary">
          {items.map((item, itemIndex) => (
            <li key={`${item}-${itemIndex}`} className="marker:text-violet-500">
              {renderInlineMarkdown(item)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^```/.test(lines[index].trim()) &&
      !/^(#{1,3})\s+/.test(lines[index].trim()) &&
      !/^>\s?/.test(lines[index].trim()) &&
      !/^[-*]\s+/.test(lines[index].trim()) &&
      !/^\d+\.\s+/.test(lines[index].trim())
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }

    blocks.push(
      <p key={`p-${blocks.length}`} className="text-[15px] leading-7 text-arena-elements-textPrimary">
        {renderTextWithBreaks(paragraphLines.join('\n'))}
      </p>,
    );
  }

  return <div className={cn('space-y-3 text-[15px] leading-7 text-arena-elements-textPrimary', className)}>{blocks}</div>;
}

export function UserBubble({
  parts,
  variant = 'default',
}: {
  parts: SessionPart[];
  variant?: ChatPartVariant;
}) {
  const textContent = parts
    .filter((part): part is TextPart => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');

  if (!textContent.trim()) {
    return null;
  }

  return (
    <div className="flex justify-end">
      <div
        className={cn(
          'ml-auto max-w-[85%] border px-4 py-2.5 text-left',
          variant === 'terminal'
            ? 'rounded-[5px] border-[#273035] bg-[#143c38] shadow-none'
            : 'rounded-2xl rounded-br-md border-violet-500/15 bg-violet-500/8 shadow-[0_8px_24px_rgba(109,40,217,0.06)] dark:border-violet-500/20 dark:bg-violet-500/12',
        )}
      >
        <div
          className={cn(
            'mb-1 text-xs font-display font-semibold uppercase tracking-[0.14em]',
            variant === 'terminal' ? 'text-[#50d2c1]' : 'text-violet-700 dark:text-violet-300',
          )}
        >
          You
        </div>
        <AppMarkdown>{textContent}</AppMarkdown>
      </div>
    </div>
  );
}

export function ToolRow({
  part,
  variant = 'default',
}: {
  part: ToolPart;
  variant?: ChatPartVariant;
}) {
  const [open, setOpen] = useState(false);
  const isTerminal = variant === 'terminal';
  const safePart: ToolPart = {
    ...part,
    tool: typeof part.tool === 'string' ? part.tool : 'unknown',
    state: {
      status: part.state?.status ?? 'running',
      input: part.state?.input,
      output: part.state?.output,
      ...(typeof part.state?.error === 'string' ? { error: part.state.error } : {}),
      ...(part.state?.metadata ? { metadata: part.state.metadata } : {}),
      ...(part.state?.time ? { time: part.state.time } : {}),
    },
  };
  const meta = getToolDisplayMetadata(safePart);
  const errorText = getToolErrorText(safePart);
  const status = safePart.state.status;
  const isRunning = status === 'pending' || status === 'running';
  const isComplete = status === 'completed';
  const isError = status === 'error';
  const startTime = safePart.state.time?.start;
  const endTime = safePart.state.time?.end;
  const durationMs = startTime && endTime ? endTime - startTime : undefined;
  const category = getToolCategory(safePart.tool);
  const iconClass = TOOL_CATEGORY_ICON_CLASS[category] ?? TOOL_CATEGORY_ICON_CLASS.other;

  return (
    <div className={cn(
      isTerminal
        ? 'rounded-[5px] border border-[#273035] bg-[#0f1a1f]'
        : 'rounded-lg border border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-2/70',
    )}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'w-full px-2.5 py-1.5 text-left transition-colors',
          isTerminal ? 'rounded-[5px] hover:bg-[#16242a]' : 'rounded-lg hover:bg-arena-elements-item-backgroundHover/80',
          open && (isTerminal ? 'bg-[#16242a]' : 'bg-arena-elements-item-backgroundHover/50'),
        )}
      >
        <div className="flex items-center gap-2.5">
          <div
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border',
              isRunning && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
              isComplete && 'border-emerald-500/20 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300',
              isError && 'border-crimson-500/20 bg-crimson-500/8 text-crimson-600 dark:text-crimson-300',
              !isRunning && !isComplete && !isError && 'border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/50 text-arena-elements-textTertiary',
            )}
          >
            <div className={cn('h-3.5 w-3.5', isRunning ? 'i-ph:spinner-gap animate-spin' : iconClass)} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-display font-medium text-arena-elements-textPrimary">
                {meta.title}
              </span>
              {isRunning && (
                <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-display font-semibold uppercase tracking-[0.06em] text-emerald-700 dark:text-emerald-300">
                  Running
                </span>
              )}
              {isError && (
                <span className="rounded-full border border-crimson-500/20 bg-crimson-500/10 px-1.5 py-0.5 text-[10px] font-display font-semibold uppercase tracking-[0.06em] text-crimson-600 dark:text-crimson-300">
                  Failed
                </span>
              )}
            </div>
            {meta.description && (
              <div className="mt-0.5 truncate text-xs font-data text-arena-elements-textTertiary">
                {meta.description}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {isRunning && startTime ? <LiveDuration startTime={startTime} /> : null}
            {!isRunning && durationMs != null ? (
              <span className="rounded-full border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/50 px-1.5 py-0.5 text-[10px] font-data text-arena-elements-textTertiary">
                {formatDuration(durationMs)}
              </span>
            ) : null}
            <div className={cn('h-3.5 w-3.5 text-arena-elements-textTertiary', open ? 'i-ph:caret-down' : 'i-ph:caret-right')} />
          </div>
        </div>
        {errorText && !open && (
          <div className="mt-2 rounded-lg border border-crimson-500/20 bg-crimson-500/5 px-2.5 py-2 text-[11px] text-crimson-600 dark:text-crimson-300">
            {errorText}
          </div>
        )}
      </button>

      {open && (
        <div className="space-y-2 border-t border-arena-elements-dividerColor/50 px-2.5 py-2">
          {safePart.state.input !== undefined && <DetailSection label="Input" value={safePart.state.input} />}
          {safePart.state.output !== undefined && <DetailSection label="Output" value={safePart.state.output} />}
          {errorText && <DetailSection label="Error" value={errorText} tone="error" />}
        </div>
      )}
    </div>
  );
}

export function ReasoningRow({
  part,
  defaultOpen = false,
  variant = 'default',
}: {
  part: ReasoningPart;
  defaultOpen?: boolean;
  variant?: ChatPartVariant;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const isTerminal = variant === 'terminal';
  const autoCollapsedRef = useRef(false);
  const startTime = part.time?.start;
  const endTime = part.time?.end;
  const durationMs = startTime && endTime ? endTime - startTime : undefined;
  const isActive = startTime != null && endTime == null;
  const text = getTextValue(part.text);
  const preview = useMemo(() => (text ? truncateText(text, 120) : undefined), [text]);

  useEffect(() => {
    if (isActive) {
      autoCollapsedRef.current = false;
      setOpen(true);
      return;
    }

    if (!autoCollapsedRef.current && durationMs != null) {
      const timer = window.setTimeout(() => {
        setOpen(false);
        autoCollapsedRef.current = true;
      }, 900);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [durationMs, isActive]);

  return (
    <div className={cn(
      isTerminal
        ? 'rounded-[5px] border border-[#273035] bg-[#0f1a1f]'
        : 'rounded-lg border border-arena-elements-dividerColor/50 bg-arena-elements-background-depth-2/70',
    )}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'w-full px-2.5 py-1.5 text-left transition-colors',
          isTerminal ? 'rounded-[5px] hover:bg-[#16242a]' : 'rounded-lg hover:bg-arena-elements-item-backgroundHover/80',
          open && (isTerminal ? 'bg-[#16242a]' : 'bg-arena-elements-item-backgroundHover/50'),
        )}
      >
        <div className="flex items-center gap-2.5">
          <div
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border',
              isActive
                ? 'border-violet-500/25 bg-violet-500/10 text-violet-700 shadow-[0_0_20px_rgba(139,92,246,0.12)] dark:text-violet-300'
                : 'border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/50 text-arena-elements-textTertiary',
            )}
          >
            <div className={cn('i-ph:brain h-3.5 w-3.5', isActive && 'animate-pulse')} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-display font-medium text-arena-elements-textPrimary">
                {isActive ? 'Thinking…' : 'Reasoning'}
              </span>
              {isActive && startTime ? <LiveDuration startTime={startTime} /> : null}
              {!isActive && durationMs != null ? (
                <span className="rounded-full border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/50 px-1.5 py-0.5 text-[10px] font-data text-arena-elements-textTertiary">
                  {formatDuration(durationMs)}
                </span>
              ) : null}
            </div>
            {preview && !open && (
              <div className="mt-0.5 truncate text-xs text-arena-elements-textSecondary">{preview}</div>
            )}
          </div>
          <div className={cn('h-3.5 w-3.5 text-arena-elements-textTertiary', open ? 'i-ph:caret-down' : 'i-ph:caret-right')} />
        </div>
      </button>

      {open && (
        <div className="border-t border-arena-elements-dividerColor/50 px-3 py-2">
          {text ? (
            <AppMarkdown className="text-[15px] leading-7 text-arena-elements-textSecondary">{text}</AppMarkdown>
          ) : (
            <div className="text-sm text-arena-elements-textTertiary">No reasoning text was provided.</div>
          )}
        </div>
      )}
    </div>
  );
}
