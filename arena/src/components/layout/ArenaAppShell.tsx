import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import { ChainSwitcher, TangleLogo, ThemeToggle } from '@tangle-network/blueprint-ui/components';
import { cn } from '@tangle-network/blueprint-ui';
import { TxDropdown } from './TxDropdown';
import { WalletButton } from './WalletButton';

const primaryNavItems = [
  { label: 'Home', href: '/', icon: 'i-ph:trophy' },
  { label: 'Leaderboard', href: '/leaderboard', icon: 'i-ph:table' },
  { label: 'My Agents', href: '/dashboard', icon: 'i-ph:house' },
  { label: 'Deploy', href: '/provision', icon: 'i-ph:rocket-launch' },
  { label: 'Create', href: '/create', icon: 'i-ph:chat-circle-dots' },
];

const SIDEBAR_COLLAPSED_KEY = 'arena:sidebar-collapsed';

function isNavActive(pathname: string, href: string) {
  if (href === '/') return pathname === '/' || pathname === '/arena';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function ArenaAppShell() {
  const location = useLocation();
  const isBotWorkspace = location.pathname.startsWith('/arena/bot/');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  });

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? 'true' : 'false');
  }, [sidebarCollapsed]);

  return (
    <div className="bp-tone-arena flex h-[100dvh] overflow-hidden bg-arena-elements-background-depth-1 text-arena-elements-textPrimary">
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
              <TangleLogo label="Arena" />
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
  const toggleSidebar = () => setSidebarCollapsed((collapsed) => !collapsed);

  return (
    <aside
      className={cn(
        'relative z-40 hidden shrink-0 flex-col border-r border-arena-elements-dividerColor/70 bg-arena-elements-background-depth-2 transition-[width] duration-200 lg:flex',
        sidebarCollapsed ? 'w-16' : 'w-64',
      )}
    >
      <div className={cn(
        'flex shrink-0 items-center border-b border-arena-elements-dividerColor/70',
        sidebarCollapsed ? 'h-16 justify-center px-2' : 'h-14 justify-between gap-2 px-3',
      )}>
        <Link
          to="/"
          className={cn(
            'inline-flex min-w-0 items-center rounded-xl transition-colors hover:bg-arena-elements-item-backgroundHover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60',
            sidebarCollapsed ? 'h-10 w-10 justify-center' : 'px-1',
          )}
          aria-label={sidebarCollapsed ? 'AI Trading Arena' : undefined}
          title={sidebarCollapsed ? 'AI Trading Arena' : undefined}
        >
          {sidebarCollapsed ? <TangleMark /> : <TangleLogo label="Arena" />}
        </Link>
        {!sidebarCollapsed && (
          <SidebarIconButton
            label="Collapse sidebar"
            onClick={toggleSidebar}
            icon="i-ph:caret-left-bold"
          />
        )}
      </div>

      <nav
        className={cn(
          'shrink-0 space-y-1 py-3',
          sidebarCollapsed ? 'px-2' : 'px-3',
        )}
        aria-label="Arena navigation"
      >
        {primaryNavItems.map((item) => {
          const active = isNavActive(pathname, item.href);
          return (
            <NavLink
              key={item.href}
              to={item.href}
              className={cn(
                'group relative flex h-11 items-center rounded-xl text-sm font-display font-medium transition-all duration-150 active:scale-[0.98]',
                sidebarCollapsed ? 'w-11 justify-center px-0' : 'gap-3 px-3',
                active
                  ? 'bg-violet-500/14 text-arena-elements-textPrimary shadow-[inset_0_0_0_1px_rgba(139,92,246,0.18)]'
                  : 'text-arena-elements-textSecondary hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary',
              )}
              title={sidebarCollapsed ? item.label : undefined}
              aria-label={sidebarCollapsed ? item.label : undefined}
            >
              <span className={`${item.icon} shrink-0 text-lg ${active ? 'text-violet-500 dark:text-violet-300' : 'text-arena-elements-textTertiary group-hover:text-arena-elements-textSecondary'}`} aria-hidden="true" />
              {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
            </NavLink>
          );
        })}
      </nav>

      <div className="min-h-0 flex-1 border-t border-arena-elements-dividerColor/60" />

      <div
        className={cn(
          'shrink-0 border-t border-arena-elements-dividerColor/70 p-2',
          sidebarCollapsed ? 'flex flex-col items-center gap-1.5' : 'space-y-2',
        )}
      >
        {sidebarCollapsed ? (
          <>
            <SidebarIconButton
              label="Expand sidebar"
              onClick={toggleSidebar}
              icon="i-ph:caret-right-bold"
            />
            <SidebarIconButton
              label="Base Sepolia testnet"
              onClick={toggleSidebar}
              icon="i-ph:globe-hemisphere-west"
            />
            <div className="flex h-11 w-11 items-center justify-center rounded-xl text-arena-elements-textSecondary transition-colors hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary [&>button]:h-10 [&>button]:w-10 [&>button]:rounded-xl">
              <ThemeToggle />
            </div>
          </>
        ) : (
          <>
            <div className="grid grid-cols-[minmax(0,1fr)_2.5rem_2.5rem] items-center gap-1.5 rounded-xl border border-arena-elements-dividerColor/60 bg-arena-elements-background-depth-1/44 p-1.5">
              <div className="min-w-0 [&>div>button]:w-full">
                <ChainSwitcher />
              </div>
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-arena-elements-textSecondary transition-colors hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary [&>button]:h-9 [&>button]:w-9 [&>button]:rounded-xl">
                <ThemeToggle />
              </div>
              <div className="[&>div>button]:h-10 [&>div>button]:w-10 [&>div>button]:rounded-xl [&>div>button]:border-0 [&>div>button]:bg-transparent [&>div>button]:p-0">
                <TxDropdown align="start" side="up" />
              </div>
            </div>
            <WalletButton />
          </>
        )}
      </div>
    </aside>
  );
}

function TangleMark() {
  return (
    <img
      src="/favicon.svg"
      alt=""
      className="h-8 w-8 rounded-md"
      aria-hidden="true"
    />
  );
}

interface SidebarIconButtonProps {
  label: string;
  icon: string;
  onClick: () => void;
}

function SidebarIconButton({ label, icon, onClick }: SidebarIconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-arena-elements-textSecondary transition-all duration-150 hover:bg-arena-elements-item-backgroundHover hover:text-arena-elements-textPrimary active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
      aria-label={label}
      title={label}
    >
      <span className={`${icon} text-lg`} aria-hidden="true" />
    </button>
  );
}
