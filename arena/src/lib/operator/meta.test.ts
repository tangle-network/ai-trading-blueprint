import { describe, expect, it, vi } from 'vitest';

describe('getOperatorApiUrlForBlueprint', () => {
  it('routes cloud blueprints to the cloud operator', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_OPERATOR_API_URL', '/operator-api');
    vi.stubEnv('VITE_CLOUD_OPERATOR_API_URL', '/operator-api');
    vi.stubEnv('VITE_INSTANCE_OPERATOR_API_URL', '/instance-operator-api');
    const { getOperatorApiUrlForBlueprint } = await import('./meta');
    expect(getOperatorApiUrlForBlueprint('trading-cloud')).toBe('/operator-api');
  });

  it('routes instance blueprints to the instance operator', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_OPERATOR_API_URL', '/operator-api');
    vi.stubEnv('VITE_CLOUD_OPERATOR_API_URL', '/operator-api');
    vi.stubEnv('VITE_INSTANCE_OPERATOR_API_URL', '/instance-operator-api');
    const { getOperatorApiUrlForBlueprint } = await import('./meta');
    expect(getOperatorApiUrlForBlueprint('trading-instance')).toBe('/instance-operator-api');
    expect(getOperatorApiUrlForBlueprint('trading-tee-instance')).toBe('/instance-operator-api');
  });
});

describe('getExpectedDeploymentKindForBlueprint', () => {
  it('maps cloud blueprints to the fleet operator kind', async () => {
    vi.resetModules();
    const { getExpectedDeploymentKindForBlueprint } = await import('./meta');
    expect(getExpectedDeploymentKindForBlueprint('trading-cloud')).toBe('fleet');
  });

  it('maps instance blueprints to the instance operator kind', async () => {
    vi.resetModules();
    const { getExpectedDeploymentKindForBlueprint } = await import('./meta');
    expect(getExpectedDeploymentKindForBlueprint('trading-instance')).toBe('instance');
    expect(getExpectedDeploymentKindForBlueprint('trading-tee-instance')).toBe('instance');
  });
});

describe('getDeploymentKindForOperatorKind', () => {
  it('maps cloud bots to fleet and instance-style bots to instance', async () => {
    vi.resetModules();
    const { getDeploymentKindForOperatorKind } = await import('./meta');
    expect(getDeploymentKindForOperatorKind('cloud')).toBe('fleet');
    expect(getDeploymentKindForOperatorKind('instance')).toBe('instance');
    expect(getDeploymentKindForOperatorKind('tee')).toBe('instance');
    expect(getDeploymentKindForOperatorKind(null)).toBe('instance');
  });
});

describe('HAS_TRADING_OPERATOR_API', () => {
  it('is true for instance-only deployments', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_OPERATOR_API_URL', '');
    vi.stubEnv('VITE_CLOUD_OPERATOR_API_URL', '');
    vi.stubEnv('VITE_INSTANCE_OPERATOR_API_URL', '/instance-operator-api');
    vi.stubEnv('VITE_TEE_OPERATOR_API_URL', '');
    const { ALL_TRADING_OPERATOR_API_URLS, HAS_TRADING_OPERATOR_API } = await import('./meta');
    expect(HAS_TRADING_OPERATOR_API).toBe(true);
    expect(ALL_TRADING_OPERATOR_API_URLS).toEqual(['/instance-operator-api']);
  });

  it('is true for TEE-only deployments', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_OPERATOR_API_URL', '');
    vi.stubEnv('VITE_CLOUD_OPERATOR_API_URL', '');
    vi.stubEnv('VITE_INSTANCE_OPERATOR_API_URL', '');
    vi.stubEnv('VITE_TEE_OPERATOR_API_URL', '/tee-operator-api');
    const { ALL_TRADING_OPERATOR_API_URLS, HAS_TRADING_OPERATOR_API } = await import('./meta');
    expect(HAS_TRADING_OPERATOR_API).toBe(true);
    expect(ALL_TRADING_OPERATOR_API_URLS).toEqual(['/tee-operator-api']);
  });

  it('deduplicates duplicate instance and TEE URLs', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_OPERATOR_API_URL', '');
    vi.stubEnv('VITE_CLOUD_OPERATOR_API_URL', '');
    vi.stubEnv('VITE_INSTANCE_OPERATOR_API_URL', '/shared-operator-api');
    vi.stubEnv('VITE_TEE_OPERATOR_API_URL', '/shared-operator-api');
    const { ALL_TRADING_OPERATOR_API_URLS, HAS_TRADING_OPERATOR_API } = await import('./meta');
    expect(HAS_TRADING_OPERATOR_API).toBe(true);
    expect(ALL_TRADING_OPERATOR_API_URLS).toEqual(['/shared-operator-api']);
  });
});
