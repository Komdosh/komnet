#!/bin/sh
# kom-net installer.
#
# Short on purpose: anyone about to pipe this into a shell should be able to
# read it first. It does four things — work out which artifact you need, fetch
# it, VERIFY ITS CHECKSUM, and put it on your PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/Komdosh/kom-net/main/install.sh | sh
#
# Options (env or flag):
#   KOMNET_VERSION=v0.2.0        install a specific release        (--version)
#   KOMNET_INSTALL_DIR=~/bin     where to put the binary           (--install-dir)
#   KOMNET_FROM_SOURCE=1         clone and build instead           (--from-source)
#
# It never uses sudo, never edits your shell rc files, and never asks for a
# token — while the repository is private it delegates to your existing git and
# gh credentials.

set -eu

REPO="Komdosh/kom-net"
BIN_NAME="komnet"
INSTALL_DIR="${KOMNET_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${KOMNET_VERSION:-latest}"
FROM_SOURCE="${KOMNET_FROM_SOURCE:-0}"

say() { printf '%s\n' "$*"; }
err() { printf 'error: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version)      VERSION="${2:?--version needs a value}"; shift 2 ;;
    --install-dir)  INSTALL_DIR="${2:?--install-dir needs a value}"; shift 2 ;;
    --from-source)  FROM_SOURCE=1; shift ;;
    -h|--help)      sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)              die "unknown option: $1" ;;
  esac
done

# ---------------------------------------------------------------- platform

detect_target() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) os=darwin ;;
    Linux)  os=linux ;;
    MINGW*|MSYS*|CYGWIN*)
      die "Windows detected. Use the PowerShell installer:
  irm https://raw.githubusercontent.com/$REPO/main/install.ps1 | iex" ;;
    *) die "unsupported operating system: $os" ;;
  esac
  case "$arch" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64)  arch=x64 ;;
    *) die "unsupported architecture: $arch" ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

# ------------------------------------------------------------------ source

install_from_source() {
  say "Building kom-net from source."
  have git || die "git is required to build from source"
  have node || die "Node 26+ is required to build from source (https://nodejs.org)"

  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge 26 ] || die "Node 26+ required to build from source; found $(node -v)"

  have pnpm || die "pnpm is required to build from source: npm i -g pnpm"

  src="$(mktemp -d)"
  trap 'rm -rf "$src"' EXIT
  # Uses your existing git credentials — works while the repo is private, and
  # means this script never handles a token.
  git clone --quiet --depth 1 "https://github.com/$REPO.git" "$src/kom-net" \
    || git clone --quiet --depth 1 "git@github.com:$REPO.git" "$src/kom-net" \
    || die "could not clone $REPO — check your GitHub access"

  ( cd "$src/kom-net" && pnpm install --frozen-lockfile --silent && pnpm build ) \
    || die "build failed"

  mkdir -p "$INSTALL_DIR"
  # The CLI package is not built yet; fail honestly rather than install nothing.
  if [ ! -f "$src/kom-net/packages/cli/dist/bin.js" ]; then
    die "this revision has no CLI yet — @kom-net/cli is not implemented.
The protocol and core engine build and test cleanly; there is nothing to install."
  fi
  install -m 0755 "$src/kom-net/packages/cli/dist/bin.js" "$INSTALL_DIR/$BIN_NAME"
}

# ----------------------------------------------------------------- release

resolve_version() {
  [ "$VERSION" != "latest" ] && { printf '%s' "$VERSION"; return; }
  if have gh; then
    gh release view --repo "$REPO" --json tagName -q .tagName 2>/dev/null && return
  fi
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1
}

install_from_release() {
  have curl || die "curl is required"
  target="$(detect_target)"

  resolved="$(resolve_version || true)"
  [ -n "$resolved" ] || die "no published release found.
kom-net has not cut its first release yet. To build the current source instead:
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sh -s -- --from-source"

  archive="$BIN_NAME-$resolved-$target.tar.gz"
  base="https://github.com/$REPO/releases/download/$resolved"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  say "Downloading $archive"
  curl -fsSL "$base/$archive" -o "$tmp/$archive" || die "download failed: $base/$archive"
  curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || die "could not fetch SHA256SUMS"

  # Mandatory, never opt-in: this script installs software that then runs
  # continuously, so an unverified download is not acceptable.
  say "Verifying checksum"
  expected="$(grep " $archive\$" "$tmp/SHA256SUMS" | awk '{print $1}')"
  [ -n "$expected" ] || die "$archive is not listed in SHA256SUMS"

  if have sha256sum; then actual="$(sha256sum "$tmp/$archive" | awk '{print $1}')"
  elif have shasum;  then actual="$(shasum -a 256 "$tmp/$archive" | awk '{print $1}')"
  else die "need sha256sum or shasum to verify the download"
  fi

  [ "$expected" = "$actual" ] || die "CHECKSUM MISMATCH for $archive
  expected $expected
  actual   $actual
Refusing to install. This may indicate a corrupted download or tampering."

  tar -xzf "$tmp/$archive" -C "$tmp"
  [ -f "$tmp/$BIN_NAME" ] || die "archive did not contain $BIN_NAME"
  mkdir -p "$INSTALL_DIR"
  install -m 0755 "$tmp/$BIN_NAME" "$INSTALL_DIR/$BIN_NAME"
}

# -------------------------------------------------------------------- main

if [ "$FROM_SOURCE" = "1" ]; then install_from_source; else install_from_release; fi

"$INSTALL_DIR/$BIN_NAME" --version >/dev/null 2>&1 \
  || die "installed binary did not run: $INSTALL_DIR/$BIN_NAME"

say ""
say "kom-net installed to $INSTALL_DIR/$BIN_NAME"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  # Print the line rather than editing rc files: silently rewriting someone's
  # shell config is not a thing an installer should do.
  *) say ""
     say "$INSTALL_DIR is not on your PATH. Add it:"
     say "  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac

say ""
say "Next:  komnet init --repo <your-transport-repo-url>"
