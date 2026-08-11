## What and why

<!-- The diff shows what changed. Explain why, and what you rejected on the way. -->

## Checklist

- [ ] `pnpm verify` is green (fmt, lint, build, test)
- [ ] Docs updated in this PR — a documented-but-missing command is a defect, because in an AI-first tool the help text _is_ the API
- [ ] For a bug fix: a failing test came first

## Invariants

Tick anything this PR touches, and say how it stays safe. None is disqualifying, but each
needs justification — and a protocol or topology change needs an ADR in `docs/adr/`.

- [ ] **Append-only writes** — an agent may only create files, never modify another's
- [ ] **No agent spawning** — kom-net must never start an agent session by default
- [ ] **`needs: human` is not answerable by an agent**
- [ ] **The secret scanner refuses rather than warns**, and findings never carry the matched value
- [ ] **`state.db` stays a rebuildable cache** (bump `SCHEMA_VERSION` if the schema moved)
- [ ] **Protocol change** — `spec/komnet-protocol-v1.md` updated, unknown fields still preserved
- [ ] None of the above
