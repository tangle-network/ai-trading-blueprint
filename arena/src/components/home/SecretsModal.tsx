import { useState, useRef, useCallback } from 'react';
import {
  Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, Input,
} from '@tangle/blueprint-ui/components';
import { toast } from 'sonner';
import { updateProvision } from '~/lib/stores/provisions';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import {
  AI_PROVIDERS,
  buildEnvForProvider,
  ACTIVATION_LABELS,
  DEFAULT_AI_PROVIDER,
  DEFAULT_AI_API_KEY,
  type AiProvider,
} from '~/lib/config/aiProviders';

const OPERATOR_API_URL = import.meta.env.VITE_OPERATOR_API_URL ?? '';

/** Generic target for secrets configuration — works from provisions or bot detail. */
export type SecretsTarget = {
  sandboxId: string;
  provisionId?: string; // If from a provision, to update provision store on success
};

export function SecretsModal({
  target,
  onClose,
}: {
  target: SecretsTarget | null;
  onClose: () => void;
}) {
  const defaultProvider = (DEFAULT_AI_PROVIDER === 'zai' ? 'zai' : 'anthropic') as AiProvider;
  const [provider, setProvider] = useState<AiProvider>(defaultProvider);
  const [apiKey, setApiKey] = useState(DEFAULT_AI_API_KEY);
  const [extraEnvs, setExtraEnvs] = useState<{ id: number; key: string; value: string }[]>([]);
  const envIdRef = useRef(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activationPhase, setActivationPhase] = useState<string | null>(null);
  const operatorAuth = useOperatorAuth(OPERATOR_API_URL);

  const providerConfig = AI_PROVIDERS.find((p) => p.id === provider) ?? AI_PROVIDERS[0];

  const [lookupError, setLookupError] = useState<string | null>(null);

  const resolveBotId = useCallback(async (sandboxId: string): Promise<string | null> => {
    if (!OPERATOR_API_URL) {
      setLookupError('Operator API URL not configured');
      return null;
    }
    try {
      const res = await fetch(`${OPERATOR_API_URL}/api/bots?limit=200`);
      if (!res.ok) {
        setLookupError('Failed to fetch bots from operator API');
        return null;
      }
      const data = await res.json();
      const match = data.bots?.find(
        (b: { sandbox_id: string }) => b.sandbox_id === sandboxId,
      );
      if (match) {
        setLookupError(null);
        return match.id as string;
      }
      setLookupError('Bot not found on operator. It may still be registering.');
      return null;
    } catch {
      setLookupError('Could not reach operator API');
      return null;
    }
  }, []);

  const handleSubmit = async () => {
    if (!target || !apiKey.trim() || !target.sandboxId) return;

    setIsSubmitting(true);
    setActivationPhase(null);
    setLookupError(null);

    const botId = await resolveBotId(target.sandboxId);
    if (!botId) {
      setIsSubmitting(false);
      return;
    }

    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${OPERATOR_API_URL}/api/bots/${botId}/activation-progress`);
        if (res.ok) {
          const data = await res.json();
          setActivationPhase(data.phase ?? null);
        }
      } catch {
        // Ignore polling errors
      }
    }, 1000);

    try {
      const envJson: Record<string, string> = buildEnvForProvider(provider, apiKey.trim());
      for (const e of extraEnvs) {
        if (e.key.trim() && e.value.trim()) {
          envJson[e.key.trim()] = e.value.trim();
        }
      }

      let authToken = operatorAuth.token;
      if (!authToken) {
        authToken = await operatorAuth.authenticate();
        if (!authToken) throw new Error('Wallet authentication failed');
      }

      const res = await fetch(`${OPERATOR_API_URL}/api/bots/${botId}/secrets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({ env_json: envJson }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `HTTP ${res.status}`);
      }

      const result = await res.json();

      if (target.provisionId) {
        updateProvision(target.provisionId, {
          phase: 'active',
          workflowId: result.workflow_id,
          sandboxId: result.sandbox_id ?? target.sandboxId,
        });
      }

      toast.success('API keys configured — agent is now active!');
      setApiKey('');
      setExtraEnvs([]);
      onClose();
    } catch (err) {
      toast.error(
        `Configuration failed: ${err instanceof Error ? err.message.slice(0, 200) : 'Unknown error'}`,
      );
    } finally {
      clearInterval(pollInterval);
      setIsSubmitting(false);
      setActivationPhase(null);
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Configure API Keys</DialogTitle>
          <DialogDescription>
            Your agent infrastructure is ready. Provide your API keys to activate trading. Keys are sent directly to the operator over HTTPS — never stored on-chain.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {lookupError && (
            <div className="text-sm text-amber-500 p-2 rounded bg-amber-500/5 border border-amber-500/20">
              {lookupError}
            </div>
          )}

          {/* Provider selector */}
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
                  className={`flex-1 px-3 py-2 rounded-md text-sm font-data border transition-colors ${
                    provider === p.id
                      ? 'border-violet-500 bg-violet-500/10 text-arena-elements-textPrimary'
                      : 'border-arena-elements-borderColor bg-arena-elements-background-depth-3 text-arena-elements-textSecondary hover:border-arena-elements-borderColorActive'
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
              <p className="text-xs text-emerald-500 mt-1">
                Pre-filled from local config
              </p>
            )}
          </div>

          {/* Extra env vars */}
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

          {/* Activation progress */}
          {isSubmitting && activationPhase && (
            <div className="flex items-center gap-2 p-2 rounded bg-amber-500/5 border border-amber-500/20">
              <div className="w-3 h-3 rounded-full border-2 border-amber-400 border-t-transparent animate-spin shrink-0" />
              <span className="text-xs font-data text-amber-300">
                {ACTIVATION_LABELS[activationPhase] ?? activationPhase}
              </span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={!apiKey.trim() || isSubmitting}
            >
              {isSubmitting ? 'Signing & Configuring...' : 'Sign & Configure'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
