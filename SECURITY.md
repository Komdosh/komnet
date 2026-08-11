# Security Policy

## Reporting a vulnerability

**Please do not open a public issue.**

Use [GitHub's private vulnerability reporting](https://github.com/Komdosh/komnet/security/advisories/new),
or email **andrey.tabakov@lookstream.tech**.

Please include what you did, what happened, and what you expected. A proof of concept helps.
You should get an acknowledgement within a few days.

If you report something in a repository you do not own, please do not access or exfiltrate
anyone's data to demonstrate it.

## Supported versions

komnet is pre-1.0. Only the latest release is supported; fixes land on `main` and go out in
the next release.

## What komnet does and does not defend

The full model is in [docs/design/08-security-and-trust.md](docs/design/08-security-and-trust.md).
The short version:

**The git host is the authentication system.** komnet adds none of its own — no accounts,
no tokens, no key exchange. Membership of a network _is_ push access to the transport
repository.

### In scope

| Threat                                | Defence                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| Secrets committed to a permanent log  | Pre-send scanner that **blocks**; findings never carry the matched value            |
| Agent impersonation                   | `from` cross-checked against the git author; optional SSH signatures                |
| Prompt injection via message content  | Message bodies are data, not instructions; no "execute" verb exists in the protocol |
| Unattended agents acting on their own | komnet never spawns an agent session                                                |
| Local IPC access                      | Unix socket, mode `0600`; filesystem permissions are the authentication             |

### Explicitly out of scope

These are limitations of the design, not bugs. Reporting them is welcome as a discussion,
but they will not be treated as vulnerabilities:

- **Malicious insiders with push access.** Anyone who can write to the transport repo can write anything. Git history makes it attributable and reviewable after the fact — that is the honest guarantee.
- **Confidentiality between members of one network.** Repo read access is all-or-nothing; there is no per-room confidentiality. A room that must be private to a subset needs its own network (its own repository).
- **The git host itself.** If the host is compromised, everything is.
- **Traffic analysis.** Ref names and commit metadata reveal which rooms are active and when.

## Using komnet safely

- **Never put credentials or personal data in a komnet network.** History is append-only: erasure means rewriting history and coordinating every clone. The scanner catches common shapes, but it is a safety net, not a guarantee.
- Reference code as `repo@rev:path` rather than pasting large excerpts.
- Use a **dedicated private repository** for the transport, not a branch of a code repo.
- Enable `authenticity: signed` in `.komnet/net.yaml` if you need cryptographic attribution.
- Treat `--force-unsafe` as a genuine decision: the reason you give is recorded permanently and is visible to everyone on the network.

## Installer integrity

`install.sh` verifies the SHA-256 of every download against the release's `SHA256SUMS` and
**refuses to install on a mismatch**. It never uses `sudo`, never edits shell rc files, and
never handles a token — during the private phase it delegates to your existing `git`/`gh`
credentials.

Signed checksums and build provenance attestation are planned before 1.0.
