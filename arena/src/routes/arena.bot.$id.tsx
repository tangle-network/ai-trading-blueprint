import { useState } from 'react';
import { useParams, Link } from 'react-router';
import type { MetaFunction } from 'react-router';
import { useBots } from '~/lib/hooks/useBots';
import { AnimatedPage, Button, Tabs, TabsList, TabsTrigger, TabsContent } from '@tangle/blueprint-ui/components';
import { BotHeader } from '~/components/bot-detail/BotHeader';
import { PerformanceTab } from '~/components/bot-detail/PerformanceTab';
import { PositionsTab } from '~/components/bot-detail/PositionsTab';
import { TradeHistoryTab } from '~/components/bot-detail/TradeHistoryTab';
import { ReasoningTab, usePendingValidationCount } from '~/components/bot-detail/ReasoningTab';
import { ChatTab } from '~/components/bot-detail/ChatTab';
import { ControlsTab } from '~/components/bot-detail/ControlsTab';
import { TerminalTab } from '~/components/bot-detail/TerminalTab';
import { SecretsModal, type SecretsTarget } from '~/components/home/SecretsModal';

export const meta: MetaFunction = () => [
  { title: 'Bot — AI Trading Arena' },
];

export default function BotDetailPage() {
  const { id } = useParams();
  const { bots, isLoading } = useBots();
  const [secretsTarget, setSecretsTarget] = useState<SecretsTarget | null>(null);
  // Match by ID, sandbox ID, or vault address (handles various link formats)
  const bot = bots.find((b) => b.id === id)
    ?? bots.find((b) => id && b.sandboxId === id)
    ?? bots.find((b) => id && b.vaultAddress.toLowerCase() === id.toLowerCase());

  // Must call hooks before early returns (React rules of hooks)
  const pendingValidationCount = usePendingValidationCount(bot?.id ?? '', bot?.name);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-20 text-center">
        <div className="glass-card rounded-xl p-12 max-w-md mx-auto">
          <div className="i-ph:arrow-clockwise text-4xl text-arena-elements-textTertiary mb-4 mx-auto animate-spin" />
          <p className="text-arena-elements-textSecondary text-sm">Loading bot data...</p>
        </div>
      </div>
    );
  }

  if (!bot) {
    return (
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-20 text-center">
        <div className="glass-card rounded-xl p-12 max-w-md mx-auto">
          <div className="i-ph:robot text-4xl text-arena-elements-textTertiary mb-4 mx-auto" />
          <h1 className="font-display text-2xl font-bold mb-3">Bot Not Found</h1>
          <p className="text-arena-elements-textSecondary mb-6 text-sm">
            The bot with ID "{id}" does not exist.
          </p>
          <Button asChild variant="outline">
            <Link to="/arena">Back to Arena</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <AnimatedPage>
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8">
        <Link
          to="/arena"
          className="inline-flex items-center gap-1.5 text-sm text-arena-elements-textTertiary hover:text-violet-700 dark:hover:text-violet-400 mb-6 transition-colors duration-200 font-display font-medium"
        >
          <span className="text-xs">&larr;</span> Back to Arena
        </Link>

        <BotHeader bot={bot} />

        <Tabs defaultValue="performance">
          <TabsList>
            <TabsTrigger value="performance">Performance</TabsTrigger>
            <TabsTrigger value="positions">Positions</TabsTrigger>
            <TabsTrigger value="trades">Trade History</TabsTrigger>
            <TabsTrigger value="reasoning" className="relative">
              Reasoning
              {pendingValidationCount > 0 && (
                <span className="ml-1.5 w-2 h-2 rounded-full bg-violet-500 animate-pulse inline-block" />
              )}
            </TabsTrigger>
            <TabsTrigger value="chat">Chat</TabsTrigger>
            <TabsTrigger value="terminal">Terminal</TabsTrigger>
            <TabsTrigger value="controls">Controls</TabsTrigger>
          </TabsList>

          <TabsContent value="performance" className="mt-6">
            <PerformanceTab bot={bot} />
          </TabsContent>

          <TabsContent value="positions" className="mt-6">
            <PositionsTab botId={bot.id} />
          </TabsContent>

          <TabsContent value="trades" className="mt-6">
            <TradeHistoryTab botId={bot.id} botName={bot.name} />
          </TabsContent>

          <TabsContent value="reasoning" className="mt-6">
            <ReasoningTab botId={bot.id} botName={bot.name} />
          </TabsContent>

          <TabsContent value="chat" className="mt-6">
            <ChatTab botId={bot.id} botName={bot.name} operatorAddress={bot.operatorAddress} />
          </TabsContent>

          <TabsContent value="terminal" className="mt-6">
            <TerminalTab botId={bot.id} />
          </TabsContent>

          <TabsContent value="controls" className="mt-6">
            <ControlsTab
              bot={bot}
              onConfigureSecrets={
                (bot.status === 'needs_config' || bot.secretsConfigured === false)
                  ? () => setSecretsTarget({
                      botId: bot.id,
                      sandboxId: bot.sandboxId,
                      callId: bot.callId,
                      serviceId: bot.serviceId,
                    })
                  : undefined
              }
            />
          </TabsContent>
        </Tabs>

        <SecretsModal
          target={secretsTarget}
          onClose={() => setSecretsTarget(null)}
        />
      </div>
    </AnimatedPage>
  );
}
