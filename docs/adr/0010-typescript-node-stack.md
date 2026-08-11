# ADR 0010 — TypeScript 7 on Node 26

**Status:** accepted · **Date:** 2026-08-11

## Context

kom-net ships as a daemon, a CLI, and an MCP server installed on every developer machine.
The CLI is invoked by agents constantly, so cold-start latency is a direct UX cost. The team
maintaining this works primarily in Kotlin/Spring.

## Decision

**TypeScript 7 on Node 26**, distributed via npm, in a pnpm workspace.

## Rationale

- **The AI-tooling ecosystem is Node-native.** MCP SDKs, editor integrations, and the config formats kom-net must write are all JavaScript-first. Building here removes a whole class of integration friction.
- **Node 26 runs `.ts` directly** — type stripping is on by default, no flag — so scripts and tests need no build step.
- **`node:sqlite` is built in**, giving a real local index with **zero native dependencies**. This matters disproportionately for "easy to set up": native modules are the usual cause of failed installs.
- **TypeScript 7's compiler is a native Go port** shipping as `tsc`, so builds are fast enough that the monorepo does not need a bundler.
- **CLI cold start** is ~40 ms, against ~400 ms for a JVM — and an agent may invoke the CLI many times per turn.

## Rejected alternatives

| Alternative    | Rejected because                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Kotlin/JVM** | Matches the team's existing skills, and was seriously considered for that reason. But JVM cold start is an order of magnitude worse for a CLI invoked on every agent turn; GraalVM native-image fixes that at the cost of a harder build and reflection constraints; and the MCP/editor ecosystem would need bridging. The team-skills advantage did not outweigh a daily latency cost. |
| **Go**         | Excellent fit — single static binary, no runtime dependency, great process and git handling. Genuinely close. Lost on ecosystem: MCP tooling and editor-config integration are less mature, and distribution via brew/curl is worse onboarding than `npx`. Worth revisiting if the daemon's footprint ever becomes the constraint.                                                      |
| **Rust**       | Fastest startup, smallest footprint, but slowest to iterate on — and this is a protocol-design-heavy project where iteration speed is the binding constraint.                                                                                                                                                                                                                           |

## Consequences

- **Node 26+ is required** on every machine. Mitigated by `npx komnet`, and a bundled single-file binary is a packaging option later.
- **Erasable syntax only.** Node's type stripping forbids `enum`, `namespace`, and parameter properties. Enforced by `erasableSyntaxOnly` in `tsconfig.base.json` — so string-literal unions with `as const` objects replace enums throughout.
- TypeScript 7 constrains the config: `moduleResolution: nodenext` only, no `baseUrl`, no `outFile`, `esModuleInterop` and `alwaysStrict` forced true.
- `@kom-net/protocol` is kept dependency-light and side-effect-free so a third party can implement a compatible client by reading it — a hedge against this stack choice aging badly.
