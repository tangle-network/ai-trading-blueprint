import type { MutableRefObject } from 'react';
import { Input } from '@tangle-network/blueprint-ui/components';
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
  revealValues?: boolean;
  showRevealToggle?: boolean;
  revealBusy?: boolean;
  revealDisabled?: boolean;
  onToggleReveal?: () => void;
}

const VARIANT_STYLES = {
  modal: {
    providerButtonSelected: 'border-[#50d2c1]/70 bg-[#143c38] text-arena-elements-textPrimary',
    providerButtonUnselected: 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] text-arena-elements-textSecondary hover:border-[#50d2c1]/50',
    providerButton: 'flex-1 rounded-[5px] border px-3 py-2 text-sm font-data transition-colors',
  },
  card: {
    providerButtonSelected: 'border-[#50d2c1]/70 bg-[#143c38] text-arena-elements-textPrimary ring-1 ring-[#50d2c1]/20',
    providerButtonUnselected: 'border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] text-arena-elements-textSecondary hover:border-[#50d2c1]/50',
    providerButton: 'flex-1 rounded-[5px] border px-3 py-2.5 text-sm font-data transition-[background-color,border-color,box-shadow]',
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
  revealValues = false,
  showRevealToggle = false,
  revealBusy = false,
  revealDisabled = false,
  onToggleReveal,
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
        <div className="relative">
          <Input
            id="secrets-api-key"
            type={revealValues ? 'text' : 'password'}
            placeholder={providerConfig.placeholder}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className={`${showRevealToggle ? 'pr-10 ' : ''}rounded-[5px] border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)]`}
          />
          {showRevealToggle && (
            <button
              type="button"
              onClick={onToggleReveal}
              disabled={revealDisabled || revealBusy}
              className="absolute right-2 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-[5px] text-arena-elements-textTertiary transition-colors hover:bg-arena-elements-background-depth-3 hover:text-arena-elements-textPrimary disabled:cursor-not-allowed disabled:opacity-50"
              title={revealValues ? 'Hide secrets' : 'Show secrets'}
              aria-label={revealValues ? 'Hide secrets' : 'Show secrets'}
            >
              <div
                className={`text-sm ${
                  revealBusy
                    ? 'i-ph:circle-notch animate-spin'
                    : revealValues
                      ? 'i-ph:eye'
                      : 'i-ph:eye-slash'
                }`}
              />
            </button>
          )}
        </div>
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
            className="flex-1 rounded-[5px] border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)]"
            aria-label={`Environment variable ${i + 1} key`}
          />
          <Input
            type={revealValues ? 'text' : 'password'}
            placeholder="value"
            value={env.value}
            onChange={(e) => {
              const updated = [...extraEnvs];
              updated[i] = { ...env, value: e.target.value };
              setExtraEnvs(updated);
            }}
            className="flex-1 rounded-[5px] border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)]"
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
        className="text-xs font-data text-[#50d2c1] hover:underline"
      >
        + Add environment variable
      </button>
    </>
  );
}
