# ADR 0026 — Exact inbox completion and read evidence

**Status:** accepted · **Date:** 2026-11-27

## Context

Sessions sharing an agent identity see the same local inbox. In 1.0.2 the
SessionStart brief recommended a bulk drain, which could clear a blocking
request before any session handled it. A room or tag filter still permits an
unrelated item to match, even if it arrived after an earlier inspection.
The room's read watermark also made an item skipped by a filter appear viewed.

## Decision

Inspection leaves completion state unchanged. A reply completes its parent by
message ID. Work handled elsewhere may be completed explicitly by ID. The
processed view and reopen action recover one local row without changing other
items. Human decisions still require the relay, and the task and review
workflows keep their own guarded transitions.

Full inbox views can publish the exact selected IDs in the optional `read_ids`
field of the existing room receipt. The legacy watermark shows room-level
progress. Trace identifies a direct reply from its `in_reply_to` field.

## Alternatives considered

- Keep bulk drain behind a room or tag filter. A filter can include a message
  the session never handled.
- Complete every item in a saved inspection snapshot. Two sessions can inspect
  the same messages and take responsibility for different items.
- Infer individual views from a room watermark. Filtered or limited listings
  can skip any earlier message.

## Consequences

The old bulk drain calls return migration guidance. Completion and reopening
use the existing local inbox rows, so recovery works for rows processed by
1.0.2. Exact read evidence is available for published views. Older receipts
retain their room-level meaning.
