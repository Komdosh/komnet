# ADR 0011 — Distribute a self-contained binary via an install script

**Status:** accepted · **Date:** 2026-08-11

## Context

kom-net installs on every developer machine and runs a background daemon. It requires
Node 26+ (for `node:sqlite`, which keeps the local index free of native dependencies), but
Node 26 shipped in April 2026 and most machines run 22 or 24 LTS.

Two problems follow. First, "upgrade Node before installing our chat tool" breaks the
one-command onboarding bar. Second — and worse for a **daemon** — running on the user's
`nvm`/`fnm`-managed Node means that switching Node version, which developers do routinely,
silently kills the background process. That presents as "kom-net stopped syncing", which is
very hard to diagnose.

The repository is private today and may be made public later, so the install path must
survive that transition.

## Decision

**Ship a self-contained single executable embedding its own Node runtime**, built with
Node's SEA support, installed by a small auditable script:

```console
$ curl -fsSL https://komnet.dev/install.sh | sh
```

`npm i -g komnet` stays a first-class secondary channel for users already on Node 26
(~2 MB instead of ~110 MB). Homebrew is a later convenience. Building from source is for
contributors — and is the mechanism during the private phase.

The **script is the stable interface**; where artifacts come from changes underneath it as
the repo goes from private → private-with-releases → public. The script handles **no
tokens**: during the private phase it delegates to the user's existing `git`/`gh` auth.

## Rationale

- **Zero runtime dependency** is the point. A daemon must not break because the user ran `nvm use 22`.
- **~110 MB is an accepted cost.** Deno and Bun are the same order of magnitude and are installed without complaint. It is a one-time download for a permanent decoupling.
- **npm covers the small-download case** for the users who can already run it.
- **No tokens in a piped shell script.** Prompting for a PAT inside `curl | sh` is precisely the pattern attackers imitate; delegating to `git`/`gh` means kom-net never handles a credential.
- **Checksum verification is mandatory.** A `curl | sh` installer that does not verify its download is a supply-chain hole, and this one installs software that then runs continuously.

## Consequences

Confirmed by building it (measured, not estimated):

- The binary is **~136 MB** and runs under `env -i PATH=/usr/bin:/bin` with no Node installed. `node:sqlite` works inside it, being a builtin and therefore part of the embedded runtime.
- **SEA cannot cross-compile**, so each platform is built on its own runner (macos-14, macos-13, ubuntu-latest, ubuntu-24.04-arm). No Windows artifact yet.
- **Not every `node` can host a blob.** Homebrew and most distro builds are a ~50 KB launcher over a shared `libnode`; the fuse sentinel lives in the library, so injection fails with a misleading "could not find the sentinel". `scripts/build-binary.mjs` detects this and downloads an official static build as the base — otherwise `pnpm binary` would only work in CI, and a release-only build path is one nobody tests.
- **The entry point cannot use top-level `await`**, since the bundle is CommonJS. Handled with `.then`, so one entry point serves npm and the binary.
- CI rebuilds and smoke-tests the binary on every push, so a broken SEA build surfaces immediately rather than at release time.

Ongoing costs:

- Binary size makes upgrades noticeable; a delta or the npm channel may become worthwhile later.
- Node version bumps require rebuilding and re-releasing every artifact.
- `install.sh` must stay short enough that a cautious user can read it before running it — a real constraint on adding features to it.
- Once public, `SHA256SUMS` gets signed and the public key is pinned in the script and published in the README.

## Alternatives considered

| Alternative                  | Rejected because                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| npm only                     | Requires Node 26 (most machines lack it) and couples the daemon to a runtime the user reroutes with `nvm`.   |
| Docker                       | The daemon needs the user's git credentials, SSH agent, and home directory; containerising fights all three. |
| Bundled JS + system Node     | Small, but reintroduces exactly the version-coupling the daemon must avoid.                                  |
| Bun/Deno `compile`           | Good output, but means targeting a second runtime's APIs and replacing `node:sqlite`.                        |
| OS packages as primary       | Per-distro packaging work, slow updates, poor coverage. Homebrew is worth having as a convenience only.      |
| Clone-and-build for everyone | Requires Node and pnpm — the original problem. Right for contributors, wrong as the default.                 |
