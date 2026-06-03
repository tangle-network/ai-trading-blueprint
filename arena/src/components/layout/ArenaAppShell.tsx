import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import { ChainSwitcher, ThemeToggle } from '@tangle-network/blueprint-ui/components';
import { cn } from '@tangle-network/blueprint-ui';
import { TxDropdown } from './TxDropdown';
import { WalletButton } from './WalletButton';

const primaryNavItems = [
  { label: 'Home', href: '/', icon: 'i-ph:trophy' },
  { label: 'Agents', href: '/leaderboard', icon: 'i-ph:table' },
  { label: 'Activity', href: '/activity', icon: 'i-ph:pulse' },
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
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-[#273035] bg-[#081013] px-3 lg:hidden">
            <Link
              to="/"
              className="inline-flex min-w-0 items-center gap-2 rounded-[5px] px-1 text-[#f6fefd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
            >
              <TangleMark />
              <span className="font-display text-base font-semibold">Arena</span>
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
        'arena-trace-terminal relative z-40 hidden shrink-0 flex-col border-r border-[#273035] bg-[#081013] text-[#f6fefd] transition-[width] duration-200 lg:flex',
        sidebarCollapsed ? 'w-16' : 'w-60',
      )}
    >
      <div className={cn(
        'flex shrink-0 items-center border-b border-[#273035]',
        sidebarCollapsed ? 'h-16 justify-center px-2' : 'h-14 justify-between gap-2 px-3',
      )}>
        <Link
          to="/"
          className={cn(
            'inline-flex min-w-0 items-center rounded-[5px] text-[#f6fefd] transition-colors hover:bg-[#16242a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60',
            sidebarCollapsed ? 'h-10 w-10 justify-center' : 'h-10 gap-2 px-2',
          )}
          aria-label={sidebarCollapsed ? 'AI Trading Arena' : undefined}
          title={sidebarCollapsed ? 'AI Trading Arena' : undefined}
        >
          <TangleMark />
          {!sidebarCollapsed && (
            <span className="truncate font-display text-lg font-semibold tracking-tight">
              Arena
            </span>
          )}
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
                'group relative flex h-10 items-center rounded-[5px] text-sm font-display font-medium transition-[background-color,color,box-shadow,transform] duration-150 active:scale-[0.98]',
                sidebarCollapsed ? 'w-11 justify-center px-0' : 'gap-3 px-3',
                active
                  ? 'bg-[#143c38] text-[#f6fefd] shadow-[inset_3px_0_0_rgba(80,210,193,0.92)]'
                  : 'text-[#949e9c] hover:bg-[#16242a] hover:text-[#f6fefd]',
              )}
              title={sidebarCollapsed ? item.label : undefined}
              aria-label={sidebarCollapsed ? item.label : undefined}
            >
              <span className={`${item.icon} shrink-0 text-lg ${active ? 'text-[#50d2c1]' : 'text-[#697371] group-hover:text-[#d2dad7]'}`} aria-hidden="true" />
              {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
            </NavLink>
          );
        })}
      </nav>

      <div className="min-h-0 flex-1 border-t border-[#273035]" />

      <div
        className={cn(
          'shrink-0 border-t border-[#273035]',
          sidebarCollapsed ? 'flex flex-col items-center gap-1.5 p-2' : 'p-2',
        )}
      >
        {sidebarCollapsed ? (
          <CollapsedAccountDock onExpand={toggleSidebar} />
        ) : (
          <ExpandedAccountDock />
        )}
      </div>
    </aside>
  );
}

const terminalControlClass = [
  '[&>button]:!h-10',
  '[&>button]:!w-full',
  '[&>button]:!justify-center',
  '[&>button]:!rounded-[5px]',
  '[&>button]:!border',
  '[&>button]:!border-[#273035]',
  '[&>button]:!bg-[#0f1a1f]',
  '[&>button]:!px-2',
  '[&>button]:!text-[#d2dad7]',
  '[&>button]:!shadow-none',
  '[&>button]:transition-[background-color,border-color,color,opacity]',
  '[&>button]:duration-150',
  '[&>button:hover]:!border-[#50d2c1]/45',
  '[&>button:hover]:!bg-[#143c38]',
  '[&>button:hover]:!text-[#f6fefd]',
  '[&>div>button]:!h-10',
  '[&>div>button]:!w-full',
  '[&>div>button]:!justify-center',
  '[&>div>button]:!rounded-[5px]',
  '[&>div>button]:!border',
  '[&>div>button]:!border-[#273035]',
  '[&>div>button]:!bg-[#0f1a1f]',
  '[&>div>button]:!px-2',
  '[&>div>button]:!text-[#d2dad7]',
  '[&>div>button]:!shadow-none',
  '[&>div>button]:transition-[background-color,border-color,color,opacity]',
  '[&>div>button]:duration-150',
  '[&>div>button:hover]:!border-[#50d2c1]/45',
  '[&>div>button:hover]:!bg-[#143c38]',
  '[&>div>button:hover]:!text-[#f6fefd]',
].join(' ');

