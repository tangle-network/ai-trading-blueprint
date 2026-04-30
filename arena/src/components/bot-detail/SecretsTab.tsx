import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@tangle-network/blueprint-ui/components';
import type { Bot } from '~/lib/types/bot';
import { useBotDetail } from '~/lib/hooks/useBotDetail';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import {
  buildBotScopedPathForDeploymentKind,
  getDeploymentKindForOperatorKind,
} from '~/lib/operator/meta';
import { readOperatorError } from '~/lib/operator/errors';
import { dispatchBotsRefresh } from '~/lib/events/bots';
import {
  ACTIVATION_LABELS,
  buildEnvForProvider,
  DEFAULT_AI_API_KEY,
  DEFAULT_AI_PROVIDER,
  type AiProvider,
} from '~/lib/config/aiProviders';
import {
  SecretsProviderFields,
  type SecretsEnvVar,
} from '~/components/secrets/SecretsProviderFields';
import { OperatorAccessCard } from '~/components/operator/OperatorAccessCard';
import { SkeletonCard } from '~/components/ui/Skeleton';

interface SecretsTabProps {
  bot: Bot;
}

type SecretsResponse = {
  status?: string;
  sandbox_id?: string | null;
  workflow_id?: string | null;
};

const WALLET_AUTH_REQUIRED_MESSAGE = 'Connect your wallet to manage this bot\'s secrets.';

