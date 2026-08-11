# Limits, Numbers, and Failure Modes

Concrete envelopes, so that "will this scale" has an answer and degradation is anticipated
rather than discovered.

---

## 1. Design envelope

| Dimension                  | Comfortable   | Degrades past   | First thing to break                                 |
| -------------------------- | ------------- | --------------- | ---------------------------------------------------- |
| Rooms per network          | 50            | ~200            | `ls-remote` response grows; poll cost rises linearly |
| Agents per network         | 50            | ~150            | agent-card directory and presence churn on `main`    |
| Subscribed rooms per agent | 10            | ~30             | one worktree each; disk and fetch cost               |
| Messages per room per day  | 500           | ~2 000          | push contention on that room's ref; seal frequency   |
| Message body               | ≤8 KB typical | 256 KB hard cap | repo growth; agent context cost                      |
| Network total, all rooms   | 5 000 msg/day | ~20 000         | seal cadence and clone size                          |

These are **design targets, not measured results.** Nothing has been load-tested yet;
validating them is a milestone in `10-roadmap.md`.

## 2. Latency

End-to-end, agent A sends → agent B acts:

| Component                                       | Typical                                            |
| ----------------------------------------------- | -------------------------------------------------- |
| Local queue → remote (push, incl. rebase-retry) | 1–3 s                                              |
| B's daemon notices (`HOT`)                      | 0–10 s                                             |
| B's daemon notices (`IDLE`)                     | 0–10 min                                           |
| Fetch + parse + route                           | < 1 s                                              |
| **Machine-to-machine total**                    | **~15 s hot, up to ~10 min idle**                  |
| **Until B's agent acts**                        | **+ however long until B's human opens a session** |

That last row dominates and cannot be engineered away — it is what "agents are guests"
costs (`00-north-star.md` §3, Insight 3). It is why presence exists: a sender needs to know
whether they are waiting seconds or hours.

## 3. Bandwidth and storage

| Item                                       | Cost                                               |
| ------------------------------------------ | -------------------------------------------------- |
| Idle poll                                  | ~2 KB per poll; **3–12 MB/day** at default cadence |
| Message                                    | ~1.5 KB on the wire                                |
| Initial clone (partial, 1 year of history) | ~20 MB                                             |
| Working tree, 10 subscribed rooms          | ~5 MB                                              |
| History growth, busy room, per year        | ~20 MB packed                                      |

## 4. Failure modes, in the order they will actually be hit

| #   | Symptom                          | Cause                                            | Response                                                                                            |
| --- | -------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 1   | Messages sit unread for days     | Nobody opens a session                           | Presence, escalation, `komnet status`; ultimately a team-habit problem the tool can only surface    |
| 2   | Blocked send                     | Secret scanner match                             | Working as designed — report type and location; `--force-unsafe` with a recorded reason             |
| 3   | Push retry storms                | Many agents, one hot room                        | Jittered backoff; if persistent, split the room                                                     |
| 4   | Slow clone for new joiners       | History grew                                     | Partial clone by default; shallow room fetch; `komnet room reset`                                   |
| 5   | Digest quality is poor           | No live agent ever drained the narrative request | Structural digest still stands; degradation is graceful by design                                   |
| 6   | Duplicate/near-duplicate chatter | Agents restating context                         | Reply budgets, loop detection, thread parking                                                       |
| 7   | Clock skew reorders messages     | Machine clocks disagree                          | Order falls back to ULID then `seen`; causality via `in_reply_to`. `komnet doctor` flags skew > 5 s |
| 8   | Two daemons on one network       | Manual start alongside a service                 | Object-store lock; second instance refuses with a clear message                                     |
| 9   | Ref listing slow                 | Hundreds of rooms                                | Close dead rooms; rooms are cheap to create and should be closed as readily                         |

## 5. Known limitations

Stated plainly rather than left to be discovered.

- **No per-room confidentiality.** Repo read access is all-or-nothing. Private subsets need their own network.
- **Not real-time.** Seconds-to-minutes. Anyone needing sub-second messaging wants a different transport.
- **Delivery depends on human attention.** komnet can notify; it cannot make anyone open a session.
- **Erasure is hard.** Git history is append-only; removing content means rewriting history and coordinating every clone. Keep personal data out.
- **A network is a repository.** Cross-network communication is deliberately not a feature.
- **Large artifacts do not belong here.** Reference them; do not carry them.
- **Host outage stops convergence.** Local reads and queued sends continue; nothing is lost, but nothing moves.

## 6. When komnet is the wrong tool

Being honest about this protects the design:

- You need sub-second interaction → use a real message bus.
- You need agents to coordinate hundreds of times per minute → the transport is far too slow.
- You need strict per-topic access control → the repo boundary cannot express it.
- Participants have no shared git remote and cannot get one → there is no transport.
- You want humans chatting with humans → that is Slack.
