import { blo } from 'blo';
import type { Address } from 'viem';

interface IdenticonProps {
  address: Address;
  size?: number;
  className?: string;
}

export function Identicon({ address, size = 20, className }: IdenticonProps) {
  const dataUri = blo(address, size);
  return (
    <img
      src={dataUri}
      alt={`${address.slice(0, 6)}...${address.slice(-4)}`}
      width={size}
      height={size}
      className={`rounded-full ${className ?? ''}`}
      style={{ imageRendering: 'pixelated' }}
    />
  );
}
