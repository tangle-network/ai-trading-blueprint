export interface Session {
  id: string;
  title: string;
  parentID?: string;
}

export interface MessagePart {
  type: 'text' | 'tool' | 'reasoning' | 'file';
  text?: string;
  tool?: string;
  state?: { status: string; input?: unknown; output?: unknown };
}

export interface Message {
  info: { id: string; role: 'user' | 'assistant' | 'system'; timestamp: string };
  parts: MessagePart[];
  source?: 'owner' | 'system';
}
