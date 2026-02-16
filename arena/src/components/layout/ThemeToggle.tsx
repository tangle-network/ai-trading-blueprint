import { Sun, Moon } from 'lucide-react';
import { useThemeValue } from '~/lib/hooks/useThemeValue';
import { toggleTheme } from '~/lib/stores/theme';
import { Button } from '~/components/ui/button';

export function ThemeToggle() {
  const theme = useThemeValue();

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={toggleTheme}
      aria-label="Toggle theme"
      className="relative overflow-hidden"
    >
      <div className="transition-transform duration-300 ease-out">
        {theme === 'dark' ? (
          <Sun className="size-4 text-amber-400" />
        ) : (
          <Moon className="size-4 text-violet-400" />
        )}
      </div>
    </Button>
  );
}
