import {
  Badge, Button, Dialog, DialogContent, DialogHeader,
  DialogTitle, DialogDescription, Identicon, Input,
} from '@tangle/blueprint-ui/components';
import type { Address } from 'viem';
import type { DiscoveredService, ServiceInfo } from '~/routes/provision/types';
import { formatCost } from '~/routes/provision/types';
import { ServiceDropdown } from './ServiceDropdown';

interface InfrastructureDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  isInstance: boolean;
  serviceMode: 'existing' | 'new';
  setServiceMode: (v: 'existing' | 'new') => void;
  // Existing service
  discoveredServices: DiscoveredService[];
  discoveryLoading: boolean;
  serviceId: string;
  setServiceId: (v: string) => void;
  serviceInfo: ServiceInfo | null;
  serviceLoading: boolean;
  serviceError: string | null;
  userAddress: Address | undefined;
  // New service
  blueprintId: string;
  operatorCount: bigint;
  discoveredOperators: Array<{ address: Address }>;
  selectedOperators: Set<Address>;
  toggleOperator: (addr: Address) => void;
  manualOperator: string;
  setManualOperator: (v: string) => void;
  addManualOperator: () => void;
  // Quotes
  isQuoting: boolean;
  quotes: Array<{ operator: string; totalCost: bigint }>;
  quoteErrors: Map<string, string>;
  totalCost: bigint;
  refetchQuotes: () => void;
  // Deploy
  isConnected: boolean;
  isNewServicePending: boolean;
  newServiceDeploying: boolean;
  handleDeployNewService: () => void;
  setNewServiceDeploying: (v: boolean) => void;
  setNewServiceTxHash: (v: `0x${string}` | undefined) => void;
}

