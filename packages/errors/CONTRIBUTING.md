# Contributing to `@oneunit/errors`

Contributions are welcome — bug reports, tests, docs, and code. No CLA to sign
and no maintainer approval needed to open a pull request. The package is MIT
licensed, so your work stays yours.

Repository-wide conventions live in the [root CONTRIBUTING.md](../../CONTRIBUTING.md).
This file covers what is specific to an error-handling library — which, of
everything in this repository, is the package most likely to be depended upon by
code that is already broken.

## Reporting a security vulnerability

**Do not open a public issue or pull request for a security report.** Report it
privately via GitHub Security Advisories (the repository's *Security* tab →
*Report a vulnerability*) or by emailing `04mayank09@gmail.com`.

An error library has an unusually wide blast radius: a leak here reaches every
application that logs or returns an error, usually through a code path nobody is
reading while they use it.

Everything else — a confusing message, a missing test, an awkward API — is a
normal issue and welcome as one.

## Getting set up

Requires **Node.js 20.19+** and **pnpm 11.9.0** (`corepack enable` gets you the
right pnpm).

```bash
pnpm install
pnpm --filter @oneunit/errors test
```

The package typechecks, tests, and builds entirely on its own, so you do not
need the rest of the monorepo working to work on it.

## The checks a pull request must pass

```bash
pnpm --filter @oneunit/errors verify        # typecheck + lint + test
pnpm --filter @oneunit/errors build
pnpm --filter @oneunit/errors pack:check
```

CI runs these on **Node 20.19, 22, and 24**, enforces the coverage thresholds
in `vitest.config.ts`, then installs the packed tarball into a clean project and
exercises the public API against it.

That last step catches the failure mode unit tests miss, and it is worth
understanding before you rely on a green suite: **these tests import `../src`,
not `../dist`.** A passing suite says the sources behave; it does not prove the
compiled output loads. (The sibling `@oneunit/redis` does the opposite — its
tests import the build — which is why its `CONTRIBUTING.md` says `npm test` tests
the build. Check the import path before assuming what a green run proved.)

To run the consumer smoke test yourself:

```bash
pnpm --filter @oneunit/errors build
pnpm --filter @oneunit/errors pack --pack-destination /tmp/errors
mkdir -p /tmp/errors-consumer && cd /tmp/errors-consumer && npm init -y
npm pkg set type=module
npm install /tmp/errors/oneunit-errors-*.tgz
```

Note the order in CI: the subpath exports are imported **before** Fastify is
installed, which is what proves the package has no hard dependency on its
optional peer.

## Writing tests

Vitest, with `app.inject()` for the Fastify handler — real routes, real
serialization, no listening socket and no network.

```bash
pnpm --filter @oneunit/errors test          # 230 tests
pnpm --filter @oneunit/errors test:watch
```

