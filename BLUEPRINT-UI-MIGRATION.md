# Arena Migration to `@tangle/blueprint-ui`

## Overview

`@tangle/blueprint-ui` is a shared package at `~/code/blueprint-ui` that extracts all
generic Tangle blueprint infrastructure — stores, contract helpers, hooks, UI components,
and a UnoCSS token preset — into a single reusable dependency. The sandbox UI has already
migrated successfully. This spec covers the arena migration.

**What blueprint-ui provides:**
- Stores: `persistedAtom`, `theme`, `txHistory`, `session`, `infra`
- Contracts: chain definitions, `configureNetworks<T>()`, reactive `publicClient`, core Tangle ABIs (`tangleJobsAbi`, `tangleServicesAbi`, `tangleOperatorsAbi`), `encodeJobArgs()`
- Hooks: `useOperators`, `useQuotes` (REST/JSON), `useJobPrice`, `useJobForm`, `useSubmitJob`, `useServiceValidation`, `useProvisionProgress`, `useSessionAuth`, `useAuthenticatedFetch`, `useThemeValue`, `useWagmiSidecarAuth`
- Components: 12 UI primitives (badge, button, card, dialog, input, select, separator, skeleton, table, tabs, textarea, toggle), motion (AnimatedPage, StaggerContainer, StaggerItem), shared (Identicon, TangleLogo), layout (ThemeToggle, ChainSwitcher), forms (FormField, BlueprintJobForm, FormSummary, JobExecutionDialog)
- UnoCSS preset: `bpThemeTokens(prefix)` for CSS variable bridge

**What stays arena-specific:**
- Domain types: `Bot`, `Trade`, `Vault`, `Portfolio`, `Competition`
- Domain hooks: `useBots`, `useBotApi`, `useBotControl`, `useBotDetail`, `useBotEnrichment`, `useChartTheme`, `useVaultRead`, `useVaultWrite`, `useTxWatcher`, `useProvisionWatcher`, `useUserServices`, `useBotApi`
- Domain ABIs: `tradingVaultAbi`, `erc20Abi`, `vaultFactoryAbi`, `tradingBlueprintAbi`
- Domain components: arena/, bot-detail/, home/, landing/, vault/ directories
- Stores: `provisions.ts` (arena-specific provisioning tracker)
- Config: `botRegistry.ts`, `aiProviders.ts`
- Protobuf: `gen/pricing_pb.ts` (gRPC quotes)

---

## Architecture: How the Package Works

### Ships TypeScript Source (No Build Step)

The package exports raw `.ts`/`.tsx` source. The consumer's Vite bundler compiles it.
This means UnoCSS scans the imported source and generates CSS with whatever token prefix
the consumer configures.

### Package Exports

```
@tangle/blueprint-ui          → stores, contracts, hooks, blueprints, utils
@tangle/blueprint-ui/components → all React components
@tangle/blueprint-ui/preset    → bpThemeTokens() for UnoCSS
```

### CSS Token Bridge

Components in the package use `bp-elements-*` classes (e.g. `text-bp-elements-textPrimary`).
Each consuming app maps `bp` to their own CSS variables in UnoCSS config:

```ts
import { bpThemeTokens } from '@tangle/blueprint-ui/preset';

// In UnoCSS defineConfig → theme → colors:
bp: bpThemeTokens('arena'),
// Result: text-bp-elements-textPrimary → color: var(--arena-elements-textPrimary)
```

The arena's existing `variables.scss` already defines `--arena-elements-*` CSS variables,
so **no SCSS changes are needed**. The token bridge maps directly to existing arena theme vars.

### Generic Network Config

Blueprint-ui uses a `configureNetworks<T>()` pattern instead of hardcoded address shapes:

```ts
import type { CoreAddresses } from '@tangle/blueprint-ui';

// CoreAddresses requires: { jobs: Address; services: Address; [key: string]: Address }
interface ArenaAddresses extends CoreAddresses {
  tangle: Address;        // arena's "tangle" contract (= blueprint-ui's "services")
  vaultFactory: Address;
  tradingBlueprint: Address;
}
```

---

## Token Mapping Verification

Before starting, verify that arena's CSS variable names match `bpThemeTokens('arena')`.
The preset generates these variable references:

