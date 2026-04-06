import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useOperatorSyncScope } from './useOperatorSyncScope';
import {
  operatorSyncScopeStore,
  resetOperatorSyncScope,
  isOperatorSourceInScope,
} from '~/lib/stores/operatorSyncScope';

describe('useOperatorSyncScope', () => {
  afterEach(() => {
    resetOperatorSyncScope();
  });

  it('scopes operator sync to the provided API urls and resets on unmount', () => {
    const { unmount } = renderHook(() => useOperatorSyncScope([
      '/operator-api',
      '/operator-api',
      null,
      '/instance-operator-api',
    ]));

    expect(operatorSyncScopeStore.get()).toEqual({
      apiUrls: ['/operator-api', '/instance-operator-api'],
    });
    expect(isOperatorSourceInScope('/operator-api', operatorSyncScopeStore.get())).toBe(true);
    expect(isOperatorSourceInScope('/tee-operator-api', operatorSyncScopeStore.get())).toBe(false);

    unmount();

    expect(operatorSyncScopeStore.get()).toEqual({ apiUrls: null });
  });
});
