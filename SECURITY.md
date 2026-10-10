# Security policy — pcp-typescript

The default policy for this organization lives in
[`pcp-spec/SECURITY.md`](https://github.com/physicalcontextprotocol/pcp-spec/blob/main/SECURITY.md)
and applies here in full. This file records what is specific to the
TypeScript SDK.

## Reporting

Use **private vulnerability reporting**:
**Security → Report a vulnerability** on this repository, or
[open an org-level advisory](https://github.com/physicalcontextprotocol/security/advisories/new).

Do not open a public issue.

## In scope here

- Transport or framing bugs in `src/` that would let a message be
  delivered out of order, replayed, or attributed to the wrong peer.
- Signature or identity verification bypass in `src/safety.ts` or
  `src/client.ts`.
- Any case where a gate (`E-Stop`, `Lease`, `Constitution`, `Shadow`)
  can be skipped in the request path.
- Leaked secrets or credentials in this repository.

## Out of scope here

- Missing hardening in the example servers — those live in
  `pcp-servers`, not here.
- Dependency CVEs in transitive packages. Report those to the package
  registry; we pick them up through automated audits.
- Absence of features. This SDK is a skeleton: it has no test suite
  yet, and its README says so.

## Supported

`v0.5` line, best-effort. There is no supported-version table for this
repository yet, so security guarantees are provisional.