| `bpThemeTokens('arena')` generates | Arena's `variables.scss` defines |
|---|---|
| `var(--arena-elements-borderColor)` | `--arena-elements-borderColor` |
| `var(--arena-elements-borderColorActive)` | `--arena-elements-borderColorActive` |
| `var(--arena-elements-bg-depth-1)` | `--arena-elements-bg-depth-1` |
| `var(--arena-elements-bg-depth-2)` | `--arena-elements-bg-depth-2` |
| `var(--arena-elements-bg-depth-3)` | `--arena-elements-bg-depth-3` |
| `var(--arena-elements-bg-depth-4)` | `--arena-elements-bg-depth-4` |
| `var(--arena-elements-textPrimary)` | `--arena-elements-textPrimary` |
| `var(--arena-elements-textSecondary)` | `--arena-elements-textSecondary` |
| `var(--arena-elements-textTertiary)` | `--arena-elements-textTertiary` |
| `var(--arena-elements-button-primary-background)` | `--arena-elements-button-primary-background` |
| `var(--arena-elements-button-primary-backgroundHover)` | `--arena-elements-button-primary-backgroundHover` |
| `var(--arena-elements-button-primary-text)` | `--arena-elements-button-primary-text` |
| `var(--arena-elements-button-secondary-*)` | Defined |
| `var(--arena-elements-button-danger-*)` | Defined |
| `var(--arena-elements-icon-success)` | `--arena-elements-icon-success` |
| `var(--arena-elements-icon-error)` | `--arena-elements-icon-error` |
| `var(--arena-elements-icon-warning)` | **CHECK: may not be defined** |
| `var(--arena-elements-icon-primary)` | `--arena-elements-icon-primary` |
| `var(--arena-elements-icon-secondary)` | `--arena-elements-icon-secondary` |
| `var(--arena-elements-dividerColor)` | `--arena-elements-dividerColor` |
| `var(--arena-elements-item-backgroundHover)` | `--arena-elements-item-backgroundHover` |
| `var(--arena-elements-item-backgroundActive)` | `--arena-elements-item-backgroundActive` |
| `var(--arena-elements-focus)` | `--arena-elements-focus` |

> **Action:** Check if `--arena-elements-icon-warning` is defined in `variables.scss`.
> If not, add it (e.g. `--arena-elements-icon-warning: theme('colors.amber.400')`) or
> it will silently fall back to `unset`.

---

## Step-by-Step Migration

### Step 1: Add Package Dependency

```bash
cd ~/code/ai-trading-blueprints/arena
```

**`package.json`** — add:
```json
{
  "dependencies": {
    "@tangle/blueprint-ui": "link:../../blueprint-ui"
  }
}
```

Then install:
```bash
pnpm install
```

### Step 2: Configure UnoCSS Token Bridge

**`uno.config.ts`** — add the preset import and wire up the `bp` color namespace:

```ts
import { bpThemeTokens } from '@tangle/blueprint-ui/preset';

export default defineConfig({
  // ... existing config ...
  theme: {
    colors: {
      // ... existing arena color definitions ...
      bp: bpThemeTokens('arena'),
    },
  },
  content: {
    pipeline: {
      include: [
        /\.(tsx?|jsx?)$/,
        '../../blueprint-ui/src/**/*.{ts,tsx}',  // scan blueprint-ui source for class names
      ],
    },
  },
});
```

> **Important:** The `content.pipeline.include` entry ensures UnoCSS scans blueprint-ui
> source files and generates the correct `bp-elements-*` utility classes.

### Step 3: Configure Vite `resolve.dedupe`

Because pnpm uses strict module isolation, Vite can't resolve blueprint-ui's peer
dependencies when following the link symlink. Add `resolve.dedupe` to `vite.config.ts`:

```ts
export default defineConfig({
  // ... existing config ...
  resolve: {
    alias: { events: 'events' },
    dedupe: [
      '@nanostores/react',
      '@radix-ui/react-dialog',
      '@radix-ui/react-separator',
      '@radix-ui/react-slot',
      '@radix-ui/react-tabs',
      '@tangle/agent-ui',
      'blo',
      'class-variance-authority',
      'clsx',
      'framer-motion',
      'nanostores',
      'react',
      'react-dom',
      'tailwind-merge',
      'viem',
      'wagmi',
    ],
  },
});
```

### Step 4: localStorage Key Migration