**Every bug fix needs a regression test that fails without it.** The suite
exists mostly because of bugs this package had; a fix without a test will be
quietly undone by the next refactor. If a change touches one of the invariants
in [ARCHITECTURE.md](./ARCHITECTURE.md#deliberate-behaviors), extend that list
and assert the new behavior.

Two habits worth copying:

- **Assert the whole matrix where one exists.** `errors.test.ts` runs a 22-case
  table that checks every class's `name`, `code`, `statusCode`, its
  `ERROR_REGISTRY` entry, and its presence in `ERROR_CODES`. A wrong status in
  one class is otherwise invisible until it reaches an HTTP response.
- **Reproduce before fixing.** Most of the bugs in the changelog were found by
  running a probe that printed the actual output, not by reading the code. If a
  fix is not obviously correct, write the probe.

## Things that are deliberate

These look like bugs and are not. Please do not "fix" them without raising it
first — several exist because of a specific failure that has already shipped.

- **`toJSON()` includes `stack`,** so a bare `JSON.stringify(error)` exposes file
  paths. The Fastify handler strips it by default and `serializeError` omits it.
  Removing it from `toJSON` would break the `includeStack` option and every
  consumer parsing the payload.
- **Redaction defaults to off.** With it off, a secret in `details` reaches the
  output. Turning it on by default would silently change the payload every
  existing consumer parses — that is a major version bump, not a fix. See
  [ARCHITECTURE.md](./ARCHITECTURE.md#redaction-is-opt-in).
- **`formatError` defaults `includeStack: true` while the Fastify handler
  defaults to `false`.** The formatter mirrors `toJSON`; the HTTP boundary is
  the one that has to be conservative.
- **`withRetry` runs a single attempt when `maxAttempts` is 0 or negative.**
  Rejecting with `undefined` was the bug this replaced.
- **An unmapped 4xx keeps its own status.** A 418 answers 418 with the code
  `BAD_REQUEST`; only a genuinely statusless error becomes a 500.
- **`combine` and `tryAll` do not fail fast.** Every input settles before the
  result is returned, so the error you get is the first failure in argument
  order, not the first to occur.
- **`errorHandlerPlugin` hand-sets `Symbol.for("skip-override")`** rather than
  depending on `fastify-plugin`; Fastify core honours the symbol itself, so the
  wrapper would be a dependency doing nothing.
- **`unwrap(err(x))` throws `x`,** which may not be an `Error`. `Result<E>` does
  not constrain `E`.

## Adding an error class

1. Extend `AppError` in `src/errors.ts` with a fixed `code` and `statusCode`.
2. Spread caller `details` **before** the canonical fields
   (`{ ...details, resource }`), never after. See
   [ARCHITECTURE.md](./ARCHITECTURE.md#design-principles).
3. Add the code to `ERROR_CODES` in `src/fastify.ts`.
4. Add the class to `ERROR_REGISTRY` in `src/errors.ts`.
5. Add a row to the `cases` table in `test/errors.test.ts`. The registry-sync
   and `ERROR_CODES`-sync tests fail if you skipped 3 or 4.

Steps 3 and 4 are two separate lists, which is a wart; the sync test is what
keeps them honest.

## Pull requests

- Branch from `main`: `fix/retry-after-header`, `docs/serialization-example`.
- Commits follow Conventional Commits with a scope:
  `fix(errors): keep a falsy id in NotFoundError`, `ci(errors): publish on a
  release tag`.
- Keep the diff focused. A refactor bundled with a behavior change makes review
  much harder.
- Update `README.md` for a user-visible change and `CHANGELOG.md` under the
  current version heading. Add an `ARCHITECTURE.md` note if you change a
  deliberate behavior or a trust boundary. Reviewers will ask.
- Say what you tested. Naming the exact command is enough; a note on what you
  checked by hand is better.

## Breaking changes

`@oneunit/errors` is at **2.x**. Because every other package in the monorepo may
depend on it, treat a change to an error's `code`, `statusCode`, `details`
shape, or the canonical payload as breaking.

Before proposing a break, consider a deprecation path — adding an option,
warning, or throwing a clearer error usually lands better than a rename or a
removal. The package has done this twice: `formatValidationError` and
`createErrorResponse` now delegate to the canonical payload and carry
`@deprecated` rather than disappearing.

Breaking changes are called out in `CHANGELOG.md` with the migration step spelled
out, so write that section for someone upgrading against their will.

**Do not bump the version in a pull request.** Releases are the maintainer's job
and are driven by an `errors-v*` git tag, which CI uses to publish. A version
number can only ever be published once.

## Reporting a bug

Open an issue with:

- the `@oneunit/errors` version and Node version,
- what you expected and what happened,
- a minimal reproduction — ideally against the public API, not internals.

If the bug is a security issue, use the private channel above instead. If it is
an error that is *missing* rather than wrong, say what the failure looked like
and which class would have been right; the class list is deliberately not
comprehensive and grows from real reports.