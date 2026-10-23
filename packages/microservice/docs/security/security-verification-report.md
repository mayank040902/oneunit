# Security Verification Report

This package collection does not currently have a single repository-wide security
verification report. Security-relevant verification is package-specific and is described
in each package's own documentation and test suite.

## Documented automation

- `packages/microservice` CI runs `pnpm audit --audit-level high`.
- Root CI does not define a dedicated CodeQL, SAST, secret-scanning, or centralized
  dependency-review workflow.
- Runtime security behavior is documented in package README files and
  `docs/security.md`.

## Direct-access boundaries

Authentication and authorization are not automatically enforced on every package path.
Consumers must configure and invoke supported security boundaries explicitly. See
`packages/microservice/README.md` for package-specific limitations.

## Status

No centralized security verification result is claimed by this document.
