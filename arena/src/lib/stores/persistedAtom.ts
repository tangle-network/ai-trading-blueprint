import { atom, type WritableAtom } from 'nanostores';

/**
 * JSON serializer that handles bigint values (converts to `{__bigint: "123"}`).
 * Needed because TrackedTx.blockNumber and gasUsed are bigints.
 */
export function serializeWithBigInt(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    typeof v === 'bigint' ? { __bigint: v.toString() } : v,
  );
}

/** Deserialize JSON produced by `serializeWithBigInt`. */
export function deserializeWithBigInt<T>(raw: string): T {
  return JSON.parse(raw, (_key, v) => {
    if (v && typeof v === 'object' && '__bigint' in v && typeof v.__bigint === 'string') {
      return BigInt(v.__bigint);
    }
    return v;
  }) as T;
}

interface PersistedAtomOpts<T> {
  /** localStorage key */
  key: string;
  /** Default value when nothing is stored */
  initial: T;
  /** Custom serializer (defaults to JSON.stringify) */
  serialize?: (value: T) => string;
  /** Custom deserializer (defaults to JSON.parse) */
  deserialize?: (raw: string) => T;
}

/**
 * A nanostores atom backed by localStorage.
 * Restores on init, persists on every `.set()`.
 * SSR-safe: falls back to `initial` when `window` is unavailable.
 */
export function persistedAtom<T>(opts: PersistedAtomOpts<T>): WritableAtom<T> {
  const { key, initial, serialize = JSON.stringify, deserialize = JSON.parse } = opts;

  let restored = initial;
  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        restored = deserialize(raw);
      }
    } catch {
      // corrupt data — use initial
    }
  }

  const store = atom<T>(restored);

  if (typeof window !== 'undefined') {
    store.subscribe((value) => {
      try {
        localStorage.setItem(key, serialize(value));
      } catch {
        // storage full or unavailable — silently ignore
      }
    });
  }

  return store;
}
