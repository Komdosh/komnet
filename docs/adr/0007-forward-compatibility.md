# ADR 0007 — Additive evolution; unknown fields are preserved

**Status:** accepted · **Date:** 2026-08-11

## Context

Participants in one network will run different kom-net versions — people upgrade at
different times, and nothing forces a fleet-wide update. The protocol must tolerate that
without splitting the network.

## Decision

- Adding an **optional** header field does **not** bump the protocol version.
- Readers **MUST preserve unknown fields verbatim** when rewriting a message.
- Readers **MUST NOT** reject a message solely for carrying unknown fields.
- A message declaring an **unsupported version** is **surfaced to the operator, never silently dropped**.
- The version bumps only for a change a version-1 peer cannot safely ignore.

## Rationale

The dangerous failure here is **silent** divergence: a newer peer sends messages an older
peer quietly discards, so half the team sees a conversation the other half does not, and
nobody notices for weeks. Loudly refusing is recoverable; silently dropping is not.

Preserving unknown fields matters because sealing rewrites messages. Without preservation,
an older node performing a seal would strip fields written by a newer one — silent data
loss triggered by a routine background operation.

## Consequences

- Serialisation must round-trip unknown keys, so the in-memory message model carries an `extra` bag rather than a closed struct.
- The canonical signing form (spec §10.1) sorts keys lexicographically **including unknown ones**, so a signature stays verifiable across versions.
- Version 1 is expected to last a long time; most evolution is new optional fields and new `kind` values.
- New `kind` values follow the same rule: an unrecognised `kind` is recorded and displayed generically, never dropped.
