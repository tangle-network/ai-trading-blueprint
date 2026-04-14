import { describe, expect, it } from 'vitest';
import type { TrackedProvision } from '~/lib/stores/provisions';
import {
  buildInstanceFallbackBot,
  findMatchingInstanceRouteProvision,
  mapLifecycleStatusToBotStatus,
} from './instanceBotRoute';

function makeInstanceProvision(overrides: Partial<TrackedProvision> = {}): TrackedProvision {
  return {
    id: 'instance-4',
    owner: '0x0000000000000000000000000000000000000001',
    name: 'Fallback Instance Bot',
    strategyType: 'dex',
    operators: [],
    blueprintId: '1',
    blueprintType: 'trading-instance',
    serviceId: 4,
    botId: 'trading-1',
    sandboxId: 'sandbox-1',
    phase: 'awaiting_secrets',
    createdAt: 1,
    updatedAt: 2,
    chainId: 31337,
    ...overrides,
  };
}

describe('instance bot route helpers', () => {
  it('matches an instance provision by bot id, sandbox id, or service id', () => {
    const provision = makeInstanceProvision();
    const provisions = [provision];

    expect(findMatchingInstanceRouteProvision(provisions, 'trading-1')).toEqual(provision);
    expect(findMatchingInstanceRouteProvision(provisions, 'sandbox-1')).toEqual(provision);
    expect(findMatchingInstanceRouteProvision(provisions, '4')).toEqual(provision);
  });

  it('builds an authoritative fallback bot from provision and operator detail data', () => {
    const bot = buildInstanceFallbackBot({
      routeId: 'sandbox-1',
      provision: makeInstanceProvision(),
      operatorApiUrl: '/instance-operator-api',
      operatorKind: 'instance',
      detail: {
        id: 'trading-1',
        operator_address: '0x00000000000000000000000000000000000000aa',
        submitter_address: '0x0000000000000000000000000000000000000001',
        vault_address: '0x00000000000000000000000000000000000000bb',
        strategy_type: 'dex',
        strategy_config: {},
        risk_params: {},
        chain_id: 31337,
        trading_active: false,
        paper_trade: false,
        created_at: 123,
        max_lifetime_days: 30,
        trading_api_url: '',
        trading_api_token: '',
        sandbox_id: 'sandbox-1',
        workflow_id: '77',
        secrets_configured: false,
        sandbox_exists: true,
        sandbox_state: 'Running',
        lifecycle_status: 'awaiting_secrets',
        archived: false,
        control_available: true,
        wind_down_started_at: null,
        validator_service_ids: [],
        validator_endpoints: [],
        call_id: 12,
        service_id: 4,
      },
    });

    expect(bot.id).toBe('trading-1');
    expect(bot.name).toBe('Fallback Instance Bot');
    expect(bot.status).toBe('needs_config');
    expect(bot.operatorKind).toBe('instance');
    expect(bot.operatorApiUrl).toBe('/instance-operator-api');
    expect(bot.secretsConfigured).toBe(false);
    expect(bot.sandboxState).toBe('Running');
    expect(bot.verificationState).toBe('authoritative');
  });

  it('maps active-but-not-trading instance bots to paused for controls routing', () => {
    expect(mapLifecycleStatusToBotStatus('active', false)).toBe('paused');
    expect(mapLifecycleStatusToBotStatus('active', true)).toBe('active');
  });
});