export function InfrastructureDialog({
  open,
  onOpenChange,
  isInstance,
  serviceMode,
  setServiceMode,
  discoveredServices,
  discoveryLoading,
  serviceId,
  setServiceId,
  serviceInfo,
  serviceLoading,
  serviceError,
  userAddress,
  blueprintId,
  operatorCount,
  discoveredOperators,
  selectedOperators,
  toggleOperator,
  manualOperator,
  setManualOperator,
  addManualOperator,
  isQuoting,
  quotes,
  quoteErrors,
  totalCost,
  refetchQuotes,
  isConnected,
  isNewServicePending,
  newServiceDeploying,
  handleDeployNewService,
  setNewServiceDeploying,
  setNewServiceTxHash,
}: InfrastructureDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] flex flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-lg">
            Infrastructure Settings
          </DialogTitle>
          <DialogDescription className="text-sm">
            Configure which service your agent will be provisioned on.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Service mode toggle — instance blueprints always create new */}
          <div className="space-y-2">
            <span className="text-sm font-data uppercase tracking-wider text-arena-elements-textSecondary block">
              Service
            </span>
            {isInstance && (
              <div className="p-3 rounded-lg bg-violet-500/5 border border-violet-500/30 text-sm text-arena-elements-textSecondary">
                Instance blueprints create a dedicated service per bot. Each service runs exactly one trading agent.
              </div>
            )}
            {!isInstance && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setServiceMode('existing')}
                  className={`flex-1 rounded-lg border px-4 py-3 text-left transition-all ${
                    serviceMode === 'existing'
                      ? 'border-violet-500/50 bg-violet-500/5 ring-1 ring-violet-500/20'
                      : 'border-arena-elements-borderColor hover:border-arena-elements-borderColorActive/40 bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1'
                  }`}
                >
                  <div className={`text-sm font-display font-semibold ${serviceMode === 'existing' ? 'text-violet-700 dark:text-violet-400' : 'text-arena-elements-textPrimary'}`}>
                    Use Existing
                  </div>
                  <div className="text-xs text-arena-elements-textTertiary mt-0.5">
                    Join a running service
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setServiceMode('new')}
                  className={`flex-1 rounded-lg border px-4 py-3 text-left transition-all ${
                    serviceMode === 'new'
                      ? 'border-violet-500/50 bg-violet-500/5 ring-1 ring-violet-500/20'
                      : 'border-arena-elements-borderColor hover:border-arena-elements-borderColorActive/40 bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1'
                  }`}
                >
                  <div className={`text-sm font-display font-semibold ${serviceMode === 'new' ? 'text-violet-700 dark:text-violet-400' : 'text-arena-elements-textPrimary'}`}>
                    Create New
                  </div>
                  <div className="text-xs text-arena-elements-textTertiary mt-0.5">
                    Deploy new infrastructure
                  </div>
                </button>
              </div>
            )}
          </div>

          {/* Existing service config */}
          {serviceMode === 'existing' && (
            <ServiceDropdown
              discoveredServices={discoveredServices}
              discoveryLoading={discoveryLoading}
              serviceId={serviceId}
              serviceInfo={serviceInfo}
              serviceLoading={serviceLoading}
              serviceError={serviceError}
              userAddress={userAddress}
              onSelect={(id) => setServiceId(id)}
            />
          )}

          {/* New service config */}
          {serviceMode === 'new' && (
            <div className="space-y-3">
              <div>
                <span className="text-sm font-data text-arena-elements-textSecondary block mb-2">
                  Select Operators ({operatorCount.toString()} available)
                </span>
                {discoveredOperators.length > 0 ? (
                  <div className="grid gap-1.5">
                    {discoveredOperators.map((op) => {
                      const sel = selectedOperators.has(op.address);
                      return (
                        <button
                          key={op.address}
                          type="button"
                          onClick={() => toggleOperator(op.address)}
                          className={`flex items-center gap-3 p-3 rounded-lg border text-left transition-all ${
                            sel
                              ? 'border-violet-500/40 bg-violet-500/5'
                              : 'border-arena-elements-borderColor hover:border-arena-elements-borderColorActive/30 bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1'
                          }`}
                        >
                          <Identicon address={op.address} size={22} />
                          <span className="font-data text-sm truncate flex-1">{op.address}</span>
                          {sel && <Badge variant="success" className="text-xs">Selected</Badge>}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-xs text-arena-elements-textTertiary py-2">
                    No operators found for blueprint {blueprintId}.
                  </div>
                )}
                <div className="flex gap-2 mt-2">
                  <Input
                    placeholder="0x... (manual address)"
                    value={manualOperator}
                    onChange={(e) => setManualOperator(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addManualOperator()}
                    className="text-xs h-8"
                    aria-label="Operator address"
                  />
                  <Button type="button" variant="outline" size="sm" onClick={addManualOperator} className="text-xs h-8">
                    Add
                  </Button>
                </div>
              </div>

              {/* Quotes */}
              {selectedOperators.size > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-data text-arena-elements-textSecondary">Operator Quotes</span>
                    <Button type="button" variant="outline" size="sm" onClick={refetchQuotes} disabled={isQuoting} className="text-[10px] h-6 px-2">
                      {isQuoting ? 'Fetching...' : 'Refresh'}
                    </Button>
                  </div>
                  {isQuoting && quotes.length === 0 && (
                    <div className="text-xs text-arena-elements-textTertiary py-2 text-center animate-pulse">
                      Solving PoW challenge...
                    </div>
                  )}
                  {quotes.length > 0 && (
                    <div className="space-y-1.5">
                      {quotes.map((q) => (
                        <div key={q.operator} className="flex items-center gap-2 p-2 rounded border border-emerald-700/30 bg-emerald-700/5 dark:border-emerald-500/30 dark:bg-emerald-500/5">
                          <Identicon address={q.operator as `0x${string}`} size={18} />
                          <span className="font-data text-xs truncate flex-1">{q.operator}</span>
                          <span className="font-data text-xs text-arena-elements-icon-success shrink-0">{formatCost(q.totalCost)}</span>
                        </div>
                      ))}
                      <div className="flex items-center justify-between px-1">
                        <span className="text-[11px] font-data text-arena-elements-textSecondary">Total</span>
                        <span className="font-data text-xs font-semibold">{formatCost(totalCost)}</span>
                      </div>
                    </div>
                  )}
                  {quoteErrors.size > 0 && (
                    <div className="space-y-1">
                      {Array.from(quoteErrors.entries()).map(([addr, msg]) => (
                        <div key={addr} className="text-[11px] text-crimson-400 truncate">
                          {addr.slice(0, 10)}...{addr.slice(-4)}: {msg}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Deploy new service button */}
              {quotes.length > 0 && (
                <div>
                  <Button
                    onClick={handleDeployNewService}
                    className="w-full"
                    size="sm"
                    disabled={!isConnected || isNewServicePending || newServiceDeploying || isQuoting}
                  >
                    {!isConnected
                      ? 'Connect Wallet'
                      : isNewServicePending
                        ? 'Confirm in Wallet...'
                        : newServiceDeploying
                          ? 'Waiting for Activation...'
                          : `Create Service (${formatCost(totalCost)})`}
                  </Button>
                  {newServiceDeploying && (
                    <div className="text-center mt-2 space-y-1">
                      <p className="text-[11px] text-arena-elements-textTertiary animate-pulse">
                        Waiting for operators to activate...
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => { setNewServiceDeploying(false); setNewServiceTxHash(undefined); }}
                        className="text-[11px] h-6"
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="pt-3 border-t border-arena-elements-dividerColor">
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