Arena currently uses `arena_theme`, `arena_tx_history`, `arena_selected_chain`,
`arena_provisions`. Blueprint-ui stores use `bp_theme`, `bp_tx_history`,
`bp_selected_chain`.

Add a one-time migration in `entry.client.tsx` **before** React hydrates:

```ts
// Migrate localStorage keys from arena_* to bp_*
const KEY_MIGRATIONS: [string, string][] = [
  ['arena_theme', 'bp_theme'],
  ['arena_tx_history', 'bp_tx_history'],
  ['arena_selected_chain', 'bp_selected_chain'],
];
for (const [oldKey, newKey] of KEY_MIGRATIONS) {
  if (!localStorage.getItem(newKey) && localStorage.getItem(oldKey)) {
    localStorage.setItem(newKey, localStorage.getItem(oldKey)!);
  }
}

// Import chains module to trigger configureNetworks() side effect
import('~/lib/contracts/chains');
```

> **Note:** `arena_provisions` is NOT migrated — it stays arena-specific and keeps its
> current key. Only stores that are replaced by blueprint-ui equivalents get migrated.

Update `root.tsx` inline theme script to check the new key first:

```ts
var theme = localStorage.getItem('bp_theme') || localStorage.getItem('arena_theme');
```

### Step 5: Create `chains.ts` Re-export + Arena Network Config

This is the most important file. Replace `src/lib/contracts/chains.ts` with a re-export
stub that configures arena-specific addresses at module load time.

**Reference:** See the sandbox version at `ai-agent-sandbox-blueprint/ui/src/lib/contracts/chains.ts`.

```ts
// src/lib/contracts/chains.ts
import type { Address } from 'viem';
import {
  tangleLocal, tangleTestnet, tangleMainnet, rpcUrl,
  configureNetworks, getNetworks,
  type CoreAddresses,
} from '@tangle/blueprint-ui';

export {
  tangleLocal, tangleTestnet, tangleMainnet, rpcUrl,
  allTangleChains, mainnet, resolveRpcUrl,
  configureNetworks, getNetworks,
} from '@tangle/blueprint-ui';
export type { CoreAddresses, NetworkConfig } from '@tangle/blueprint-ui';

/** Arena-specific contract addresses. */
export interface ArenaAddresses extends CoreAddresses {
  tangle: Address;
  vaultFactory: Address;
  tradingBlueprint: Address;
}

// Configure arena networks at module load time.
configureNetworks<ArenaAddresses>({
  [tangleLocal.id]: {
    chain: tangleLocal,
    rpcUrl,
    label: 'Tangle Local',
    shortLabel: 'Local',
    addresses: {
      // CoreAddresses requires jobs + services; arena maps them to the same "tangle" contract
      jobs: (import.meta.env.VITE_TANGLE_CONTRACT ?? '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9') as Address,
      services: (import.meta.env.VITE_TANGLE_CONTRACT ?? '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9') as Address,
      tangle: (import.meta.env.VITE_TANGLE_CONTRACT ?? '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9') as Address,
      vaultFactory: (import.meta.env.VITE_VAULT_FACTORY ?? '0x0000000000000000000000000000000000000000') as Address,
      tradingBlueprint: (import.meta.env.VITE_TRADING_BLUEPRINT ?? '0x0000000000000000000000000000000000000000') as Address,
    },
  },
  [tangleTestnet.id]: {
    chain: tangleTestnet,
    rpcUrl: 'https://testnet-rpc.tangle.tools',
    label: 'Tangle Testnet',
    shortLabel: 'Testnet',
    addresses: {
      jobs: '0x0000000000000000000000000000000000000000' as Address,
      services: '0x0000000000000000000000000000000000000000' as Address,
      tangle: '0x0000000000000000000000000000000000000000' as Address,
      vaultFactory: '0x0000000000000000000000000000000000000000' as Address,
      tradingBlueprint: '0x0000000000000000000000000000000000000000' as Address,
    },
  },
  [tangleMainnet.id]: {
    chain: tangleMainnet,
    rpcUrl: 'https://rpc.tangle.tools',
    label: 'Tangle Mainnet',
    shortLabel: 'Mainnet',
    addresses: {
      jobs: '0x0000000000000000000000000000000000000000' as Address,
      services: '0x0000000000000000000000000000000000000000' as Address,
      tangle: '0x0000000000000000000000000000000000000000' as Address,
      vaultFactory: '0x0000000000000000000000000000000000000000' as Address,
      tradingBlueprint: '0x0000000000000000000000000000000000000000' as Address,
    },
  },
});

/** Backwards-compatible accessor. */
export const networks = getNetworks<ArenaAddresses>();
```

