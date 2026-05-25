// MIRROR of ai-agent-sandbox-blueprint/ui/src/lib/wallet/detectParentOrigin.ts.
// Both products embed in the same Tangle Cloud parent under the same
// iframe protocol. Consolidate into @tangle-network/blueprint-ui next.
//
// Determine which origin to trust as the parent dapp.
//
// `document.referrer` is the *initial* embedder — it's set when the iframe is
// first loaded and survives reloads (though it can be cleared by `referrerpolicy`
// or by the embedder). The Tangle Cloud iframe wrapper deliberately omits
// `referrerpolicy="no-referrer"` so we get the embedder's origin here.
//
// We compare it against an allowlist of known Tangle Cloud origins. If it
// matches, that's the parent. Otherwise the iframe is being loaded directly
// (standalone domain visit, dev server, untrusted embedder) and the bridge
// stays disabled — the app falls back to its normal injected/WC wallet path.

const TRUSTED_CLOUD_ORIGINS = [
  'https://cloud.tangle.tools',
  'https://develop.cloud.tangle.tools',
  // Local dev (Vite default port for tangle-cloud + Netlify dev preview).
  'http://localhost:4300',
  'http://localhost:8888',
];

function originFromReferrer(): string | null {
  if (typeof document === 'undefined') return null;
  const ref = document.referrer;
  if (!ref) return null;
  try {
    return new URL(ref).origin;
  } catch {
    return null;
  }
}

/**
 * Returns the parent origin to bridge to, or null when no trusted parent is
 * detected. Caller should skip installing the bridge connector when this
 * returns null.
 *
 * Allowlist can be extended at build time via `VITE_TANGLE_CLOUD_ORIGINS`
 * (comma-separated). Dev-server origins are bundled in for the inner-loop
 * embed flow at apps/tangle-cloud:4300.
 */
export function detectTangleCloudParentOrigin(): string | null {
  if (typeof window === 'undefined' || window.parent === window) {
    return null;
  }
  const explicitFromEnv = (import.meta.env.VITE_TANGLE_CLOUD_ORIGINS as
    | string
    | undefined)?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  const allowlist = new Set([...TRUSTED_CLOUD_ORIGINS, ...explicitFromEnv]);
  const referrerOrigin = originFromReferrer();
  if (referrerOrigin && allowlist.has(referrerOrigin)) {
    return referrerOrigin;
  }
  // Fallback: if the iframe URL carries `?parent=<origin>` and that origin is
  // on the allowlist, accept it. Useful for dev embedding without a real
  // referrer (some browsers strip referrer from cross-origin loads).
  try {
    const url = new URL(window.location.href);
    const explicit = url.searchParams.get('parent');
    if (explicit && allowlist.has(explicit)) return explicit;
  } catch {
    // ignore
  }
  return null;
}
