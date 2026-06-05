import { ConnectKitButton } from 'connectkit';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

interface ConnectWalletPanelProps {
  title?: string;
  description: string;
  footnote?: ReactNode;
  bullets?: readonly string[];
  actions?: readonly AccessAction[];
}

interface AccessAction {
  label: string;
  href: string;
  icon: string;
}

const defaultAccessActions = [
  {
    label: 'Agents',
    href: '/leaderboard',
    icon: 'i-ph:table',
  },
  {
    label: 'Activity',
    href: '/activity',
    icon: 'i-ph:pulse',
  },
  {
    label: 'New Agent',
    href: '/create',
    icon: 'i-ph:chat-circle-dots',
  },
] as const;

export function ConnectWalletPanel({
  title = 'Connect your wallet',
  description,
  footnote,
  actions = defaultAccessActions,
}: ConnectWalletPanelProps) {
  return (
    <div className="arena-trace-terminal flex min-h-full bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-text)] lg:h-full">
      <section className="flex w-full min-w-0 flex-col">
        <div className="shrink-0 border-b border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] px-3 py-3">
          <div className="flex min-w-0 flex-col gap-3 min-[900px]:flex-row min-[900px]:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-[var(--arena-terminal-border-hover)] bg-[var(--arena-terminal-accent-soft)] text-[var(--arena-terminal-accent)]">
                <span className="i-ph:wallet text-lg" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h1 className="truncate font-display text-lg font-semibold tracking-tight text-[var(--arena-terminal-text)]">
                {title}
                </h1>
                <p className="mt-0.5 max-h-10 max-w-[64rem] overflow-hidden text-sm leading-5 text-[var(--arena-terminal-text-muted)]">
                  {description}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2 min-[900px]:justify-end">
              {actions.map((action) => (
                <Link
                  key={action.href}
                  to={action.href}
                  className="arena-command-link-secondary inline-flex h-9 items-center gap-2 border px-3 font-display text-sm font-medium transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)] lg:hidden"
                >
                  <span className={`${action.icon} text-sm`} aria-hidden="true" />
                  {action.label}
                </Link>
              ))}
              <ConnectKitButton.Custom>
                {({ show, isConnecting }) => (
                  <button
                    type="button"
                    onClick={() => show?.()}
                    disabled={!show || isConnecting}
                    className="arena-command-link-primary inline-flex h-9 items-center justify-center gap-2 border px-3 font-display text-sm font-semibold transition-[background-color,opacity,transform] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--arena-terminal-accent)]"
                  >
                    {isConnecting ? (
                      <>
                        <span className="h-3.5 w-3.5 rounded-full border-2 border-[var(--arena-terminal-accent-text)]/25 border-t-[var(--arena-terminal-accent-text)]" />
                        Connecting…
                      </>
                    ) : (
                      <>
                        <span className="i-ph:plug text-base" aria-hidden="true" />
                        Connect Wallet
                      </>
                    )}
                  </button>
                )}
              </ConnectKitButton.Custom>
            </div>
          </div>
          {footnote && (
            <p className="mt-2 pl-12 font-data text-xs text-[var(--arena-terminal-text-subtle)]">
            {footnote}
            </p>
          )}
        </div>
        <div className="min-h-0 flex-1" />
      </section>
    </div>
  );
}