const primaryWalletControlClass = [
  terminalControlClass,
  '[&>button]:!border-[#50d2c1]/55',
  '[&>button]:!bg-[#50d2c1]',
  '[&>button]:!font-semibold',
  '[&>button]:!text-[#06100e]',
  '[&>button:hover]:!border-[#7ce6d9]',
  '[&>button:hover]:!bg-[#7ce6d9]',
  '[&>button:hover]:!text-[#06100e]',
  '[&>div>button]:!border-[#50d2c1]/55',
  '[&>div>button]:!bg-[#50d2c1]',
  '[&>div>button]:!font-semibold',
  '[&>div>button]:!text-[#06100e]',
  '[&>div>button:hover]:!border-[#7ce6d9]',
  '[&>div>button:hover]:!bg-[#7ce6d9]',
  '[&>div>button:hover]:!text-[#06100e]',
].join(' ');

const collapsedControlClass = [
  'flex h-11 w-11 items-center justify-center overflow-hidden rounded-[5px] border border-[#273035] bg-[#0b1418] text-[#949e9c] transition-[background-color,border-color,color] duration-150 hover:border-[#50d2c1]/45 hover:bg-[#143c38] hover:text-[#f6fefd]',
  '[&>button]:!h-10',
  '[&>button]:!w-10',
  '[&>button]:!min-w-0',
  '[&>button]:!overflow-hidden',
  '[&>button]:!rounded-[5px]',
  '[&>button]:!border-0',
  '[&>button]:!bg-transparent',
  '[&>button]:!p-0',
  '[&>button]:!text-[#d2dad7]',
  '[&>div>button]:!h-10',
  '[&>div>button]:!w-10',
  '[&>div>button]:!min-w-0',
  '[&>div>button]:!overflow-hidden',
  '[&>div>button]:!rounded-[5px]',
  '[&>div>button]:!border-0',
  '[&>div>button]:!bg-transparent',
  '[&>div>button]:!p-0',
  '[&>div>button]:!text-[#d2dad7]',
  '[&_*]:!max-w-full',
].join(' ');

function ExpandedAccountDock() {
  return (
    <div className="rounded-[6px] border border-[#273035] bg-[#0b1418] p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <div className={cn('min-w-0', primaryWalletControlClass)}>
        <WalletButton />
      </div>
      <div className={cn('mt-1.5 min-w-0', terminalControlClass)}>
        <ChainSwitcher />
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        <div className={cn('min-w-0', terminalControlClass)}>
          <TxDropdown align="start" side="up" />
        </div>
        <div className={cn('min-w-0', terminalControlClass)}>
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}

function CollapsedAccountDock({ onExpand }: { onExpand: () => void }) {
  return (
    <>
      <SidebarIconButton
        label="Expand sidebar"
        onClick={onExpand}
        icon="i-ph:caret-right-bold"
      />
      <div className={collapsedControlClass}>
        <ChainSwitcher />
      </div>
      <div className={collapsedControlClass}>
        <TxDropdown align="start" side="up" />
      </div>
      <div className={collapsedControlClass}>
        <ThemeToggle />
      </div>
      <div className={collapsedControlClass}>
        <WalletButton />
      </div>
    </>
  );
}

function TangleMark() {
  return (
    <img
      src="/favicon.svg"
      alt=""
      className="h-7 w-7 rounded-[5px]"
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
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[5px] text-[#949e9c] transition-[background-color,color,transform] duration-150 hover:bg-[#16242a] hover:text-[#f6fefd] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
      aria-label={label}
      title={label}
    >
      <span className={`${icon} text-lg`} aria-hidden="true" />
    </button>
  );
}
