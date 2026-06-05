import type { ReactNode } from 'react';

interface ToolPart {
  type: 'tool';
  tool: string;
  state: {
    metadata?: Record<string, unknown>;
  };
}

interface RunGroupProps {
  run: {
    id: string;
    summaryText?: string | null;
    messages: Array<{ id: string; role: string }>;
  };
  partMap: Record<string, Array<{ type: string; text?: string; tool?: string; state?: Record<string, unknown> }>>;
  collapsed: boolean;
  onToggle: () => void;
  renderToolDetail?: (part: ToolPart) => ReactNode | null;
  headerActions?: ReactNode;
}

export function RunGroup({
  run,
  partMap,
  collapsed,
  onToggle,
  renderToolDetail,
  headerActions,
}: RunGroupProps) {
  return (
    <div data-chat-role="assistant" data-sandbox-run-group={run.id} data-collapsed={String(collapsed)}>
      <button type="button" onClick={onToggle}>
        {collapsed ? 'Expand run' : 'Collapse run'}
      </button>
      {headerActions}
      <p>{run.summaryText}</p>
      {!collapsed && run.messages.map((message) => (
        <div key={message.id}>
          {(partMap[message.id] ?? []).map((part, index) => (
            <div key={`${message.id}-${index}`} data-chat-part={part.type}>
              {part.type === 'text' || part.type === 'reasoning' ? part.text : part.tool}
              {part.type === 'tool' && renderToolDetail
                ? renderToolDetail(part as ToolPart)
                : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
