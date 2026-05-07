/**
 * Two-column envelope builder that lets the operator construct a
 * `SignedEnvelope` from typed inputs instead of hand-editing JSON.
 *
 * Left column: enforcement variant picker + per-variant binding fields.
 * Right column: bot/vault/chain identity, signers, expiry, nonce, and
 * the trading policy caps.
 *
 * Bottom: live validation issues from `validateEnvelopeForSigning`. The
 * "Use this envelope" button hands the in-progress draft up to the parent
 * via `onUseEnvelope` — the parent can then drop it into the existing
 * sign-and-submit flow.
 */

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@tangle-network/blueprint-ui/components';
import {
  ENFORCEMENT_KINDS,
  protocolForKind,
  type EnforcementKind,
  type EnvelopeEnforcement,
  type SignedEnvelope,
} from '~/lib/types/envelope';
import {
  validateEnvelopeForSigning,
  type EnvelopeValidationIssue,
} from '~/lib/envelope/validate';
import { defaultEnvelope, defaultEnforcementForKind } from './defaults';
import { EnforcementVariantPicker } from './EnforcementVariantPicker';
import { EnforcementFields } from './enforcement-fields';
import {
  AddressField,
  AmountField,
  FieldShell,
  NumberField,
  TextField,
  ToggleField,
} from './FormPrimitives';

export interface EnvelopeBuilderProps {
  /** Optional initial envelope (e.g. when editing an existing one). */
  initial?: SignedEnvelope;
  /** Pre-fills bot_id when starting from scratch. */
  defaultBotId?: string;
  defaultVaultAddress?: `0x${string}`;
  defaultChainId?: number;
  /** Called when the operator clicks "Use this envelope". */
  onUseEnvelope: (env: SignedEnvelope) => void;
  /** Optional cancel handler — surfaces a "Cancel" button when present. */
  onCancel?: () => void;
}

