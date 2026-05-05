import { useState } from 'react';
import { Badge, Identicon } from '@tangle-network/blueprint-ui/components';
import type { Address } from 'viem';
import type { DiscoveredService, ServiceInfo } from '~/routes/provision/types';

interface ServiceDropdownProps {
  discoveredServices: DiscoveredService[];
  discoveryLoading: boolean;
  serviceId: string;
  serviceInfo: ServiceInfo | null;
  serviceLoading: boolean;
  serviceError: string | null;
  userAddress: Address | undefined;
  onSelect: (id: string) => void;
}

export function ServiceDropdown({
  discoveredServices,
  discoveryLoading,
  serviceId,
  serviceInfo,
  serviceLoading,
  serviceError,
  userAddress,
  onSelect,
}: ServiceDropdownProps) {
  const [open, setOpen] = useState(false);
  const selected = discoveredServices.find((ds) => ds.serviceId.toString() === serviceId);

  return (
    <div className="space-y-3">
      {discoveryLoading && discoveredServices.length === 0 && (
        <div className="text-sm text-arena-elements-textTertiary py-3 text-center animate-pulse">
          Scanning for available services...
        </div>
      )}

      {!discoveryLoading && discoveredServices.length === 0 && userAddress && (
        <div className="text-sm text-arena-elements-textTertiary py-3 text-center">
          No services found. Try creating a new service instead.
        </div>
      )}

      {discoveredServices.length > 0 && (
        <div className="relative">
          <span className="text-[11px] font-data font-semibold uppercase tracking-[0.22em] text-arena-elements-textTertiary block mb-2">
            Select Service
          </span>

          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="arena-control-shell w-full rounded-xl px-4 py-3.5 text-left"
          >
            <div className="flex items-start gap-3">
              <span
                className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${selected?.isActive ? 'bg-arena-elements-icon-success shadow-[0_0_0_4px_rgba(16,185,129,0.14)]' : 'bg-crimson-400 shadow-[0_0_0_4px_rgba(244,63,94,0.12)]'}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-display text-sm font-semibold text-arena-elements-textPrimary">
                    {selected ? `Service #${selected.serviceId}` : `Service #${serviceId}`}
                  </span>
                  {selected?.isOwner && (
                    <Badge variant="outline" className="text-[10px] uppercase tracking-[0.16em]">Owner</Badge>
                  )}
                  {selected?.isPermitted && !selected.isOwner && (
                    <Badge variant="outline" className="text-[10px] uppercase tracking-[0.16em]">Permitted</Badge>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-data text-arena-elements-textTertiary">
                  <span>
                    {selected
                      ? (selected.isActive ? 'Active and ready' : 'Inactive service')
                      : (serviceLoading ? 'Checking service status' : 'Manual service selection')}
                  </span>
                  <span>
                    {selected
                      ? `${selected.operatorCount} operator${selected.operatorCount !== 1 ? 's' : ''}`
                      : 'Select an existing service'}
                  </span>
                </div>
              </div>
              <svg
                className={`mt-1 h-4 w-4 shrink-0 text-arena-elements-textTertiary transition-transform ${open ? 'rotate-180' : ''}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </button>

          {open && (
            <div className="arena-control-shell mt-2 overflow-hidden rounded-xl">
              {discoveredServices.map((ds) => {
                const isSelected = serviceId === ds.serviceId.toString();
                return (
                  <button
                    key={ds.serviceId}
                    type="button"
                    onClick={() => {
                      onSelect(ds.serviceId.toString());
                      setOpen(false);
                    }}
                    className={`w-full px-4 py-3 text-left transition-colors ${
                      isSelected
                        ? 'bg-violet-500/10'
                        : ds.isActive && ds.isPermitted
                          ? 'hover:bg-arena-elements-item-backgroundHover'
                          : 'opacity-50'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${ds.isActive ? 'bg-arena-elements-icon-success' : 'bg-crimson-400'}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-display text-sm font-medium text-arena-elements-textPrimary">
                            Service #{ds.serviceId}
                          </span>
                          {ds.isOwner && (
                            <Badge variant="outline" className="text-[10px] uppercase tracking-[0.16em]">Owner</Badge>
                          )}
                          {ds.isPermitted && !ds.isOwner && (
                            <Badge variant="outline" className="text-[10px] uppercase tracking-[0.16em]">Permitted</Badge>
                          )}
                          {!ds.isPermitted && (
                            <Badge variant="destructive" className="text-[10px] uppercase tracking-[0.16em]">No access</Badge>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-data text-arena-elements-textTertiary">
                          <span>{ds.isActive ? 'Active' : 'Inactive'}</span>
                          <span>{ds.operatorCount} operator{ds.operatorCount !== 1 ? 's' : ''}</span>
                        </div>
                      </div>
                      {isSelected && (
                        <svg className="mt-1 h-4 w-4 shrink-0 text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {serviceError && (
        <div className="text-sm text-crimson-400 p-3 rounded-lg bg-crimson-500/5 border border-crimson-500/20">
          {serviceError}
        </div>
      )}

      {/* Service details (shown below dropdown for the selected service) */}
      {serviceInfo && (
        <div className="arena-panel-inset rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${serviceInfo.isActive ? 'bg-arena-elements-icon-success' : 'bg-crimson-400'}`}
            />
            <span className="text-sm font-display font-medium text-arena-elements-textPrimary">
              Service {serviceId} — {serviceInfo.isActive ? 'Active' : 'Inactive'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-y-1.5 text-sm font-data">
            <span className="text-arena-elements-textTertiary">Owner</span>
            <span className="text-arena-elements-textPrimary truncate">{serviceInfo.owner}</span>
            <span className="text-arena-elements-textTertiary">Operators</span>
            <span className="text-arena-elements-textPrimary">{serviceInfo.operators.length}</span>
            <span className="text-arena-elements-textTertiary">TTL</span>
            <span className="text-arena-elements-textPrimary">
              {serviceInfo.ttl > 0 ? `${Math.floor(serviceInfo.ttl / 86400)}d` : 'Unlimited'}
            </span>
          </div>
          {serviceInfo.operators.length > 0 && (
            <div className="pt-1 space-y-1">
              {serviceInfo.operators.map((addr) => (
                <div key={addr} className="flex items-center gap-2 px-2.5 py-1.5 rounded bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1">
                  <Identicon address={addr} size={18} />
                  <span className="font-data text-xs text-arena-elements-textSecondary truncate">{addr}</span>
                </div>
              ))}
            </div>
          )}
          {!serviceInfo.isPermitted && userAddress && (
            <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400 pt-1">
              <span>Your address is not a permitted caller. The transaction may revert.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
