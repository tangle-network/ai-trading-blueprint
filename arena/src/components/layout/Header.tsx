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

  return (
    <header className="fixed top-0 left-0 right-0 z-40 h-[var(--header-height)] glass-card-strong border-t-0 border-x-0 rounded-none">
      <div className="relative mx-auto flex h-full max-w-7xl items-center px-4 sm:px-6">
        {/* Logo */}
        <Link to="/" className="flex items-center group shrink-0">
          <TangleLogo label="Trading Arena" />
        </Link>

        {/* Nav — absolutely centered so right-side actions don't shift it */}
        <nav className="hidden sm:flex items-center gap-1 absolute left-1/2 -translate-x-1/2">
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
    </header>
  );
}
