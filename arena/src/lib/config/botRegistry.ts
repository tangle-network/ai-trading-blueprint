/**
 * Bot Registry — maps service IDs to metadata and API URLs.
 *
 * Configured via environment variables:
 *   VITE_SERVICE_IDS=0,1,2
 *   VITE_BOT_APIS={"0":"http://localhost:3100","1":"http://localhost:3101"}
 *   VITE_BOT_META={"0":{"name":"Alpha Momentum","strategyType":"momentum"},"1":{"name":"Mean Revert Pro","strategyType":"mean-reversion"}}
 *
 * When running against a local Anvil devnet, set these to match your deployed services.
 */

export interface BotMeta {
  name: string;
  strategyType: string;
  createdAt?: number;
}

// Parse bot API URL mapping from env
const BOT_APIS: Record<string, string> = (() => {
  try {
    const raw = import.meta.env.VITE_BOT_APIS;
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
})();

// Parse bot metadata from env
const BOT_META: Record<string, BotMeta> = (() => {
  try {
    const raw = import.meta.env.VITE_BOT_META;
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
})();

/**
 * Get the HTTP API base URL for a bot by service ID.
 * Returns undefined if no API URL is configured.
 */
export function getBotApiUrl(serviceId: number): string | undefined {
  return BOT_APIS[String(serviceId)];
}

/**
 * Get metadata (name, strategy) for a bot by service ID.
 */
export function getBotMeta(serviceId: number): BotMeta | undefined {
  return BOT_META[String(serviceId)];
}

const OPERATOR_API_URL = import.meta.env.VITE_OPERATOR_API_URL ?? '';

/**
 * Get the API URL for a bot by its bot ID string.
 * Falls back to the operator API URL when no per-bot API is configured.
 */
export function getApiUrlForBot(_botId: string): string | undefined {
  // When per-bot APIs are configured, use them
  const urls = Object.values(BOT_APIS);
  if (urls.length === 1) return urls[0];
  // Fall back to operator API (which serves all bot endpoints)
  if (OPERATOR_API_URL) return OPERATOR_API_URL;
  return undefined;
}

