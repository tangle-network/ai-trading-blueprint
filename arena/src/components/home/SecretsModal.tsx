import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@tangle/blueprint-ui/components';
import { toast } from 'sonner';
import { SecretsProviderFields, type SecretsEnvVar } from '~/components/secrets/SecretsProviderFields';
import { updateProvision } from '~/lib/stores/provisions';
import { resolveBotId as resolveBot } from '~/lib/utils/resolveBotId';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import {
  buildEnvForProvider,
  ACTIVATION_LABELS,
  DEFAULT_AI_PROVIDER,
  DEFAULT_AI_API_KEY,
  type AiProvider,
} from '~/lib/config/aiProviders';

const OPERATOR_API_URL = import.meta.env.VITE_OPERATOR_API_URL ?? '';

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

  const [lookupError, setLookupError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clean up poll interval when dialog closes or component unmounts
  useEffect(() => {
    if (!target) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      setIsSubmitting(false);
      setActivationPhase(null);
    }
  }, [target]);

  const resolveBotId = useCallback(async (t: SecretsTarget): Promise<string | null> => {
    const result = await resolveBot(OPERATOR_API_URL, {
      botId: t.botId,
      callId: t.callId,
      serviceId: t.serviceId,
      sandboxId: t.sandboxId,
    });
    if ('botId' in result) {
      setLookupError(null);
      return result.botId;
    }
    setLookupError(result.error);
    return null;
  }, []);

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

    if (pollRef.current) clearInterval(pollRef.current);
    let pollFailures = 0;
    const pollStart = Date.now();
    const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes hard cap
    pollRef.current = setInterval(async () => {
      if (Date.now() - pollStart > POLL_TIMEOUT_MS) {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        return;
      }
      try {
        const res = await fetch(`${OPERATOR_API_URL}/api/bots/${botId}/activation-progress`);
        if (res.ok) {
          const data = await res.json();
          setActivationPhase(data.phase ?? null);
          pollFailures = 0;
        } else {
          pollFailures++;
        }
      } catch {
        pollFailures++;
      }
      if (pollFailures >= 10 && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
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

      let res = await fetch(`${OPERATOR_API_URL}/api/bots/${botId}/secrets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({ env_json: envJson }),
      });

      // Retry once with fresh token on 401 (stale PASETO)
      if (res.status === 401) {
        authToken = await operatorAuth.authenticate();
        if (!authToken) throw new Error('Re-authentication failed');
        res = await fetch(`${OPERATOR_API_URL}/api/bots/${botId}/secrets`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
          },
          body: JSON.stringify({ env_json: envJson }),
        });
      }

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
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
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
