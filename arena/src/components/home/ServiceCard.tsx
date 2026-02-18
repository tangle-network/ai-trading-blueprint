import { useState } from 'react';
import { Link } from 'react-router';
import { motion, AnimatePresence } from 'framer-motion';
import { Badge } from '~/components/ui/badge';
import { Identicon } from '~/components/shared/Identicon';
import type { UserService } from '~/lib/hooks/useUserServices';
import type { Bot } from '~/lib/types/bot';
import { formatDuration, truncateAddress } from '~/lib/format';

export function ServiceCard({
  service,
  bots,
}: {
  service: UserService;
  bots: Bot[];
}) {
  const [expanded, setExpanded] = useState(false);

  const statusVariant = service.isActive ? 'success' : service.terminatedAt > 0 ? 'destructive' : 'amber';
  const statusLabel = service.isActive ? 'Active' : service.terminatedAt > 0 ? 'Terminated' : 'Pending';

  const ttlFraction = service.remainingSeconds != null && service.ttl > 0
    ? Math.min(1, Math.max(0, service.remainingSeconds / (service.ttl * 12)))
    : null;

  const totalTvl = bots.reduce((sum, b) => sum + b.tvl, 0);

  return (
    <div className="glass-card rounded-lg border border-arena-elements-borderColor/40 transition-colors hover:border-arena-elements-borderColorActive/30">
      {/* Collapsed row */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
      >
        <div className={`i-ph:cube text-base shrink-0 ${
          service.isActive ? 'text-arena-elements-icon-success' : 'text-arena-elements-textTertiary'
        }`} />

        <span className="text-sm font-display font-semibold whitespace-nowrap">
          Service #{service.serviceId}
        </span>

        <Badge variant={statusVariant} className="text-[10px]">{statusLabel}</Badge>

        {/* Inline stats */}
        <div className="flex items-center gap-3 text-[11px] font-data text-arena-elements-textSecondary ml-1 min-w-0 overflow-hidden">
          <span className="flex items-center gap-1 shrink-0">
            <div className="i-ph:users text-[10px]" />
            {service.operators.length}
          </span>
          {bots.length > 0 && (
            <span className="flex items-center gap-1 shrink-0">
              <div className="i-ph:robot text-[10px]" />
              {bots.length}
            </span>
          )}
          {totalTvl > 0 && (
            <span className="shrink-0">
              ${totalTvl >= 1000 ? `${(totalTvl / 1000).toFixed(0)}K` : totalTvl.toFixed(0)}
            </span>
          )}
          {/* Operator identicons */}
          <span className="flex items-center gap-0.5 shrink-0">
            {service.operators.slice(0, 3).map((op) => (
              <Identicon key={op} address={op} size={16} />
            ))}
            {service.operators.length > 3 && (
              <span className="text-[10px] text-arena-elements-textTertiary ml-0.5">
                +{service.operators.length - 3}
              </span>
            )}
          </span>
        </div>

        {/* Right: TTL + caret */}
        <div className="flex items-center gap-2 ml-auto shrink-0">
          {service.remainingSeconds != null && service.remainingSeconds > 0 && (
            <div className="flex items-center gap-1.5">
              {ttlFraction != null && (
                <div className="w-12 h-1 rounded-full bg-arena-elements-background-depth-3">
                  <div
                    className={`h-full rounded-full ${
                      ttlFraction > 0.3 ? 'bg-emerald-500' : ttlFraction > 0.1 ? 'bg-amber-400' : 'bg-crimson-400'
                    }`}
                    style={{ width: `${ttlFraction * 100}%` }}
                  />
                </div>
              )}
              <span className="text-[11px] font-data text-arena-elements-textTertiary whitespace-nowrap">
                {formatDuration(service.remainingSeconds)}
              </span>
            </div>
          )}
          <div className={`i-ph:caret-down text-xs text-arena-elements-textTertiary transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {/* Expanded detail */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 pt-1 border-t border-arena-elements-dividerColor/50 space-y-3">
              {/* Operators */}
              <div>
                <h4 className="text-[11px] font-data uppercase tracking-wider text-arena-elements-textTertiary mb-1.5">
                  Operators
                </h4>
                <div className="space-y-1">
                  {service.operators.map((op) => (
                    <div key={op} className="flex items-center gap-2 px-2 py-1 rounded bg-arena-elements-background-depth-3/50">
                      <Identicon address={op} size={18} />
                      <span className="text-xs font-data text-arena-elements-textPrimary">
                        {truncateAddress(op)}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigator.clipboard.writeText(op);
                        }}
                        className="text-arena-elements-textTertiary hover:text-violet-400 transition-colors ml-auto"
                        title="Copy address"
                      >
                        <div className="i-ph:copy text-xs" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Vaults */}
              {service.vaultAddresses.length > 0 && (
                <div>
                  <h4 className="text-[11px] font-data uppercase tracking-wider text-arena-elements-textTertiary mb-1.5">
                    Vaults
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {service.vaultAddresses.map((addr) => (
                      <Link
                        key={addr}
                        to={`/vault/${addr}`}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-data bg-arena-elements-background-depth-3/50 border border-arena-elements-borderColor/40 hover:border-violet-500/40 transition-colors"
                      >
                        <div className="i-ph:vault text-[10px] text-arena-elements-textTertiary" />
                        <span className="text-violet-700 dark:text-violet-400">
                          {truncateAddress(addr)}
                        </span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {/* Bots */}
              {bots.length > 0 && (
                <div>
                  <h4 className="text-[11px] font-data uppercase tracking-wider text-arena-elements-textTertiary mb-1.5">
                    Bots
                  </h4>
                  <div className="space-y-1">
                    {bots.map((bot) => {
                      const isProvisioning = bot.id.startsWith('provision:');
                      const statusVariant = bot.status === 'active' ? 'success' as const
                        : bot.status === 'needs_config' ? 'amber' as const
                        : bot.status === 'paused' ? 'amber' as const
                        : 'secondary' as const;
                      const statusText = isProvisioning ? 'provisioning'
                        : bot.status === 'needs_config' ? 'needs config'
                        : bot.status;

                      const inner = (
                        <>
                          <div className={`text-xs shrink-0 ${isProvisioning ? 'i-ph:gear animate-spin text-amber-400' : 'i-ph:robot text-arena-elements-textTertiary'}`} />
                          <span className="text-xs font-display font-medium truncate">{bot.name}</span>
                          <Badge variant={isProvisioning ? 'amber' : statusVariant} className="text-[9px] ml-auto">
                            {statusText}
                          </Badge>
                        </>
                      );

                      return isProvisioning ? (
                        <div
                          key={bot.id}
                          className="flex items-center gap-2 px-2 py-1 rounded bg-arena-elements-background-depth-3/50"
                        >
                          {inner}
                        </div>
                      ) : (
                        <Link
                          key={bot.id}
                          to={`/arena/bot/${bot.id}`}
                          className="flex items-center gap-2 px-2 py-1 rounded bg-arena-elements-background-depth-3/50 hover:bg-arena-elements-background-depth-3 transition-colors"
                        >
                          {inner}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Meta */}
              <div className="flex items-center gap-3 text-[10px] font-data text-arena-elements-textTertiary pt-1">
                <span>Blueprint #{service.blueprintId}</span>
                <span>Owner: {truncateAddress(service.owner)}</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
