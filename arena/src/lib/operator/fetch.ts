import { useCallback } from 'react';
import { OPERATOR_API_URL } from './meta';
import { useOperatorAuth } from '~/lib/hooks/useOperatorAuth';
import { readOperatorError } from './errors';

type FetchOpts = RequestInit & {
  auth?: boolean;
  rawResponse?: boolean;
};

export class OperatorAuthRequiredError extends Error {
  constructor() {
    super('Wallet authentication required');
    this.name = 'OperatorAuthRequiredError';
  }
}

export function useOperatorFetch() {
  const auth = useOperatorAuth(OPERATOR_API_URL);

  const operatorFetch = useCallback(async (
    path: string,
    opts: FetchOpts = {},
  ): Promise<Response> => {
    const { auth: needsAuth = true, rawResponse = false, headers, ...init } = opts;
    let token = needsAuth ? auth.getCachedToken() : null;

    const doFetch = async (bearer: string | null) => {
      const requestHeaders = new Headers(headers ?? {});
      if (!requestHeaders.has('Accept')) {
        requestHeaders.set('Accept', 'application/json');
      }
      if (bearer) {
        requestHeaders.set('Authorization', `Bearer ${bearer}`);
      }
      return fetch(`${OPERATOR_API_URL}${path}`, {
        ...init,
        headers: requestHeaders,
      });
    };

    if (needsAuth && !token) {
      throw new OperatorAuthRequiredError();
    }

    let res = await doFetch(token);

    if (needsAuth && res.status === 401) {
      token = await auth.getToken(true);
      if (!token) {
        throw new OperatorAuthRequiredError();
      }
      res = await doFetch(token);
    }

    if (!res.ok) {
      throw await readOperatorError(res);
    }

    if (rawResponse) {
      return res;
    }

    return res;
  }, [auth]);

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
