import { describe, expect, it } from 'vitest';
import {
  OPERATOR_API_PORT,
  TRADING_API_PORT,
  buildInstallCommand,
  buildOperatorEnvBlock,
  normalizeEndpoint,
  normalizeOperatorAddress,
  parseAllowlist,
} from './registration';

const ADDR_A = '0x1111111111111111111111111111111111111111';
const ADDR_B = '0x2222222222222222222222222222222222222222';

describe('normalizeOperatorAddress', () => {
  it('lowercases a valid checksummed address', () => {
    expect(normalizeOperatorAddress('0xABCDEF0123456789abcdef0123456789ABCDEF01')).toBe(
      '0xabcdef0123456789abcdef0123456789abcdef01',
    );
  });

  it('accepts 0X prefix and trims whitespace', () => {
    expect(normalizeOperatorAddress(`  0X${'a'.repeat(40)}  `)).toBe(`0x${'a'.repeat(40)}`);
  });

  it('rejects wrong length and non-hex', () => {
    expect(normalizeOperatorAddress('0x1234')).toBeNull();
    expect(normalizeOperatorAddress(`0x${'z'.repeat(40)}`)).toBeNull();
    expect(normalizeOperatorAddress('not-an-address')).toBeNull();
    expect(normalizeOperatorAddress('')).toBeNull();
  });
});

describe('parseAllowlist', () => {
  it('splits on commas, whitespace and newlines, dedupes, sorts', () => {
    const result = parseAllowlist(`${ADDR_B}, ${ADDR_A}\n${ADDR_A}`);
    expect(result.valid).toEqual([ADDR_A, ADDR_B]);
    expect(result.invalid).toEqual([]);
  });

  it('partitions invalid tokens', () => {
    const result = parseAllowlist(`${ADDR_A} bogus 0xshort`);
    expect(result.valid).toEqual([ADDR_A]);
    expect(result.invalid).toEqual(['bogus', '0xshort']);
  });
});

describe('normalizeEndpoint', () => {
  it('strips trailing slashes', () => {
    expect(normalizeEndpoint('https://op.example:9200/')).toBe('https://op.example:9200');
    expect(normalizeEndpoint('  https://op.example:9200// ')).toBe('https://op.example:9200');
  });
});

describe('buildOperatorEnvBlock', () => {
  it('emits allowlist mode with addresses and capacity', () => {
    const env = buildOperatorEnvBlock({
      accessMode: 'allowlist',
      allowlist: [ADDR_A, ADDR_B],
      maxCapacity: 5,
      apiEndpoint: 'https://op.example:9200/',
      operatorAddress: ADDR_A,
      strategies: ['momentum', 'arbitrage'],
    });
    expect(env).toContain('TRADING_REQUESTER_ACCESS_MODE=allowlist');
    expect(env).toContain(`TRADING_REQUESTER_ALLOWLIST=${ADDR_A},${ADDR_B}`);
    expect(env).toContain('OPERATOR_MAX_CAPACITY=5');
    expect(env).toContain(`OPERATOR_ADDRESS=${ADDR_A}`);
    expect(env).toContain('OPERATOR_API_ENDPOINT=https://op.example:9200');
    expect(env).toContain('SUPPORTED_STRATEGIES=momentum,arbitrage');
    expect(env).toContain(`OPERATOR_API_PORT=${OPERATOR_API_PORT}`);
    expect(env).toContain(`TRADING_API_PORT=${TRADING_API_PORT}`);
  });

  it('omits allowlist line in public mode and capacity when unlimited', () => {
    const env = buildOperatorEnvBlock({
      accessMode: 'public',
      allowlist: [ADDR_A],
      maxCapacity: 0,
      strategies: [],
    });
    expect(env).toContain('TRADING_REQUESTER_ACCESS_MODE=public');
    expect(env).not.toContain('TRADING_REQUESTER_ALLOWLIST');
    expect(env).not.toContain('OPERATOR_MAX_CAPACITY');
    expect(env).not.toContain('SUPPORTED_STRATEGIES');
  });
});

describe('buildInstallCommand', () => {
  it('embeds the env block inside a heredoc and brings the stack up', () => {
    const env = buildOperatorEnvBlock({
      accessMode: 'public',
      allowlist: [],
      strategies: [],
    });
    const cmd = buildInstallCommand(env);
    expect(cmd).toContain("cat > .env <<'EOF'");
    expect(cmd).toContain('TRADING_REQUESTER_ACCESS_MODE=public');
    expect(cmd).toContain('docker compose up -d');
    expect(cmd).toContain('./deploy/setup-hetzner.sh');
  });
});
