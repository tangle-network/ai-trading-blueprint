import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '~/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium font-display transition-all duration-200 disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg:not([class*="size-"])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50 focus-visible:ring-offset-2 focus-visible:ring-offset-arena-elements-background-depth-1',
  {
    variants: {
      variant: {
        default:
          'bg-emerald-500 text-obsidian-950 font-semibold hover:bg-emerald-400 shadow-[0_0_20px_rgba(0,255,136,0.2)] hover:shadow-[0_0_30px_rgba(0,255,136,0.3)]',
        destructive:
          'bg-crimson-500/15 text-crimson-400 border border-crimson-500/20 hover:bg-crimson-500/25 hover:border-crimson-500/30',
        outline:
          'glass glass-hover text-arena-elements-textPrimary',
        secondary:
          'bg-arena-elements-background-depth-3 text-arena-elements-textSecondary border border-arena-elements-borderColor hover:bg-arena-elements-background-depth-4 hover:text-arena-elements-textPrimary',
        ghost:
          'text-arena-elements-textSecondary hover:text-arena-elements-textPrimary hover:bg-arena-elements-item-backgroundHover',
        link:
          'text-emerald-400 underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        sm: 'h-8 rounded-md gap-1.5 px-3 text-xs has-[>svg]:px-2.5',
        lg: 'h-11 rounded-xl px-7 text-base has-[>svg]:px-5',
        icon: 'size-9',
        'icon-sm': 'size-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
