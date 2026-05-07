/**
 * Bot detail "Envelope" tab — read/sign/revoke v3 SignedEnvelope.
 *
 * UX flow:
 *   1. Agent runtime constructs an unsigned envelope JSON (it has the policy,
 *      enforcement, and approval signers from configuration).
 *   2. Operator pastes that JSON here.
 *   3. UI validates structurally (matches server `EnvelopeError` rules) and
 *      shows a hash preview.
 *   4. Operator signs via wallet (`eth_signTypedData_v4` with the
 *      "TradingEnvelope" v2 EIP-712 domain). The signed envelope is then
 *      submitted to PUT /envelope.
 *
 * Status section displays:
 *   - protocol + enforcement variant
 *   - amount caps + min-output rate
 *   - signers + score weighting
 *   - issued/expires timestamps
 *   - signature count vs min_signatures
 */

import { useMemo, useState } from 'react';
import { useAccount, useSignTypedData } from 'wagmi';
import { Button } from '@tangle-network/blueprint-ui/components';
import {
  useDeleteEnvelope,
  useEnvelope,
  usePutEnvelope,
} from '~/lib/hooks/useEnvelope';
import { buildEnvelopeTypedData } from '~/lib/envelope/eip712';
import {
  validateEnvelopeForSigning,
  type EnvelopeValidationIssue,
} from '~/lib/envelope/validate';
import type { SignedEnvelope } from '~/lib/types/envelope';
import type { Bot } from '~/lib/types/bot';

interface EnvelopeTabProps {
  bot: Bot;
}

export function EnvelopeTab({ bot }: EnvelopeTabProps) {
  const args = useMemo(
    () => ({
      botId: bot.id,
      operatorKind: bot.operatorKind,
      apiUrl: bot.operatorApiUrl ?? undefined,
    }),
    [bot.id, bot.operatorKind, bot.operatorApiUrl],
  );

  const envelopeQuery = useEnvelope(args);
  const putEnvelope = usePutEnvelope(args);
  const deleteEnvelope = useDeleteEnvelope(args);

  return (
    <div className="space-y-6">
      <EnvelopeStatusCard
        envelope={envelopeQuery.data ?? null}
        loading={envelopeQuery.isLoading}
        error={envelopeQuery.error}
      />
      <SignAndSubmitCard
        existing={envelopeQuery.data ?? null}
        onSubmit={(env) => putEnvelope.mutateAsync(env)}
        submitting={putEnvelope.isPending}
        submitError={putEnvelope.error}
      />
      {envelopeQuery.data && (
        <RevokeCard
          onRevoke={() => deleteEnvelope.mutateAsync()}
          revoking={deleteEnvelope.isPending}
          error={deleteEnvelope.error}
        />
      )}
    </div>
  );
}

// ── Status display ──

