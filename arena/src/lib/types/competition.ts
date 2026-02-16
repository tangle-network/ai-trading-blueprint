export type CompetitionStatus = 'upcoming' | 'active' | 'completed';

export interface Competition {
  id: string;
  name: string;
  description: string;
  status: CompetitionStatus;
  startDate: number;
  endDate: number;
  participantCount: number;
  prizeDescription: string;
  botIds: string[];
}
