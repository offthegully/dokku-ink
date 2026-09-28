#!/bin/sh
# dokku-ink installer — downloads a self-contained binary (no Node/Bun needed).
#
#   curl -fsSL https://raw.githubusercontent.com/offthegully/dokku-ink/main/install.sh | sh
#
# Overrides (env vars):
#   DOKKU_INK_VERSION      tag to install (default: latest release)
#   DOKKU_INK_INSTALL_DIR  where to put the binary (default: /usr/local/bin,
#                          falling back to $HOME/.local/bin if not writable)
set -eu

REPO="offthegully/dokku-ink"
BIN_NAME="dokku-ink"

err() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$1" >&2; }

# --- detect platform -------------------------------------------------------
os="$(uname -s)"
case "$os" in
  Linux)  os="linux" ;;
  Darwin) os="darwin" ;;
  *) err "unsupported OS: $os (only Linux and macOS have prebuilt binaries)" ;;
esac

arch="$(uname -m)"
case "$arch" in
  x86_64 | amd64)  arch="x64" ;;
  aarch64 | arm64) arch="arm64" ;;
  *) err "unsupported architecture: $arch" ;;
esac

asset="${BIN_NAME}-${os}-${arch}"

# --- resolve download URL --------------------------------------------------
if [ -n "${DOKKU_INK_VERSION:-}" ]; then
  base="https://github.com/${REPO}/releases/download/${DOKKU_INK_VERSION}"
else
  base="https://github.com/${REPO}/releases/latest/download"
fi
url="${base}/${asset}"

# --- pick a downloader -----------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  download() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  download() { wget -qO "$2" "$1"; }
else
  err "need curl or wget to download the binary"
fi

# --- download --------------------------------------------------------------
tmp="$(mktemp)"
sums="$(mktemp)"
trap 'rm -f "$tmp" "$sums"' EXIT

info "downloading ${asset} (${DOKKU_INK_VERSION:-latest})"
download "$url" "$tmp" || err "download failed: $url
(has a release with prebuilt binaries been published yet?)"

# --- verify checksum -------------------------------------------------------
# Releases before checksums were added have no SHA256SUMS; install those on
# HTTPS alone. Once the file exists, the binary must be listed and match.
if download "${base}/SHA256SUMS" "$sums" 2>/dev/null; then
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$tmp" | cut -d' ' -f1)"
  else
    actual=""
  fi
  if [ -n "$actual" ]; then
    expected="$(awk -v a="$asset" '$2 == a || $2 == "*"a { print $1 }' "$sums")"
    [ -n "$expected" ] || err "SHA256SUMS doesn't list ${asset}"
    [ "$expected" = "$actual" ] || err "checksum mismatch for ${asset}
  expected ${expected}
  got      ${actual}"
    info "checksum verified"
  else
    info "no sha256sum/shasum found; skipping checksum"
  fi
fi

# --- install into the first directory that accepts it ----------------------
# Tries, in order: the requested dir directly; the same dir via sudo (only for
# the default /usr/local/bin); then ~/.local/bin. Each attempt is allowed to
# fail (permission, no tty for sudo, unset HOME) and move on, so a sudo denial
# or headless run falls back instead of aborting.
requested="${DOKKU_INK_INSTALL_DIR:-/usr/local/bin}"

move_into() { # move_into <dir> <sudo-prefix> ; nonzero on any failure
  _dir="$1"
  _pfx="$2"
  [ -n "$_dir" ] || return 1
  $_pfx mkdir -p "$_dir" 2>/dev/null || return 1
  $_pfx install -m 755 "$tmp" "${_dir}/${BIN_NAME}" 2>/dev/null || return 1
}

dest=""
if move_into "$requested" ""; then
  dest="${requested}/${BIN_NAME}"
elif [ "$requested" = "/usr/local/bin" ]; then
  if command -v sudo >/dev/null 2>&1 && move_into "$requested" "sudo"; then
    dest="${requested}/${BIN_NAME}"
  elif [ -n "${HOME:-}" ] && move_into "$HOME/.local/bin" ""; then
    dest="$HOME/.local/bin/${BIN_NAME}"
  fi
fi

if [ -z "$dest" ]; then
  err "couldn't write to ${requested} (permission denied) and no writable fallback was found.
Re-run pointing at a directory you own, e.g.:
  ... | DOKKU_INK_INSTALL_DIR=\"\$HOME/.local/bin\" sh"
fi

install_dir="$(dirname "$dest")"
info "installed to ${dest}"

installed_version="$("$dest" --version 2>/dev/null || echo "unknown")"
info "installed ${installed_version}"

# --- PATH hint -------------------------------------------------------------
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *)
    printf '\n\033[33mNote:\033[0m %s is not on your PATH.\n' "$install_dir" >&2
    printf 'Add this to your shell profile (~/.bashrc, ~/.zshrc):\n\n' >&2
    printf '  export PATH="%s:$PATH"\n\n' "$install_dir" >&2
    ;;
esac

info "done — run '${BIN_NAME} --help' to get started (and '${BIN_NAME} update' to upgrade later)"
