import { atom } from 'nanostores';

export interface OperatorSyncScope {
  apiUrls: string[] | null;
}

const DEFAULT_SCOPE: OperatorSyncScope = {
  apiUrls: null,
};

export const operatorSyncScopeStore = atom<OperatorSyncScope>(DEFAULT_SCOPE);

function areApiUrlListsEqual(
  left: string[] | null,
  right: string[] | null,
): boolean {
  if (left === right) return true;
  if (left == null || right == null) return left == null && right == null;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function setOperatorSyncScope(apiUrls: Array<string | null | undefined>) {
  const normalized = Array.from(new Set(
    apiUrls
      .filter((apiUrl): apiUrl is string => typeof apiUrl === 'string' && apiUrl.length > 0),
  ));

  const nextScope = {
    apiUrls: normalized.length > 0 ? normalized : null,
  };
  const currentScope = operatorSyncScopeStore.get();

  if (areApiUrlListsEqual(currentScope.apiUrls, nextScope.apiUrls)) {
    return;
  }

  operatorSyncScopeStore.set(nextScope);
}

export function resetOperatorSyncScope() {
  if (operatorSyncScopeStore.get().apiUrls == null) return;
  operatorSyncScopeStore.set(DEFAULT_SCOPE);
}

export function isOperatorSourceInScope(
  apiUrl: string,
  scope: OperatorSyncScope,
): boolean {
  return scope.apiUrls == null || scope.apiUrls.includes(apiUrl);
}
