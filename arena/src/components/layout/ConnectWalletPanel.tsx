import { ConnectKitButton } from 'connectkit';
import type { ReactNode } from 'react';

interface ConnectWalletPanelProps {
  /** Headline copy (default: "Connect your wallet") */
  title?: string;
  /** One-line explainer beneath the headline */
  description: string;
  /** Optional secondary description rendered below the CTA */
  footnote?: ReactNode;
  /** Optional bullet list of capabilities exposed once the wallet connects */
  bullets?: readonly string[];
}

// Theme-aware empty state used by routes that are dead in the water without a
// wallet (e.g. `/provision`). Uses the same glass-card vocabulary as the rest
// of the arena so it reads on both `data-theme="dark"` and `data-theme="light"`
// — no hardcoded `bg-black` / `text-white` / `text-gray-N`.
//
// The previous behaviour was to render route shells immediately; that meant
// the embedding iframe surfaced a solid black rectangle on a light-mode parent
// while wagmi reconnected. This panel takes the place of that void.
export function ConnectWalletPanel({
  title = 'Connect your wallet',
  description,
  footnote,
  bullets,
}: ConnectWalletPanelProps) {
  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-12 sm:py-16">
      <div className="glass-card-strong rounded-2xl border border-arena-elements-borderColor p-8 sm:p-10 text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-violet-500/10 border border-violet-500/20 mb-5">
          <span className="i-ph:wallet text-2xl text-violet-700 dark:text-violet-400" />
        </div>
        <h1 className="font-display font-bold text-2xl sm:text-3xl text-arena-elements-textPrimary tracking-tight mb-2">
          {title}
        </h1>
        <p className="text-base text-arena-elements-textSecondary mb-6">
          {description}
        </p>
        <ConnectKitButton.Custom>
          {({ show, isConnecting }) => (
            <button
              type="button"
              onClick={() => show?.()}
              disabled={!show || isConnecting}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-violet-500/10 border border-violet-500/30 text-violet-700 dark:text-violet-300 text-sm font-display font-semibold hover:bg-violet-500/20 hover:border-violet-500/50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isConnecting ? (
                <>
                  <span className="w-3.5 h-3.5 rounded-full border-2 border-violet-500/40 border-t-violet-600 dark:border-t-violet-300 animate-spin" />
                  Connecting…
                </>
              ) : (
                <>
                  <span className="i-ph:plug text-base" />
                  Connect Wallet
                </>
              )}
            </button>
          )}
        </ConnectKitButton.Custom>
        {bullets && bullets.length > 0 && (
          <ul className="mt-8 grid gap-2.5 text-left sm:grid-cols-2">
            {bullets.map((bullet) => (
              <li
                key={bullet}
                className="flex items-start gap-2 text-sm text-arena-elements-textSecondary"
              >
                <span className="i-ph:check-circle text-base text-arena-elements-icon-success mt-0.5 shrink-0" />
                <span>{bullet}</span>
              </li>
            ))}
          </ul>
        )}
        {footnote && (
          <p className="mt-6 text-xs text-arena-elements-textTertiary">
            {footnote}
          </p>
        )}
      </div>
    </div>
  );
}
