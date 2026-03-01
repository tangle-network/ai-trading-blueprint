import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';

// ── Mock QueryClient ────────────────────────────────────────────────────

const testQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      gcTime: 0,
    },
  },
});

export function TestProviders({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={testQueryClient}>
      {children}
    </QueryClientProvider>
  );
}

/**
 * Creates a fresh QueryClient per test to avoid shared state.
 */
export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });
}

export function createWrapper() {
  const client = createTestQueryClient();
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        {children}
      </QueryClientProvider>
    );
  };
}

// ── Mock @tangle/blueprint-ui ───────────────────────────────────────────

// Provides minimal passthrough for UI components used in tests
export function mockBlueprintUi() {
  vi.mock('@tangle/blueprint-ui/components', () => ({
    Badge: ({ children, ...props }: any) => <span data-testid="badge" {...props}>{children}</span>,
    Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
    Card: ({ children, ...props }: any) => <div data-testid="card" {...props}>{children}</div>,
    CardContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    Input: (props: any) => <input {...props} />,
    Table: ({ children, ...props }: any) => <table {...props}>{children}</table>,
    TableHeader: ({ children, ...props }: any) => <thead {...props}>{children}</thead>,
    TableBody: ({ children, ...props }: any) => <tbody {...props}>{children}</tbody>,
    TableRow: ({ children, ...props }: any) => <tr {...props}>{children}</tr>,
    TableHead: ({ children, ...props }: any) => <th {...props}>{children}</th>,
    TableCell: ({ children, ...props }: any) => <td {...props}>{children}</td>,
    Dialog: ({ children }: any) => <div>{children}</div>,
    DialogContent: ({ children }: any) => <div>{children}</div>,
    DialogHeader: ({ children }: any) => <div>{children}</div>,
    DialogTitle: ({ children }: any) => <h2>{children}</h2>,
    DialogDescription: ({ children }: any) => <p>{children}</p>,
    Tabs: ({ children }: any) => <div>{children}</div>,
    TabsList: ({ children }: any) => <div>{children}</div>,
    TabsTrigger: ({ children }: any) => <button>{children}</button>,
    TabsContent: ({ children }: any) => <div>{children}</div>,
    Identicon: ({ address }: any) => <span data-testid="identicon">{address?.slice(0, 6)}</span>,
  }));

  vi.mock('@tangle/blueprint-ui', () => ({
    useThemeValue: () => 'dark',
    Identicon: ({ address }: any) => <span data-testid="identicon">{address?.slice(0, 6)}</span>,
  }));
}

// ── Mock framer-motion ──────────────────────────────────────────────────

export function mockFramerMotion() {
  vi.mock('framer-motion', () => ({
    m: {
      div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    },
    AnimatePresence: ({ children }: any) => <>{children}</>,
  }));
}
