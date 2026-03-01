import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router';
import { ChainSwitcher, TangleLogo, ThemeToggle } from '@tangle/blueprint-ui/components';
import { cn } from '@tangle/blueprint-ui';
import { TxDropdown } from './TxDropdown';
import { WalletButton } from './WalletButton';

const navItems = [
  { label: 'Leaderboard', href: '/' },
  { label: 'Home', href: '/dashboard' },
  { label: 'Deploy', href: '/provision' },
];

export function Header() {
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close mobile nav on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  // ESC key closes mobile nav
  useEffect(() => {
    if (!mobileOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMobileOpen(false);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [mobileOpen]);

  return (
    <header className="fixed top-0 left-0 right-0 z-40 h-[var(--header-height)] glass-card-strong border-t-0 border-x-0 rounded-none">
      <div className="relative mx-auto flex h-full max-w-7xl items-center px-4 sm:px-6">
        {/* Mobile hamburger */}
        <button
          type="button"
          onClick={() => setMobileOpen(!mobileOpen)}
          className="sm:hidden p-2 -ml-2 mr-1 rounded-lg text-arena-elements-textSecondary hover:text-arena-elements-textPrimary hover:bg-arena-elements-item-backgroundHover transition-colors"
          aria-label="Toggle navigation menu"
          aria-expanded={mobileOpen}
        >
          <div className={mobileOpen ? 'i-ph:x text-lg' : 'i-ph:list text-lg'} />
        </button>

        {/* Logo */}
        <Link to="/" className="flex items-center group shrink-0">
          <TangleLogo label="Trading Arena" />
        </Link>

        {/* Nav — absolutely centered so right-side actions don't shift it */}
        <nav aria-label="Main navigation" className="hidden sm:flex items-center gap-1 absolute left-1/2 -translate-x-1/2">
          {navItems.map((item) => (
            <Link
              key={item.href}
              to={item.href}
              className={cn(
                'px-4 py-2 rounded-lg text-sm font-display font-medium transition-all duration-200 whitespace-nowrap',
                (item.href === '/' ? location.pathname === '/' : location.pathname.startsWith(item.href))
                  ? 'text-violet-700 dark:text-violet-400 bg-violet-500/10'
                  : 'text-arena-elements-textSecondary hover:text-arena-elements-textPrimary hover:bg-arena-elements-item-backgroundHover',
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        {/* Actions — pushed to the right */}
        <div className="flex items-center gap-2 ml-auto shrink-0">
          <ChainSwitcher />
          <ThemeToggle />
          <TxDropdown />
          <WalletButton />
        </div>
      </div>

      {/* Mobile navigation */}
      {mobileOpen && (
        <nav aria-label="Mobile navigation" className="sm:hidden glass-card-strong border-t border-arena-elements-dividerColor/50 rounded-b-xl mx-2 mb-2 overflow-hidden">
          <div className="flex flex-col p-2 gap-1">
            {navItems.map((item) => (
              <Link
                key={item.href}
                to={item.href}
                className={cn(
                  'px-4 py-3 rounded-lg text-sm font-display font-medium transition-all duration-200',
                  (item.href === '/' ? location.pathname === '/' : location.pathname.startsWith(item.href))
                    ? 'text-violet-700 dark:text-violet-400 bg-violet-500/10'
                    : 'text-arena-elements-textSecondary hover:text-arena-elements-textPrimary hover:bg-arena-elements-item-backgroundHover',
                )}
              >
                {item.label}
              </Link>
            ))}
          </div>
        </nav>
      )}
    </header>
  );
}
