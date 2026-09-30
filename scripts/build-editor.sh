#!/usr/bin/env bash
# Builds the Desiide desktop app from the VSCodium fork in editor/ (EDT-1).
#
#   scripts/build-editor.sh           build (reuses editor/vscode if it is at the pinned commit)
#   scripts/build-editor.sh --clean   re-fetch the upstream source first
#
# Output: editor/VSCode-<os>-<arch>/ (macOS: Desiide.app). ~7 min and ~8.5 GB on an M4 Pro;
# see the ide-editor-shell skill ("Building") for measured numbers.
#
# Follows the flow of VSCodium's dev/build.sh, which can't be used directly because it hard-codes
# the VSCodium branding variables. Differences: branding env below, versions pinned from the
# submodule tag (reproducible), and no CLI/REH/update builds.
set -euo pipefail

ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
EDITOR="${ROOT}/editor"
CLEAN="no"
[[ "${1:-}" == "--clean" ]] && CLEAN="yes"

[[ -f "${EDITOR}/build.sh" ]] || { echo "editor/ is empty: run 'git submodule update --init editor'" >&2; exit 1; }
for tool in git jq python3 curl unzip pnpm; do
  command -v "${tool}" > /dev/null || { echo "missing dependency: ${tool}" >&2; exit 1; }
done

# {{{ desiide-ai: packaged first, with the repo's own toolchain, and built into the app (EDT-2)
echo "Packaging desiide-ai"
( cd "${ROOT}" && pnpm --filter desiide-ai run package )
DESIIDE_AI_VSIX="${ROOT}/extensions/desiide-ai/desiide-ai.vsix"
# }}}

# {{{ platform
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
# }}}

# {{{ node: VSCodium's pinned version, not the repo root's
NODE_VERSION="$( tr -d '[:space:]v' < "${EDITOR}/.nvmrc" )"
if [[ "$( node -v 2> /dev/null )" != "v${NODE_VERSION}" ]]; then
  NODE_DIR="${HOME}/.cache/desiide/node-v${NODE_VERSION}-${NODE_OS}-${NODE_ARCH}"
  if [[ ! -x "${NODE_DIR}/bin/node" ]]; then
    echo "Downloading Node ${NODE_VERSION} to ${NODE_DIR}"
    mkdir -p "$( dirname "${NODE_DIR}" )"
    TARBALL="node-v${NODE_VERSION}-${NODE_OS}-${NODE_ARCH}.tar.gz"
    ( cd "$( dirname "${NODE_DIR}" )" \
      && curl -sfO "https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}" \
      && curl -sf "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " ${TARBALL}\$" | shasum -a 256 -c - \
      && tar xzf "${TARBALL}" && rm "${TARBALL}" )
  fi
  export PATH="${NODE_DIR}/bin:${PATH}"
fi
echo "node $( node -v )"
# }}}

# {{{ build environment
export APP_NAME="Desiide"
export BINARY_NAME="desiide"
export ORG_NAME="Desiide"
export GH_REPO_PATH="SaketMunda/desiide"
export ASSETS_REPOSITORY="SaketMunda/desiide"
export VSCODE_QUALITY="stable"
export CI_BUILD="no"
export SHOULD_BUILD="yes"
export SHOULD_BUILD_CLI="no"      # the Rust CLI is only needed for tunnels
export SHOULD_BUILD_REH="no"      # remote server builds: 1.0 scope
export SHOULD_BUILD_REH_WEB="no"
export DISABLE_UPDATE="yes"       # never poll VSCodium's update feed (privacy rule)
export VSCODE_SKIP_NODE_VERSION_CHECK="yes"
# A private npm cache: the build doesn't depend on (or write to) the user's ~/.npm.
export npm_config_cache="${HOME}/.cache/desiide/npm"

# Reproducible versions: the release version is the VSCodium release the fork is based on, pinned
# in a file (forks and submodule clones don't carry VSCodium's tags), not VSCodium's time-derived
# one. The source version is computed here (version.sh would otherwise `npm install -g` a checksum
# tool on machines without sha1sum).
RELEASE_VERSION="$( tr -d '[:space:]' < "${EDITOR}/patches/desiide/base-version" )"
export RELEASE_VERSION
BUILD_SOURCEVERSION="$( printf '%s\n' "${RELEASE_VERSION}" | shasum -a 1 | cut -d' ' -f1 )"
export BUILD_SOURCEVERSION
MS_COMMIT_PINNED="$( jq -r '.commit' "${EDITOR}/upstream/stable.json" )"
# }}}

cd "${EDITOR}"
set +u # VSCodium's scripts read unset variables (GITHUB_ENV, npm_config_arch, ...)

# {{{ upstream source: fetched once per pinned commit
if [[ "${CLEAN}" == "no" && -d vscode/.git && "$( git -C vscode rev-parse HEAD 2> /dev/null )" == "${MS_COMMIT_PINNED}" ]]; then
  echo "Reusing editor/vscode at ${MS_COMMIT_PINNED}"
  # Undo the previous run's patches and copied files (same as dev/build.sh -s).
  git -C vscode add .
  git -C vscode reset -q --hard HEAD
  rm -rf vscode/.build vscode/out*
  export MS_TAG MS_COMMIT
  MS_TAG="$( jq -r '.tag' upstream/stable.json )"
  MS_COMMIT="${MS_COMMIT_PINNED}"
else
  rm -rf vscode VSCode-*
  # shellcheck disable=SC1091
  . get_repo.sh
fi
# }}}

rm -rf "VSCode-darwin-${VSCODE_ARCH}" "VSCode-linux-${VSCODE_ARCH}"
# patches/desiide/apply.sh picks it up from here (a path under vscode/, as upstream's build expects).
mkdir -p vscode/.build/desiide
cp "${DESIIDE_AI_VSIX}" vscode/.build/desiide/desiide-ai.vsix
START=$( date +%s )
# shellcheck disable=SC1091
. version.sh
# shellcheck disable=SC1091
. build.sh
echo "Built ${APP_NAME} ${RELEASE_VERSION} in $(( ( $( date +%s ) - START ) / 60 )) min"
ls -d "${EDITOR}"/VSCode-*"${VSCODE_ARCH}"/* 2> /dev/null | head -3
