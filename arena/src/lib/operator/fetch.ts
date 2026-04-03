import { useCallback } from 'react';
import { OPERATOR_API_URL } from './meta';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import { readOperatorError } from './errors';

type FetchOpts = RequestInit & {
  auth?: boolean;
  rawResponse?: boolean;
  refreshOnUnauthorized?: boolean;
};

export class OperatorAuthRequiredError extends Error {
  constructor() {
    super('Wallet authentication required');
    this.name = 'OperatorAuthRequiredError';
  }
}

type OperatorFetchAuth = {
  getCachedToken: () => string | null;
  getToken: (forceRefresh?: boolean) => Promise<string | null>;
};

async function doOperatorFetch(
  apiUrl: string,
  path: string,
  auth: OperatorFetchAuth,
  opts: FetchOpts = {},
): Promise<Response> {
  const {
    auth: needsAuth = true,
    refreshOnUnauthorized = true,
    headers,
    ...init
  } = opts;
  let token = needsAuth ? auth.getCachedToken() : null;

  const doFetch = async (bearer: string | null) => {
    const requestHeaders = new Headers(headers ?? {});
    if (!requestHeaders.has('Accept')) {
      requestHeaders.set('Accept', 'application/json');
    }
    if (bearer) {
      requestHeaders.set('Authorization', `Bearer ${bearer}`);
    }
    return fetch(`${apiUrl}${path}`, {
      ...init,
      headers: requestHeaders,
    });
  };

  if (needsAuth && !token) {
    throw new OperatorAuthRequiredError();
  }

  let res = await doFetch(token);

  if (needsAuth && refreshOnUnauthorized && res.status === 401) {
    token = await auth.getToken(true);
    if (!token) {
      throw new OperatorAuthRequiredError();
    }
    res = await doFetch(token);
  }

  if (!res.ok) {
    throw await readOperatorError(res);
  }

  return res;
}

export async function operatorFetchWithAuth(
  apiUrl: string,
  path: string,
  auth: OperatorFetchAuth,
  opts: FetchOpts = {},
): Promise<Response> {
  return doOperatorFetch(apiUrl, path, auth, opts);
}

export async function operatorJsonWithAuth<T>(
  apiUrl: string,
  path: string,
  auth: OperatorFetchAuth,
  opts: FetchOpts = {},
): Promise<T> {
  const res = await doOperatorFetch(apiUrl, path, auth, opts);
  return res.json() as Promise<T>;
}

export function useOperatorFetch(apiUrl = OPERATOR_API_URL) {
  const auth = useOperatorAuth(apiUrl);

  const operatorFetch = useCallback(async (
    path: string,
    opts: FetchOpts = {},
  ): Promise<Response> => {
    const { rawResponse = false, ...nextOpts } = opts;
    const res = await doOperatorFetch(apiUrl, path, auth, nextOpts);

    if (rawResponse) {
      return res;
    }

    return res;
  }, [apiUrl, auth]);

  const operatorJson = useCallback(async <T>(
    path: string,
    opts: FetchOpts = {},
  ): Promise<T> => {
    const res = await operatorFetch(path, opts);
    return res.json() as Promise<T>;
  }, [operatorFetch]);

  return {
    ...auth,
    operatorFetch,
    operatorJson,
  };
}