> **Key detail:** Blueprint-ui's `CoreAddresses` requires `jobs` and `services` fields.
> Arena's current code uses a single `tangle` address for both. Map `jobs` and `services`
> to the same `VITE_TANGLE_CONTRACT` value, and keep `tangle` for backward compatibility.

### Step 6: Create `addresses.ts` Adapter

Arena has a Proxy-based `addresses` export and a `tokens` object. Update to use blueprint-ui's
`getAddresses()` under the hood:

```ts
// src/lib/contracts/addresses.ts
import type { Address } from 'viem';
import { getAddresses } from '@tangle/blueprint-ui';
import type { ArenaAddresses } from './chains';

// Reactive addresses — reads from the selected chain's network config via blueprint-ui.
export const addresses = new Proxy({} as ArenaAddresses, {
  get(_target, prop: string) {
    return getAddresses<ArenaAddresses>()[prop as keyof ArenaAddresses];
  },
});

// Well-known token addresses (mainnet)
export const tokens = {
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address,
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address,
} as const;
```

### Step 7: Create `abis.ts` Re-export

Arena's `abis.ts` has both Tangle core ABIs and arena-specific ABIs. Split:

```ts
// src/lib/contracts/abis.ts

// Core Tangle ABIs from shared package
export { tangleJobsAbi, tangleServicesAbi, tangleOperatorsAbi } from '@tangle/blueprint-ui';

// Arena-specific ABIs (stay local)
export const tradingVaultAbi = [ /* ... existing ... */ ] as const;
export const erc20Abi = [ /* ... existing ... */ ] as const;
export const vaultFactoryAbi = [ /* ... existing ... */ ] as const;
export const tradingBlueprintAbi = [ /* ... existing ... */ ] as const;
```

> **Note:** Arena's `tangleJobsAbi`, `tangleServicesAbi`, and `tangleOperatorsAbi`
> are identical to blueprint-ui's. Delete the local copies and re-export from the package.

### Step 8: Create `publicClient.ts` Re-export

```ts
// src/lib/contracts/publicClient.ts
export {
  selectedChainIdStore,
  publicClientStore,
  getPublicClient,
  publicClient,
  getAddresses,
} from '@tangle/blueprint-ui';
```

### Step 9: Replace Store Files with Re-exports

**`src/lib/stores/persistedAtom.ts`:**
```ts
export { persistedAtom, serializeWithBigInt, deserializeWithBigInt } from '@tangle/blueprint-ui';
```

**`src/lib/stores/theme.ts`:**
```ts
export type { Theme } from '@tangle/blueprint-ui';
export { kTheme, DEFAULT_THEME, themeStore, themeIsDark, toggleTheme } from '@tangle/blueprint-ui';
```

**`src/lib/stores/txHistory.ts`:**
```ts
export type { TrackedTx } from '@tangle/blueprint-ui';
export { txListStore, pendingCount, addTx, updateTx, clearTxs } from '@tangle/blueprint-ui';
```

**`src/lib/stores/provisions.ts`:**
> **Keep as-is.** This is arena-specific. It imports `persistedAtom` which now re-exports
> from blueprint-ui — no changes needed if the import path is `./persistedAtom` or
> `~/lib/stores/persistedAtom`. Verify the import path resolves correctly.

### Step 10: Replace Shared Hooks with Re-exports

These hooks are functionally identical between arena and blueprint-ui:

**`src/lib/hooks/useThemeValue.ts`:**
```ts
export { useThemeValue } from '@tangle/blueprint-ui';
```

**`src/lib/hooks/useWagmiSidecarAuth.ts`:**
```ts
export { useWagmiSidecarAuth } from '@tangle/blueprint-ui';
```

### Step 11: Evaluate Remaining Hooks

These hooks exist in both codebases but have meaningful differences:

#### `useOperators.ts` — Can migrate with small adapter

**Difference:** Arena imports `addresses.tangle` for the contract address. Blueprint-ui
uses `getAddresses().services`.

