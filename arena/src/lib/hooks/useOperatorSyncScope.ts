import { useEffect, useLayoutEffect, useMemo } from 'react';
import { resetOperatorSyncScope, setOperatorSyncScope } from '~/lib/stores/operatorSyncScope';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export function useOperatorSyncScope(apiUrls: Array<string | null | undefined>) {
  const normalizedApiUrls = useMemo(
    () => Array.from(new Set(
      apiUrls.filter((apiUrl): apiUrl is string => typeof apiUrl === 'string' && apiUrl.length > 0),
    )),
    [apiUrls],
  );
  const scopeKey = normalizedApiUrls.join('||');

  useIsomorphicLayoutEffect(() => {
    if (normalizedApiUrls.length === 0) {
      resetOperatorSyncScope();
      return;
    }

    setOperatorSyncScope(normalizedApiUrls);
    return () => resetOperatorSyncScope();
  }, [scopeKey]);
}
