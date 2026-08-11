# Distribution and Installation

komnet installs on every developer machine and runs a background daemon there. Onboarding
friction is therefore a first-order design concern, not packaging trivia — a tool that is
awkward to install does not get installed.

---

## 1. The bar

> A developer who has never heard of komnet should be reachable on the network in **one
> command**, without installing a language runtime, and without trusting anything beyond
> the repository their team already controls.

## 2. The tension

`@komnet/core` requires **Node 26+** — for native TypeScript execution and, more
importantly, for built-in `node:sqlite` (which is what keeps the local index free of native
dependencies). But Node 26 shipped in April 2026; most machines are on 22 or 24 LTS.

Requiring "upgrade Node first" would break the one-command bar for the majority of users.

There is a second, sharper problem specific to a **daemon**: if komnet runs on the user's
`nvm`/`fnm`-managed Node, then switching Node version — an ordinary thing developers do
several times a week — silently breaks the background process. The failure presents as
"komnet just stopped syncing", which is miserable to diagnose.

## 3. Decision

**Ship a self-contained single executable that embeds its own Node runtime**, built with
Node's Single Executable Application support (`node:sea`), delivered by an install script.

```console
$ curl -fsSL https://komnet.dev/install.sh | sh
```

| Channel                         | Audience                         | Size    | Runtime dependency |
| ------------------------------- | -------------------------------- | ------- | ------------------ |
| **Install script → SEA binary** | default, everyone                | ~136 MB | **none**           |
| `npm i -g komnet`               | already on Node 26+              | ~2 MB   | Node 26+           |
| Homebrew tap                    | macOS/Linux preference           | ~136 MB | none               |
| Build from source               | contributors; private-repo phase | —       | Node 26 + pnpm     |

The binary is large — comparable to Deno or Bun, which developers install without
complaint. It buys **complete decoupling from the user's Node version**, which for a
long-lived background process is worth far more than 136 MB of disk.

**Verified, not assumed:** the built binary runs under `env -i PATH=/usr/bin:/bin` with no
Node installed, and `node:sqlite` works inside the blob because it is a builtin and
therefore part of the embedded runtime. CI rebuilds and smoke-tests it on every push, so a
broken SEA build surfaces immediately rather than at release time.

### 3.1 How it is built

`scripts/build-binary.mjs`: bundle to a single CommonJS file with esbuild (Node builtins
external, everything else inlined), generate the SEA blob, inject it into a copy of the Node
runtime with postject, then re-sign on macOS — which refuses to run a signed binary that has
been modified.

Two constraints discovered while building it, both now handled:

- **SEA cannot cross-compile.** Each platform's artifact is built on its own runner.
- **Not every `node` can host a blob.** Homebrew and most distro builds are a ~50 KB launcher over a shared `libnode`, and the fuse sentinel lives in the library, not the launcher — injection fails with a confusing "could not find the sentinel". The script detects this and downloads an official static build to use as the base, so `pnpm binary` works on a developer machine and not only in CI.
- **The entry point avoids top-level `await`**, because the bundle is CommonJS where that is a syntax error. One entry point therefore serves both npm and the binary.

`npm` remains a first-class channel for the many users who _do_ have Node 26, and it is two
orders of magnitude smaller.

## 4. The install script

Deliberately small enough to read before piping to a shell — anyone about to run
`curl | sh` should be able to audit it in under a minute.

```
1. detect os/arch                  darwin|linux × arm64|x64  (windows → PowerShell script)
2. resolve version                 $KOMNET_VERSION, else the latest GitHub release
3. download                        tarball + SHA256SUMS from the release
4. VERIFY CHECKSUM                 refuse to install on mismatch
5. install                         $KOMNET_INSTALL_DIR, else ~/.local/bin
6. verify                          run `komnet --version`
7. print next step                 `komnet init --repo <url>`
```

Non-negotiables:

- **Checksum verification is mandatory**, never opt-in. A `curl | sh` installer that does not verify what it downloaded is a supply-chain hole.
- **Never `sudo`.** Installs to a user directory. Needing root to install a chat client is a smell.
- **Never touch shell rc files silently.** If the install dir is not on `PATH`, print the line to add and let the user add it.
- **Idempotent.** Re-running upgrades in place.
- **Fails loudly.** `set -eu`, explicit error messages, no partial installs left behind.

