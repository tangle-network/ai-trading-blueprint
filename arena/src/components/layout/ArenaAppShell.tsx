import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { type Dispatch, type RefObject, type SetStateAction, useEffect, useId, useMemo, useState } from 'react';
import { useAccount, useSwitchChain } from 'wagmi';
import { useStore } from '@nanostores/react';
import { ThemeToggle } from '@tangle-network/blueprint-ui/components';
import { cn, selectedChainIdStore } from '@tangle-network/blueprint-ui';
import { useDropdownMenu } from '@tangle-network/sandbox-ui/hooks';
import { ArenaHeaderUtilitiesContext } from '~/components/arena/ArenaPageHeader';
import { networks } from '~/lib/contracts/chains';
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
    <div className="bp-tone-arena arena-trace-terminal flex h-[100dvh] overflow-hidden bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-text)]">
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

      <ArenaHeaderUtilitiesContext.Provider value={!isBotWorkspace ? <HeaderUtilityControls /> : null}>
      <div className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden">
        {!isBotWorkspace && (
          <div className="arena-trace-terminal flex h-14 shrink-0 items-center justify-between border-b border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] px-3 lg:hidden">
            <Link
              to="/"
              className="inline-flex min-w-0 items-center gap-2 rounded-[5px] px-1 text-[var(--arena-terminal-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
            >
              <TangleMark />
              <span className="font-display text-base font-semibold">Tangle</span>
            </Link>
            <div className="flex shrink-0 items-center gap-1.5">
              <NetworkButton compact />
              <div className={collapsedControlClass}>
                <TxDropdown />
              </div>
              <div className={collapsedControlClass}>
                <ThemeToggle />
              </div>
              <WalletButton compact />
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
      </ArenaHeaderUtilitiesContext.Provider>
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
        'arena-trace-terminal relative z-40 hidden shrink-0 flex-col border-r border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-bg)] text-[var(--arena-terminal-text)] transition-[width] duration-200 lg:flex',
        sidebarCollapsed ? 'w-16' : 'w-60',
      )}
    >
      <div className={cn(
        'flex shrink-0 items-center border-b border-[var(--arena-terminal-border)]',
        sidebarCollapsed ? 'h-16 justify-center px-2' : 'h-14 justify-between gap-2 px-3',
      )}>
        <Link
          to="/"
          className={cn(
            'inline-flex min-w-0 items-center rounded-[5px] text-[var(--arena-terminal-text)] transition-colors hover:bg-[var(--arena-terminal-panel-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60',
            sidebarCollapsed ? 'h-10 w-10 justify-center' : 'h-10 gap-2 px-2',
          )}
          aria-label={sidebarCollapsed ? 'Tangle Trading' : undefined}
          title={sidebarCollapsed ? 'Tangle Trading' : undefined}
        >
          <TangleMark />
          {!sidebarCollapsed && (
            <span className="truncate font-display text-lg font-semibold tracking-tight">
              Tangle
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
        aria-label="Tangle navigation"
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

      <div className="min-h-0 flex-1 border-t border-[var(--arena-terminal-border)]" />

      <div
        className={cn(
          'shrink-0 border-t border-[var(--arena-terminal-border)]',
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
  '[&>button]:!border-[var(--arena-terminal-border)]',
  '[&>button]:!bg-[var(--arena-terminal-panel)]',
  '[&>button]:!px-2',
  '[&>button]:!text-[var(--arena-terminal-text-secondary)]',
  '[&>button]:!shadow-none',
  '[&>button]:transition-[background-color,border-color,color,opacity]',
  '[&>button]:duration-150',
  '[&>button:hover]:!border-[var(--arena-terminal-border-hover)]',
  '[&>button:hover]:!bg-[var(--arena-terminal-accent-soft)]',
  '[&>button:hover]:!text-[var(--arena-terminal-text)]',
  '[&>div>button]:!h-10',
  '[&>div>button]:!w-full',
  '[&>div>button]:!justify-center',
  '[&>div>button]:!rounded-[5px]',
  '[&>div>button]:!border',
  '[&>div>button]:!border-[var(--arena-terminal-border)]',
  '[&>div>button]:!bg-[var(--arena-terminal-panel)]',
  '[&>div>button]:!px-2',
  '[&>div>button]:!text-[var(--arena-terminal-text-secondary)]',
  '[&>div>button]:!shadow-none',
  '[&>div>button]:transition-[background-color,border-color,color,opacity]',
  '[&>div>button]:duration-150',
  '[&>div>button:hover]:!border-[var(--arena-terminal-border-hover)]',
  '[&>div>button:hover]:!bg-[var(--arena-terminal-accent-soft)]',
  '[&>div>button:hover]:!text-[var(--arena-terminal-text)]',
].join(' ');

const collapsedControlClass = [
  'flex h-11 w-11 items-center justify-center rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] text-[var(--arena-terminal-text-muted)] transition-[background-color,border-color,color] duration-150 hover:border-[var(--arena-terminal-border-hover)] hover:bg-[var(--arena-terminal-accent-soft)] hover:text-[var(--arena-terminal-text)]',
  '[&>button]:!h-10',
  '[&>button]:!w-10',
  '[&>button]:!min-w-0',
  '[&>button]:!overflow-hidden',
  '[&>button]:!rounded-[5px]',
  '[&>button]:!border-0',
  '[&>button]:!bg-transparent',
  '[&>button]:!p-0',
  '[&>button]:!text-[var(--arena-terminal-text-secondary)]',
  '[&>div>button]:!h-10',
  '[&>div>button]:!w-10',
  '[&>div>button]:!min-w-0',
  '[&>div>button]:!overflow-hidden',
  '[&>div>button]:!rounded-[5px]',
  '[&>div>button]:!border-0',
  '[&>div>button]:!bg-transparent',
  '[&>div>button]:!p-0',
  '[&>div>button]:!text-[var(--arena-terminal-text-secondary)]',
].join(' ');

const headerUtilityControlClass = [
  'flex h-9 w-9 items-center justify-center rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] text-[var(--arena-terminal-text-muted)] transition-[background-color,border-color,color] duration-150 hover:border-[var(--arena-terminal-border-hover)] hover:bg-[var(--arena-terminal-accent-soft)] hover:text-[var(--arena-terminal-text)]',
  '[&>button]:!h-8',
  '[&>button]:!w-8',
  '[&>button]:!min-w-0',
  '[&>button]:!overflow-hidden',
  '[&>button]:!rounded-[5px]',
  '[&>button]:!border-0',
  '[&>button]:!bg-transparent',
  '[&>button]:!p-0',
  '[&>button]:!text-[var(--arena-terminal-text-secondary)]',
  '[&>div>button]:!h-8',
  '[&>div>button]:!w-8',
  '[&>div>button]:!min-w-0',
  '[&>div>button]:!overflow-hidden',
  '[&>div>button]:!rounded-[5px]',
  '[&>div>button]:!border-0',
  '[&>div>button]:!bg-transparent',
  '[&>div>button]:!p-0',
  '[&>div>button]:!text-[var(--arena-terminal-text-secondary)]',
].join(' ');

function HeaderUtilityControls() {
  return (
    <div className="hidden items-center gap-1.5 lg:flex">
      <div className={headerUtilityControlClass}>
        <TxDropdown />
      </div>
      <div className={headerUtilityControlClass}>
        <ThemeToggle />
      </div>
    </div>
  );
}

function ExpandedAccountDock() {
  return (
    <div className="rounded-[6px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-surface)] p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <div className={cn('min-w-0', terminalControlClass)}>
        <WalletButton align="start" side="up" />
      </div>
      <div className={cn('mt-1.5 min-w-0', terminalControlClass)}>
        <NetworkButton align="start" side="up" />
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
        <NetworkButton compact align="start" side="up" />
      </div>
      <div className={collapsedControlClass}>
        <WalletButton compact align="start" side="up" />
      </div>
    </>
  );
}

function NetworkButton({
  compact = false,
  align = 'end',
  side = 'down',
}: {
  compact?: boolean;
  align?: 'start' | 'end';
  side?: 'up' | 'down';
}) {
  const selectedChainId = useStore(selectedChainIdStore);
  const { isConnected } = useAccount();
  const { switchChain } = useSwitchChain();
  const { open, ref, toggle, close } = useDropdownMenu();
  const menuRef = ref as RefObject<HTMLDivElement>;
  const networkEntries = useMemo(
    () => Object.values(networks).sort((left, right) => left.chain.name.localeCompare(right.chain.name)),
    [],
  );
  const selectedNetwork = networks[selectedChainId] ?? networkEntries[0];
  const selectedLabel = selectedNetwork?.chain.name ?? 'Network';

  return (
    <div ref={menuRef} className="relative min-w-0">
      <button
        type="button"
        onClick={toggle}
        className={cn(
          'inline-flex h-10 max-w-full items-center justify-center gap-2 rounded-[5px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] px-2 font-display text-sm font-medium text-[var(--arena-terminal-text-secondary)] transition-[background-color,border-color,color,opacity,transform] duration-150 hover:border-[var(--arena-terminal-border-hover)] hover:bg-[var(--arena-terminal-accent-soft)] hover:text-[var(--arena-terminal-text)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60',
          compact ? 'w-10 min-w-0 px-0' : 'w-full',
        )}
        aria-label="Network"
        aria-expanded={open}
        title={compact ? selectedLabel : undefined}
      >
        <span className="i-ph:globe-hemisphere-west shrink-0 text-base" aria-hidden="true" />
        {!compact && <span className="min-w-0 truncate">{selectedLabel}</span>}
      </button>

      {open && (
        <div
          className={cn(
            'absolute z-50 max-h-[min(24rem,calc(100vh-1rem))] w-[min(18rem,calc(100vw-1rem))] overflow-hidden rounded-[6px] border border-[var(--arena-terminal-border)] bg-[var(--arena-terminal-panel)] p-1.5 shadow-[var(--arena-terminal-shadow-lg)]',
            align === 'start' ? 'left-0' : 'right-0',
            side === 'up' ? 'bottom-full mb-2' : 'top-full mt-2',
          )}
        >
          <div className="px-2 py-1.5 font-data text-[10px] uppercase tracking-[0.12em] text-[var(--arena-terminal-text-subtle)]">
            Network
          </div>
          <div className="max-h-[17rem] overflow-y-auto [scrollbar-gutter:stable]">
            {networkEntries.map((network) => {
              const selected = network.chain.id === selectedChainId;
              return (
                <button
                  key={network.chain.id}
                  type="button"
                  onClick={() => {
                    selectedChainIdStore.set(network.chain.id);
                    if (isConnected) {
                      switchChain({ chainId: network.chain.id });
                    }
                    close();
                  }}
                  className={cn(
                    'grid w-full grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 rounded-[5px] px-2 py-2 text-left transition-[background-color,color] duration-150 hover:bg-[var(--arena-terminal-panel-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60',
                    selected ? 'bg-[var(--arena-terminal-accent-soft)] text-[var(--arena-terminal-text)]' : 'text-[var(--arena-terminal-text-secondary)]',
                  )}
                >
                  <span
                    className={cn(
                      'h-2 w-2 rounded-full',
                      selected ? 'bg-[var(--arena-terminal-accent)]' : 'bg-[var(--arena-terminal-text-subtle)]',
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate font-display text-sm font-semibold">
                    {network.chain.name}
                  </span>
                  <span className="font-data text-[10px] tabular-nums text-[var(--arena-terminal-text-muted)]">
                    {network.chain.id}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function TangleMark() {
  const gradientA = useId();
  const gradientB = useId();

  return (
    <svg
      viewBox="0 0 32 28"
      className="h-7 w-8 shrink-0"
      aria-hidden="true"
    >
      <path
        d="M32 21.9598C32.0014 20.3605 31.2756 18.8261 29.9818 17.6934C28.6881 16.5606 26.9321 15.9221 25.0994 15.918H17.4484C17.4003 15.2958 17.3699 14.6596 17.3699 14C17.3699 13.3404 17.3396 12.7073 17.2969 12.082H25.0994C26.9162 12.0566 28.6488 11.4089 29.9233 10.2788C31.1978 9.14863 31.9121 7.62659 31.9121 6.041C31.9121 4.45541 31.1978 2.93337 29.9233 1.80323C28.6488 .67309 26.9162 .02544 25.0994 0H6.81321C4.9964 .02544 3.26386 .67309 1.98936 1.80323C.714863 2.93337 .000568 4.45541 .000568 6.041C.000568 7.62659 .714862 9.14863 1.98936 10.2788C3.26386 11.4089 4.9964 12.0566 6.81321 12.082L14 12.25C14.5 12.25 14.5427 13.3404 14.5427 14C14.5427 14.6596 14.573 15.2927 14.6158 15.918H6.81321C4.9964 15.9434 3.26386 16.5911 1.98936 17.7212C.714862 18.8514 .000567 20.3734 .000567 21.959C.000567 23.5446 .714862 25.0666 1.98936 26.1968C3.26386 27.3269 4.9964 27.9746 6.81321 28H25.0994C26.9318 27.9959 28.6875 27.3576 29.9812 26.2252C31.2749 25.0928 32.0009 23.5588 32 21.9598ZM29.1727 6.04022C29.1732 6.98405 28.7446 7.8895 27.981 8.5579C27.2173 9.22631 26.181 9.60308 25.0994 9.60556H16.9974C16.7039 7.83811 16.1447 6.11213 15.3342 4.47222C14.9768 3.7617 14.5193 3.09283 13.9723 2.48111H25.0994C26.1798 2.48358 27.215 2.8595 27.9785 3.52656C28.7419 4.19362 29.1713 5.09747 29.1727 6.04022ZM6.81321 9.60555C5.72959 9.60555 4.69036 9.22992 3.92412 8.56129C3.15789 7.89266 2.72742 6.98581 2.72742 6.04022C2.72742 5.09464 3.15789 4.18778 3.92412 3.51915C4.69036 2.85052 5.7296 2.47489 6.81321 2.47489H8.64754C10.2679 2.47489 11.8028 3.59489 12.7583 5.47244C13.4124 6.7954 13.8776 8.18352 14.1434 9.60555H6.81321ZM2.7399 21.9598C2.73943 21.0159 3.16802 20.1105 3.93166 19.4421C4.6953 18.7737 5.73161 18.3969 6.81321 18.3944H14.9153C15.2088 20.1619 15.768 21.8879 16.5785 23.5278C16.9358 24.2383 17.3933 24.9072 17.9404 25.5189H6.81321C5.73285 25.5164 4.69762 25.1405 3.93418 24.4734C3.17074 23.8064 2.74131 22.9025 2.7399 21.9598ZM19.1651 22.5276C18.511 21.2046 18.0458 19.8165 17.78 18.3944H25.0994C26.1831 18.3944 27.2223 18.7701 27.9885 19.4387C28.7548 20.1073 29.1852 21.0142 29.1852 21.9598C29.1852 22.9054 28.7548 23.8122 27.9885 24.4809C27.2223 25.1495 26.1831 25.5251 25.0994 25.5251H23.2651C21.6518 25.5251 20.117 24.4051 19.1651 22.5276Z"
        fill={`url(#${gradientA})`}
      />
      <path
        opacity="0.78"
        d="M32 6.04022C32.0014 7.63948 31.2756 9.17389 29.9818 10.3066C28.688 11.4394 26.9321 12.0779 25.0993 12.082H17.4481C17.4 12.7042 17.3697 13.3404 17.3697 14C17.3697 14.6596 17.3394 15.2927 17.2966 15.918H25.0993C26.9162 15.9434 28.6487 16.5911 29.9232 17.7212C31.1978 18.8514 31.9121 20.3734 31.9121 21.959C31.9121 23.5446 31.1978 25.0666 29.9232 26.1968C28.6487 27.3269 26.9162 27.9746 25.0993 28H6.81277C4.99592 27.9746 3.26335 27.3269 1.98883 26.1968C.714308 25.0666 0 23.5446 0 21.959C0 20.3734 .714308 18.8514 1.98883 17.7212C3.26335 16.5911 4.99592 15.9434 6.81277 15.918L13.9997 15.75C14.4997 15.75 14.5424 14.6596 14.5424 14C14.5424 13.3404 14.5727 12.7073 14.6155 12.082H6.81277C4.99592 12.0566 3.26335 11.4089 1.98883 10.2788C.714308 9.14863 0 7.62659 0 6.041C0 4.45541 .714308 2.93337 1.98883 1.80323C3.26335 .673093 4.99592 .02544 6.81277 0H25.0993C26.9317 .00412 28.6875 .642418 29.9812 1.77482C31.2749 2.90723 32.0009 4.44123 32 6.04022Z"
        fill={`url(#${gradientB})`}
      />
      <defs>
        <linearGradient id={gradientA} x1="2.38" y1="1.77" x2="26.53" y2="29.37" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8E59FF" />
          <stop offset="1" stopColor="#6888F9" />
        </linearGradient>
        <linearGradient id={gradientB} x1="2.38" y1="26.23" x2="26.53" y2="-1.37" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8E59FF" />
          <stop offset="1" stopColor="#6888F9" />
        </linearGradient>
      </defs>
    </svg>
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
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[5px] text-[var(--arena-terminal-text-muted)] transition-[background-color,color,transform] duration-150 hover:bg-[var(--arena-terminal-panel-strong)] hover:text-[var(--arena-terminal-text)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#50d2c1]/60"
      aria-label={label}
      title={label}
    >
      <span className={`${icon} text-lg`} aria-hidden="true" />
    </button>
  );
}
