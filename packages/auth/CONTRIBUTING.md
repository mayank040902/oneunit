# Contributing to `@oneunit/auth`

Contributions are welcome — bug reports, tests, docs, and code. No CLA to sign
and no maintainer approval needed to open a pull request. The package is MIT
licensed, so your work stays yours.

Repository-wide conventions live in the [root CONTRIBUTING.md](../../CONTRIBUTING.md).
This file covers what is specific to an authentication library.

## Reporting a security vulnerability first

**Do not open a public issue or pull request for a security report.** An
authentication library has a higher blast radius than most: a flaw here is a
flaw in every application that installs it, and a public issue with exploit
details gives attackers a head start while the fix is written.

Report privately, in order of preference:

1. **GitHub Security Advisories** — the repository's *Security* tab →
   *Report a vulnerability*. This opens a private thread only the maintainers
   can see.
2. **Email** the maintainer at `04mayank09@gmail.com`.

Please include the affected version, a minimal reproduction, and the impact you
expect. You will get an acknowledgement, and you will be credited in the
release notes unless you would rather not be.

Everything else — a confusing error message, a missing test, an API that is hard
to use — is a normal issue and welcome as one.

## Getting set up

Requires **Node.js 20+** and **pnpm 11.9.0** (`corepack enable` gets you the
right pnpm).

```bash
pnpm install
pnpm --filter @oneunit/auth test
```

The package typechecks, tests, and builds entirely on its own, so you do not
need the rest of the monorepo to work on it.

## The checks a pull request must pass

```bash
pnpm --filter @oneunit/auth typecheck
pnpm --filter @oneunit/auth test
pnpm --filter @oneunit/auth build
pnpm --filter @oneunit/auth pack:check
```

CI runs these on **Node 20, 22, and 24**, then installs the packed tarball into
a clean project and exercises the public API against it. That last step catches
the failure mode unit tests miss: an import that only resolves inside this
repository. If you add an example or change an export, expect it to be checked
as a real consumer.

To run the consumer smoke test yourself:

```bash
pnpm --filter @oneunit/auth build
pnpm --filter @oneunit/auth pack --pack-destination /tmp/auth
mkdir -p /tmp/auth-consumer && cd /tmp/auth-consumer && npm init -y
npm install /tmp/auth/oneunit-auth-*.tgz
```

## Writing tests

Tests use the Node.js built-in runner (`node:test`) via `tsx`. There is no test
framework to configure.

```bash
pnpm --filter @oneunit/auth test
```

**Security behavior needs a test that fails without the fix.** The behaviors
enumerated as invariants in
[ARCHITECTURE.md](./docs/ARCHITECTURE.md#security-invariants) are each backed by a
case in `test/security.test.ts`; if you touch one of them, extend that list and
add the test. A PR that hardens something and does not add a regression test will
be asked for one, because the next refactor will otherwise quietly undo it.

Tests must not reach the network. The Apple suite generates an RSA key pair and
injects it through the `jwks` config option rather than fetching Apple's real
keys — keep it that way, or CI will be slow and flaky.

## Things that are deliberate

These look like bugs and are not. Please do not "fix" them without raising it
first:

- **`defaultRole` grants anonymous callers.** `rbac.can(null, "x.write")`
  returns `true` when a `defaultRole` is configured. That is intentional: a
  default role is a grant to a subject with no subject. See
  [ARCHITECTURE.md](./docs/ARCHITECTURE.md#defaultrole-applies-to-a-null-subject-too).
- **A refresh token cannot be revoked by `logout()` after its access token was
  issued.** Access tokens are stateless assertions. `revokeAllSessions()` with a
  `sessionStore` is the way to invalidate them early.
- **RBAC changes are not retroactive.** A token's `roles` and `permissions` are a
  snapshot from login.
- **The query string is not read for a token** unless you pass `{ query: true }`.
  A token in a URL leaks into logs, history, and `Referer` headers.

## Pull requests

- Branch from `main`: `fix/refresh-token-race`, `docs/cookie-example`,
  `feat/password-rehash`, and so on.
- Commit messages follow Conventional Commits with a scope:
  `fix(auth): refuse a refresh token with no jti`, `docs(auth): explain
  session revocation`. History is the guide if you need more examples.
- Keep the diff focused. A refactor bundled with a behavior change makes review
  much harder, and security review hardest of all.
- Update `README.md` for a user-visible change and `CHANGELOG.md` under
  `Unreleased`, and add an `ARCHITECTURE.md` note if it changes a trust
  boundary. Reviewers will ask.
- Say what you tested. "I verified with `pnpm --filter @oneunit/auth test`" is
  enough; a note on what you checked by hand is better.

## Breaking changes

`@oneunit/auth` is at **2.x**, so removing or changing behavior needs a major
release. Before proposing one, consider whether a deprecation path exists —
adding an option, warning, or throwing a clearer error usually lands better than
a rename. Breaking changes are called out in `CHANGELOG.md` with the migration
step spelled out, so write that section for someone upgrading against their will.

If your change is breaking, do not bump the version. Releases are the
maintainer's job and are driven by an `auth-v*` git tag, which CI uses to
publish. A version number can only ever be published once, so it is never
bumped in a pull request.

## Reporting a bug

Open an issue with:

- the `@oneunit/auth` version and Node version,
- what you expected and what happened,
- a minimal reproduction — ideally against the public API, not internals.

If the bug is a security issue, use the private channel above instead.
