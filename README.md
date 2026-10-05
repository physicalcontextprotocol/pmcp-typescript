# pmcp-typescript

TypeScript/Node SDK for PCP — the client and server surface for a
Node runtime.

## Status

**Real code, no test suite.** ~105 KB across eight source files under
`src/`:

- `client.ts` — MCP client
- `server.ts`, `server_impl.ts` — server surface + handler wiring
- `types.ts` — protocol types
- `safety.ts` — client-side safety wrappers
- `fleet.ts` — fleet coordination
- `utils.ts` — helpers
- `index.ts` — barrel re-exports

Published to npm as `@physicalcontextprotocol/sdk`. All runtime
dependencies (`ws`, `eventemitter3`, `uuid`) are actually imported.

## Install

```bash
npm install @physicalcontextprotocol/sdk
```

```ts
import { createClient, createStdioClient } from '@physicalcontextprotocol/sdk';
```

Client entry points are `createClient` (generic), `createStdioClient`,
`createHttpClient`, `createWebSocketClient`, and `createFleetClient`, plus
the `PCPRobotClient` / `PCPFleetClient` / `PCPServerClient` /
`PCPWebSocketClient` classes. There is no export named `PCPClient`.

## Build from source

```bash
npm install
npm run build   # outputs dist/
```

There is no test suite yet — `npm test` intentionally exits 0 with a
message rather than pretending Jest ran. When a test suite is added,
change `scripts.test` back to `jest` and add a `jest.config.*`.

## Not release-ready — what's missing

- No test coverage.
- No CI wiring beyond the org-level typescript-sdk job (which currently
  only verifies `npm run build`).
- Types have not been re-checked against `pmcp-spec` v0.5 since the
  split — the intended source-of-truth is `pmcp-spec/schema/`, which
  itself does not yet cover the JSON-RPC method surface.

## License

Apache 2.0 (see [`LICENSE`](LICENSE)).