**Solution:** If arena maps both `jobs` and `services` to the same Tangle contract address
(as described in Step 5), then blueprint-ui's `useOperators` will work identically. Replace:

```ts
export type { DiscoveredOperator } from '@tangle/blueprint-ui';
export { useOperators } from '@tangle/blueprint-ui';
```

#### `useQuotes.ts` — Keep arena's version (different protocol)

**Difference:** Arena uses **gRPC/Protobuf** via `@connectrpc/connect` + generated
`pricing_pb.ts`. Blueprint-ui uses a **REST/JSON** fallback endpoint (`/pricing/quote`).

**Decision:** **Keep arena's `useQuotes.ts` locally.** The gRPC implementation is more
mature and uses the real protobuf contract. The shared types (`OperatorQuote`,
`UseQuotesResult`) are compatible, but the implementation differs substantially.

> **Future consideration:** Once the REST endpoint is standardized across all operators,
> arena could migrate to blueprint-ui's version. Or blueprint-ui could add a `transport`
> option to support both gRPC and REST.

#### `useProvisionProgress.ts` — Keep arena's version

Arena's version uses `@tanstack/react-query` for polling and has arena-specific
`useProvisionsList`. Blueprint-ui's version has different phase typing. Keep local.

#### Hooks that don't exist in arena (no action needed)

Blueprint-ui also exports these, but arena doesn't use them:
- `useJobPrice`, `useJobPrices` — sandbox-specific pricing UX
- `useJobForm` — generic job form state management
- `useSubmitJob` — generic job submission flow
- `useServiceValidation` — service availability checking
- `useSessionAuth`, `useAuthenticatedFetch` — sidecar session auth

Arena can adopt these later if/when it needs generic job submission flows.

### Step 12: Replace UI Components with Re-exports

All arena UI components below are near-identical to blueprint-ui's versions. The only
systematic difference is the CSS prefix (`arena-elements-*` vs `bp-elements-*`), which
is handled by the UnoCSS token bridge.

**`src/components/ui/badge.tsx`:**
```ts
export { Badge, badgeVariants } from '@tangle/blueprint-ui/components';
```

> **Check:** Arena badge has variants: `default`, `secondary`, `destructive`, `success`,
> `outline`, `accent`, `amber`. Blueprint-ui badge has: `default`, `secondary`,
> `destructive`, `success`, `outline`, `running`, `stopped`, `cold`. If arena needs
> `accent`/`amber` variants, add them to blueprint-ui first, then migrate.

**`src/components/ui/button.tsx`:**
```ts
export { Button, buttonVariants } from '@tangle/blueprint-ui/components';
```

> **Check:** Arena button variants: `default`, `destructive`, `outline`, `secondary`,
> `ghost`, `link`. Blueprint-ui has all of these plus `success`. Compatible.

**`src/components/ui/card.tsx`:**
```ts
export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@tangle/blueprint-ui/components';
```

**`src/components/ui/dialog.tsx`:**
```ts
export { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '@tangle/blueprint-ui/components';
```

> **Note:** Arena's dialog imports `lucide-react` for the close icon. Blueprint-ui uses
> Phosphor (`i-ph:x`). Visually equivalent. Dropping the lucide dep for dialog is fine.

**`src/components/ui/input.tsx`:**
```ts
export { Input } from '@tangle/blueprint-ui/components';
```

**`src/components/ui/separator.tsx`:**
```ts
export { Separator } from '@tangle/blueprint-ui/components';
```

**`src/components/ui/skeleton.tsx`:**
```ts
export { Skeleton } from '@tangle/blueprint-ui/components';
```

**`src/components/ui/table.tsx`:**
```ts
export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@tangle/blueprint-ui/components';
```

**`src/components/ui/tabs.tsx`:**
```ts
export { Tabs, TabsList, TabsTrigger, TabsContent } from '@tangle/blueprint-ui/components';
```

**Components arena does NOT currently have but blueprint-ui provides:**
- `select.tsx` — adopt if needed
- `textarea.tsx` — adopt if needed
- `toggle.tsx` — adopt if needed

### Step 13: Replace Shared & Layout Components

**`src/components/shared/Identicon.tsx`:**
```ts
export { Identicon } from '@tangle/blueprint-ui/components';
```

