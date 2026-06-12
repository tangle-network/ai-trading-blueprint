import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Identicon } from '@tangle-network/blueprint-ui/components';
import type { Address } from 'viem';
import type { QuoteFailureKind } from '~/lib/hooks/useQuotes';
import { formatCost } from '~/routes/provision/types';
import { truncateAddress } from '~/lib/format';

export interface OperatorPickerOption {
  address: Address;
  /** Hostname of the operator's registered RPC endpoint, when parseable. */
  rpcHost?: string;
  /** Signed quote total. Present = the operator can take this launch. */
  quoteCost?: bigint;
  /** Quote failure classification. Present = shown disabled with a reason. */
  failure?: QuoteFailureKind;
  /** Quote request still in flight for this operator. */
  pending?: boolean;
}

interface OperatorPickerProps {
  options: OperatorPickerOption[];
  /** Effective operator the launch will bind to. */
  selected?: Address;
  /** Cheapest quoted operator — the default pick. */
  cheapest?: Address;
  onSelect: (address: Address) => void;
}

const FAILURE_TEXT: Record<QuoteFailureKind, string> = {
  unauthorized: 'Not accepting launches',
  at_capacity: 'At capacity',
  unreachable: 'Unreachable',
  cannot_price: 'No quote',
  misconfigured: 'No quote',
};

function sameAddress(a?: string, b?: string): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

/** Hostname for display from a registered operator RPC address. */
export function operatorRpcHost(rpcAddress?: string): string | undefined {
  if (!rpcAddress) return undefined;
  try {
    const url = new URL(
      rpcAddress.includes('://') ? rpcAddress : `https://${rpcAddress}`,
    );
    return url.hostname;
  } catch {
    return undefined;
  }
}

/**
 * The operator line of the quick-launch contract: collapsed it states the
 * picked operator and its signed price; expanded it lists every discovered
 * operator for the runtime so the user can re-target the launch. Price is the
 * deciding fact — operators without a signed quote stay visible but disabled.
 */
export function OperatorPicker({
  options,
  selected,
  cheapest,
  onSelect,
}: OperatorPickerProps) {
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((option) =>
    sameAddress(option.address, selected),
  );

  // Roving focus across enabled rows; selection only on explicit activation.
  const enabledAddresses = options
    .filter((option) => option.quoteCost != null)
    .map((option) => option.address);
  const [focusAddress, setFocusAddress] = useState<Address | undefined>(
    undefined,
  );
  const effectiveFocus =
    focusAddress && enabledAddresses.some((a) => sameAddress(a, focusAddress))
      ? focusAddress
      : selected;

  useEffect(() => {
    if (!expanded) setFocusAddress(undefined);
  }, [expanded]);

  const moveFocus = (delta: number) => {
    if (enabledAddresses.length === 0) return;
    const current = enabledAddresses.findIndex((a) =>
      sameAddress(a, effectiveFocus),
    );
    const next =
      current === -1
        ? 0
        : (current + delta + enabledAddresses.length) % enabledAddresses.length;
    const address = enabledAddresses[next];
    setFocusAddress(address);
    listRef.current
      ?.querySelector<HTMLButtonElement>(`[data-operator="${address}"]`)
      ?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        event.preventDefault();
        moveFocus(1);
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        event.preventDefault();
        moveFocus(-1);
        break;
      case 'Escape':
        setExpanded(false);
        break;
    }
  };

  const choose = (address: Address) => {
    onSelect(address);
    setExpanded(false);
  };

  return (
    <div className="border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)]">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
        className="flex w-full items-center justify-between gap-3 p-3 text-left transition-colors hover:bg-[var(--arena-terminal-panel-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)]"
      >
        <span className="flex min-w-0 items-center gap-3">
          {selectedOption ? (
            <Identicon address={selectedOption.address} size={28} />
          ) : (
            <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel-strong)] text-[var(--arena-terminal-muted)]">
              <span className="i-ph:receipt text-sm" aria-hidden="true" />
            </span>
          )}
          <span className="min-w-0">
            <span className="block font-data text-[11px] uppercase tracking-[0.08em] text-[var(--arena-terminal-text-subtle)]">
              Operator quote
            </span>
            <span className="mt-0.5 flex min-w-0 items-baseline gap-2 text-sm">
              <span className="truncate font-display font-semibold text-[var(--arena-terminal-text)]">
                {selectedOption
                  ? selectedOption.rpcHost ?? truncateAddress(selectedOption.address)
                  : 'Choosing...'}
              </span>
              {selectedOption?.quoteCost != null && (
                <span className="shrink-0 font-data font-semibold text-[var(--arena-terminal-accent)]">
                  {formatCost(selectedOption.quoteCost)}
                </span>
              )}
            </span>
          </span>
        </span>
        <span className="inline-flex h-8 shrink-0 items-center border border-[var(--arena-terminal-border)] px-2 font-display text-sm font-semibold text-[var(--arena-terminal-accent)]">
          {expanded ? 'Close' : 'Change'}
        </span>
      </button>

      {expanded && (
        <div
          ref={listRef}
          role="radiogroup"
          aria-label="Operator"
          onKeyDown={handleKeyDown}
          className="border-t border-[var(--arena-terminal-border)]"
        >
          {options.map((option) => {
            const isSelected = sameAddress(option.address, selected);
            const available = option.quoteCost != null;
            const isCheapest = available && sameAddress(option.address, cheapest);
            return (
              <button
                key={option.address}
                type="button"
                role="radio"
                aria-checked={isSelected}
                data-operator={option.address}
                disabled={!available}
                tabIndex={
                  available
                    ? sameAddress(option.address, effectiveFocus)
                      ? 0
                      : -1
                    : undefined
                }
                onClick={() => choose(option.address)}
                className={`flex w-full items-center justify-between gap-3 border-l-2 p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--arena-terminal-accent)] disabled:cursor-not-allowed ${
                  isSelected
                    ? 'border-l-[var(--arena-terminal-accent)] bg-[color-mix(in_srgb,var(--arena-terminal-accent)_8%,transparent)]'
                    : 'border-l-transparent motion-safe:transition-colors hover:bg-[color-mix(in_srgb,var(--arena-terminal-accent)_4%,transparent)] disabled:hover:bg-transparent'
                }`}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <Identicon address={option.address} size={26} />
                  <span className="flex min-w-0 flex-col">
                    <span
                      className={`truncate font-display text-sm font-semibold ${
                        available
                          ? 'text-arena-elements-textPrimary'
                          : 'text-arena-elements-textTertiary'
                      }`}
                    >
                      {option.rpcHost ?? truncateAddress(option.address)}
                    </span>
                    <span className="truncate font-data text-xs text-arena-elements-textTertiary">
                      {option.rpcHost ? truncateAddress(option.address) : 'Registered operator'}
                    </span>
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  {available ? (
                    <>
                      <span className="font-data text-sm font-semibold text-arena-elements-textPrimary">
                        {formatCost(option.quoteCost!)}
                      </span>
                      {isCheapest && (
                        <span className="ml-2 font-data text-xs text-arena-elements-textTertiary">
                          cheapest
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="font-data text-xs text-arena-elements-textTertiary">
                      {option.pending
                        ? 'Pricing…'
                        : option.failure
                          ? FAILURE_TEXT[option.failure]
                          : 'No quote'}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
