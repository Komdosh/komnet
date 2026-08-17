# Contributing to komnet

Thanks for looking. This document covers how to build it, what the review bar is, and —
most importantly — **the invariants that must not break**.

---

## Setup

Requires **Node 24+** (for native TypeScript execution and built-in `node:sqlite`),
**pnpm**, and **git 2.42+** (`worktree add --orphan`).

```console
pnpm install
pnpm build          # tsc --build (TypeScript 7 native compiler)
pnpm test           # builds first, then node --test
pnpm verify         # fmt + lint + build + test — this is the CI gate
```

`pnpm verify` must be green before you open a PR. There is no separate lint config to learn:
prettier and oxlint are wired into the same command.

To build the self-contained binary (embeds its own Node):

```console
pnpm binary         # → dist-bin/komnet
```

If your `node` is a Homebrew or distro build, the script will notice it cannot host a SEA
blob and fetch an official Node runtime to use as the base. That is expected, not a fault.

---

## The invariants

These are not style preferences. Each one holds up a load-bearing property of the design,
and breaking one produces a bug that is very hard to trace back.

### 1. Append-only writes

> An agent may only **create** files. The only files it may modify are its own agent card
> and its own read receipts.

This is what makes `git pull --rebase` structurally unable to conflict, which is why there
is no merge-resolution logic anywhere in the codebase. If you find yourself wanting to edit
an existing message, the answer is a new message that references it.

Sealing is the single exception, and it holds a distributed lock. See
[ADR 0004](docs/adr/0004-append-only-immutable-messages.md).

### 2. komnet never spawns an agent session

No `claude -p`, no `codex exec`, no headless invocation of anything, by default. Coding
agents run on interactive subscription plans; spawning them spends money the user did not
agree to and runs agents nobody is watching.

Work is **staged** into an inbox and drained by a live agent. If a feature seems to need
"just run the agent to…", it needs redesigning. See
[ADR 0006](docs/adr/0006-no-agent-spawning.md).

### 3. `needs: human` uses cooperative relay attribution

The ordinary MCP and daemon paths refuse these answers, and the state layer keeps them
pending until the explicit `--as-human` relay flow records an answer. This reduces accidental
misattribution but does not authenticate a person: agents and humans share the same OS and
terminal authority. Never describe `author_kind: human` as proof of human approval. See
[ADR 0012](docs/adr/0012-needs-human-is-cooperative-attribution.md).

### 4. The secret scanner refuses; it never warns

Git history is permanent, so a leaked credential can only be rotated, not recalled. And a
finding **never carries the matched value** — not in errors, not in logs. There is a test
asserting the scanner does not leak secrets into its own output. Keep it passing.

### 5. `state.db` is a cache, never a source of truth

Every row is derivable from git. Deleting the file must lose nothing. If you add a column,
bump `SCHEMA_VERSION` — the schema mismatch path **discards and rebuilds** rather than
migrating, and that is deliberate.

### 6. Protocol changes need a spec update

`spec/komnet-protocol-v1.md` is normative. Adding an **optional** header field does not bump
the protocol version, and readers must preserve unknown fields verbatim
([ADR 0007](docs/adr/0007-forward-compatibility.md)). Anything a version-1 peer cannot safely
ignore does bump it, and needs an ADR.

### 7. Erasable syntax only

Node's type stripping forbids `enum`, `namespace`, and parameter properties. Enforced by
`erasableSyntaxOnly` in `tsconfig.base.json`. Use `as const` objects with string-literal
union types instead — the codebase does this consistently.

---

## Tests

The suite drives **real git** against temporary repositories. That is intentional: the whole
design rests on claims about git's behaviour, and mocking git would test our beliefs about
it rather than the thing itself.

Two tests are load-bearing and should be understood before changing the transport:

- **concurrent-push convergence** (`packages/core/test`) — two clones write from the same base commit; the loser rebases and both messages survive.
- **the full two-agent conversation** (`packages/cli/test`) — spawns the real built binary and runs init → room → ask → sync → inbox → answer.

Note that CLI tests **spawn the binary** rather than calling `run()` in-process. Capturing
stdout by replacing `process.stdout.write` also swallows the test reporter's own output,
which silently reduced 17 tests to 1 before this was fixed.

For a bug fix: write the failing test first, then the minimal fix.

