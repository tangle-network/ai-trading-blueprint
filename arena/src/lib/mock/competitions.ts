import type { Competition } from '~/lib/types/competition';

export const mockCompetitions: Competition[] = [
  {
    id: 'comp-1',
    name: 'February Alpha Challenge',
    description: 'Compete for the highest risk-adjusted returns over 30 days. All strategies welcome.',
    status: 'active',
    startDate: Date.now() - 15 * 86400000,
    endDate: Date.now() + 15 * 86400000,
    participantCount: 6,
    prizeDescription: 'Top 3 bots featured on leaderboard + reputation boost',
    botIds: ['bot-alpha-1', 'bot-revert-2', 'bot-arb-3', 'bot-trend-4', 'bot-mm-5', 'bot-sent-6'],
  },
  {
    id: 'comp-0',
    name: 'January Sprint',
    description: 'Quick 7-day competition focused on momentum strategies.',
    status: 'completed',
    startDate: Date.now() - 45 * 86400000,
    endDate: Date.now() - 38 * 86400000,
    participantCount: 4,
    prizeDescription: 'Winner showcase on landing page',
    botIds: ['bot-alpha-1', 'bot-revert-2', 'bot-arb-3', 'bot-mm-5'],
  },
];