export function EnvelopeBuilder({
  initial,
  defaultBotId,
  defaultVaultAddress,
  defaultChainId,
  onUseEnvelope,
  onCancel,
}: EnvelopeBuilderProps) {
  const [draft, setDraft] = useState<SignedEnvelope>(() =>
    initial
      ?? defaultEnvelope({
        botId: defaultBotId,
        vaultAddress: defaultVaultAddress,
        chainId: defaultChainId,
      }),
  );

  // When the parent updates the initial values (e.g. switching bots), reset.
  useEffect(() => {
    if (initial) setDraft(initial);
  }, [initial]);

  const issues = useMemo(() => validateEnvelopeForSigning(draft), [draft]);

  const update = (patch: Partial<SignedEnvelope>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const setEnforcement = (next: EnvelopeEnforcement) => {
    setDraft((prev) => ({
      ...prev,
      enforcement: next,
      protocol: protocolForKind(next.kind),
    }));
  };

  const enforcementKind: EnforcementKind = draft.enforcement?.kind ?? 'uniswap_v3_swap';
  const enforcement: EnvelopeEnforcement =
    draft.enforcement ?? defaultEnforcementForKind('uniswap_v3_swap');

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Left column: enforcement */}
      <section className="rounded-lg border border-bp-elements-borderColor bg-bp-elements-background-depth-2 p-4 space-y-4">
        <h4 className="text-sm font-semibold uppercase tracking-wide text-bp-elements-textPrimary">
          On-chain enforcement
        </h4>
        <EnforcementVariantPicker
          value={enforcementKind}
          onChange={setEnforcement}
        />
        <div className="border-t border-bp-elements-borderColor pt-4">
          <EnforcementFields
            value={enforcement}
            onChange={setEnforcement}
          />
        </div>
      </section>

      {/* Right column: identity, signers, policy */}
      <section className="rounded-lg border border-bp-elements-borderColor bg-bp-elements-background-depth-2 p-4 space-y-4">
        <h4 className="text-sm font-semibold uppercase tracking-wide text-bp-elements-textPrimary">
          Envelope binding & policy
        </h4>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <TextField
            label="Bot id"
            value={draft.bot_id}
            onChange={(v) => update({ bot_id: v })}
            placeholder="bot-…"
          />
          <NumberField
            label="Chain id"
            value={draft.chain_id}
            onChange={(v) => update({ chain_id: v })}
            min={1}
          />
          <AddressField
            label="Vault address"
            value={draft.vault_address}
            onChange={(v) =>
              update({
                vault_address: v,
                // Mirror to verifying_contract by default; user can edit separately if needed.
                verifying_contract:
                  draft.verifying_contract === draft.vault_address
                    ? v
                    : draft.verifying_contract,
              })
            }
          />
          <AddressField
            label="Verifying contract"
            value={draft.verifying_contract}
            onChange={(v) => update({ verifying_contract: v })}
            hint="Defaults to vault address"
          />
          <TextField
            label="Protocol"
            value={draft.protocol}
            onChange={(v) => update({ protocol: v })}
            hint="Auto-set from enforcement variant"
          />
          <NumberField
            label="Nonce"
            value={draft.nonce}
            onChange={(v) => update({ nonce: v })}
            min={1}
          />
          <NumberField
            label="Issued at (unix)"
            value={draft.issued_at}
            onChange={(v) => update({ issued_at: v })}
          />
          <NumberField
            label="Expires at (unix)"
            value={draft.expires_at}
            onChange={(v) => update({ expires_at: v })}
            hint={`${Math.max(0, draft.expires_at - draft.issued_at)} sec window`}
          />
        </div>

        <SignersEditor
          signers={draft.approval_signers}
          onChange={(next) => update({ approval_signers: next })}
        />

        <NumberField
          label="Min signatures"
          value={draft.min_signatures}
          onChange={(v) => update({ min_signatures: v })}
          min={1}
          max={Math.max(1, draft.approval_signers.length)}
        />

        <div className="border-t border-bp-elements-borderColor pt-3 space-y-3">
          <h5 className="text-xs uppercase tracking-wide text-bp-elements-textTertiary font-medium">
            Trading policy
          </h5>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <FieldShell label="Max trade size (USD)">
              <DecimalInput
                value={draft.policy.max_trade_size_usd}
                onChange={(v) =>
                  update({
                    policy: { ...draft.policy, max_trade_size_usd: v },
                  })
                }
              />
            </FieldShell>
            <FieldShell label="Max total exposure (USD)">
              <DecimalInput
                value={draft.policy.max_total_exposure_usd}
                onChange={(v) =>
                  update({
                    policy: { ...draft.policy, max_total_exposure_usd: v },
                  })
                }
              />
            </FieldShell>
            <FieldShell label="Max drawdown (%)">
              <DecimalInput
                value={draft.policy.max_drawdown_pct}
                onChange={(v) =>
                  update({
                    policy: { ...draft.policy, max_drawdown_pct: v },
                  })
                }
              />
            </FieldShell>
            <ToggleField
              label="Can open positions"
              value={draft.policy.can_open_positions}
              onChange={(v) =>
                update({
                  policy: { ...draft.policy, can_open_positions: v },
                })
              }
              hint="Off = close-only mode"
            />
          </div>
        </div>
      </section>

      {/* Bottom: validation + actions */}
      <section className="lg:col-span-2 rounded-lg border border-bp-elements-borderColor bg-bp-elements-background-depth-2 p-4 space-y-3">
        <ValidationPanel issues={issues} />
        <div className="flex flex-wrap gap-2 justify-end">
          {onCancel && (
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button
            onClick={() => onUseEnvelope(draft)}
            disabled={issues.length > 0}
            data-testid="use-envelope-button"
          >
            Use this envelope
          </Button>
        </div>
      </section>
    </div>
  );
}

// ── Sub-components ──

function SignersEditor({
  signers,
  onChange,
}: {
  signers: `0x${string}`[];
  onChange: (next: `0x${string}`[]) => void;
}) {
  return (
    <FieldShell
      label="Approval signers"
      hint="EVM addresses authorized to co-sign this envelope"
    >
      <div className="space-y-2">
        {signers.length === 0 && (
          <p className="text-xs text-bp-elements-textTertiary">No signers yet.</p>
        )}
        {signers.map((signer, idx) => (
          <SignerRow
            key={idx}
            address={signer}
            onChange={(next) => {
              const copy = [...signers];
              copy[idx] = next;
              onChange(copy);
            }}
            onRemove={() => onChange(signers.filter((_, i) => i !== idx))}
          />
        ))}
        <Button
          variant="outline"
          onClick={() =>
            onChange([
              ...signers,
              '0x0000000000000000000000000000000000000000' as `0x${string}`,
            ])
          }
        >
          Add signer
        </Button>
      </div>
    </FieldShell>
  );
}

function SignerRow({
  address,
  onChange,
  onRemove,
}: {
  address: `0x${string}`;
  onChange: (next: `0x${string}`) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="flex-1">
        <AddressField
          label=""
          value={address}
          onChange={onChange}
        />
      </div>
      <Button variant="outline" onClick={onRemove}>
        Remove
      </Button>
    </div>
  );
}

function DecimalInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <input
      type="text"
      inputMode="decimal"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-11 rounded-lg px-3.5 py-2.5 text-base bg-bp-elements-background-depth-3 border border-bp-elements-borderColor text-bp-elements-textPrimary outline-none"
    />
  );
}

function ValidationPanel({ issues }: { issues: EnvelopeValidationIssue[] }) {
  if (issues.length === 0) {
    return (
      <div
        className="text-sm text-emerald-500"
        data-testid="validation-status"
      >
        Envelope structurally valid. Click "Use this envelope" to proceed to signing.
      </div>
    );
  }
  return (
    <div data-testid="validation-status">
      <div className="text-sm font-medium text-amber-500 mb-1">
        {issues.length} issue{issues.length === 1 ? '' : 's'} to resolve:
      </div>
      <ul className="text-xs space-y-0.5 list-disc pl-5">
        {issues.map((issue, idx) => (
          <li key={`${issue.field}:${idx}`} className="text-amber-400">
            <span className="font-mono">{issue.field}</span> — {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Re-export for tests / consumers that want the full kinds list.
export { ENFORCEMENT_KINDS };
