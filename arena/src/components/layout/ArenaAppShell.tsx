import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { type Dispatch, type SetStateAction, useState } from 'react';
import { ChainSwitcher, TangleLogo, ThemeToggle } from '@tangle-network/blueprint-ui/components';
import { cn } from '@tangle-network/blueprint-ui';
import { TxDropdown } from './TxDropdown';
import { WalletButton } from './WalletButton';

const primaryNavItems = [
  { label: 'My Agents', href: '/dashboard', icon: 'i-ph:house' },
  { label: 'Leaderboard', href: '/', icon: 'i-ph:trophy' },
  { label: 'Deploy', href: '/provision', icon: 'i-ph:rocket-launch' },
  { label: 'Create', href: '/create', icon: 'i-ph:chat-circle-dots' },
];

function isNavActive(pathname: string, href: string) {
  if (href === '/') return pathname === '/' || pathname === '/arena';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function ArenaAppShell() {
  const location = useLocation();
  const isBotWorkspace = location.pathname.startsWith('/arena/bot/');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  return (
    <div className="bp-tone-arena flex h-[100dvh] overflow-hidden bg-arena-elements-background-depth-1 text-arena-elements-textPrimary bg-mesh bg-noise">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:rounded-lg focus:bg-violet-600 focus:text-white focus:text-sm focus:font-display focus:font-medium"
      >
        Skip to content
      </a>

      {!isBotWorkspace && (
        <DesktopArenaSidebar
          pathname={location.pathname}
          sidebarCollapsed={sidebarCollapsed}
          setSidebarCollapsed={setSidebarCollapsed}
        />
      )}

      <div className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden">
        {!isBotWorkspace && (
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2/88 px-3 backdrop-blur-xl lg:hidden">
            <Link to="/" className="min-w-0">
              <TangleLogo label="Trading Cloud" />
            </Link>
            <div className="flex shrink-0 items-center gap-1.5">
              <ChainSwitcher />
              <WalletButton />
            </div>
          </div>
        )}

        <main
          id="main-content"
          className={cn(
            'relative z-10 min-h-0 flex-1',
            isBotWorkspace ? 'overflow-hidden' : 'overflow-y-auto',
          )}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}

interface DesktopArenaSidebarProps {
  pathname: string;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
}

function DesktopArenaSidebar({
  pathname,
  sidebarCollapsed,
  setSidebarCollapsed,
}: DesktopArenaSidebarProps) {
  return (
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
          const active = isNavActive(pathname, item.href);
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
              aria-label={sidebarCollapsed ? item.label : undefined}
            >
              <span className={`${item.icon} text-base ${active ? 'text-violet-500 dark:text-violet-300' : 'text-arena-elements-textTertiary'}`} aria-hidden="true" />
              {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
            </NavLink>
          );
        })}
      </nav>

      <div className="min-h-0 flex-1 border-t border-arena-elements-dividerColor/60" />

      <div className="shrink-0 border-t border-arena-elements-dividerColor/70 p-2">
        <div className={cn('mb-2 grid gap-1', sidebarCollapsed ? 'grid-cols-1' : 'grid-cols-2')}>
          <div className="rounded-lg border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/50 p-1">
            {sidebarCollapsed ? (
              <button
                type="button"
                onClick={() => setSidebarCollapsed(false)}
                className="inline-flex h-10 w-full items-center justify-center rounded-md text-arena-elements-textSecondary transition-colors hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
                aria-label="Base Sepolia testnet"
                title="Base Sepolia testnet"
              >
                <span className="i-ph:globe-hemisphere-west text-base" aria-hidden="true" />
              </button>
            ) : (
              <ChainSwitcher />
            )}
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
  );
}
