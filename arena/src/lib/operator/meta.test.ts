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