## 5. Release artifacts

Per tagged release, on GitHub Releases:

```
komnet-v<version>-darwin-arm64.tar.gz     built on macos-14
komnet-v<version>-darwin-x64.tar.gz       built on macos-13
komnet-v<version>-linux-x64.tar.gz        built on ubuntu-latest
komnet-v<version>-linux-arm64.tar.gz      built on ubuntu-24.04-arm
SHA256SUMS
install.sh                                ← the installer itself
```

Built by `.github/workflows/release.yml` from a tagged commit, so every artifact is
traceable to a source revision. Windows is not packaged yet; WSL or build-from-source.

**`install.sh` ships as a release asset.** That is what makes
`releases/latest/download/install.sh` resolve to the installer matching the newest release,
rather than whatever happens to be on a branch that may be ahead of what is published.

Three guards keep the loop honest, because the failure they prevent is invisible until a
user hits it:

1. **Version agreement.** The workflow refuses to publish unless the tag, `packages/cli/package.json`, and the `VERSION` constant all match. A binary reporting a version that never existed poisons every later bug report.
2. **Name agreement.** It asserts that every archive name `install.sh` will derive is actually present in `SHA256SUMS`. If the naming formula drifts on either side, the release fails instead of producing 404s.
3. **Round-trip check.** After publishing, it downloads `releases/latest/download/install.sh` and diffs it against the file in the tree.

## 6. Private now, public later

The repository is private today and may be published later. The install path must work
across that transition, so **the script is the stable interface** and the source of
artifacts changes underneath it:

| Phase                  | How install works                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Private (now)**      | `install.sh --from-source` clones over the user's existing git auth and builds. No release artifacts needed, and no token handling in the script. |
| **Private + releases** | `gh release download` using the user's existing GitHub auth. Still no secrets in the script.                                                      |
| **Public**             | Anonymous download from GitHub Releases; `komnet.dev/install.sh` becomes the canonical URL.                                                       |

Deliberately **no token handling in the install script**. Prompting for a PAT in a piped
shell script is exactly the pattern attackers imitate; delegating to `git` and `gh` means
komnet never sees a credential.

## 7. Supply-chain posture

Because this is `curl | sh` software that then runs continuously:

- **Checksums always**, verified before anything is executed.
- **Signed `SHA256SUMS`** (minisign or cosign) once the repo is public, with the public key published in the README and pinned in the script.
- **Build provenance** via GitHub artifact attestations, so an artifact is traceable to a workflow run and a commit.
- **Reproducible-ish builds** — pinned Node version, pinned toolchain, lockfile committed.
- **No install-time network access beyond the release download**, and no postinstall scripts in the npm package.

## 8. Daemon registration

Installing the binary does not start anything. `komnet init` registers the daemon with the
platform's own supervisor, and never as a system service:

| Platform | Mechanism                                        |
| -------- | ------------------------------------------------ |
| macOS    | `launchd` user agent in `~/Library/LaunchAgents` |
| Linux    | `systemd --user` unit                            |
| Windows  | Task Scheduler, at logon                         |

It runs **as the user, unprivileged**. `komnet doctor` verifies it is registered, running,
and able to reach the remote, and `komnet uninstall` removes the registration, the binary,
and — with explicit confirmation — local state.

## 9. Rejected alternatives

| Alternative                                       | Rejected because                                                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **npm only**                                      | Requires Node 26, which most machines do not have. Breaks the one-command bar, and couples a long-lived daemon to a runtime the user reroutes with `nvm`.           |
| **Docker**                                        | A background agent needs the user's git credentials, SSH agent, and home directory. Containerising it fights every one of those.                                    |
| **Bundle a JS file + require system Node**        | Small, but inherits the exact version-coupling problem the daemon must avoid.                                                                                       |
| **Static binary via Bun/Deno compile**            | Attractive output, but would mean targeting a second runtime's APIs — notably replacing `node:sqlite`.                                                              |
| **OS package managers as primary** (apt/dnf/brew) | Slow to update, per-distro packaging work, and most users are not on a distro we would package for. Homebrew is worth having as a convenience, not as the baseline. |
| **Install via `git clone` + build for everyone**  | Requires Node and pnpm, i.e. the problem again. Correct for contributors, wrong as the default.                                                                     |
