# Contributing to kom-net

Thanks for looking. This document covers how to build it, what the review bar is, and —
most importantly — **the invariants that must not break**.

---

## Setup

Requires **Node 26+** (for native TypeScript execution and built-in `node:sqlite`),
**pnpm**, and **git 2.42+** (`worktree add --orphan`).

```console
$ pnpm install
$ pnpm build          # tsc --build (TypeScript 7 native compiler)
$ pnpm test           # builds first, then node --test
$ pnpm verify         # fmt + lint + build + test — this is the CI gate
```

`pnpm verify` must be green before you open a PR. There is no separate lint config to learn:
prettier and oxlint are wired into the same command.

To build the self-contained binary (~136 MB, embeds its own Node):

```console
$ pnpm binary         # → dist-bin/komnet
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

### 2. kom-net never spawns an agent session

No `claude -p`, no `codex exec`, no headless invocation of anything, by default. Coding
agents run on interactive subscription plans; spawning them spends money the user did not
agree to and runs agents nobody is watching.

Work is **staged** into an inbox and drained by a live agent. If a feature seems to need
"just run the agent to…", it needs redesigning. See
[ADR 0006](docs/adr/0006-no-agent-spawning.md).

### 3. A `needs: human` message cannot be answered by an agent

Enforced in `Network.answer`, in the state layer, and stated in the CLI help. This is the
protocol's core human-in-the-loop guarantee — it is normative, not advisory.

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

Maintainers only:

1. bump the version in `packages/cli/package.json` **and** the `VERSION` constant in `packages/cli/src/main.ts`
2. update `CHANGELOG.md`
3. `git tag vX.Y.Z && git push origin vX.Y.Z`

The release workflow refuses to publish if the tag, the package version, and the `VERSION`
constant disagree — a binary reporting a version that never existed poisons every later bug
report.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).
