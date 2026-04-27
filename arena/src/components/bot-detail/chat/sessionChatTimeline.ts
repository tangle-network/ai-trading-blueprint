import type { SessionPart, TextPart } from '@tangle-network/sandbox-ui/types';
import type { AppSessionMessage } from '~/lib/hooks/useBotSessionStream';

export interface SessionTimelineEntry {
  part: SessionPart;
  msgId: string;
  index: number;
}

function getSafeText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isSuppressedJunkText(value: string): boolean {
  return /^(\[object Object\]\s*)+$/.test(value.trim());
}

export function isRenderableTextPart(part: SessionPart): part is TextPart {
  return (
    part.type === 'text'
    && typeof part.text === 'string'
    && !part.synthetic
    && part.text.trim().length > 0
    && !isSuppressedJunkText(part.text)
  );
}

function normalizeComparableText(value: string | null | undefined): string {
  return getSafeText(value).replace(/\s+/g, ' ').trim();
}

export function collectSessionTimelineParts(
  messages: AppSessionMessage[],
  partMap: Record<string, SessionPart[]>,
): SessionTimelineEntry[] {
  const parts: SessionTimelineEntry[] = [];

  for (const msg of messages) {
    const msgParts = Array.isArray(partMap[msg.id]) ? partMap[msg.id] : [];
    msgParts.forEach((part, index) => {
      if (!part || typeof part !== 'object' || typeof part.type !== 'string') {
        return;
      }
      if (part.type === 'text' && !isRenderableTextPart(part)) {
        return;
      }

      parts.push({ part, msgId: msg.id, index });
    });
  }

  return parts;
}

export function collectVisibleSessionTimelineParts(
  messages: AppSessionMessage[],
  partMap: Record<string, SessionPart[]>,
  collapsed: boolean,
): SessionTimelineEntry[] {
  const allParts = collectSessionTimelineParts(messages, partMap);
  if (!collapsed) {
    return allParts;
  }

  return allParts.filter(({ part }) => isRenderableTextPart(part));
}

export function filterLeadingPromptEcho(
  entries: SessionTimelineEntry[],
  previousUserText: string | null,
  isStreaming: boolean,
): SessionTimelineEntry[] {
  const normalizedUserText = normalizeComparableText(previousUserText);
  if (!normalizedUserText) {
    return entries;
  }

  const firstTextIndex = entries.findIndex(({ part }) => part.type === 'text' && getSafeText(part.text).trim().length > 0);
  if (firstTextIndex < 0) {
    return entries;
  }

  const firstText = normalizeComparableText(
    entries[firstTextIndex]?.part.type === 'text' ? entries[firstTextIndex].part.text : '',
  );
  if (firstText !== normalizedUserText) {
    return entries;
  }

  if (isStreaming) {
    return entries.filter((_, index) => index !== firstTextIndex);
  }

  const hasMeaningfulFollowup = entries.some(({ part }, index) => {
    if (index === firstTextIndex) {
      return false;
    }
    if (part.type === 'tool' || part.type === 'reasoning') {
      return true;
    }

    const partText = normalizeComparableText(part.type === 'text' ? part.text : '');
    return part.type === 'text' && partText !== '' && partText !== normalizedUserText;
  });

  if (!hasMeaningfulFollowup) {
    return entries;
  }

  return entries.filter((_, index) => index !== firstTextIndex);
}
