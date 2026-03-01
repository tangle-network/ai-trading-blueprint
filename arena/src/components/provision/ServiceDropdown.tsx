import { useState } from 'react';
import { Badge, Identicon } from '@tangle/blueprint-ui/components';
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
          <span className="text-sm font-data text-arena-elements-textSecondary block mb-2">
            Select Service
          </span>

          {/* Selected service trigger */}
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="w-full flex items-center gap-3 p-3 rounded-lg border border-arena-elements-borderColor hover:border-arena-elements-borderColorActive/40 bg-arena-elements-background-depth-3 dark:bg-arena-elements-background-depth-1 transition-colors text-left"
          >
            {selected ? (
              <>
                <span
                  className={`w-2.5 h-2.5 rounded-full shrink-0 ${selected.isActive ? 'bg-arena-elements-icon-success' : 'bg-crimson-400'}`}
                />
                <span className="font-data text-sm text-arena-elements-textPrimary flex-1">
                  Service #{selected.serviceId}
                </span>
                <span className="text-xs font-data text-arena-elements-textTertiary">
                  {selected.operatorCount} operator{selected.operatorCount !== 1 ? 's' : ''}
                </span>
                {selected.isOwner && (
                  <Badge variant="outline" className="text-xs">Owner</Badge>
                )}
                {selected.isPermitted && !selected.isOwner && (
                  <Badge variant="outline" className="text-xs">Permitted</Badge>
                )}
              </>
            ) : (
              <>
                {serviceLoading ? (
                  <span className="w-2.5 h-2.5 rounded-full shrink-0 bg-amber-400 animate-pulse" />
                ) : null}
                <span className="font-data text-sm text-arena-elements-textTertiary flex-1">
                  Service #{serviceId}
                </span>
              </>
            )}
            <svg
              className={`w-4 h-4 text-arena-elements-textTertiary transition-transform shrink-0 ${open ? 'rotate-180' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {/* Dropdown options */}
          {open && (
            <div className="mt-1.5 rounded-lg border border-arena-elements-borderColor bg-arena-elements-background-depth-2 shadow-lg overflow-hidden">
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
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                      isSelected
                        ? 'bg-violet-500/10'
                        : ds.isActive && ds.isPermitted
                          ? 'hover:bg-arena-elements-item-backgroundHover'
                          : 'opacity-50'
                    }`}
                  >
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${ds.isActive ? 'bg-arena-elements-icon-success' : 'bg-crimson-400'}`}
                    />
                    <span className="font-data text-sm text-arena-elements-textPrimary flex-1">
                      Service #{ds.serviceId}
                    </span>
                    <span className="text-xs font-data text-arena-elements-textTertiary">
                      {ds.operatorCount} op{ds.operatorCount !== 1 ? 's' : ''}
                    </span>
                    {ds.isOwner && (
                      <Badge variant="outline" className="text-[11px]">Owner</Badge>
                    )}
                    {ds.isPermitted && !ds.isOwner && (
                      <Badge variant="outline" className="text-[11px]">Permitted</Badge>
                    )}
                    {!ds.isPermitted && (
                      <Badge variant="destructive" className="text-[11px]">No Access</Badge>
                    )}
                    {isSelected && (
                      <svg className="w-4 h-4 text-violet-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
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
        <div className="p-3.5 rounded-lg bg-arena-elements-item-backgroundHover/30 border border-arena-elements-borderColor/40 space-y-2">
          <div className="flex items-center gap-2">
            <span
              className={`w-2.5 h-2.5 rounded-full shrink-0 ${serviceInfo.isActive ? 'bg-arena-elements-icon-success' : 'bg-crimson-400'}`}
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
