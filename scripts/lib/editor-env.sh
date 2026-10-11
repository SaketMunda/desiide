#!/usr/bin/env bash
# Shared by scripts/build-editor.sh and scripts/package-app.sh. Sourced with ROOT set to the repo root.
#
# Exports OS_NAME (osx | linux) and VSCODE_ARCH (arm64 | x64), as VSCodium's scripts expect, and
# defines use_editor_node.

EDITOR="${ROOT}/editor"

case "${OSTYPE}" in
  darwin*) export OS_NAME="osx"; NODE_OS="darwin" ;;
  linux*) export OS_NAME="linux"; NODE_OS="linux" ;;
  *) echo "unsupported OS: ${OSTYPE} (Windows builds are 1.0 scope)" >&2; exit 1 ;;
esac
case "$( uname -m )" in
  arm64 | aarch64) export VSCODE_ARCH="arm64"; NODE_ARCH="arm64" ;;
  x86_64) export VSCODE_ARCH="x64"; NODE_ARCH="x64" ;;
  *) echo "unsupported arch: $( uname -m )" >&2; exit 1 ;;
esac

# Puts VSCodium's pinned Node (editor/.nvmrc), not the repo root's, first on PATH. When the current
# node differs, downloads that version once into ~/.cache/desiide/, verified against nodejs.org's
# SHASUMS256.txt.
use_editor_node() {
  local version dir tarball
  version="$( tr -d '[:space:]v' < "${EDITOR}/.nvmrc" )"
  if [[ "$( node -v 2> /dev/null )" != "v${version}" ]]; then
    dir="${HOME}/.cache/desiide/node-v${version}-${NODE_OS}-${NODE_ARCH}"
    if [[ ! -x "${dir}/bin/node" ]]; then
      echo "Downloading Node ${version} to ${dir}"
      mkdir -p "$( dirname "${dir}" )"
      tarball="node-v${version}-${NODE_OS}-${NODE_ARCH}.tar.gz"
      ( cd "$( dirname "${dir}" )" \
        && curl -sfO "https://nodejs.org/dist/v${version}/${tarball}" \
        && curl -sf "https://nodejs.org/dist/v${version}/SHASUMS256.txt" | grep " ${tarball}\$" | shasum -a 256 -c - \
        && tar xzf "${tarball}" && rm "${tarball}" )
    fi
    export PATH="${dir}/bin:${PATH}"
  fi
  echo "node $( node -v )"
}