export function SecretsTab({ bot }: SecretsTabProps) {
  const { address } = useAccount();
  const apiUrl = bot.operatorApiUrl ?? '';
  const deploymentKind = getDeploymentKindForOperatorKind(bot.operatorKind);
  const auth = useOperatorAuth(apiUrl);
  const queryClient = useQueryClient();
  const { data: detail, isLoading } = useBotDetail(bot.id, apiUrl, bot.operatorKind);
  const defaultProvider = (
    DEFAULT_AI_PROVIDER === 'zai' || DEFAULT_AI_PROVIDER === 'tangle-router'
      ? DEFAULT_AI_PROVIDER
      : 'anthropic'
  ) as AiProvider;
  const [provider, setProvider] = useState<AiProvider>(defaultProvider);
  const [apiKey, setApiKey] = useState(DEFAULT_AI_API_KEY);
  const [extraEnvs, setExtraEnvs] = useState<SecretsEnvVar[]>([]);
  const envIdRef = useRef(0);
  const [useOperatorKey, setUseOperatorKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activationPhase, setActivationPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmWipeOpen, setConfirmWipeOpen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isOwner = Boolean(
    detail?.submitter_address
      && address
      && detail.submitter_address.toLowerCase() === address.toLowerCase(),
  );
  const secretsConfigured = detail?.secrets_configured === true;
  const isAwaitingSecrets = detail?.lifecycle_status === 'awaiting_secrets';
  const canSubmit = useOperatorKey || apiKey.trim().length > 0;

  const secretsPath = useMemo(
    () => buildBotScopedPathForDeploymentKind(deploymentKind, bot.id, '/secrets'),
    [bot.id, deploymentKind],
  );
  const activationProgressPath = useMemo(
    () => buildBotScopedPathForDeploymentKind(deploymentKind, bot.id, '/activation-progress'),
    [bot.id, deploymentKind],
  );

  const invalidateBotData = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['bot-detail', apiUrl, bot.id] });
    queryClient.invalidateQueries({ queryKey: ['bot-metrics', apiUrl, bot.id] });
    queryClient.invalidateQueries({ queryKey: ['bot-trades', apiUrl, bot.id] });
    queryClient.invalidateQueries({ queryKey: ['bot-recent-validations', apiUrl, bot.id] });
    queryClient.invalidateQueries({ queryKey: ['bot-portfolio', apiUrl, bot.id] });
    queryClient.invalidateQueries({ queryKey: ['bot-enrichment', apiUrl, bot.id] });
    dispatchBotsRefresh();
  }, [apiUrl, bot.id, queryClient]);

  const clearPolling = useCallback(() => {
    if (!pollRef.current) return;
    clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  const operatorFetch = useCallback(async (
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
  ): Promise<Response> => {
    const send = async (forceRefresh = false): Promise<Response> => {
      const token = await auth.getToken(forceRefresh);
      if (!token) {
        throw new Error(WALLET_AUTH_REQUIRED_MESSAGE);
      }
      return fetch(`${apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    };

    let res = await send(false);
    if (res.status === 401) {
      res = await send(true);
    }
    return res;
  }, [apiUrl, auth]);

  const startActivationPolling = useCallback(() => {
    clearPolling();
    const startedAt = Date.now();
    const timeoutMs = 5 * 60 * 1000;
    let failures = 0;

    pollRef.current = setInterval(() => {
      void (async () => {
        if (Date.now() - startedAt > timeoutMs) {
          clearPolling();
          return;
        }

        try {
          const res = await operatorFetch(activationProgressPath, 'GET');
          if (!res.ok) {
            failures += 1;
          } else {
            const data = await res.json() as { phase?: string | null };
            setActivationPhase(data.phase ?? null);
            failures = 0;
          }
        } catch {
          failures += 1;
        }

        if (failures >= 10) clearPolling();
      })();
    }, 1000);
  }, [activationProgressPath, clearPolling, operatorFetch]);

  const buildSecretsEnv = useCallback((): Record<string, string> => {
    if (useOperatorKey) return {};

    const envJson = buildEnvForProvider(provider, apiKey.trim());
    for (const envVar of extraEnvs) {
      const key = envVar.key.trim();
      const value = envVar.value.trim();
      if (!key || !value) continue;
      envJson[key] = value;
    }
    return envJson;
  }, [apiKey, extraEnvs, provider, useOperatorKey]);

  const postSecrets = useCallback(async (envJson: Record<string, string>) => {
    const res = await operatorFetch(secretsPath, 'POST', { env_json: envJson });
    if (!res.ok) throw await readOperatorError(res);
    return res.json() as Promise<SecretsResponse>;
  }, [operatorFetch, secretsPath]);

  const deleteSecrets = useCallback(async () => {
    const res = await operatorFetch(secretsPath, 'DELETE');
    if (!res.ok) throw await readOperatorError(res);
    return res.json() as Promise<SecretsResponse>;
  }, [operatorFetch, secretsPath]);

  const handleSubmitSecrets = useCallback(async () => {
    if (!canSubmit || busy) return;

    setBusy(true);
    setError(null);
    setActivationPhase(null);
    startActivationPolling();
    let wipedExistingSecrets = false;

    try {
      if (secretsConfigured) {
        await deleteSecrets();
        wipedExistingSecrets = true;
      }
      await postSecrets(buildSecretsEnv());
      toast.success(secretsConfigured ? 'Secrets replaced and bot reactivated.' : 'Secrets configured and bot activated.');
      setApiKey('');
      setExtraEnvs([]);
      setUseOperatorKey(false);
      invalidateBotData();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update secrets';
      setError(message);
      toast.error(`Secrets update failed: ${message.slice(0, 160)}`);
      if (wipedExistingSecrets) {
        invalidateBotData();
      }
    } finally {
      clearPolling();
      setBusy(false);
      setActivationPhase(null);
    }
  }, [
    buildSecretsEnv,
    busy,
    canSubmit,
    clearPolling,
    deleteSecrets,
    invalidateBotData,
    postSecrets,
    secretsConfigured,
    startActivationPolling,
  ]);

  const handleWipeSecrets = useCallback(async () => {
    setConfirmWipeOpen(false);
    setBusy(true);
    setError(null);
    setActivationPhase(null);

    try {
      await deleteSecrets();
      toast.success('Secrets wiped. Bot is awaiting new secrets.');
      setApiKey('');
      setExtraEnvs([]);
      setUseOperatorKey(false);
      invalidateBotData();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to wipe secrets';
      setError(message);
      toast.error(`Wipe failed: ${message.slice(0, 160)}`);
    } finally {
      setBusy(false);
    }
  }, [deleteSecrets, invalidateBotData]);

  useEffect(() => {
    return () => clearPolling();
  }, [clearPolling]);

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (bot.verificationState === 'unverified') {
    return (
      <OperatorAccessCard
        title="Secrets unavailable"
        description="This bot is still using unverified fallback data, so secrets management stays disabled until the operator confirms the current state."
        apiUrl={apiUrl}
      />
    );
  }

  if (!auth.isAuthenticated && !detail) {
    return (
      <OperatorAccessCard
        title="Operator authentication required"
        description="Connect your wallet to manage this bot's runtime secrets."
        apiUrl={apiUrl}
      />
    );
  }

  if (!detail) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:lock-simple text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
        Bot detail not available from operator API.
      </div>
    );
  }

  if (!isOwner) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:shield-warning text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
        <h3 className="font-display font-semibold text-base text-arena-elements-textPrimary mb-2">
          Owner only
        </h3>
        <p className="text-sm">
          Only the wallet that provisioned this bot can manage its secrets.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-4">
        <div className="glass-card rounded-xl p-5 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="font-display font-bold text-lg">Runtime Secrets</h3>
              <p className="text-sm text-arena-elements-textSecondary mt-1">
                Replace the bot&apos;s private runtime environment without putting keys on-chain.
              </p>
            </div>
            <Badge variant={secretsConfigured ? 'success' : 'outline'}>
              {secretsConfigured ? 'Configured' : 'Not Set'}
            </Badge>
          </div>

          {error && (
            <div className="text-sm text-amber-500 p-3 rounded-lg bg-amber-500/5 border border-amber-500/20">
              {error}
            </div>
          )}

          {secretsConfigured && (
            <div className="text-sm text-arena-elements-textSecondary p-3 rounded-lg bg-arena-elements-background-depth-3 border border-arena-elements-borderColor">
              Existing secret values are hidden. Submitting this form wipes the current user-provided secrets, restarts the sidecar, and activates the bot with the new set.
            </div>
          )}

          {!secretsConfigured && isAwaitingSecrets && (
            <div className="text-sm text-emerald-500 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
              This bot is provisioned and ready for activation.
            </div>
          )}

          <button
            type="button"
            onClick={() => setUseOperatorKey(!useOperatorKey)}
            className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
              useOperatorKey
                ? 'border-violet-500/50 bg-violet-500/10 ring-1 ring-violet-500/20'
                : 'border-arena-elements-borderColor bg-arena-elements-background-depth-3 hover:border-arena-elements-borderColorActive'
            }`}
          >
            <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
              useOperatorKey ? 'border-violet-500 bg-violet-500' : 'border-arena-elements-textTertiary'
            }`}>
              {useOperatorKey && <div className="i-ph:check text-[10px] text-white" />}
            </div>
            <div>
              <span className="text-sm font-display font-medium text-arena-elements-textPrimary">
                Use operator-provided key
              </span>
              <p className="text-xs text-arena-elements-textTertiary mt-0.5">
                Skip manual key entry when this operator has pre-configured AI credentials.
              </p>
            </div>
          </button>

          {!useOperatorKey && (
            <SecretsProviderFields
              provider={provider}
              setProvider={setProvider}
              apiKey={apiKey}
              setApiKey={setApiKey}
              extraEnvs={extraEnvs}
              setExtraEnvs={setExtraEnvs}
              envIdRef={envIdRef}
              defaultProvider={defaultProvider}
              variant="card"
            />
          )}

          {busy && activationPhase && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/20">
              <div className="w-3 h-3 rounded-full border-2 border-amber-400 border-t-transparent animate-spin shrink-0" />
              <span className="text-sm font-data text-amber-400">
                {ACTIVATION_LABELS[activationPhase] ?? activationPhase}
              </span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => { void handleSubmitSecrets(); }}
              disabled={!canSubmit || busy}
            >
              {busy
                ? 'Updating...'
                : secretsConfigured
                  ? 'Replace Secrets'
                  : 'Activate With Secrets'}
            </Button>
            <Button
              variant="destructive"
              onClick={() => setConfirmWipeOpen(true)}
              disabled={!secretsConfigured || busy}
            >
              Wipe All Secrets
            </Button>
          </div>
        </div>

        <div className="glass-card rounded-xl p-5 h-fit space-y-4">
          <h3 className="font-display font-bold text-lg">What Changes</h3>
          <div className="space-y-3 text-sm text-arena-elements-textSecondary">
            <div className="flex gap-2">
              <div className="i-ph:eye-slash text-base text-arena-elements-textTertiary shrink-0 mt-0.5" />
              <p>Secret values are never shown back in the browser.</p>
            </div>
            <div className="flex gap-2">
              <div className="i-ph:arrows-clockwise text-base text-arena-elements-textTertiary shrink-0 mt-0.5" />
              <p>Replacing secrets restarts the bot sidecar so the new environment is applied.</p>
            </div>
            <div className="flex gap-2">
              <div className="i-ph:warning text-base text-arena-elements-textTertiary shrink-0 mt-0.5" />
              <p>Wiping secrets pauses the bot until new credentials are configured.</p>
            </div>
          </div>
        </div>
      </div>

      <Dialog open={confirmWipeOpen} onOpenChange={setConfirmWipeOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Wipe Bot Secrets?</DialogTitle>
            <DialogDescription>
              This removes all user-provided runtime secrets and restarts the bot sidecar without them. Trading and chat remain unavailable until new secrets are configured.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => setConfirmWipeOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => { void handleWipeSecrets(); }}
              disabled={busy}
            >
              {busy ? 'Wiping...' : 'Wipe Secrets'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
