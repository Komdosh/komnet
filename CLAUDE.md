# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm verify        # fmt:check + lint + build + test — this is exactly what CI runs
pnpm build         # tsc --build (TypeScript 7 native compiler, project references)
pnpm test          # builds first, then node --test over packages/*/test/**/*.test.ts
pnpm binary        # → dist-bin/komnet, the self-contained executable
```

Running a subset:

```bash
node --test packages/core/test/core.test.ts                    # one file (build first)
node --test --test-name-pattern "converges when two agents" \
  packages/core/test/core.test.ts                              # one test
pnpm build && node packages/cli/dist/bin.js --help             # exercise the CLI directly
```

**`--test-name-pattern` must come BEFORE the file path.** After it, Node treats it as a
script argument and silently runs the whole file — reporting a pass, so nothing tells you
the filter was ignored. Always pass a file too: with no path it walks every suite, which
takes minutes.

`pnpm test` builds first on purpose: the CLI and MCP test suites **spawn the built binary**
(`packages/cli/dist/bin.js`), so a stale `dist/` silently tests old code.

Requires **Node 26+** (native TS execution, built-in `node:sqlite`) and **git 2.42+**
(`worktree add --orphan`).

## What this is

A message bus for AI coding agents whose transport is a git repository. Rooms are git
branches, messages are files, git history is the log. There is no server.

Read `docs/design/00-north-star.md` before making design decisions — it fixes the main idea
and everything else is downstream. `spec/komnet-protocol-v1.md` is the normative on-disk
contract; `docs/adr/` records every significant decision with the alternatives rejected.

## Invariants

These are not style preferences. Each holds up a load-bearing property, and breaking one
produces a bug that is very hard to trace back. `CONTRIBUTING.md` has the full rationale.

1. **Append-only writes.** An agent may only _create_ files; the only files it may modify are
   its own agent card and its own read receipts. This is why `git pull --rebase` structurally
   cannot conflict, and why there is no merge-resolution logic anywhere. Sealing is the single
   exception and holds a distributed lock.
2. **komnet never spawns an agent session.** No `claude -p`, no `codex exec`. Agents run on
   interactive subscription plans. Work is _staged_ into an inbox and drained by a live agent.
   If a feature seems to need "just run the agent to…", it needs redesigning.
3. **`needs: human` is cooperative attribution, not authentication.** Ordinary agent/MCP
   answers are refused and the inbox stays pending until the explicit relay flow is used.
   `--as-human` may be operated by an agent on behalf of its human, so never treat the marker
   as proof of who controlled the terminal. See ADR 0012.
4. **The secret scanner refuses, never warns**, and a finding never carries the matched value.
5. **`state.db` is a cache, never a source of truth.** Every row is derivable from git.
   Adding a column means bumping `SCHEMA_VERSION`; the mismatch path discards and rebuilds
   rather than migrating.

## Architecture

Package dependency order — `protocol → core → daemon → mcp → cli`:

| Package            | Role                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@komnet/protocol` | The wire contract in executable form: message parse/serialise, ULID, path and ref conventions, ordering, routing. Deliberately dependency-light so a third party could reimplement it.                 |
| `@komnet/core`     | The engine. `Network` is the orchestrator every surface shares; `Repo`/`GitRunner` shell out to the user's own git; `StateDb` (node:sqlite) is the local cache; `FileLock` serialises direct-mode git. |
| `@komnet/daemon`   | Long-lived process: adaptive sync loop, inbox staging, notifications, presence, unix-socket IPC. Also owns the `Backend` abstraction.                                                                  |
| `@komnet/mcp`      | MCP v2 server (`@modelcontextprotocol/server`) over the same `Backend`.                                                                                                                                |
| `komnet` (cli)     | Thin surface over `Backend`.                                                                                                                                                                           |

Two structural points that require reading several files to see:

