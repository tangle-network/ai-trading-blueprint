import { motion } from 'framer-motion';
import { useBotTrades } from '~/lib/hooks/useBotApi';
import { Card, CardContent } from '~/components/ui/card';
import { Badge } from '~/components/ui/badge';

interface ReasoningTabProps {
  botId: string;
  botName?: string;
}

function ScoreRing({ score }: { score: number }) {
  const radius = 18;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const color = score >= 80 ? '#00FF88' : score >= 50 ? '#FFB800' : '#FF3B5C';

  return (
    <div className="score-ring w-11 h-11">
      <svg width="44" height="44">
        <circle
          cx="22"
          cy="22"
          r={radius}
          fill="none"
          stroke="rgba(240, 240, 245, 0.06)"
          strokeWidth="3"
        />
        <circle
          cx="22"
          cy="22"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 4px ${color}40)` }}
        />
      </svg>
      <span className="score-value" style={{ color }}>{score}</span>
    </div>
  );
}

export function ReasoningTab({ botId, botName = '' }: ReasoningTabProps) {
  const { data: allTrades, isLoading } = useBotTrades(botId, botName);
  const trades = allTrades?.filter((t) => t.validatorReasoning) ?? [];

  if (isLoading) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:arrow-clockwise text-3xl mb-3 mx-auto text-arena-elements-textTertiary animate-spin" />
        Loading validator reasoning...
      </div>
    );
  }

  if (trades.length === 0) {
    return (
      <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
        <div className="i-ph:brain text-3xl mb-3 mx-auto text-arena-elements-textTertiary" />
        No validator reasoning available for this bot's trades.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {trades.map((trade, i) => (
        <motion.div
          key={trade.id}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.06, duration: 0.4 }}
        >
          <Card className="overflow-hidden">
            <CardContent className="pt-5 pb-5">
              <div className="flex items-start gap-4">
                <ScoreRing score={trade.validatorScore ?? 0} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <Badge variant={trade.action === 'buy' ? 'success' : 'destructive'}>
                      {trade.action.toUpperCase()}
                    </Badge>
                    <span className="text-sm font-display font-medium">
                      {trade.tokenIn}/{trade.tokenOut}
                    </span>
                    <span className="text-[11px] font-data text-arena-elements-textTertiary">
                      {new Date(trade.timestamp).toLocaleString('en-US', {
                        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <p className="text-sm text-arena-elements-textSecondary leading-relaxed">
                    {trade.validatorReasoning}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      ))}
    </div>
  );
}
