export interface OperatorErrorBody {
  code?: string;
  message?: string;
  bot_id?: string;
  sandbox_id?: string;
}

export class OperatorRequestError extends Error {
  status: number;
  body: OperatorErrorBody | null;

  constructor(status: number, message: string, body: OperatorErrorBody | null = null) {
    super(message);
    this.name = 'OperatorRequestError';
    this.status = status;
    this.body = body;
  }
}

export async function readOperatorError(res: Response): Promise<OperatorRequestError> {
  const raw = await res.text();
  let body: OperatorErrorBody | null = null;

  try {
    body = raw ? JSON.parse(raw) as OperatorErrorBody : null;
  } catch {
    body = null;
  }

  const message = body?.message || raw || `HTTP ${res.status}`;
  return new OperatorRequestError(res.status, message, body);
}

export function isStaleStateError(err: unknown): err is OperatorRequestError {
  return err instanceof OperatorRequestError && err.body?.code === 'stale_state';
}
