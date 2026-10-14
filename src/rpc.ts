import { DEFAULT_RPC_URL, type McpConfig } from './config.js';
import type { FetchLike } from './upstream.js';

export class ReadError extends Error {
  constructor(readonly outcome: string, readonly source: 'rpc' | 'indexer' = 'rpc') { super(outcome); }
}
const quantity = (value: unknown): value is string => typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);

/** A closed read-only JSON-RPC surface. Even runtime callers cannot add write methods. */
export class Rpc {
  private id = 0;
  constructor(private config: McpConfig, private fetchImpl: FetchLike) {}

  async request(method: 'eth_chainId' | 'eth_getBlockByNumber' | 'eth_call', params: unknown[]): Promise<unknown> {
    if (!['eth_chainId', 'eth_getBlockByNumber', 'eth_call'].includes(method)) throw new ReadError('unsupported_rpc_method');
    const id = ++this.id;
    try {
      const response = await this.fetchImpl(this.config.rpcUrl ?? DEFAULT_RPC_URL, {
        method: 'POST', signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      if (!response.ok) throw new ReadError('http_error');
      let body;
      try { body = await response.json(); } catch { throw new ReadError('bad_payload'); }
      if (!body || body.jsonrpc !== '2.0' || body.id !== id) throw new ReadError('bad_payload');
      if (body.error) throw new ReadError('rpc_error');
      if (body.result == null) throw new ReadError('bad_payload');
      return body.result;
    } catch (error) {
      if (error instanceof ReadError) throw error;
      throw new ReadError(error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'unreachable');
    }
  }

  async head(): Promise<{ number: string; timestamp: bigint }> {
    const chain = await this.request('eth_chainId', []);
    if (!quantity(chain)) throw new ReadError('bad_payload');
    if (BigInt(chain) !== 16661n) throw new ReadError('chain_mismatch');
    const block = await this.request('eth_getBlockByNumber', ['latest', false]) as { number?: unknown; timestamp?: unknown };
    if (!quantity(block.number) || !quantity(block.timestamp)) throw new ReadError('bad_payload');
    return { number: block.number, timestamp: BigInt(block.timestamp) };
  }

  async call(to: string, data: string, block: string): Promise<string> {
    const result = await this.request('eth_call', [{ to, data }, block]);
    if (typeof result !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(result)) throw new ReadError('bad_payload');
    return result.toLowerCase();
  }
}
