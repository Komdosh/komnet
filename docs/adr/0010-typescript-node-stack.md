# ADR 0010 — TypeScript 7 on Node 24+

**Status:** accepted · **Date:** 2026-08-11 · **Amended:** 2026-08-17 (supported floor
lowered from 26 to 24; the stack decision itself is unchanged)

## Context

komnet ships as a daemon, a CLI, and an MCP server installed on every developer machine.
The CLI is invoked by agents constantly, so cold-start latency is a direct UX cost. The team
maintaining this works primarily in Kotlin/Spring.

## Decision

**TypeScript 7 on Node 24+**, distributed via npm, in a pnpm workspace. (Recorded as Node 26; see the amendment below.)

## Rationale

- **The AI-tooling ecosystem is Node-native.** MCP SDKs, editor integrations, and the config formats komnet must write are all JavaScript-first. Building here removes a whole class of integration friction.
- **Node runs `.ts` directly** — type stripping is on by default, no flag, from 24 onward — so scripts and tests need no build step.
- **`node:sqlite` is built in**, giving a real local index with **zero native dependencies**. This matters disproportionately for "easy to set up": native modules are the usual cause of failed installs.
- **TypeScript 7's compiler is a native Go port** shipping as `tsc`, so builds are fast enough that the monorepo does not need a bundler.
- **CLI cold start** is ~40 ms, against ~400 ms for a JVM — and an agent may invoke the CLI many times per turn.

## Rejected alternatives

| Alternative    | Rejected because                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Kotlin/JVM** | Matches the team's existing skills, and was seriously considered for that reason. But JVM cold start is an order of magnitude worse for a CLI invoked on every agent turn; GraalVM native-image fixes that at the cost of a harder build and reflection constraints; and the MCP/editor ecosystem would need bridging. The team-skills advantage did not outweigh a daily latency cost. |
| **Go**         | Excellent fit — single static binary, no runtime dependency, great process and git handling. Genuinely close. Lost on ecosystem: MCP tooling and editor-config integration are less mature, and distribution via brew/curl is worse onboarding than `npx`. Worth revisiting if the daemon's footprint ever becomes the constraint.                                                      |
| **Rust**       | Fastest startup, smallest footprint, but slowest to iterate on — and this is a protocol-design-heavy project where iteration speed is the binding constraint.                                                                                                                                                                                                                           |

## Amendment — 2026-08-17: the floor is 24, not 26

The original decision said Node 26 and gave two reasons: unflagged type stripping and
built-in `node:sqlite`. **Both are also true of Node 24, so neither reason supports 26.** The
number was never measured against anything lower — every machine involved already ran 26, so
CI pinned 26, `.node-version` said 26, and nothing ever exercised the version the published
package claimed to need.

What was actually run on Node 24.19.0 (Active LTS since 2025-10-28; 26 does not reach LTS
until 2026-10-28):

| Check                              | Result            |
| ---------------------------------- | ----------------- |
| `pnpm install --frozen-lockfile`   | pass              |
| `pnpm fmt:check`                   | pass              |
| `pnpm lint`                        | pass              |
| `pnpm build`                       | pass              |
| `pnpm test`                        | 341/341 pass      |
| `node scripts/build-binary.mjs`    | pass, binary runs |
| `require('node:sqlite')` unflagged | works             |
| `.ts` executed directly, unflagged | works             |

The floor is therefore **`>=24.0.0`** in all six `package.json` files and in `install.sh`,
and CI now runs the verify gate on 24 **and** 26 across both operating systems. Testing only
the newest runtime is what let the floor drift in the first place; the matrix is the guard
against a repeat.

Node 22 was not tested and is not claimed: type stripping needs 22.18+ and `node:sqlite` is
flagged there, so 22 would require flags rather than a version bump.

This does not weaken [ADR 0011](0011-self-contained-binary-distribution.md). The SEA binary
exists so a long-lived daemon is not coupled to a runtime the user reroutes with `nvm`, which
is independent of where the floor sits.

## Consequences

- **Node 24+ is required** on every machine. Mitigated by `npx komnet`, and a bundled single-file binary is a packaging option later.
- **Erasable syntax only.** Node's type stripping forbids `enum`, `namespace`, and parameter properties. Enforced by `erasableSyntaxOnly` in `tsconfig.base.json` — so string-literal unions with `as const` objects replace enums throughout.
- TypeScript 7 constrains the config: `moduleResolution: nodenext` only, no `baseUrl`, no `outFile`, `esModuleInterop` and `alwaysStrict` forced true.
- `@komnet/protocol` is kept dependency-light and side-effect-free so a third party can implement a compatible client by reading it — a hedge against this stack choice aging badly.
