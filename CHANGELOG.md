# Changelog

## 0.6.0

- New tools: `comfy_search_tokens`, `comfy_swap_quote`, `comfy_creator_fees`,
  `comfy_build_swap_tx`, `comfy_build_launch_tx` (14 tools in total).
- Streamable HTTP: loopback Host/Origin check (DNS-rebinding guard) and a 1 MB request limit.
- `COMFY_ENGINE_ORIGIN` and `COMFY_INDEXER_GRAPHQL_HTTP` must be HTTPS (HTTP only on loopback).
- Upstream requests refuse redirects; body-read timeouts report `timeout`.
- Server instructions mark third-party text fields as untrusted.
- `@modelcontextprotocol/sdk` raised to ^1.32.1.
