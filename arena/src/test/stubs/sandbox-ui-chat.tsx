import type { ReactNode } from 'react';

interface ChatMessageProps {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ReactNode;
  className?: string;
  userLabel?: string;
  assistantLabel?: string;
  avatar?: ReactNode;
}

export function ChatMessage({
  role,
  content,
  toolCalls,
  className,
  userLabel,
  assistantLabel,
  avatar,
}: ChatMessageProps) {
  const label = role === 'user'
    ? userLabel ?? 'You'
    : role === 'assistant'
      ? assistantLabel ?? 'Agent'
      : 'System';

  return (
    <div className={className} data-chat-role={role}>
      {avatar}
      <div>{label}</div>
      <p>{content}</p>
      {toolCalls}
    </div>
  );
}
