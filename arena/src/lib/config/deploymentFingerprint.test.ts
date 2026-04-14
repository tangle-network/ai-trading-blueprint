import { describe, expect, it } from 'vitest';
import {
  buildArenaDeploymentFingerprint,
  buildScopedStorageKey,
  migrateLegacyScopedKey,
  pruneScopedStorageKeys,
} from './deploymentFingerprint';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
}

describe('deployment fingerprint helpers', () => {
  it('builds a stable fallback fingerprint from deployment env values', () => {
    const fingerprint = buildArenaDeploymentFingerprint({
      VITE_CHAIN_ID: '31337',
      VITE_TANGLE_CONTRACT: '0xabc',
      VITE_OPERATOR_API_URL: 'https://operator.test',
      VITE_CLOUD_OPERATOR_API_URL: 'https://cloud.test',
      VITE_INSTANCE_OPERATOR_API_URL: 'https://instance.test',
      VITE_TEE_OPERATOR_API_URL: 'https://tee.test',
      VITE_TRADING_BLUEPRINT: '0xdef',
    });

    expect(fingerprint).toContain('31337');
    expect(fingerprint).toContain('0xabc');
    expect(fingerprint).toContain('https://operator.test');
  });

  it('prefers an explicit deployment fingerprint when present', () => {
    expect(buildArenaDeploymentFingerprint({
      VITE_DEPLOYMENT_FINGERPRINT: 'custom-fingerprint',
      VITE_CHAIN_ID: 'ignored',
    })).toBe('custom-fingerprint');
  });

  it('migrates legacy unscoped keys to the current scoped key', () => {
    const storage = new MemoryStorage();
    const currentKey = buildScopedStorageKey('arena_provisions', 'deploy-a');
    storage.setItem('arena_provisions', '[{"id":"legacy"}]');

    migrateLegacyScopedKey(storage, 'arena_provisions', currentKey);

    expect(storage.getItem(currentKey)).toBe('[{"id":"legacy"}]');
    expect(storage.getItem('arena_provisions')).toBeNull();
  });

  it('prunes stale scoped keys while keeping the active deployment key', () => {
    const storage = new MemoryStorage();
    const currentKey = buildScopedStorageKey('arena_provisions', 'deploy-b');
    storage.setItem(buildScopedStorageKey('arena_provisions', 'deploy-a'), '[1]');
    storage.setItem(currentKey, '[2]');
    storage.setItem('arena_provisions', '[3]');

    pruneScopedStorageKeys(storage, 'arena_provisions', currentKey);

    expect(storage.getItem(buildScopedStorageKey('arena_provisions', 'deploy-a'))).toBeNull();
    expect(storage.getItem('arena_provisions')).toBeNull();
    expect(storage.getItem(currentKey)).toBe('[2]');
  });
});
