import { DEFAULT_INFINITY_DEPLOYMENT, type McpConfig } from './config.js';
import { ReadError } from './rpc.js';

/** Public pins from mainnet-production-16661.json, its launch admission and
 * deployed-addresses.mainnet-production.json (W0G).
 * Consumer installs have no sibling checkout. tools.test.mjs pins this copy. */
export const MAINNET = {
  chainId: 16661,
  manager: '0xaabd31f24914b48daea998e69683225e289d08b0',
  vault: '0x5809c1ff809cfc6fca8518016cdffa8339ba2a3a',
  w0g: '0x1cd0690ff9a693f5ef2dd976660a8dafc81a109c',
  splitter: '0x500acfbb2199d35ab1aa87736665d76c56bf633e',
  router: '0x76526f4815447f693468ef44e0204a0689178d9e',
  quoter: '0x493a75d7c43e64f69a3223a9b70e848597ae987d',
  permit2: '0x000000000022d473030f116ddee9f6b43ac78ba3',
  launcher: '0x2f74d603f7b7d8b7bfc78ef04e09905b862be86a',
  hook: '0x809acd73ac30b4e2d2dfd7d35b1fda850dcd4334',
  iaiHook: '0xc912324aca9ea0cc34c2615dc53d5a0465bbad30',
  iaiToken: '0xc77fbd3824cc68e612b26114d176879addc29463',
  sourceCommit: '6fd0ccb8853cc5834a1b4dafd4257cba36239cad',
} as const;
export function ensureDeployment(config: McpConfig): void {
  if (config.deploymentId !== DEFAULT_INFINITY_DEPLOYMENT) throw new ReadError('unsupported_deployment', 'indexer');
}