**All logic lives in `core/network.ts`.** The CLI, the daemon's IPC dispatch, and the MCP
tools all call the same `Network` methods, so the surfaces cannot drift apart. Adding a
capability means adding it to `Network` first, then exposing it in each surface.

**`Backend` (in `daemon/src/backend.ts`) is daemon-or-direct.** It prefers the daemon over its
socket and falls back to opening a `Network` directly. That is why a stopped daemon degrades
delivery to pull-based instead of breaking anything, and why both CLI and MCP get identical
behaviour. `komnet init` and `komnet doctor` deliberately bypass it.

**Git topology:** `room/<id>` orphan branches carry the live high-churn log; `main` carries
the sealed record (digests, decisions, room configs, agent cards). One
`git ls-remote 'refs/heads/room/*'` reveals exactly which rooms changed without fetching.
Sealing (merge room → main, then prune) is implemented in `core/seal/` and described in
`docs/design/06-retention-and-sealing.md`. It runs via `komnet seal`, over daemon IPC, and
automatically when a room outgrows its retention window.

## Language and toolchain constraints

- **Erasable syntax only.** Node's type stripping forbids `enum`, `namespace`, and parameter
  properties; enforced by `erasableSyntaxOnly`. Use `as const` objects with string-literal
  union types — the codebase does this consistently.
- **`exactOptionalPropertyTypes` is on.** Building an object with an optional field uses the
  spread pattern: `...(x === undefined ? {} : { x })`.
- TypeScript 7 constrains config: `moduleResolution: nodenext` only, no `baseUrl`, no `outFile`.
- Relative imports are written with `.ts` extensions (`rewriteRelativeImportExtensions`).
- The IDE frequently reports stale `Cannot find module '@komnet/*'` and
  `allowImportingTsExtensions` diagnostics. **Trust `pnpm build`, not the IDE.**

## Tests

The suite drives **real git** in temp repos and a **real MCP client** over stdio, because the
design rests on claims about how those actually behave. Four cases are load-bearing:

- concurrent-push convergence (`packages/core/test`) — two clones from the same base commit;
- the two-agent conversation through the built binary (`packages/cli/test`);
- the daemon delivering with no agent running and no explicit `sync` (`packages/daemon/test`);
- the MCP stdio handshake, asserting stdout carries only JSON-RPC (`packages/mcp/test`).

CLI/MCP tests spawn the binary rather than calling `run()` in-process — replacing
`process.stdout.write` to capture output also swallows the test reporter's own output, which
once silently reduced 17 tests to 1.

**Beware vacuous tests here.** Two have already shipped and been fixed: an assertion guarded
by a condition that was never true, and a `needs: human` test that sent the message from the
same agent (routing never delivers a message back to its author, so the inbox was empty).
When a test involves routing, use a genuinely second agent.

## Releases

Automatic from `main`, driven by Conventional Commit subjects:

- `feat:` / `fix:` / `perf:` → **patch** release (bump, changelog, tag, 4 binaries, npm)
- `feat!:` or `BREAKING CHANGE:` → **stops** and asks for a manual version
- `docs:` `chore:` `ci:` `test:` `refactor:` `style:` / non-conventional → **nothing**

The automatic path only ever bumps the patch; minor and major are manual (Auto Release →
Run workflow with an explicit `version`), which is also the only way to cut the first release.

`node scripts/release-version.mjs --check` shows what the next push would do; `--verify`
asserts all **seven** version sites agree (five `package.json` files plus the `VERSION` and
`MCP_SERVER_VERSION` constants). The release guard runs `--verify`, so drift fails the release
rather than shipping a binary that reports a version that never existed.

## Other agent configs

A user-level `~/.codex/config.toml` and `~/.gemini/settings.json` exist on this machine. To
pull their MCP servers, commands, or instructions into Claude Code, reply `/import` to see
what is importable, then `/import --yes=<digest>` to apply it. (If `/import` is unavailable
on this surface, run `claude import` from a terminal.)
