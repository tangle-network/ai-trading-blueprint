import * as React from 'react';
import { cn } from '~/lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-11 w-full min-w-0 rounded-lg px-3.5 py-2.5 text-base font-body',
        'bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-4 border border-arena-elements-borderColor text-arena-elements-textPrimary',
        'placeholder:text-arena-elements-textTertiary',
        'transition-all duration-200 outline-none',
        'hover:border-arena-elements-borderColorActive/40',
        'focus-visible:border-violet-500/40 focus-visible:ring-2 focus-visible:ring-violet-500/10',
        'disabled:pointer-events-none disabled:opacity-40',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