function EnvelopeStatusCard({
  envelope,
  loading,
  error,
}: {
  envelope: SignedEnvelope | null;
  loading: boolean;
  error: Error | null;
}) {
  if (loading) return <Card title="Current envelope"><p className="text-sm">Loading…</p></Card>;
  if (error) return <Card title="Current envelope"><p className="text-sm text-red-500">{error.message}</p></Card>;
  if (!envelope) {
    return (
      <Card title="Current envelope">
        <p className="text-sm text-muted-foreground">No envelope on file. Sign and submit one below to enable envelope-mode trading.</p>
      </Card>
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const expired = envelope.expires_at <= now;
  const expiresIn = formatDuration(envelope.expires_at - now);

  return (
    <Card title="Current envelope">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <Field label="Protocol" value={envelope.protocol} />
        <Field label="Bot" value={envelope.bot_id} mono />
        <Field label="Vault" value={envelope.vault_address} mono />
        <Field label="Chain ID" value={String(envelope.chain_id)} />
        <Field label="Nonce" value={String(envelope.nonce)} />
        <Field
          label="Status"
          value={
            <span className={expired ? 'text-red-500' : 'text-emerald-500'}>
              {expired ? 'expired' : `active — expires in ${expiresIn}`}
            </span>
          }
        />
        <Field label="Signatures" value={`${envelope.signatures.length}/${envelope.min_signatures} required`} />
        <Field label="Approval signers" value={envelope.approval_signers.length.toString()} />
      </dl>
      {envelope.enforcement && (
        <div className="mt-4 border-t pt-3">
          <div className="text-xs font-semibold uppercase text-muted-foreground mb-2">On-chain enforcement</div>
          <pre className="text-xs bg-muted/30 rounded p-2 overflow-x-auto">
{JSON.stringify(envelope.enforcement, null, 2)}
          </pre>
        </div>
      )}
      <div className="mt-4 border-t pt-3">
        <div className="text-xs font-semibold uppercase text-muted-foreground mb-2">Policy</div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
          <Field label="Max trade (USD)" value={envelope.policy.max_trade_size_usd} small />
          <Field label="Max exposure (USD)" value={envelope.policy.max_total_exposure_usd} small />
          <Field label="Max drawdown" value={`${envelope.policy.max_drawdown_pct}%`} small />
          <Field label="Can open positions" value={envelope.policy.can_open_positions ? 'yes' : 'close-only'} small />
        </dl>
      </div>
    </Card>
  );
}

// ── Sign-and-submit ──

function SignAndSubmitCard({
  existing,
  onSubmit,
  submitting,
  submitError,
}: {
  existing: SignedEnvelope | null;
  onSubmit: (env: SignedEnvelope) => Promise<unknown>;
  submitting: boolean;
  submitError: Error | null;
}) {
  const [draft, setDraft] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [issues, setIssues] = useState<EnvelopeValidationIssue[]>([]);
  const { address: walletAddress } = useAccount();
  const { signTypedDataAsync, isPending: signing } = useSignTypedData();

  const parsedDraft = useMemo<SignedEnvelope | null>(() => {
    if (!draft.trim()) return null;
    try {
      const parsed = JSON.parse(draft) as SignedEnvelope;
      setParseError(null);
      return parsed;
    } catch (e) {
      setParseError((e as Error).message);
      return null;
    }
  }, [draft]);

  const onValidate = () => {
    if (!parsedDraft) return;
    setIssues(validateEnvelopeForSigning(parsedDraft));
  };

  const onSign = async () => {
    if (!parsedDraft) return;
    const validated = validateEnvelopeForSigning(parsedDraft);
    setIssues(validated);
    if (validated.length > 0) return;
    if (existing && parsedDraft.nonce <= existing.nonce) {
      setIssues([
        {
          field: 'nonce',
          message: `nonce ${parsedDraft.nonce} must be greater than current ${existing.nonce}`,
        },
      ]);
      return;
    }
    const typedData = buildEnvelopeTypedData(parsedDraft);
    const signature = await signTypedDataAsync(typedData);
    if (!walletAddress) throw new Error('Wallet not connected');

    const signed: SignedEnvelope = {
      ...parsedDraft,
      signatures: [
        ...parsedDraft.signatures,
        {
          signer: walletAddress as `0x${string}`,
          signature: signature as `0x${string}`,
          score: 100, // self-signed envelopes default to top score; multi-sig flows replace this
        },
      ],
    };
    await onSubmit(signed);
    setDraft('');
    setIssues([]);
  };

  return (
    <Card title="Sign and submit envelope">
      <p className="text-xs text-muted-foreground mb-2">
        Paste an unsigned envelope JSON from your agent runtime. The structure is validated client-side
        against the same rules the server enforces. You'll be asked to sign EIP-712 typed data via your wallet.
      </p>
      <textarea
        className="w-full font-mono text-xs bg-muted/30 rounded p-2 min-h-[200px]"
        placeholder='{"version":2,"bot_id":"...","protocol":"uniswap_v3",...}'
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setIssues([]);
        }}
      />
      {parseError && <p className="text-xs text-red-500 mt-1">JSON parse: {parseError}</p>}
      {issues.length > 0 && (
        <ul className="text-xs text-red-500 mt-2 list-disc pl-4">
          {issues.map((i, idx) => (
            <li key={`${i.field}:${idx}`}>
              <span className="font-mono">{i.field}</span> — {i.message}
            </li>
          ))}
        </ul>
      )}
      {submitError && <p className="text-xs text-red-500 mt-1">PUT /envelope: {submitError.message}</p>}
      <div className="flex gap-2 mt-3">
        <Button variant="outline" onClick={onValidate} disabled={!parsedDraft}>
          Validate
        </Button>
        <Button onClick={onSign} disabled={!parsedDraft || signing || submitting || !walletAddress}>
          {signing ? 'Awaiting signature…' : submitting ? 'Submitting…' : 'Sign & submit'}
        </Button>
      </div>
    </Card>
  );
}

// ── Revoke ──

function RevokeCard({
  onRevoke,
  revoking,
  error,
}: {
  onRevoke: () => Promise<unknown>;
  revoking: boolean;
  error: Error | null;
}) {
  return (
    <Card title="Revoke">
      <p className="text-xs text-muted-foreground mb-2">
        Clearing the stored envelope blocks new envelope-mode trades immediately. Already-confirmed
        on-chain trades cannot be reverted from here. To restore trading you must sign and submit a
        new envelope with a higher nonce.
      </p>
      {error && <p className="text-xs text-red-500 mb-2">{error.message}</p>}
      <Button variant="destructive" onClick={onRevoke} disabled={revoking}>
        {revoking ? 'Revoking…' : 'Revoke envelope'}
      </Button>
    </Card>
  );
}

// ── primitives ──

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <h3 className="text-sm font-semibold mb-3">{title}</h3>
      {children}
    </section>
  );
}

function Field({
  label,
  value,
  mono,
  small,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  small?: boolean;
}) {
  return (
    <div className={small ? 'flex justify-between' : 'flex flex-col'}>
      <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono text-xs break-all' : 'text-sm'}>{value}</dd>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0s';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m`;
  return `${seconds}s`;
}
