#!/usr/bin/env bash
# Installs each release asset from scripts/package-app.sh the way a user would, then runs the
# first-launch suite (desiide-ai test:app) against the installed app (REL-1: "launchable").
#
#   scripts/smoke-app.sh <version> [dist-dir]      dist-dir defaults to dist/app
#
# Linux: needs a display (run under xvfb-run); the .deb is installed only if passwordless sudo works.
set -euo pipefail

ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
VERSION="${1:?usage: scripts/smoke-app.sh <version> [dist-dir]}"
DIST="$( cd "${2:-${ROOT}/dist/app}" && pwd )"
# shellcheck source=scripts/lib/editor-env.sh
. "${ROOT}/scripts/lib/editor-env.sh"
WORK="$( mktemp -d )"
trap 'rm -rf "${WORK}"' EXIT

first_launch() { # <asset label> <app binary>
  echo "== first launch from the ${1}: ${2}"
  DESIIDE_APP_PATH="${2}" pnpm --dir "${ROOT}" -F desiide-ai test:app
}

smoke_macos() {
  local name="Desiide-${VERSION}-darwin-${VSCODE_ARCH}"

  hdiutil attach -nobrowse -readonly -mountpoint "${WORK}/dmg" "${DIST}/${name}.dmg" > /dev/null
  [[ -L "${WORK}/dmg/Applications" ]] || { echo "${name}.dmg has no Applications link" >&2; exit 1; }
  ditto "${WORK}/dmg/Desiide.app" "${WORK}/from-dmg/Desiide.app"
  hdiutil detach "${WORK}/dmg" > /dev/null
  # Quarantine it like a browser download, then take the first-launch step from the release notes.
  xattr -w com.apple.quarantine "0083;$( printf %x "$( date +%s )" );Safari;" "${WORK}/from-dmg/Desiide.app"
  xattr -dr com.apple.quarantine "${WORK}/from-dmg/Desiide.app"
  codesign --verify --deep --strict "${WORK}/from-dmg/Desiide.app"
  first_launch dmg "${WORK}/from-dmg/Desiide.app/Contents/MacOS/Desiide"

  ditto -x -k "${DIST}/${name}.zip" "${WORK}/from-zip"
  first_launch zip "${WORK}/from-zip/Desiide.app/Contents/MacOS/Desiide"
}

smoke_linux() {
  local name="Desiide-${VERSION}-linux-${VSCODE_ARCH}" appimage="Desiide-${VERSION}-linux-x86_64.AppImage" bin before after

  tar -xzf "${DIST}/${name}.tar.gz" -C "${WORK}"
  first_launch tar.gz "${WORK}/${name}/desiide"

  cp "${DIST}/${appimage}" "${WORK}/" && chmod +x "${WORK}/${appimage}"
  ( cd "${WORK}" && "./${appimage}" --appimage-extract > /dev/null )
  first_launch AppImage "${WORK}/squashfs-root/AppRun"

  if ! sudo -n true 2> /dev/null; then
    echo "== skipping the .deb: needs passwordless sudo"
    return
  fi
  # Privacy rule: installing must not register Microsoft's VS Code apt repo. CI images already carry
  # other Microsoft sources, so compare before and after.
  before="$( grep -rl 'packages.microsoft.com/repos/code' /etc/apt 2> /dev/null | sort || true )"
  sudo apt-get install -y "${DIST}/${name}.deb"
  after="$( grep -rl 'packages.microsoft.com/repos/code' /etc/apt 2> /dev/null | sort || true )"
  [[ "${before}" == "${after}" ]] || { echo "the .deb registered Microsoft's apt repo: ${after}" >&2; exit 1; }
  bin="/usr/share/desiide/desiide" # upstream's deb layout: /usr/share/<applicationName>/
  [[ -x "${bin}" ]] || { echo "the .deb didn't install ${bin}:" >&2; dpkg -L desiide | head -20 >&2; exit 1; }
  first_launch deb "${bin}"
  sudo apt-get remove -y desiide > /dev/null
}

case "${OS_NAME}" in
  osx) smoke_macos ;;
  linux) smoke_linux ;;
esac
echo "== every ${OS_NAME} asset launched"
