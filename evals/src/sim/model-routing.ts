/** Logical model ids used by the trading evals. */
export type LlmModel =
  | 'kimi-k2'
  | 'glm-4.7'
  | 'glm-5.1'
  | string

export interface ModelRouting {
  /** API key resolved at call time so environment updates do not require reload. */
  apiKey: () => string
  baseUrl: string
  /** Provider-specific model name sent over the wire. */
  modelId: string
  /** Stable provider release identity recorded in eval results. */
  executionIdentity: string
  label: string
}

const MODEL_CONFIG: Record<string, ModelRouting> = {
  'kimi-k2': {
    apiKey: () => process.env.MOONSHOT_API_KEY ?? '',
    baseUrl: 'https://api.moonshot.ai/v1',
    modelId: 'kimi-k2.6',
    executionIdentity: 'moonshot/kimi-k2.6@2.6',
    label: 'Moonshot Kimi K2.6',
  },
  'glm-4.7': {
    apiKey: () => process.env.ZAI_API_KEY ?? '',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    modelId: 'glm-4.7',
    executionIdentity: 'zai/glm-4.7@4.7',
    label: 'Z.AI GLM-4.7',
  },
  'glm-5.1': {
    apiKey: () => process.env.ZAI_GLM_API_KEY ?? process.env.ZAI_API_KEY ?? '',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    modelId: 'glm-5.1',
    executionIdentity: 'zai/glm-5.1@5.1',
    label: 'Z.AI GLM-5.1',
  },
}

function routingForModel(model: LlmModel): ModelRouting {
  const cfg = MODEL_CONFIG[model]
  if (!cfg) {
    const known = Object.keys(MODEL_CONFIG).join(', ')
    throw new Error(`unknown LLM model "${model}"; known: ${known}`)
  }
  return cfg
}

/** Return the immutable provider release recorded in Agent Eval rows. */
export function modelExecutionIdentity(model: LlmModel): string {
  const identity = routingForModel(model).executionIdentity.trim()
  const [name, snapshot, ...extra] = identity.split('@')
  if (
    !name ||
    !snapshot ||
    extra.length > 0 ||
    /^(latest|current|default)$/i.test(snapshot)
  ) {
    throw new Error(
      `model "${model}" has mutable or missing execution identity "${identity}"; pin a provider release`,
    )
  }
  return identity
}

/** Resolve routing and reject missing credentials before a provider call. */
export function resolveModel(model: LlmModel): ModelRouting {
  const cfg = routingForModel(model)
  modelExecutionIdentity(model)
  if (!cfg.apiKey()) {
    throw new Error(
      `${cfg.label} requires env var (MOONSHOT_API_KEY / ZAI_API_KEY etc.) — not set`,
    )
  }
  return cfg
}
