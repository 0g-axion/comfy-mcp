/* Base URLs come from env with production defaults, so a stranger's first
 * `npx`-style run reads comfy.fun's live market (0G mainnet, chain 16661) with zero
 * configuration. The server is READ-ONLY: it holds no key and signs nothing.
 * COMFY_SESSION is an opaque, owner-provided bearer used only for the private jobs read. */

export const DEFAULT_ENGINE_ORIGIN = 'https://warmth.comfy.fun';
export const DEFAULT_INDEXER_GRAPHQL_HTTP = 'https://indexer.comfy.fun/v1/graphql';
/** The Infinity deployment the market tools read: `chainId:manager:splitter`, the key
 *  every indexed row carries. Production's only
 *  generation; inside the Comfy monorepo, tools.test.mjs derives it from the deployment
 *  record, so a new generation fails the test first. */
export const DEFAULT_INFINITY_DEPLOYMENT = '16661:0xaabd31f24914b48daea998e69683225e289d08b0:0x500acfbb2199d35ab1aa87736665d76c56bf633e';
export const DEFAULT_RPC_URL = 'https://evmrpc.0g.ai';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEPLOYMENT_KEY = /^[0-9]{1,10}:0x[0-9a-f]{40}:0x[0-9a-f]{40}$/;

export interface McpConfig {
  /** Public mainnet RPC; COMFY_RPC_URL overrides the repository default. */
  rpcUrl?: string;
  /** Engine REST origin (the same origin the web's NEXT_PUBLIC_ENGINE_ORIGIN points at). */
  engineOrigin: string;
  /** Indexer GraphQL HTTP endpoint (the web's NEXT_PUBLIC_INDEXER_GRAPHQL_HTTP). */
  indexerGraphqlHttp: string;
  /** The Infinity deployment key the market tools scope every read by. */
  deploymentId: string;
  /** Per-upstream-request budget. A hung upstream must not hang the tool call. */
  timeoutMs: number;
  /** Optional owner wallet session forwarded only to private engine reads. */
  session?: string;
}

const trimOrigin = (value: string | undefined) => (value ?? '').trim().replace(/\/+$/, '');

/** HTTPS, or plain HTTP only on loopback, so neither quotes nor the owner's session
 *  travel in cleartext to a remote host. */
function safeUrl(name: string, value: string | undefined, fallback: string): string {
  const trimmed = trimOrigin(value);
  if (!trimmed) return fallback;
  let parsed: URL;
  try { parsed = new URL(trimmed); }
  catch { throw new Error(`${name} must be a valid HTTPS URL or an HTTP loopback URL`); }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error(`${name} must use HTTPS except for localhost, 127.0.0.1, or ::1`);
  }
  return trimmed;
}

/** A COMFY_INFINITY_DEPLOYMENT that was set but could not be used, for a startup
 *  warning: falling back to comfy.fun silently would read mainnet for someone who meant
 *  another deployment. */
export function ignoredDeployment(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env.COMFY_INFINITY_DEPLOYMENT ?? '').trim();
  return raw && !DEPLOYMENT_KEY.test(raw.toLowerCase()) ? raw : null;
}

export function resolveConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const timeoutRaw = Number(env.COMFY_MCP_TIMEOUT_MS ?? '');
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw >= 100 && timeoutRaw <= 60_000
    ? Math.floor(timeoutRaw)
    : DEFAULT_TIMEOUT_MS;
  /* a malformed key would scope every read to nothing and answer an empty market as
     if it were live; it falls back to the default instead */
  const deployment = (env.COMFY_INFINITY_DEPLOYMENT ?? '').trim().toLowerCase();
  return {
    rpcUrl: safeUrl('COMFY_RPC_URL', env.COMFY_RPC_URL, DEFAULT_RPC_URL),
    engineOrigin: safeUrl('COMFY_ENGINE_ORIGIN', env.COMFY_ENGINE_ORIGIN, DEFAULT_ENGINE_ORIGIN),
    indexerGraphqlHttp: safeUrl('COMFY_INDEXER_GRAPHQL_HTTP', env.COMFY_INDEXER_GRAPHQL_HTTP, DEFAULT_INDEXER_GRAPHQL_HTTP),
    deploymentId: DEPLOYMENT_KEY.test(deployment) ? deployment : DEFAULT_INFINITY_DEPLOYMENT,
    session: env.COMFY_SESSION?.trim() || undefined,
    timeoutMs,
  };
}
