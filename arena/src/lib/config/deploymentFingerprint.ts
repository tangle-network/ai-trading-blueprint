const DEPLOYMENT_FINGERPRINT_ENV_KEYS = [
  'VITE_DEPLOYMENT_FINGERPRINT',
  'VITE_CHAIN_ID',
  'VITE_TANGLE_CONTRACT',
  'VITE_TANGLE',
  'VITE_OPERATOR_API_URL',
  'VITE_CLOUD_OPERATOR_API_URL',
  'VITE_INSTANCE_OPERATOR_API_URL',
  'VITE_TEE_OPERATOR_API_URL',
  'VITE_TRADING_OPERATOR_API_URLS',
  'VITE_ADDITIONAL_TRADING_OPERATOR_API_URLS',
  'VITE_TRADING_BLUEPRINT',
  'VITE_VAULT_FACTORY',
  'VITE_SANDBOX_BLUEPRINT_ID',
  'VITE_INSTANCE_BLUEPRINT_ID',
] as const;

type FingerprintEnv = Record<string, string | undefined>;

function normalizeFingerprintPart(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}

export function buildArenaDeploymentFingerprint(env: FingerprintEnv = import.meta.env): string {
  const explicit = normalizeFingerprintPart(env.VITE_DEPLOYMENT_FINGERPRINT);
  if (explicit) return explicit;

  const fallback = DEPLOYMENT_FINGERPRINT_ENV_KEYS
    .map((key) => normalizeFingerprintPart(env[key]))
    .filter(Boolean)
    .join('::');

  return fallback || 'default';
}

export function buildScopedStorageKey(prefix: string, fingerprint = buildArenaDeploymentFingerprint()): string {
  return `${prefix}::${fingerprint}`;
}

export function migrateLegacyScopedKey(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  prefix: string,
  currentKey: string,
) {
  if (currentKey === prefix) return;

  const currentValue = storage.getItem(currentKey);
  const legacyValue = storage.getItem(prefix);
  if (legacyValue == null) return;

  if (currentValue == null) {
    storage.setItem(currentKey, legacyValue);
  }

  storage.removeItem(prefix);
}

export function pruneScopedStorageKeys(
  storage: Pick<Storage, 'length' | 'key' | 'removeItem'>,
  prefix: string,
  currentKey: string,
) {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key) continue;
    if (key === prefix || key.startsWith(`${prefix}::`)) {
      keys.push(key);
    }
  }

  keys
    .filter((key) => key !== currentKey)
    .forEach((key) => storage.removeItem(key));
}
