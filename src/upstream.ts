import type { McpConfig } from './config.js';

/* Bounded, typed reads over the two upstreams the web already uses:
 * the points-engine REST origin and the indexer GraphQL endpoint. Every
 * failure keeps its shape — a tool must be able to SAY what went wrong
 * instead of inventing an empty-but-live answer. */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type UpstreamFailure =
  | 'timeout'
  | 'unreachable'
  | 'http_error'
  | 'graphql_error'
  | 'bad_payload';

export type UpstreamResult<T> =
  | { outcome: 'ok'; data: T }
  | { outcome: UpstreamFailure; status?: number; refusal?: string };

const timedOut = (error: unknown) =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

const failureFrom = (error: unknown): UpstreamFailure => (timedOut(error) ? 'timeout' : 'unreachable');

/* a body that stops arriving before the deadline is a timeout, not a malformed payload */
const bodyFailure = (error: unknown): UpstreamFailure => (timedOut(error) ? 'timeout' : 'bad_payload');

const STABLE_CODE = /^[a-z][a-z0-9_]{1,63}$/;

export async function engineGet<T>(
  config: McpConfig,
  path: string,
  fetchImpl: FetchLike = fetch,
  headers: Record<string, string> = {},
): Promise<UpstreamResult<T>> {
  try {
    const response = await fetchImpl(config.engineOrigin + path, {
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: { accept: 'application/json', ...headers },
      // never replay a request (and possibly the owner's session) to another location
      redirect: 'error',
    });
    if (!response.ok) {
      /* The engine names a refusal by a stable code: in `code` beside its
         sentence (`503 task_board_closed`), or in `error` itself for the gate's
         refusals (401 sign_in_required: no session; 403 wallet_mismatch: a
         session for another wallet). The code is carried for a tool to relay as
         its outcome; anything that is not a bare code stays an ordinary HTTP error. */
      try {
        const body = await response.json() as { error?: unknown; code?: unknown };
        const refusal = [body.code, body.error].find((value): value is string =>
          typeof value === 'string' && STABLE_CODE.test(value));
        if (refusal) return { outcome: 'http_error', status: response.status, refusal };
      } catch { /* a non-JSON refusal remains an ordinary HTTP error */ }
      return { outcome: 'http_error', status: response.status };
    }
    try {
      return { outcome: 'ok', data: (await response.json()) as T };
    } catch (error) {
      return { outcome: bodyFailure(error) };
    }
  } catch (error) {
    return { outcome: failureFrom(error) };
  }
}

/* The public indexer edge enforces a named-operation allowlist: only the
 * exact allowlisted operation ASTs are served. Documents in queries.ts are
 * copied verbatim from that allowlist. */
export async function indexerQuery<T>(
  config: McpConfig,
  operationName: string,
  document: string,
  variables: Record<string, unknown>,
  fetchImpl: FetchLike = fetch,
): Promise<UpstreamResult<T>> {
  try {
    const response = await fetchImpl(config.indexerGraphqlHttp, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ operationName, query: document, variables }),
    });
    if (!response.ok) return { outcome: 'http_error', status: response.status };
    let envelope: { data?: T; errors?: unknown[] };
    try {
      envelope = (await response.json()) as { data?: T; errors?: unknown[] };
    } catch (error) {
      return { outcome: bodyFailure(error) };
    }
    if (envelope.errors?.length || envelope.data == null) return { outcome: 'graphql_error' };
    return { outcome: 'ok', data: envelope.data };
  } catch (error) {
    return { outcome: failureFrom(error) };
  }
}
