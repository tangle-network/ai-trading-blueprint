import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '~/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-[11px] font-semibold font-data uppercase tracking-wider w-fit whitespace-nowrap shrink-0 gap-1 transition-colors',
  {
    variants: {
      variant: {
        default:
          'border-arena-elements-borderColor bg-arena-elements-background-depth-3 text-arena-elements-textPrimary',
        secondary:
          'border-arena-elements-dividerColor bg-arena-elements-background-depth-2 text-arena-elements-textSecondary',
        destructive:
          'border-crimson-500/20 bg-crimson-500/10 text-crimson-400',
        success:
          'border-emerald-500/20 bg-emerald-500/10 text-emerald-400',
        outline:
          'text-arena-elements-textPrimary border-arena-elements-borderColor bg-transparent',
        accent:
          'border-violet-500/20 bg-violet-500/10 text-violet-400',
        amber:
          'border-amber-500/20 bg-amber-500/10 text-amber-400',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span';
  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
