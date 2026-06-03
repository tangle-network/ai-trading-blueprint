import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { type Dispatch, type RefObject, type SetStateAction, useEffect, useMemo, useState } from 'react';
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

type BrandTheme = 'light' | 'dark';

function isNavActive(pathname: string, href: string) {
  if (href === '/') return pathname === '/' || pathname === '/arena';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function getDocumentBrandTheme(): BrandTheme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function useDocumentBrandTheme(): BrandTheme {
  const [theme, setTheme] = useState<BrandTheme>(() => getDocumentBrandTheme());

  useEffect(() => {
    const root = document.documentElement;
    const updateTheme = () => setTheme(getDocumentBrandTheme());

    updateTheme();

    const observer = new MutationObserver(updateTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });

    const onStorage = (event: StorageEvent) => {
      if (event.key === 'bp_theme' || event.key === 'arena_theme') updateTheme();
    };
    window.addEventListener('storage', onStorage);

    return () => {
      observer.disconnect();
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return theme;
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
              <TangleBrandMark />
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
          aria-label="Tangle Trading"
          title={sidebarCollapsed ? 'Tangle Trading' : undefined}
        >
          <TangleBrandMark compact={sidebarCollapsed} />
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

function TangleBrandMark({ compact = false }: { compact?: boolean }) {
  const theme = useDocumentBrandTheme();
  const src = compact ? '/tangle-mark.svg' : theme === 'dark' ? '/tangle-logo-light.svg' : '/tangle-logo.svg';

  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden',
        compact ? 'h-8 w-8' : 'h-10 w-[124px]',
      )}
      aria-hidden="true"
    >
      <img
        src={src}
        alt=""
        className="h-full w-full object-contain"
      />
    </span>
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
