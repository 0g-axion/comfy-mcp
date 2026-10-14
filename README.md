# comfy.fun MCP (`@0g-axion/comfy-mcp`)

<img src="https://raw.githubusercontent.com/0g-axion/comfy-mcp/main/assets/logo.png" alt="comfy.fun" width="96" />

Explore 0G tokens, quote swaps, and build unsigned transactions.

Connect your agent to comfy.fun on 0G mainnet to explore tokens, quote swaps, check creator fees, browse agent tasks and compute, and build unsigned transactions for your wallet. The server holds no keys and never signs or submits transactions. Figures it cannot read come back as unknown, never as zero. Connect over stdio or streamable HTTP.

## Safety

- Read-only RPC and indexer access.
- Holds no private keys; never signs or sends transactions.
- Builders return unsigned transactions for you to review and sign in your own wallet.
- Unreadable figures are returned as unknown, never zero.
- Token names, listings and task text are third-party content; the server tells clients to treat them as data, never as instructions.
- Builders require an explicit slippage (at most 5000 bps, like the web app); review it before signing.

## Overview

MCP server for reading [Comfy](https://www.comfy.fun) and building unsigned
transactions. An agent (Claude Code, Codex, Cursor, any MCP client) can read
the market the same way the web app does. Fourteen tools read Comfy's engine REST, public
indexer GraphQL and public 0G RPC (mainnet, chain 16661), or build unsigned
transactions for an external wallet. The server holds no wallet key, never
signs and never submits transactions. The owner-only `comfy_jobs` read can
forward an opaque wallet session supplied through `COMFY_SESSION`. On comfy.fun
today, the two task-board tools answer `503 task_board_closed`; the table below marks them.

The package is scoped on purpose: the unscoped `comfy-mcp` on npm belongs to
Comfy-Org (ComfyUI) and is not this project.

## Add it to a client

```bash
# Claude Code
claude mcp add comfy -- npx -y @0g-axion/comfy-mcp@0.6.0

# Cursor: install the comfy.fun plugin from the Cursor Marketplace, or use the
# generic config below in ~/.cursor/mcp.json

# Codex CLI (~/.codex/config.toml)
# [mcp_servers.comfy]
# command = "npx"
# args = ["-y", "@0g-axion/comfy-mcp@0.6.0"]
```

Generic client config:

```json
{
  "mcpServers": {
    "comfy": { "command": "npx", "args": ["-y", "@0g-axion/comfy-mcp@0.6.0"] }
  }
}
```

No configuration is needed: by default the server reads comfy.fun's engine
and indexer. To read another
deployment, set `COMFY_ENGINE_ORIGIN` and `COMFY_INDEXER_GRAPHQL_HTTP`.

## Tools

| Tool | Operation | Upstream |
| --- | --- | --- |
| `comfy_tokens` | the newest launches, the affiliate's market (iAI, `affiliated: true`) first as on the site, with market fields in 0G: price, 24h change and volume, FDV, market cap, the 0G in the pool (`liquidity_og`), holders, traders | indexer GraphQL |
| `comfy_token` | one token's detail by address, with lifetime volume and whether the site lists it | indexer GraphQL |
| `comfy_trades` | recent trades for a token: side, trader, amounts, execution and spot price | indexer GraphQL |
| `comfy_compute_funded` | compute delivered to agents' pools, all time, as the Infinity index records it: total, per-token rows, basis; `compute_unknown` when the engine could not read the index | engine REST |
| `comfy_agent_compute` | one token's delivered compute, pool, tier and basis; router is null until the engine exposes it | engine REST |
| `comfy_bazaar` | the public services agents sell | engine REST |
| `comfy_tasks` | open tasks on the task board, newest first, with `kind`, `category`, `min_budget_og` and `after` | engine REST. **`503 task_board_closed` on comfy.fun today** |
| `comfy_task` | one task by id: its acceptors' counts and the buyer's standing, never the task's input | engine REST. **`503 task_board_closed` on comfy.fun today** |
| `comfy_jobs` | owner wallet's private commercial jobs | engine REST + `COMFY_SESSION` |
| `comfy_search_tokens` | name/symbol/address substring search (`query`, optional `limit`), with scanned matching rows, hidden count and truncation | indexer GraphQL |
| `comfy_swap_quote` | exact-input buy/sell quote (`token`, `side`, decimal-string `amount`, optional `slippage_bps`), expected/minimum output and live fee rates | indexer + public RPC |
| `comfy_creator_fees` | earned, claimed, reassigned and credited claimable fees plus separate pending sweep projections; `wallet`, `token`, or both | indexer + FeeSplitter RPC views |
| `comfy_build_swap_tx` | unsigned swap (`token`, `side`, `amount`, required `slippage_bps`, `recipient`), plus conditional sell approval calldata | indexer + public RPC; local encoding |
| `comfy_build_launch_tx` | unsigned ordinary token launch against the committed mainnet launcher and live policy | public RPC; local encoding |

The market tools read comfy's Infinity index through its public read
operations, scoped to one deployment. A token that has never traded reports
null price, change, volume, FDV and market cap: its opening price is not a
measured market figure. `comfy_tokens` leaves out what the site's lists leave
out (test launches, reserved tickers) and says how many in
`hidden`; `comfy_token` still reads any of them by address. Tokens of the
retired index are not read: every token on comfy.fun is on the Infinity index.

`comfy_tasks` and `comfy_task` relay the engine's `503 task_board_closed`
while the task board is closed.

A figure an upstream cannot supply comes back as unknown, never as zero, and
an upstream that is down is a `live: false` answer, not an empty list. A
deployment the index does not know is `deployment_unknown`, and a newest-first
read that cannot be read whole is `window_overflow`, never a stale page. More in the
[MCP docs](https://www.comfy.fun/docs/build/mcp).

## Transports and configuration

```bash
npx -y @0g-axion/comfy-mcp@0.6.0                    # stdio (for MCP client configs)
npx -y @0g-axion/comfy-mcp@0.6.0 --http --port 8931       # streamable-http at POST /mcp, loopback only
```

`--port` defaults to `COMFY_MCP_PORT`, then `8931`. Base URLs come from
`COMFY_ENGINE_ORIGIN` and `COMFY_INDEXER_GRAPHQL_HTTP` and default to
comfy.fun's (`https://warmth.comfy.fun`, `https://indexer.comfy.fun/v1/graphql`).
`COMFY_INFINITY_DEPLOYMENT` names the deployment the market tools read, as
`chainId:manager:splitter`; it defaults to comfy.fun's, and a malformed value
falls back to it.
`COMFY_MCP_TIMEOUT_MS` bounds each upstream request (default `5000`, 100 to
60000).
`COMFY_SESSION` is optional for all public tools and required for an
owner-authorized `comfy_jobs` result. A session for a different wallet than the
one asked about is relayed as the engine's `403 wallet_mismatch`, not as
sign-in advice. The session is honoured on stdio only: the `--http` listener
authenticates no client, so it never forwards `COMFY_SESSION` and `comfy_jobs`
there answers the engine's `401 sign_in_required`. To get a session, run
`comfy auth login` from the [comfy CLI](https://www.npmjs.com/package/comfy-cli#signing-in)
with `WARMTH_API=https://warmth.comfy.fun`. It signs the engine's challenge
with the wallet's `PRIVATE_KEY` (a wallet whose key you cannot export cannot
sign in this way) and stores a 24-hour session in `~/.config/comfy/sessions.json`;
pass that session as `COMFY_SESSION`, and keep it out of logs and committed
client configs.

## Quotes and unsigned transactions (0.6.0)

`COMFY_RPC_URL` overrides the public repository default `https://evmrpc.0g.ai`.
It must use HTTPS; HTTP is allowed only for `localhost`, `127.0.0.1`, or `[::1]`.
The configured RPC is trusted for quote amounts and therefore `min_out`; chain
and payload checks do not prove its answers are accurate.
Chain tools verify chain 16661 and currently support the committed production
Infinity generation only. A different `COMFY_INFINITY_DEPLOYMENT` returns
`unsupported_deployment`; changing the indexer URL does not authorize a different
router. All contract reads in a result use one block. RPC timeouts, wrong-chain
responses and malformed results are named failures, never zero balances.

Amounts are exact decimal **strings**, not floating-point numbers. Like the web
trade path, swaps support native 0G / 18-decimal tokens. The quote defaults to
100 basis points slippage; both quotes and builders cap it at 5000 bps (50%),
matching the web app. Builders require an explicit integer in 0–5000.
Minimum output rounds up, as in the web SDK. Fee disclosure uses the live hook
and per-pool FeeSplitter settings; hook bps and core pips have different bases
and are not summed. A quote still includes the hook charge if optional fee
reads fail: `fees: null` and `fees_status` name the failed RPC source.
Price impact compares quoted output with the same-block pool spot price and
explicitly includes fees and curve movement; it is not isolated curve impact.
An unreadable spot price yields null with `price_impact_status`.

Unsigned builders return `{chainId, to, data, value, description,
approvals_needed}`. `value` is decimal **wei**, and calldata is hex. Swap
output goes to `recipient`, while the eventual sender supplies the input. Sell
approvals are conditional prerequisites, not a claim about that sender's
allowances: first approve the exact token amount to Permit2, then approve the
router in Permit2 until the swap deadline. Both are unsigned. The swap uses an
empty Permit signature, matching the SDK's allowance-based path. Approval and
swap submission belong to the external wallet. Swap deadlines are ten minutes
from the read block; stale quotes should be rebuilt.

Creator fees are public ledger data, not an authenticated ownership claim.
A token-only request returns all its creator/recipient wallet legs. A wallet
filter uses current `bindingOf` results, including co-recipients. Wallet-only
requests inspect at most 100 indexed tokens in ascending `deployment:address`
id order: by address, **not launch time**. Tokens outside this window are not
searched; use `token` to read one directly. Scans use at most eight concurrent
pool workers and at most eight outstanding pool-read RPC calls (including
response bodies). Index page fetches and the head read are separate. A 20-second
overall budget includes index discovery and RPC.
`scanned` counts discovered token rows, including `excluded` rows; it is not the
number of successful pool reads. `failed` lists `{token, reason}` for unusable
or unfinished pools, including missing or malformed indexed pool records. A pool failure or deadline sets `complete: false` and
retains successful pools; `scan_outcome` is `ok`, `partial`, or `timeout`.
If the deadline expires before a block is read, `block_number` is null; if token
discovery has not finished, `failed` is empty because addresses are still unknown.
`complete` also stays false when the index window is truncated. These results
are never lifetime totals. Token-specific failures remain tool errors.
`claimable` means credited now; `pending` is the separately projected next sweep
at the current split. Native and token amounts each include exact `raw` strings;
unknown token decimals yield `formatted: null`.

Launch inputs are `creator`, `name`, `symbol`, `salt` (32-byte hex),
`opening_tick` (a multiple of 60), and `terms` with `creator_tax_bps`,
`delay_seconds`, `opening_bps`, `floor_bps`, and `decay_seconds`. Optional fields
are `image`, `metadata`,
`context`, and `recipients` (up to 15 entries, each with `identity`,
`account_wallet`, `share_bps`). The creator must be the eventual
sender. The builder always uses the SDK's five-rung project ladder,
enforces the live caps and 30-second minimum opening
delay, binds the current config hash, and uses the
live launch fee and a five-minute deadline. This is an ordinary token launch;
agent registration, sponsorship and post-launch compute-share changes are
separate flows.

Search uses `InfinityTokens`' existing allowlisted `$where` filter, escaping SQL
wildcards in user text. `scanned` counts matching rows returned by the indexer
(up to 1,000), not the total token population; `truncated` covers both this scan
bound and the requested output limit. Test launches and reserved tickers follow
the same exclusions as `comfy_tokens`. Before the output limit, scanned matches
rank by exact address, exact symbol, exact name, symbol prefix, name prefix,
then other matches, case-insensitively. Ties use descending `liquidity_og`,
with null liquidity last.

## Development

```bash
npm ci
npm test      # builds, then runs the test suite (Node 20+)
```

A few parity tests cross-check files in Comfy's main repository and are skipped here.


## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## License

MIT, see [LICENSE](LICENSE).
