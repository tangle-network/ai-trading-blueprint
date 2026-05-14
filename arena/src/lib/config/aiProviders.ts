export type AiProvider = 'anthropic' | 'zai' | 'tangle-router';

export const DEFAULT_AI_PROVIDER = import.meta.env.VITE_DEFAULT_AI_PROVIDER ?? '';
export const DEFAULT_AI_API_KEY = import.meta.env.VITE_DEFAULT_AI_API_KEY ?? '';
export const DEFAULT_TANGLE_ROUTER_BASE_URL =
  import.meta.env.VITE_TANGLE_ROUTER_BASE_URL ?? 'https://router.tangle.tools/v1';

export const AI_PROVIDERS: {
  id: AiProvider;
  label: string;
  placeholder: string;
  envKey: string;
  modelProvider: string;
  modelName: string;
}[] = [
  {
    id: 'zai',
    label: 'Z.ai (GLM)',
    placeholder: 'your-zai-api-key',
    envKey: 'ZAI_API_KEY',
    modelProvider: 'zai-coding-plan',
    modelName: 'glm-4.7',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    placeholder: 'sk-ant-...',
    envKey: 'ANTHROPIC_API_KEY',
    modelProvider: 'anthropic',
    modelName: 'claude-sonnet-4-6',
  },
  {
    id: 'tangle-router',
    label: 'Tangle Router',
    placeholder: 'your-tangle-router-key',
    envKey: 'TANGLE_API_KEY',
    modelProvider: 'openrouter',
    modelName: 'anthropic/claude-sonnet-4-6',
  },
];

export function buildEnvForProvider(provider: AiProvider, key: string): Record<string, string> {
  const config = AI_PROVIDERS.find((p) => p.id === provider) ?? AI_PROVIDERS[0];
  const env: Record<string, string> = {
    OPENCODE_MODEL_PROVIDER: config.modelProvider,
    OPENCODE_MODEL_NAME: config.modelName,
    OPENCODE_MODEL_API_KEY: key,
  };
  // Also set the provider-native key so inner session reads it
  env[config.envKey] = key;
  if (provider === 'tangle-router') {
    env.TANGLE_ROUTER_BASE_URL = DEFAULT_TANGLE_ROUTER_BASE_URL;
    env.OPENCODE_MODEL_BASE_URL = DEFAULT_TANGLE_ROUTER_BASE_URL;
  }
  return env;
}

export const ACTIVATION_LABELS: Record<string, string> = {
  validating: 'Loading bot configuration...',
  recreating_sidecar: 'Recreating container with secrets...',
  running_setup: 'Installing strategy dependencies...',
  creating_workflow: 'Configuring trading loop...',
  complete: 'Agent activated!',
};
