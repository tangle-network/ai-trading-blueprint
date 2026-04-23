import { describe, expect, it } from 'vitest';
import {
  collectSessionTimelineParts,
  filterLeadingPromptEcho,
  isRenderableTextPart,
} from '../chat/sessionChatTimeline';

describe('sessionChatTimeline', () => {
  it('suppresses obvious junk object text', () => {
    expect(isRenderableTextPart({ type: 'text', text: '[object Object]' } as any)).toBe(false);
    expect(isRenderableTextPart({ type: 'text', text: ' [object Object] ' } as any)).toBe(false);
    expect(isRenderableTextPart({ type: 'text', text: '[object Object]\n[object Object]' } as any)).toBe(false);
  });

  it('keeps normal assistant text renderable', () => {
    expect(isRenderableTextPart({ type: 'text', text: 'Market looks stable.' } as any)).toBe(true);
  });

  it('filters suppressed text parts out of the collected timeline', () => {
    const parts = collectSessionTimelineParts(
      [{ id: 'assistant-1', role: 'assistant' } as any],
      {
        'assistant-1': [
          { type: 'text', text: '[object Object]' },
          { type: 'text', text: 'Clean response' },
        ] as any,
      },
    );

    expect(parts).toHaveLength(1);
    expect((parts[0]?.part as any).text).toBe('Clean response');
  });

  it('suppresses leading prompt echoes even when whitespace differs', () => {
    const entries = filterLeadingPromptEcho(
      [
        { msgId: 'assistant-1', index: 0, part: { type: 'text', text: 'hello\nwho are you' } as any },
        { msgId: 'assistant-1', index: 1, part: { type: 'reasoning', text: 'Checking identity context.' } as any },
        { msgId: 'assistant-1', index: 2, part: { type: 'text', text: 'I can help with your bot.' } as any },
      ],
      'hello who are you',
      false,
    );

    expect(entries).toHaveLength(2);
    expect((entries[0]?.part as any).type).toBe('reasoning');
    expect((entries[1]?.part as any).text).toBe('I can help with your bot.');
  });
});
