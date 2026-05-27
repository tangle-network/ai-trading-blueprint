/**
 * Shared HTTP transport for every venue adapter. One JSON-fetch helper,
 * one bearer-auth convention, one timeout knob — so each adapter is a
 * thin shape-mapper and not its own HTTP client.
 */

import type { VenueClientConfig } from './types.js'

const DEFAULT_TIMEOUT_MS = 15_000

export class TradingApiHttpError extends Error {
  readonly status: number
  readonly body: string
  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path} failed (${status}): ${body}`)
    this.name = 'TradingApiHttpError'
    this.status = status
    this.body = body
  }
}

export class TradingApiClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(cfg: VenueClientConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '')
    this.token = cfg.botToken
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = cfg.fetchImpl ?? fetch
  }

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const qs = query
      ? '?' +
        Object.entries(query)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : ''
    return this.request<T>('GET', `${path}${qs}`)
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body)
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const init: RequestInit = {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        signal: ctrl.signal,
      }
      if (body !== undefined) init.body = JSON.stringify(body)
      const res = await this.fetchImpl(url, init)
      const text = await res.text()
      if (!res.ok) {
        throw new TradingApiHttpError(method, path, res.status, text)
      }
      return (text ? JSON.parse(text) : {}) as T
    } finally {
      clearTimeout(timer)
    }
  }
}
