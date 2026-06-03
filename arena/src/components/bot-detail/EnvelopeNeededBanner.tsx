/**
 * Envelope-mode reminder banner for the bot detail page.
 *
 * Shown only when:
 *   - bot is in envelope mode (`bot.validationTrust === 'envelope'`), AND
 *   - the operator API confirms there is no signed envelope on file.
 *
 * Auto-disappears once an envelope is stored — the underlying `useEnvelope`
 * query reflects the freshly PUT envelope on success.
 */

import { Button } from '@tangle-network/blueprint-ui/components';
import { useEnvelope } from '~/lib/hooks/useEnvelope';
import type { Bot } from '~/lib/types/bot';

interface EnvelopeNeededBannerProps {
  bot: Bot;
  onSignEnvelope: () => void;
}

export function EnvelopeNeededBanner({
  bot,
  onSignEnvelope,
}: EnvelopeNeededBannerProps) {
  const isEnvelopeMode = bot.validationTrust === 'envelope';
  const envelopeQuery = useEnvelope({
    botId: bot.id,
    operatorKind: bot.operatorKind,
    apiUrl: bot.operatorApiUrl ?? undefined,
  });

  // Hide while we don't have an authoritative answer yet — avoids flicker for
  // bots that already have an envelope on file but whose query hasn't resolved.
  if (!isEnvelopeMode) return null;
  if (envelopeQuery.isLoading) return null;
  if (envelopeQuery.data) return null;
  if (envelopeQuery.isError) return null;

  return (
    <div
      role="alert"
      aria-label="Envelope required"
      className="mb-4 flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3"
    >
      <div className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500 animate-pulse" aria-hidden="true" />
      <div className="flex-1">
        <div className="text-sm font-display font-semibold text-amber-700 dark:text-amber-400">
          Envelope required
        </div>
        <p className="mt-0.5 text-xs text-amber-950/80 dark:text-amber-100/85">
          This bot is in Envelope mode. Sign and submit an envelope on the
          Envelope tab to enable trading.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onSignEnvelope}
        className="shrink-0"
      >
        Open Envelope tab
      </Button>
    </div>
  );
}
