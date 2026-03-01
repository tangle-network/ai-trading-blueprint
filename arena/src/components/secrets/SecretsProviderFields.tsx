import type { MutableRefObject } from 'react';
import { Input } from '@tangle/blueprint-ui/components';
import {
  AI_PROVIDERS,
  DEFAULT_AI_API_KEY,
  type AiProvider,
} from '~/lib/config/aiProviders';

export type SecretsEnvVar = { id: number; key: string; value: string };

type SecretsProviderFieldsVariant = 'modal' | 'card';

interface SecretsProviderFieldsProps {
  provider: AiProvider;
  setProvider: (v: AiProvider) => void;
  apiKey: string;
  setApiKey: (v: string) => void;
  extraEnvs: SecretsEnvVar[];
  setExtraEnvs: (v: SecretsEnvVar[]) => void;
  envIdRef: MutableRefObject<number>;
  defaultProvider: AiProvider;
  variant?: SecretsProviderFieldsVariant;
}

const VARIANT_STYLES = {
  modal: {
    providerButtonSelected: 'border-violet-500 bg-violet-500/10 text-arena-elements-textPrimary',
    providerButtonUnselected: 'border-arena-elements-borderColor bg-arena-elements-background-depth-3 text-arena-elements-textSecondary hover:border-arena-elements-borderColorActive',
    providerButton: 'flex-1 px-3 py-2 rounded-md text-sm font-data border transition-colors',
  },
  card: {
    providerButtonSelected: 'border-violet-500/50 bg-violet-500/10 text-arena-elements-textPrimary ring-1 ring-violet-500/20',
    providerButtonUnselected: 'border-arena-elements-borderColor bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1 text-arena-elements-textSecondary hover:border-arena-elements-borderColorActive',
    providerButton: 'flex-1 px-3 py-2.5 rounded-lg text-sm font-data border transition-all',
  },
} as const;

export function SecretsProviderFields({
  provider,
  setProvider,
  apiKey,
  setApiKey,
  extraEnvs,
  setExtraEnvs,
  envIdRef,
  defaultProvider,
  variant = 'card',
}: SecretsProviderFieldsProps) {
  const providerConfig = AI_PROVIDERS.find((p) => p.id === provider) ?? AI_PROVIDERS[0];
  const styles = VARIANT_STYLES[variant];

  return (
    <>
      <div role="group" aria-label="AI Provider">
        <span className="text-sm font-display font-medium text-arena-elements-textPrimary block mb-1.5">
          AI Provider
        </span>
        <div className="flex gap-2">
          {AI_PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setProvider(p.id);
                if (p.id === defaultProvider && DEFAULT_AI_API_KEY) {
                  setApiKey(DEFAULT_AI_API_KEY);
                } else {
                  setApiKey('');
                }
              }}
              className={`${styles.providerButton} ${
                provider === p.id ? styles.providerButtonSelected : styles.providerButtonUnselected
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-arena-elements-textTertiary mt-1">
          Model: {providerConfig.modelName}
        </p>
      </div>

      <div>
        <label htmlFor="secrets-api-key" className="text-sm font-display font-medium text-arena-elements-textPrimary block mb-1.5">
          API Key <span className="text-crimson-400">*</span>
        </label>
        <Input
          id="secrets-api-key"
          type="password"
          placeholder={providerConfig.placeholder}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        {apiKey && DEFAULT_AI_API_KEY && apiKey === DEFAULT_AI_API_KEY && (
          <p className="text-xs text-emerald-500 mt-1">Pre-filled from local config</p>
        )}
      </div>

      {extraEnvs.map((env, i) => (
        <div key={env.id} className="flex gap-2">
          <Input
            placeholder="KEY"
            value={env.key}
            onChange={(e) => {
              const updated = [...extraEnvs];
              updated[i] = { ...env, key: e.target.value };
              setExtraEnvs(updated);
            }}
            className="flex-1"
            aria-label={`Environment variable ${i + 1} key`}
          />
          <Input
            type="password"
            placeholder="value"
            value={env.value}
            onChange={(e) => {
              const updated = [...extraEnvs];
              updated[i] = { ...env, value: e.target.value };
              setExtraEnvs(updated);
            }}
            className="flex-1"
            aria-label={`Environment variable ${i + 1} value`}
          />
          <button
            type="button"
            onClick={() => setExtraEnvs(extraEnvs.filter((_, j) => j !== i))}
            className="text-arena-elements-textTertiary hover:text-crimson-400 transition-colors px-1"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={() => {
          envIdRef.current += 1;
          setExtraEnvs([...extraEnvs, { id: envIdRef.current, key: '', value: '' }]);
        }}
        className="text-xs font-data text-violet-700 dark:text-violet-400 hover:underline"
      >
        + Add environment variable
      </button>
    </>
  );
}
