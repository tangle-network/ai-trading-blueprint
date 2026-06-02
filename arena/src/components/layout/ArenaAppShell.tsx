import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { useState } from 'react';
import type { Address } from 'viem';
import { useAccount } from 'wagmi';
import { ChainSwitcher, Identicon, TangleLogo, ThemeToggle } from '@tangle-network/blueprint-ui/components';
import { cn } from '@tangle-network/blueprint-ui';
import { useBots } from '~/lib/hooks/useBots';
import { botStatusLabel, formatNumber } from '~/lib/format';
import { TxDropdown } from './TxDropdown';
import { WalletButton } from './WalletButton';

const primaryNavItems = [
  { label: 'Home', href: '/dashboard', icon: 'i-ph:house' },
  { label: 'Leaderboard', href: '/', icon: 'i-ph:trophy' },
  { label: 'Deploy Agent', href: '/provision', icon: 'i-ph:rocket-launch' },
  { label: 'Create From Chat', href: '/create', icon: 'i-ph:chat-circle-dots' },
];

function isNavActive(pathname: string, href: string) {
  if (href === '/') return pathname === '/' || pathname === '/arena';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function formatReturn(value: number) {
  if (!Number.isFinite(value) || value === 0) return '—';
  return `${value > 0 ? '+' : ''}${formatNumber(value, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  })}%`;
}

export function ArenaAppShell() {
  const location = useLocation();
  const { address, isConnected } = useAccount();
  const { bots } = useBots();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const activeAgents = bots
    .filter((bot) => bot.verificationState !== 'unverified')
    .filter((bot) => bot.status === 'active' || bot.status === 'paused' || bot.totalTrades > 0)
    .sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (b.status === 'active' && a.status !== 'active') return 1;
      return b.pnlPercent - a.pnlPercent;
    })
    .slice(0, 8);
  const normalizedAddress = address?.toLowerCase() ?? null;
  const ownedAgentIds = new Set(
    normalizedAddress
      ? activeAgents
        .filter((bot) => bot.submitterAddress?.toLowerCase() === normalizedAddress)
        .map((bot) => bot.id)
      : [],
  );
  const ownedAgents = activeAgents.filter((bot) => ownedAgentIds.has(bot.id)).slice(0, 4);
  const fleetAgents = (ownedAgents.length > 0
    ? activeAgents.filter((bot) => !ownedAgentIds.has(bot.id))
    : activeAgents).slice(0, ownedAgents.length > 0 ? 6 : 8);
  const agentSections = ownedAgents.length > 0
    ? [
        { label: 'My Agents', bots: ownedAgents },
        { label: 'Fleet', bots: fleetAgents },
      ]
    : [{ label: 'Fleet', bots: fleetAgents }];

  return (
    <div className="bp-tone-arena flex h-[100dvh] overflow-hidden bg-arena-elements-background-depth-1 text-arena-elements-textPrimary bg-mesh bg-noise">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:rounded-lg focus:bg-violet-600 focus:text-white focus:text-sm focus:font-display focus:font-medium"
      >
        Skip to content
      </a>

      <aside
        className={cn(
          'relative z-10 hidden shrink-0 flex-col border-r border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/86 shadow-[12px_0_38px_rgba(0,0,0,0.18)] backdrop-blur-xl transition-[width] duration-200 lg:flex',
          sidebarCollapsed ? 'w-20' : 'w-64',
        )}
      >
        <div className={cn(
          'flex h-14 shrink-0 items-center gap-2 border-b border-arena-elements-dividerColor/70 px-3',
          sidebarCollapsed ? 'justify-center' : 'justify-between',
        )}>
          <Link to="/" className={cn('flex min-w-0 items-center', sidebarCollapsed && 'sr-only')}>
            <TangleLogo label={sidebarCollapsed ? undefined : 'Trading Cloud'} />
          </Link>
          <button
            type="button"
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-1/52 text-arena-elements-textSecondary transition-colors hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <span className={sidebarCollapsed ? 'i-ph:caret-right-bold text-lg' : 'i-ph:caret-left-bold text-lg'} />
          </button>
        </div>

        <nav className="shrink-0 space-y-1 px-2 py-3" aria-label="Arena navigation">
          {primaryNavItems.map((item) => {
            const active = isNavActive(location.pathname, item.href);
            return (
              <NavLink
                key={item.href}
                to={item.href}
                className={cn(
                  'flex h-10 items-center rounded-lg text-sm font-display font-medium transition-colors',
                  sidebarCollapsed ? 'justify-center px-0' : 'gap-2.5 px-3',
                  active
                    ? 'bg-violet-500/14 text-arena-elements-textPrimary'
                    : 'text-arena-elements-textSecondary hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary',
                )}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <span className={`${item.icon} text-base ${active ? 'text-violet-500 dark:text-violet-300' : 'text-arena-elements-textTertiary'}`} aria-hidden="true" />
                {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
              </NavLink>
            );
          })}
        </nav>

        <div className="min-h-0 flex-1 border-t border-arena-elements-dividerColor/60 px-2 py-3">
          {!sidebarCollapsed && (
            <div className="mb-2 flex items-center justify-between px-2">
              <div className="font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary">
                Agents
              </div>
              <Link
                to="/"
                className="font-data text-[10px] uppercase tracking-wider text-arena-elements-textTertiary transition-colors hover:text-arena-elements-textPrimary"
              >
                View all
              </Link>
            </div>
          )}
          <div className="space-y-1 overflow-y-auto pr-1">
            {activeAgents.length === 0 ? (
              <div className={cn(
                'rounded-lg border border-dashed border-arena-elements-dividerColor/70 text-xs text-arena-elements-textTertiary',
                sidebarCollapsed ? 'px-2 py-3 text-center' : 'px-3 py-4',
              )}>
                {isConnected ? 'No active agents yet.' : 'Connect to load operator agents.'}
              </div>
            ) : agentSections.map((section) => (
              <div key={section.label} className="space-y-1">
                {!sidebarCollapsed && (
                  <div className="px-2 pb-1 pt-2 font-data text-[10px] font-semibold uppercase tracking-wider text-arena-elements-textTertiary first:pt-0">
                    {section.label}
                  </div>
                )}
                {section.bots.map((bot) => {
                  const selected = location.pathname.startsWith(`/arena/bot/${bot.id}`);
                  const positive = bot.pnlPercent >= 0;
                  return (
                    <Link
                      key={bot.id}
                      to={`/arena/bot/${encodeURIComponent(bot.id)}/performance`}
                      className={cn(
                        'group flex items-center rounded-lg border transition-colors',
                        sidebarCollapsed ? 'min-h-12 justify-center px-0 py-2' : 'min-h-[56px] gap-2 px-2 py-2',
                        selected
                          ? 'border-violet-500/28 bg-violet-500/12'
                          : 'border-transparent hover:border-arena-elements-dividerColor/70 hover:bg-arena-elements-item-backgroundHover',
                      )}
                      title={sidebarCollapsed ? `${section.label}: ${bot.name}` : undefined}
                    >
                      <Identicon address={bot.operatorAddress as Address} size={sidebarCollapsed ? 28 : 26} />
                      {!sidebarCollapsed && (
                        <>
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-display text-sm font-semibold text-arena-elements-textPrimary">
                              {bot.name}
                            </div>
                            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-arena-elements-textTertiary">
                              <span className={cn(
                                'h-1.5 w-1.5 rounded-full',
                                bot.status === 'active' ? 'bg-emerald-500' : 'bg-amber-400',
                              )} />
                              <span className="truncate">{botStatusLabel(bot.status)}</span>
                            </div>
                          </div>
                          <div className={cn(
                            'font-data text-xs font-bold',
                            bot.pnlPercent === 0
                              ? 'text-arena-elements-textTertiary'
                              : positive
                                ? 'text-arena-elements-icon-success'
                                : 'text-arena-elements-icon-error',
                          )}
                          >
                            {formatReturn(bot.pnlPercent)}
                          </div>
                        </>
                      )}
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <div className="shrink-0 border-t border-arena-elements-dividerColor/70 p-2">
          <div className={cn('mb-2 grid gap-1', sidebarCollapsed ? 'grid-cols-1' : 'grid-cols-2')}>
            <div className="rounded-lg border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/50 p-1">
              <ChainSwitcher />
            </div>
            <div className="rounded-lg border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/50 p-1">
              <ThemeToggle />
            </div>
          </div>
          <div className="mb-2">
            <TxDropdown />
          </div>
          {!sidebarCollapsed && <WalletButton />}
        </div>
      </aside>

      <div className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/88 px-3 backdrop-blur-xl lg:hidden">
          <Link to="/" className="min-w-0">
            <TangleLogo label="Trading Cloud" />
          </Link>
          <div className="flex shrink-0 items-center gap-1.5">
            <ChainSwitcher />
            <WalletButton />
          </div>
        </div>

        <main id="main-content" className="relative z-10 min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
