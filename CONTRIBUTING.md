# Contributing to pmcp-typescript

The TypeScript/Node SDK — `@pmcp/client`.

The organization-wide contributor policy lives in
[`physicalcontextprotocol/.github`](https://github.com/physicalcontextprotocol/.github/blob/main/CONTRIBUTING.md).
This file covers what is specific to this repository.

## Running the checks

```bash
npm install
npm run build     # tsc — currently FAILS with 19 errors
npm run lint
npm test
```

`npm test` currently prints "no tests yet (skeleton)" and exits 0. That
is a placeholder, not a passing test suite. It is the single most
useful thing you could add.

## The SDK does not compile, and that is deliberate to leave visible

`npm run build` fails with 19 TypeScript errors. CI records the count and
**fails if it grows** (`error-budget` is the one blocking job), but does
not pretend the build passes. `CHANGELOG.md` has the full breakdown by
error code.

Two clusters need judgement rather than a mechanical fix:

**1. Four `TS2308` errors mean there are two servers.** `src/index.ts`
re-exports both `./server` and `./server_impl`, and both export a
`PMCPServer`, `ActuationHandler`, `SensorHandler`, and
`PMCPServerOptions`. This is the same duplicate-implementation shape as
the Python SDK's `pmcp/` / `sdk/` / `v05/`. **Resolving it means
deciding which server is canonical.** That is the highest-value change
in this repository, and it is an architecture decision, so it is not
made by a drive-by type fix. If you take it on, say which one you picked
and why, and delete the other rather than leaving it exported-but-dimmed.

**2. `bid_energy_j` does not exist on `LeaseGrant`.** `pmcp-spec`'s
`LeaseGrant` has no energy-bid field at all. So either the schema is
missing a concept this SDK assumes, or the SDK is referencing something
that was dropped during the type-consolidation work. This one needs
someone who knows which — it is not a rename.

Everything else is mechanical: camelCase/snake_case drift
(`leaseId` → `lease_id`, `energyConsumedJ` → `energy_consumed_j`), two
types imported from `./types` that it does not export
(`ConstitutionCheck`, `MetricsSnapshot`), a `SensorType` that is
declared as a `type` union but used as a runtime value, and a
`src/utils.ts` that touches `window`/`document` under a `tsconfig` whose
`lib` is `["ES2020"]` with no DOM.

If you fix a subset, **lower the baseline in `.github/workflows/ci.yml`
and record it in `CHANGELOG.md` in the same PR**, so the guard keeps
meaning what it says.

## Honest scope

This is a skeleton. Before contributing, read the repository README for
what is and is not implemented. In short:

- There is **no test suite**.
- It does not currently **compile**.
- It is a peer SDK, not a binding over the Python implementation. If
  you find yourself importing from or shelling out to Python, you are
  writing a binding — that is not what this repository is for, and it
  would undercut the "three peer SDKs" claim the project makes.

## High-value contributions

- A real test suite, especially one that runs the shared
  `pmcp-conformance` suite against this implementation. That is the
  thing that would make the "three peer SDKs" claim checkable rather
  than asserted.
- Client and server lifecycle, transport selection, and reconnect
  handling.
- `src/safety.ts` gate implementation brought up to parity with the
  specification's gate ordering.
- Any place where a gate can be skipped or reordered.

## Before you claim parity

If a change makes this SDK behave differently from `pmcp-python` or
`pmcp-rust` for the same input, say so in the PR description. The wire
format is meant to be identical across all three, and divergence is a
bug in one of them — usually the newest.

## Releasing

`npm publish` is not wired up yet. Bump `version` in `package.json`
and add a `CHANGELOG.md` entry in the same PR.
