import { UnsupportedFeatureCard } from '~/components/operator/OperatorAccessCard';

interface TerminalTabProps {
  botId: string;
}

export function TerminalTab({ botId }: TerminalTabProps) {
  void botId;
  return <UnsupportedFeatureCard feature="Terminal" />;
}
