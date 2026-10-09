# Changelog — pmcp-typescript

All notable changes to the `physicalcontextprotocol` TypeScript SDK. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- **Package renamed** from `@pcp/client` to `physicalcontextprotocol`
  (unscoped), matching the Python and Rust distributions.
  `npm install physicalcontextprotocol`. Nothing was published under the old
  name, so no alias is needed.

## [1.0.1] — 2026-10-05

### Fixed

- **README named the wrong install command and pinned a version.** 1.0.0
  shipped a README that told consumers to run a bare `npm install` and
  named the package as `physicalcontextprotocol@1.0.0`, neither of which
  matches the published artifact. npm tarballs are immutable, so the text
  can only be corrected by a new version. The version is now dropped from
  the package-name sentence entirely — the registry is the source of truth
  for the current version, and restating it there is what made the shipped
  text go stale. Install instructions now name the registry package and the
  actual client entry points, with a note that there is no `PCPClient`
  export.

## [1.0.0] — 2026-09-28

First tagged public release. **Read this before assuming the SDK is
finished — it is a skeleton, and the changelog says so.**

### Added

- `SECURITY.md` scoped to this SDK: transport/framing bugs, signature
  and identity bypasses, and any path where a gate can be skipped.
- `CONTRIBUTING.md` stating the peer-SDK constraint explicitly: this is
  a peer implementation, not a binding over the Python SDK. If a
  contribution ends up importing from or shelling out to Python, it is
  the wrong kind of contribution — it would undercut the "three peer
  SDKs" claim the project makes.

### Changed

- Repository metadata in `package.json` now points at
  `github.com/physicalcontextprotocol/pmcp-typescript`.
- Moved out of the monorepo into its own repository, deliberately, so
  the three SDKs read as peer implementations rather than one
  reference implementation plus two bindings.

### Known limitations (documented, not fixed)

- **The SDK does not compile. 32 TypeScript errors.** Recorded here in
  full because a count with no breakdown is not actionable:

  | Count | Error | Nature |
  |---|---|---|
  | 4 | `TS2308` ambiguity on `ActuationHandler`, `PCPServer`, `PCPServerOptions`, `SensorHandler` at `src/index.ts:11` | **architecture**, see below |
  | 6 | `TS2561`/`TS2353` — `leaseId`, `robotId`, `sensorType`, `energyConsumedJ`, `bid_energy_j` used where the type declares `lease_id`, `robot_id`, `sensor_type`, `energy_consumed_j` | camelCase/snake_case drift |
  | 2 | `TS2305` — `ConstitutionCheck` and `MetricsSnapshot` imported from `./types`, which does not export them | missing types |
  | 1 | `TS2693` — `SensorType` used as a value, but it is declared as a `type` union rather than an enum | needs a runtime representation |
  | 1 | `TS2339`/`TS2353` ×3 — `bid_energy_j` does not exist on `LeaseGrant` at all | **see below** |
  | 1 | `TS2345` — `K \| undefined` not assignable to `K` in `src/utils.ts:308` | strictness |
  | 2 | `TS2304`/`TS2584` — `window` and `document` not found in `src/utils.ts:535-536` | `tsconfig` sets `lib: ["ES2020"]`, so no DOM |

  **The 4 `TS2308` errors are the interesting ones, and they are not a
  typo.** `src/index.ts` re-exports *both* `./server` and
  `./server_impl`, and each of them exports its own `PCPServer`,
  `ActuationHandler`, `SensorHandler`, and `PCPServerOptions`. This is
  the same duplicate-implementation problem the Python SDK has, and
  resolving it means deciding which server is canonical — an
  architecture decision, deliberately not made silently here.

  **`bid_energy_j` is a genuine spec question, not a naming slip.**
  `pmcp-spec`'s `LeaseGrant` has no energy-bid field at all, so either
  the schema is missing a concept the SDK assumes, or the SDK is
  referencing a concept that was dropped. That needs an answer from
  someone who knows which.

- **There is no test suite.** `npm test` prints "no tests yet
  (skeleton)" and exits 0. That is a placeholder, not a passing suite.
  CI's only *blocking* job is an error-budget check that stops the 19
  compile errors from growing.
- The highest-value addition would be the ability to run the shared
  `pmcp-conformance` suite against this implementation. That is what
  would make the parity claim checkable rather than asserted.
- `npm publish` is not wired up; there is no CI release job.
