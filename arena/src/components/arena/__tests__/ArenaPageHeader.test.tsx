import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ArenaPageHeader } from '../ArenaPageHeader';

describe('ArenaPageHeader', () => {
  it('renders as a square app bar aligned with the sidebar instead of a rounded card', () => {
    const { container } = render(
      <ArenaPageHeader
        title="Create"
        metrics={[
          { label: 'Draft', value: 'Perps' },
          { label: 'Venue', value: 'Hyper' },
          { label: 'Route', value: 'Paper' },
        ]}
      />,
    );

    const header = container.querySelector('section');
    const innerBar = header?.firstElementChild;

    expect(header).toHaveClass('border-b');
    expect(header).not.toHaveClass('rounded-[6px]');
    expect(header).not.toHaveClass('border');
    expect(innerBar).toHaveClass('min-h-14');
  });
});
