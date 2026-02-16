import { Link, useLocation } from 'react-router';
import { ThemeToggle } from './ThemeToggle';
import { TxDropdown } from './TxDropdown';
import { WalletButton } from './WalletButton';
import { TangleLogo } from '~/components/shared/TangleLogo';
import { cn } from '~/lib/utils';

const navItems = [
  { label: 'Leaderboard', href: '/' },
  { label: 'Deploy', href: '/provision' },
];

export function Header() {
  const location = useLocation();

  return (
    <header className="fixed top-0 left-0 right-0 z-40 h-[var(--header-height)] glass-card-strong border-t-0 border-x-0 rounded-none">
      <div className="mx-auto flex h-full max-w-7xl items-center justify-between px-4 sm:px-6">
        {/* Logo */}
        <Link to="/" className="flex items-center group">
          <TangleLogo />
        </Link>

        {/* Nav */}
        <nav className="hidden sm:flex items-center gap-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              to={item.href}
              className={cn(
                'px-4 py-2 rounded-lg text-sm font-display font-medium transition-all duration-200',
                (item.href === '/' ? location.pathname === '/' : location.pathname.startsWith(item.href))
                  ? 'text-violet-700 dark:text-violet-400 bg-violet-500/10'
                  : 'text-arena-elements-textSecondary hover:text-arena-elements-textPrimary hover:bg-arena-elements-item-backgroundHover',
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <TxDropdown />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