**`src/components/shared/TangleLogo.tsx`:**
```ts
// Re-export with arena's brand label
export { TangleLogo } from '@tangle/blueprint-ui/components';
```

> Blueprint-ui's TangleLogo accepts a `label` prop (default: `"Tangle"`). Arena currently
> hardcodes `"Trading Arena"`. Update usage sites to pass `label="Trading Arena"`:
> ```tsx
> <TangleLogo label="Trading Arena" />
> ```

**`src/components/layout/ThemeToggle.tsx`:**
```ts
export { ThemeToggle } from '@tangle/blueprint-ui/components';
```

> **Note:** Arena's ThemeToggle uses `lucide-react` (Sun/Moon icons). Blueprint-ui uses
> Phosphor (`i-ph:sun`/`i-ph:moon`). The switch is cosmetic. Arena already has Phosphor
> icons (`@iconify-json/ph`) as a devDependency, so this works.

**`src/components/layout/ChainSwitcher.tsx`:**
```ts
export { ChainSwitcher } from '@tangle/blueprint-ui/components';
```

**`src/components/motion/AnimatedPage.tsx`:**
```ts
export { AnimatedPage, StaggerContainer, StaggerItem } from '@tangle/blueprint-ui/components';
```

> **Note:** Arena also has `StaggerContainer.tsx` as a separate file with slightly different
> animation values (0.06s stagger vs 0.05s, y:12 vs y:16). Decide which to keep.
> Recommend deleting the separate `StaggerContainer.tsx` and using blueprint-ui's version
> from AnimatedPage.

**`src/components/motion/AnimatedNumber.tsx`:**
> **Keep as-is.** Blueprint-ui does not include AnimatedNumber. It's arena-specific.

### Step 14: Keep Arena-Specific Components As-Is

These stay local — no blueprint-ui equivalent exists:

```
src/components/arena/       — FilterBar, LeaderboardTable, SparklineChart
src/components/bot-detail/  — BotHeader, ControlsTab, PerformanceTab, ChatTab, etc.
src/components/home/        — HomeBotCard, ServiceCard, ProvisionsBanner, SecretsModal
src/components/landing/     — Hero, HowItWorks, LiveTicker, StatsBar
src/components/vault/       — DepositForm, WithdrawForm, VaultStats
src/components/layout/Header.tsx  — Arena has custom nav items; keep local
src/components/layout/Footer.tsx  — Arena has custom links; keep local
src/components/layout/TxDropdown.tsx   — Uses arena-specific provisions store
src/components/layout/WalletButton.tsx — Uses arena-specific network config
```

> **Note on Header/Footer:** Blueprint-ui's Header and Footer could be made generic with
> props for `navItems`, `brandComponent`, etc. This is a future enhancement. For now, keep
> arena's custom versions.

### Step 15: Update `utils.ts`

```ts
// src/lib/utils.ts
export { cn } from '@tangle/blueprint-ui';
```

### Step 16: Verify Build

```bash
# Typecheck
cd ~/code/ai-trading-blueprints/arena
npx tsc --noEmit

# Production build
npx vite build
```

Fix any issues. Common problems from the sandbox migration:

1. **`~/` path alias in blueprint-ui** — Already fixed. All blueprint-ui source uses
   relative imports.

2. **Peer dep version mismatch** — If you see deep type errors in viem/wagmi, check that
   arena's viem version is compatible with blueprint-ui's `^2.31.0` peer dep range.

3. **Missing `resolve.dedupe` entries** — If Rollup fails to resolve a bare import from
   blueprint-ui source, add the package to `resolve.dedupe` in vite.config.ts.

4. **UnoCSS not scanning blueprint-ui** — If `bp-elements-*` classes aren't generating
   CSS, verify the `content.pipeline.include` glob is correct.

---

## File-by-File Migration Checklist

### Replace with re-export stubs (delete local implementation):

