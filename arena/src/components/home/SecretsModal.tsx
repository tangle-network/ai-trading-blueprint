import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@tangle/blueprint-ui/components';
import { toast } from 'sonner';
import { SecretsProviderFields, type SecretsEnvVar } from '~/components/secrets/SecretsProviderFields';
import { removeProvision, updateProvision } from '~/lib/stores/provisions';
import { resolveBotId as resolveBot } from '~/lib/utils/resolveBotId';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import { buildBotScopedPath, useOperatorMeta } from '~/lib/operator/meta';
import { isStaleStateError, readOperatorError } from '~/lib/operator/errors';
import { dispatchBotsRefresh } from '~/lib/events/bots';
import {
  buildEnvForProvider,
  ACTIVATION_LABELS,
  DEFAULT_AI_PROVIDER,
  DEFAULT_AI_API_KEY,
  type AiProvider,
} from '~/lib/config/aiProviders';

const OPERATOR_API_URL = import.meta.env.VITE_OPERATOR_API_URL ?? '';
const WALLET_AUTH_REQUIRED_MESSAGE = 'Wallet authentication required to load bot data.';

/** Generic target for secrets configuration — works from provisions or bot detail. */
export type SecretsTarget = {
  sandboxId?: string;
  callId?: number;
  serviceId?: number;
  botId?: string;
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
  const [extraEnvs, setExtraEnvs] = useState<SecretsEnvVar[]>([]);
  const envIdRef = useRef(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activationPhase, setActivationPhase] = useState<string | null>(null);
  const operatorAuth = useOperatorAuth(OPERATOR_API_URL);
  const { data: operatorMeta } = useOperatorMeta();

  const [lookupError, setLookupError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPolling = useCallback((): void => {
    if (!pollRef.current) return;
    clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  const getOperatorToken = useCallback(async (refresh = false): Promise<string | null> => {
    if (refresh) {
      operatorAuth.clearCachedToken();
    } else if (operatorAuth.token) {
      return operatorAuth.token;
    }

    const authToken = await operatorAuth.authenticate();
    if (!authToken) {
      setLookupError(WALLET_AUTH_REQUIRED_MESSAGE);
      return null;
    }

    return authToken;
  }, [operatorAuth]);

  // Clean up poll interval when dialog closes or component unmounts
  useEffect(() => {
    if (!target) {
      clearPolling();
      setIsSubmitting(false);
      setActivationPhase(null);
    }
  }, [clearPolling, target]);

  const resolveBotId = useCallback(async (t: SecretsTarget): Promise<string | null> => {
    let authToken = await getOperatorToken();
    if (!authToken) return null;

    let result = await resolveBot(OPERATOR_API_URL, {
      botId: t.botId,
      callId: t.callId,
      serviceId: t.serviceId,
      sandboxId: t.sandboxId,
      token: authToken,
    });
    if (!('botId' in result) && result.code === 'auth_required') {
      authToken = await getOperatorToken(true);
      if (!authToken) return null;
      result = await resolveBot(OPERATOR_API_URL, {
        botId: t.botId,
        callId: t.callId,
        serviceId: t.serviceId,
        sandboxId: t.sandboxId,
        token: authToken,
      });
    }

    if ('botId' in result) {
      if (t.provisionId && t.botId !== result.botId) {
        updateProvision(t.provisionId, { botId: result.botId });
      }
      setLookupError(null);
      return result.botId;
    }
    if (t.provisionId && (result.code === 'stale_state' || result.code === 'conflict')) {
      removeProvision(t.provisionId);
    }
    setLookupError(result.error);
    return null;
  }, [getOperatorToken]);

  const startActivationPolling = useCallback((botId: string): void => {
    clearPolling();

    const pollStart = Date.now();
    const pollTimeoutMs = 5 * 60 * 1000;
    let pollFailures = 0;

    pollRef.current = setInterval(async () => {
      if (Date.now() - pollStart > pollTimeoutMs) {
        clearPolling();
        return;
      }

      try {
        if (!operatorMeta) return;

        const headers: Record<string, string> = {};
        if (operatorAuth.token) {
          headers.Authorization = `Bearer ${operatorAuth.token}`;
        }

        const res = await fetch(
          `${OPERATOR_API_URL}${buildBotScopedPath(operatorMeta, botId, '/activation-progress')}`,
          { headers },
        );

        if (!res.ok) {
          pollFailures += 1;
        } else {
          const data = await res.json();
          setActivationPhase(data.phase ?? null);
          pollFailures = 0;
        }
      } catch {
        pollFailures += 1;
      }

      if (pollFailures >= 10) {
        clearPolling();
      }
    }, 1000);
  }, [clearPolling, operatorAuth.token, operatorMeta]);

  const buildSecretsEnv = useCallback((): Record<string, string> => {
    const envJson = buildEnvForProvider(provider, apiKey.trim());

    for (const envVar of extraEnvs) {
      const key = envVar.key.trim();
      const value = envVar.value.trim();
      if (!key || !value) continue;
      envJson[key] = value;
    }

    return envJson;
  }, [apiKey, extraEnvs, provider]);

  const submitSecrets = useCallback(async (
    botId: string,
    envJson: Record<string, string>,
  ): Promise<{ workflow_id?: number; sandbox_id?: string }> => {
    if (!operatorMeta) {
      throw new Error('Operator metadata not loaded');
    }

    const secretsPath = `${OPERATOR_API_URL}${buildBotScopedPath(operatorMeta, botId, '/secrets')}`;

    const postSecrets = async (authToken: string): Promise<Response> => {
      return fetch(secretsPath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ env_json: envJson }),
      });
    };

    let authToken = await getOperatorToken();
    if (!authToken) {
      throw new Error('Wallet authentication failed');
    }

    let res = await postSecrets(authToken);
    if (res.status === 401) {
      authToken = await getOperatorToken(true);
      if (!authToken) {
        throw new Error('Re-authentication failed');
      }
      res = await postSecrets(authToken);
    }

    if (!res.ok) {
      throw await readOperatorError(res);
    }

    return res.json();
  }, [getOperatorToken, operatorMeta]);

  const handleSubmit = async () => {
    if (!target || !apiKey.trim()) return;

    setIsSubmitting(true);
    setActivationPhase(null);
    setLookupError(null);

    const botId = await resolveBotId(target);
    if (!botId) {
      setIsSubmitting(false);
      return;
    }

    startActivationPolling(botId);

    try {
      const result = await submitSecrets(botId, buildSecretsEnv());

      if (target.provisionId) {
        updateProvision(target.provisionId, {
          phase: 'active',
          workflowId: result.workflow_id,
          sandboxId: result.sandbox_id ?? target.sandboxId,
        });
      }

      toast.success('API keys configured — agent is now active!');
      dispatchBotsRefresh();
      setApiKey('');
      setExtraEnvs([]);
      onClose();
    } catch (err) {
      if (isStaleStateError(err)) {
        setLookupError(err.message);
      }
      toast.error(
        `Configuration failed: ${err instanceof Error ? err.message.slice(0, 200) : 'Unknown error'}`,
      );
    } finally {
      clearPolling();
      setIsSubmitting(false);
      setActivationPhase(null);
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open: boolean) => !open && onClose()}>
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

          <SecretsProviderFields
            provider={provider}
            setProvider={setProvider}
            apiKey={apiKey}
            setApiKey={setApiKey}
            extraEnvs={extraEnvs}
            setExtraEnvs={setExtraEnvs}
            envIdRef={envIdRef}
            defaultProvider={defaultProvider}
            variant="modal"
          />

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
