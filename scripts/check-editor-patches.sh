#!/usr/bin/env bash
# Dry-runs Desiide's source patches (editor/patches/desiide/*.patch) against another upstream
# VS Code version, without a full checkout or build: it downloads only the files the patches touch.
#
#   scripts/check-editor-patches.sh 1.139.0
#
# Use it before bumping the VSCodium submodule. It checks our patches only; VSCodium's own patches
# are VSCodium's job, and the full build (scripts/build-editor.sh) is the final check.
set -euo pipefail

TAG="${1:?usage: scripts/check-editor-patches.sh <vscode-tag, e.g. 1.139.0>}"
ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
PATCHES="${ROOT}/editor/patches/desiide"
TMP="$( mktemp -d )"
trap 'rm -rf "${TMP}"' EXIT

git -C "${TMP}" init -q
FAILED=0
for patch in "${PATCHES}"/*.patch; do
  for file in $( sed -n 's|^+++ b/||p' "${patch}" ); do
    mkdir -p "${TMP}/$( dirname "${file}" )"
    curl -sf "https://raw.githubusercontent.com/microsoft/vscode/${TAG}/${file}" -o "${TMP}/${file}" \
      || { echo "✗ $( basename "${patch}" ): ${file} not found at ${TAG}"; FAILED=1; continue 2; }
  done
  if ( cd "${TMP}" && git apply --check --ignore-whitespace "${patch}" 2> /dev/null ); then
    echo "✓ $( basename "${patch}" ) applies to VS Code ${TAG}"
  else
    echo "✗ $( basename "${patch}" ) does not apply to VS Code ${TAG}: regenerate it (see editor/patches/desiide/README.md)"
    FAILED=1
  fi
done

# Built-in desiide-ai relies on upstream installing a local VSIX from product.json (apply.sh).
if curl -sf "https://raw.githubusercontent.com/microsoft/vscode/${TAG}/build/lib/builtInExtensions.ts" | grep -q 'vsix?: string'; then
  echo "✓ local-VSIX built-in extensions still supported at ${TAG}"
else
  echo "✗ build/lib/builtInExtensions.ts at ${TAG} no longer supports 'vsix': desiide-ai bundling needs a new approach"
  FAILED=1
fi
exit "${FAILED}"