| Arena File | Re-export From | Exports |
|---|---|---|
| `lib/utils.ts` | `@tangle/blueprint-ui` | `cn` |
| `lib/stores/persistedAtom.ts` | `@tangle/blueprint-ui` | `persistedAtom`, `serializeWithBigInt`, `deserializeWithBigInt` |
| `lib/stores/theme.ts` | `@tangle/blueprint-ui` | `Theme`, `kTheme`, `DEFAULT_THEME`, `themeStore`, `themeIsDark`, `toggleTheme` |
| `lib/stores/txHistory.ts` | `@tangle/blueprint-ui` | `TrackedTx`, `txListStore`, `pendingCount`, `addTx`, `updateTx`, `clearTxs` |
| `lib/contracts/publicClient.ts` | `@tangle/blueprint-ui` | `selectedChainIdStore`, `publicClientStore`, `getPublicClient`, `publicClient`, `getAddresses` |
| `lib/hooks/useThemeValue.ts` | `@tangle/blueprint-ui` | `useThemeValue` |
| `lib/hooks/useWagmiSidecarAuth.ts` | `@tangle/blueprint-ui` | `useWagmiSidecarAuth` |
| `lib/hooks/useOperators.ts` | `@tangle/blueprint-ui` | `DiscoveredOperator`, `useOperators` |
| `components/ui/badge.tsx` | `@tangle/blueprint-ui/components` | `Badge`, `badgeVariants` |
| `components/ui/button.tsx` | `@tangle/blueprint-ui/components` | `Button`, `buttonVariants` |
| `components/ui/card.tsx` | `@tangle/blueprint-ui/components` | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` |
| `components/ui/dialog.tsx` | `@tangle/blueprint-ui/components` | `Dialog`, `DialogTrigger`, `DialogContent`, `DialogHeader`, `DialogFooter`, `DialogTitle`, `DialogDescription` |
| `components/ui/input.tsx` | `@tangle/blueprint-ui/components` | `Input` |
| `components/ui/separator.tsx` | `@tangle/blueprint-ui/components` | `Separator` |
| `components/ui/skeleton.tsx` | `@tangle/blueprint-ui/components` | `Skeleton` |
| `components/ui/table.tsx` | `@tangle/blueprint-ui/components` | `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell` |
| `components/ui/tabs.tsx` | `@tangle/blueprint-ui/components` | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` |
| `components/shared/Identicon.tsx` | `@tangle/blueprint-ui/components` | `Identicon` |
| `components/shared/TangleLogo.tsx` | `@tangle/blueprint-ui/components` | `TangleLogo` |
| `components/layout/ThemeToggle.tsx` | `@tangle/blueprint-ui/components` | `ThemeToggle` |
| `components/layout/ChainSwitcher.tsx` | `@tangle/blueprint-ui/components` | `ChainSwitcher` |
| `components/motion/AnimatedPage.tsx` | `@tangle/blueprint-ui/components` | `AnimatedPage`, `StaggerContainer`, `StaggerItem` |

### Require custom re-export + local config (see steps above):

| Arena File | Action |
|---|---|
| `lib/contracts/chains.ts` | Re-export + `ArenaAddresses` + `configureNetworks()` call |
| `lib/contracts/abis.ts` | Re-export core ABIs + keep arena-specific ABIs locally |
| `lib/contracts/addresses.ts` | Update Proxy to use `getAddresses<ArenaAddresses>()` |

### Keep as-is (arena-specific, no blueprint-ui equivalent):

| Arena File | Reason |
|---|---|
| `lib/stores/provisions.ts` | Arena-specific provisioning tracker |
| `lib/hooks/useQuotes.ts` | Uses gRPC/Protobuf (blueprint-ui uses REST) |
| `lib/hooks/useProvisionProgress.ts` | Arena-specific react-query polling |
| `lib/hooks/useProvisionWatcher.ts` | Arena-specific TX/provision monitor |
| `lib/hooks/useTxWatcher.ts` | Arena-specific TX confirmation watcher |
| `lib/hooks/useBots.ts` | Arena domain: bot discovery |
| `lib/hooks/useBotApi.ts` | Arena domain: bot trade/portfolio API |
| `lib/hooks/useBotControl.ts` | Arena domain: bot start/stop |
| `lib/hooks/useBotDetail.ts` | Arena domain: bot detail query |
| `lib/hooks/useBotEnrichment.ts` | Arena domain: bot metric enrichment |
| `lib/hooks/useChartTheme.ts` | Arena domain: chart.js theming |
| `lib/hooks/useOperatorAuth.ts` | Arena domain: PASETO operator auth |
| `lib/hooks/useServiceInfo.ts` | Arena domain: service TTL/info query |
| `lib/hooks/useUserServices.ts` | Arena domain: user's services list |
| `lib/hooks/useVaultRead.ts` | Arena domain: vault state reader |
| `lib/hooks/useVaultWrite.ts` | Arena domain: vault deposit/redeem |
| `lib/types/*` | Arena domain types |
| `lib/config/*` | Arena domain config |
| `lib/format.ts` | Arena-specific formatters |
| `lib/gen/pricing_pb.ts` | Generated protobuf |
| `lib/mock/*` | Arena mock data |
| `components/arena/*` | Arena domain components |
| `components/bot-detail/*` | Arena domain components |
| `components/home/*` | Arena domain components |
| `components/landing/*` | Arena domain components |
| `components/vault/*` | Arena domain components |
| `components/layout/Header.tsx` | Arena-specific nav/branding |
| `components/layout/Footer.tsx` | Arena-specific links |
| `components/layout/TxDropdown.tsx` | Uses arena provisions store |
| `components/layout/WalletButton.tsx` | Uses arena network config |
| `components/motion/AnimatedNumber.tsx` | Arena-specific chart animation |
| `components/motion/StaggerContainer.tsx` | Delete — use AnimatedPage's StaggerContainer |
| `providers/Web3Provider.tsx` | Arena-specific wagmi config |

