import { Link, useLocation } from 'react-router';
import { ThemeToggle } from './ThemeToggle';
import { WalletButton } from './WalletButton';
import { cn } from '~/lib/utils';

const navItems = [
  { label: 'Arena', href: '/arena' },
  { label: 'Deploy', href: '/provision' },
];

export function Header() {
  const location = useLocation();

  return (
    <header className="fixed top-0 left-0 right-0 z-40 h-[var(--header-height)] glass-card-strong border-t-0 border-x-0 rounded-none">
      <div className="mx-auto flex h-full max-w-7xl items-center justify-between px-4 sm:px-6">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-2.5 group">
          <div className="relative flex items-center justify-center w-8 h-8">
            <div className="absolute inset-0 bg-emerald-500/20 rounded-lg blur-sm group-hover:bg-emerald-500/30 transition-colors" />
            <div className="relative i-ph:lightning-fill text-emerald-400 text-lg" />
          </div>
          <span className="font-display font-bold text-base tracking-tight">
            Trading Arena
          </span>
        </Link>

        {/* Nav */}
        <nav className="hidden sm:flex items-center gap-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              to={item.href}
              className={cn(
                'px-3.5 py-1.5 rounded-lg text-sm font-display font-medium transition-all duration-200',
                location.pathname.startsWith(item.href)
                  ? 'text-emerald-400 bg-emerald-500/10'
                  : 'text-arena-elements-textTertiary hover:text-arena-elements-textPrimary hover:bg-arena-elements-item-backgroundHover',
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