---

## Commits and PRs

**Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/), because
they decide the release.** Landing on `main` triggers an automatic release — but only when
the commits since the last tag actually change behaviour:

| Subject                                                                           | Effect                                          |
| --------------------------------------------------------------------------------- | ----------------------------------------------- |
| `feat: …` `fix: …` `perf: …`                                                      | **patch** — `0.1.0 → 0.1.1`                     |
| `feat!: …` or a `BREAKING CHANGE:` footer                                         | **no auto-release** — asks for a manual version |
| `docs:` `chore:` `ci:` `test:` `refactor:` `style:`, or anything non-conventional | **no release**                                  |

**The automatic path only ever bumps the patch.** A `feat:` ships as a patch: minor bumps
signal scope to users and are worth choosing deliberately, not inheriting from a commit
prefix. Cut a minor by hand when it is genuinely warranted — **Auto Release → Run workflow**
with an explicit version.

Two deliberate refusals in that table:

- **Non-releasable types release nothing.** An npm publish is permanent, so a README fix must never burn a version number.
- **A breaking change stops the pipeline** rather than shipping as a patch. A patch is the one thing users assume is safe to take, so labelling a breaking change as one would actively mislead.

`node scripts/release-version.mjs --check` shows exactly what the next push would do.

The body still matters:

- Explain **why**, not what — the diff already shows what. When you rejected an alternative, say so.
- One logical change per PR.
- Update the docs in the same PR. A documented-but-missing command is a defect in an AI-first tool, because the help text _is_ the API.
- No attribution trailers in commit messages.

## Architecture decisions

Anything that changes the protocol, the git topology, the trust model, or the delivery model
gets an ADR in `docs/adr/`. Follow the existing format — context, decision, **alternatives
rejected and why**, consequences. The rejected-alternatives section is the part that earns
its keep in two years.

## Releasing

**Patch releases are automatic.** Land a `feat:` or `fix:` on `main` and the pipeline bumps
the patch, rewrites the changelog, tags, builds four platform binaries, and publishes to
GitHub Releases and npm.

**Minor and major releases are manual** — run **Auto Release → Run workflow** with an
explicit `version`. That is also the only way to cut the **first** release, since there is no
tag history to infer from.

The pieces, for when it misbehaves:

- `scripts/release-version.mjs --check` — what the next push would release, as JSON.
- `scripts/release-version.mjs --verify` — assert every version site agrees. The release guard runs this, so drift fails the release rather than shipping a binary that lies about its version.
- **Auto Release → Run workflow** with `dry_run` — decide and run the full gate without tagging or publishing.

Two properties worth knowing:

- The gate (`fmt`, `lint`, `build`, `test`) runs **after** the version bump, against the tree that will actually be tagged. Verifying the pre-bump tree would be verifying the wrong thing.
- The release workflow is `workflow_call`-able and the auto-release job calls it directly. A tag pushed with `GITHUB_TOKEN` does **not** trigger workflows, so a tag-triggered release would silently never run — and there is exactly one release path rather than two that can drift.

### npm

Publishing to npm needs an `NPM_TOKEN` secret on the **`publishing` environment** (an
**automation** token, so it works with 2FA). The `npm` job declares that environment; without
the declaration `secrets.NPM_TOKEN` resolves to an empty string and the job reports success
having published nothing.

The five packages publish in dependency order — `protocol → core → daemon → mcp → komnet` —
because a package cannot resolve on the registry until everything it depends on is already
there. `pnpm pack` does the packing (it rewrites `workspace:*` to real versions, which npm
cannot do) and `npm publish` uploads the tarball (it can attach provenance). Already-published
versions are skipped, so re-running a release is safe.

### npm

Publishing to npm needs an `NPM_TOKEN` repository secret (an **automation** token, so it
works with 2FA enabled). Without it the workflow logs a warning and still publishes the
GitHub release, so the two channels are independent.

The five packages publish in dependency order — `protocol → core → daemon → mcp → komnet` —
because a package cannot resolve on the registry until everything it depends on is already
there. `pnpm pack` does the packing (it rewrites `workspace:*` to real versions, which npm
cannot do) and `npm publish` uploads the tarball (it can attach provenance). Already-published
versions are skipped, so re-running a release is safe.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).
