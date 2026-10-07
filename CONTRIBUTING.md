# Contributing

Contributions are welcome — issues, pull requests, tests, docs, and code. No
CLA to sign and no maintainer approval needed to open a pull request. Every
package in this repository is MIT licensed, so your work stays yours.

Repository: https://github.com/mayank040902/framework

## Before you start

**If you are contributing to `@oneunit/auth`, read
[packages/auth/CONTRIBUTING.md](packages/auth/CONTRIBUTING.md) instead.** It
covers security disclosure, which applies to any authentication work here, plus
the behaviors in that package that are deliberate and must not be "fixed" by
accident.

## Reporting a security vulnerability

**Do not open a public issue for a security report.** Report it privately via
GitHub Security Advisories (the repository's *Security* tab → *Report a
vulnerability*) or by emailing `04mayank09@gmail.com`. A flaw in one of these
packages is a flaw in every application using it, and a public write-up starts
giving attackers a head start while the fix is written.

Everything else is a normal issue and welcome as one.

## Getting set up

Requires **Node.js 20+** and **pnpm 11.9.0**:

```bash
corepack enable      # installs the pinned pnpm version
pnpm install
```

Verify your install before starting:

```bash
pnpm --filter @oneunit/auth test
```

## Checks a pull request must pass

Each package is independently testable, so work on one package without building
the monorepo:

```bash
pnpm --filter @oneunit/auth test        # substitute the package you changed
pnpm --filter @oneunit/auth typecheck
pnpm --filter @oneunit/auth build
```

For repo-wide changes, or before opening a pull request that touches several
packages:

```bash
pnpm typecheck    # every workspace project
pnpm test         # every workspace project
pnpm build        # every workspace project
pnpm pack:check   # what would actually be published
pnpm lint         # eslint across the repository
```

These run recursively over every workspace project, `examples/` included. Build
before typechecking across the repo: the packages resolve each other's types
through their built `dist`, so a cold checkout reports
`Cannot find module '@oneunit/...'` until `pnpm build` has run.

> **`pnpm lint` runs and is expected to pass.** Root `typescript` is pinned to
> `^5.9` because `typescript-eslint@8` does not yet support TypeScript 7. If a
> dependency bump pulls TypeScript 7 back in, lint will fail with
> `typescript-eslint does not support TS 7.0` before checking anything — that is
> a toolchain signal, not something to fix in your diff.
>
> The lint script passes `--ignore-pattern '**/.kilo/**'`. Agent worktrees are
> full working copies living inside the repository, and each carries its own
> `eslint.config.js`, so without that flag ESLint loads their configs and reports
> thousands of phantom errors.

`pnpm format:check` verifies Prettier formatting; `pnpm format` rewrites files.

## Layout

- `packages/*` — independently published libraries
- `docs/` — architecture, security, combining packages, env, examples
- `examples/combined` — one service using every package

Each package has its own tests, README, CHANGELOG, CONTRIBUTING, and LICENSE.

## Conventions

- **Branch** from `main`: `fix/refresh-token-race`, `docs/cookie-example`.
- **Commits** follow Conventional Commits with a scope:
  `fix(auth): refuse a refresh token with no jti`, `ci(auth): publish on a
  release tag`.
- **Keep diffs focused.** Bundling a refactor with a behavior change makes
  review harder, and security review hardest of all.
- **Do not bump package versions in a pull request.** Releases are driven by a
  git tag, and a published version number can never be reused.
- **Never add `workspace:` to a published `dependencies` block.** Optional
  siblings belong in `peerDependencies` with
  `peerDependenciesMeta.optional`.

## Docs

A change in behavior that a user can observe is a change that needs docs:

- public API → that package's `README.md` and the matching `docs/packages/*.md`
- trust boundaries, security posture → `docs/security.md`, `docs/architecture.md`
- multi-package wiring → `docs/combining-packages.md`

Say in the pull request what you tested. Naming the exact command is enough; a
note on anything you verified by hand is better.

## Pull requests

Keep the description short: what changed, why, and how you verified it. If you
have not verified it, say so — an unverified draft is welcome, a claim that
something works when it does not is not.

Reviews are not guaranteed to be fast. If a pull request is quiet, a polite ping
after a week is fine.
