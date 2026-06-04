import { ConnectKitButton } from 'connectkit';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

interface ConnectWalletPanelProps {
  title?: string;
  description: string;
  footnote?: ReactNode;
  bullets?: readonly string[];
}

const launchRoutes = [
  {
    label: 'New Agent',
    href: '/create',
    icon: 'i-ph:chat-circle-dots',
    meta: 'paper first',
  },
  {
    label: 'Activate Agent',
    href: '/provision',
    icon: 'i-ph:rocket-launch',
    meta: 'wallet',
  },
  {
    label: 'Live Activity',
    href: '/activity',
    icon: 'i-ph:pulse',
    meta: 'fills',
  },
] as const;

export function ConnectWalletPanel({
  title = 'Connect your wallet',
  description,
  footnote,
  bullets,
}: ConnectWalletPanelProps) {
  const checks = bullets && bullets.length > 0 ? bullets : [
    'Operator access',
    'Agent funding',
    'Live telemetry',
  ];

  return (
    <div className="arena-trace-terminal flex min-h-full bg-[#081013] text-[#f6fefd] lg:h-full">
      <div className="mx-auto flex w-full max-w-[1260px] flex-1 flex-col gap-3 lg:h-full lg:min-h-0">
        <section className="grid border border-[#273035] bg-[#0b1418] lg:h-full lg:min-h-[560px] lg:grid-rows-[auto_minmax(0,1fr)] lg:overflow-hidden">
          <div className="grid gap-4 border-b border-[#273035] px-4 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
            <div className="min-w-0">
              <p className="font-mono text-xs uppercase tracking-[0.18em] text-[#50d2c1]">
                Arena Access
              </p>
              <h1 className="mt-1 text-pretty font-display text-2xl font-semibold tracking-tight text-[#f6fefd] md:text-3xl">
                {title}
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-5 text-[#949e9c]">
                {description}
              </p>
            </div>
            <div className="grid grid-cols-3 overflow-hidden border border-[#273035] bg-[#081013] font-mono text-[11px] uppercase tracking-[0.12em] text-[#949e9c] md:w-[390px]">
              <span className="border-r border-[#273035] px-3 py-2 text-center">Base</span>
              <span className="border-r border-[#273035] px-3 py-2 text-center">Paper</span>
              <span className="px-3 py-2 text-center text-[#50d2c1]">Risk</span>
            </div>
          </div>

          <div className="grid gap-3 p-3 lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="grid gap-3 lg:min-h-0 lg:grid-rows-[auto_minmax(0,1fr)]">
              <section className="overflow-hidden border border-[#273035] bg-[#081013]">
                <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] border-b border-[#273035] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#697371]">
                  <span>Launch Check</span>
                  <span className="text-right">State</span>
                </div>
                {checks.map((bullet) => (
                  <div
                    key={bullet}
                    className="grid grid-cols-[24px_minmax(0,1fr)_5.5rem] items-center gap-2 border-b border-[#273035] px-3 py-2.5 last:border-b-0"
                  >
                    <span className="i-ph:check-circle text-base text-[#50d2c1]" aria-hidden="true" />
                    <span className="min-w-0 truncate font-display text-sm font-semibold text-[#f6fefd]">{bullet}</span>
                    <span className="text-right font-mono text-xs text-[#50d2c1]">Ready</span>
                  </div>
                ))}
              </section>

              <section className="grid gap-2 border border-[#273035] bg-[#081013] p-2 lg:min-h-0 lg:grid-rows-[auto_minmax(0,1fr)]">
                <div className="grid gap-2 md:grid-cols-3">
                  {launchRoutes.map((route) => (
                    <Link
                      key={route.href}
                      to={route.href}
                      className="group grid min-h-[118px] content-between rounded-[5px] border border-[#273035] bg-[#0f1a1f] p-3 transition-[background-color,border-color,transform] duration-150 hover:border-[#50d2c1]/55 hover:bg-[#132329] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="flex h-10 w-10 items-center justify-center rounded-[5px] bg-[#143c38] text-[#50d2c1]">
                          <span className={`${route.icon} text-xl`} aria-hidden="true" />
                        </span>
                        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-[#697371]">
                          {route.meta}
                        </span>
                      </span>
                      <span className="mt-5 flex items-center justify-between gap-3">
                        <span className="font-display text-base font-semibold text-[#f6fefd]">
                          {route.label}
                        </span>
                        <span className="i-ph:arrow-right text-base text-[#697371] transition-[color,transform] duration-150 group-hover:translate-x-0.5 group-hover:text-[#50d2c1]" aria-hidden="true" />
                      </span>
                    </Link>
                  ))}
                </div>
                <div className="min-h-0 overflow-hidden border border-[#273035] bg-[#0f1a1f]">
                  <div className="grid grid-cols-[2rem_minmax(0,1fr)_8rem] border-b border-[#273035] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#697371]">
                    <span>#</span>
                    <span>Launch Path</span>
                    <span className="text-right">Surface</span>
                  </div>
                  {[
                    ['01', 'Create paper agent', 'New Agent'],
                    ['02', 'Sign service ownership', 'Activation'],
                    ['03', 'Start operator runtime', 'Agent'],
                    ['04', 'Watch fills and runs', 'Activity'],
                  ].map(([index, action, surface]) => (
                    <div
                      key={index}
                      className="grid grid-cols-[2rem_minmax(0,1fr)_8rem] items-center border-b border-[#273035] px-3 py-2.5 last:border-b-0"
                    >
                      <span className="font-mono text-xs text-[#50d2c1]">{index}</span>
                      <span className="truncate font-display text-sm font-semibold text-[#f6fefd]">{action}</span>
                      <span className="truncate text-right font-mono text-xs text-[#949e9c]">{surface}</span>
                    </div>
                  ))}
                </div>
              </section>
            </div>

            <aside className="flex flex-col justify-between gap-3 border border-[#273035] bg-[#081013] p-3 lg:min-h-0">
              <div>
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-[5px] bg-[#143c38] text-[#50d2c1]">
                  <span className="i-ph:wallet text-xl" aria-hidden="true" />
                </div>
                <h2 className="font-display text-lg font-semibold text-[#f6fefd]">
                  Owner Wallet
                </h2>
                <p className="mt-1 text-sm leading-5 text-[#949e9c]">
                  Connect once to unlock service creation and operator access.
                </p>
                <div className="space-y-2 border-y border-[#273035] py-3 font-mono text-xs">
                  <ReadoutRow label="Owner" value="wallet" />
                  <ReadoutRow label="Route" value="agent launch" />
                  <ReadoutRow label="Access" value="operator" />
                </div>
                <div className="mt-3 space-y-2 rounded-[5px] border border-[#273035] bg-[#0f1a1f] p-3 font-mono text-xs">
                  <ReadoutRow label="Network" value="base" />
                  <ReadoutRow label="Mode" value="paper first" />
                  <ReadoutRow label="Risk" value="gated" />
                  <ReadoutRow label="Scope" value="owner" />
                </div>
              </div>
              <ConnectKitButton.Custom>
                {({ show, isConnecting }) => (
                  <button
                    type="button"
                    onClick={() => show?.()}
                    disabled={!show || isConnecting}
                    className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-[5px] bg-[#50d2c1] px-4 font-display text-sm font-semibold text-[#06100e] transition-[background-color,opacity,transform] duration-150 hover:bg-[#7ce6d9] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
                  >
                    {isConnecting ? (
                      <>
                        <span className="h-3.5 w-3.5 rounded-full border-2 border-[#06100e]/25 border-t-[#06100e]" />
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
            </aside>
          </div>
        </section>
        {footnote && (
          <p className="self-end font-mono text-xs text-[#697371]">
            {footnote}
          </p>
        )}
      </div>
    </div>
  );
}

function ReadoutRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-3">
      <span className="uppercase tracking-[0.12em] text-[#697371]">{label}</span>
      <span className="min-w-0 truncate text-right text-[#d2dad7]">{value}</span>
    </div>
  );
}