---

## Breaking Changes to Watch For

### 1. `addresses.tangle` vs `addresses.services`

Blueprint-ui's core hooks (`useOperators`, etc.) use `getAddresses().services` for the
Tangle contract address. Arena currently uses `addresses.tangle`. By mapping both `jobs`
and `services` to `VITE_TANGLE_CONTRACT` in the chains config (Step 5), this works
transparently. But any arena-specific code that uses `addresses.tangle` must continue
using the arena-specific `addresses` proxy (Step 6), not `getAddresses()` directly.

### 2. `useQuotes` return type

Blueprint-ui's `UseQuotesResult` includes `isSolvingPow: boolean`. Arena's version does
not have this field. Since arena keeps its own `useQuotes`, this isn't an issue. But if
any shared component expects `isSolvingPow`, it won't exist.

### 3. Dialog close icon

Arena's dialog uses `lucide-react`'s `XIcon`. Blueprint-ui uses Phosphor `i-ph:x`.
After migration, the dialog close button will use a Phosphor icon. Visually similar but
not pixel-identical. The `lucide-react` import can potentially be removed from
`package.json` if no other components use it.

### 4. Theme toggle icons

Same as dialog — Sun/Moon switch from lucide to Phosphor icons.

### 5. Badge variant differences

If arena components use `accent` or `amber` badge variants, these don't exist in
blueprint-ui. Options:
- Add the missing variants to blueprint-ui (preferred — keeps package comprehensive)
- Use `className` overrides at usage sites

### 6. `StaggerContainer` animation timing

Arena's standalone `StaggerContainer.tsx` uses `staggerChildren: 0.06` and `y: 12`.
Blueprint-ui's version uses `staggerChildren: 0.05` and `y: 16`. Minor visual difference.
Decide which values to standardize on.

---

## Estimated Scope

| Category | Files to Change | Complexity |
|---|---|---|
| Package setup (dep, UnoCSS, Vite, localStorage) | 4 files | Low |
| Contract re-exports (chains, abis, addresses, publicClient) | 4 files | Medium |
| Store re-exports | 3 files | Low |
| Hook re-exports | 3 files | Low |
| Component re-exports | 13 files | Low |
| Delete StaggerContainer.tsx duplicate | 1 file | Low |
| Update TangleLogo usage sites (add `label` prop) | ~2 files | Low |
| Verify + fix type/build errors | — | Medium |
| **Total** | ~30 files | **1-2 hours** |

---

## Future Enhancements

After this migration, consider these improvements to `@tangle/blueprint-ui`:

1. **Add arena's missing badge variants** (`accent`, `amber`) to the shared Badge component
2. **Parameterize Header/Footer** with `navItems`/`brandComponent` props so both apps
   can share the layout shell
3. **Add `useQuotes` transport option** to support both gRPC and REST protocols
4. **Extract `provisions.ts` store** if other blueprints need multi-phase provisioning tracking
5. **Publish to npm** — currently `link:` deps, eventually publish `@tangle/blueprint-ui`
   to a registry for third-party blueprint developers
