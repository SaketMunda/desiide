#!/usr/bin/env bash
# Packages the app built by scripts/build-editor.sh into release assets (REL-1).
#
#   scripts/package-app.sh <version> [out-dir]      out-dir defaults to dist/app
#
# macOS: Desiide-<version>-darwin-<arch>.dmg and .zip
# Linux: Desiide-<version>-linux-x64.tar.gz and .deb, Desiide-<version>-linux-x86_64.AppImage
#
# Builds are unsigned (Developer ID signing is 1.0 scope); the release notes carry the first-launch
# step. Checksums are written by the release job over every platform's assets (SHA256SUMS).
set -euo pipefail

ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
VERSION="${1:?usage: scripts/package-app.sh <version> [out-dir]}"
OUT="${2:-${ROOT}/dist/app}"
# shellcheck source=scripts/lib/editor-env.sh
. "${ROOT}/scripts/lib/editor-env.sh"

mkdir -p "${OUT}"
OUT="$( cd "${OUT}" && pwd )"
BUILD_DIR="${EDITOR}/VSCode-$( [[ "${OS_NAME}" == "osx" ]] && echo darwin || echo linux )-${VSCODE_ARCH}"
[[ -d "${BUILD_DIR}" ]] || { echo "${BUILD_DIR} not found: run scripts/build-editor.sh first" >&2; exit 1; }

package_macos() {
  local app="${BUILD_DIR}/Desiide.app" name="Desiide-${VERSION}-darwin-${VSCODE_ARCH}" stage attempt
  # Ad-hoc signature, not a Developer ID one: packaging edits Info.plist after Electron's own ad-hoc
  # signature, and Apple silicon refuses to run code whose signature doesn't match. Gatekeeper still
  # quarantines the download, hence the first-launch step in the release notes.
  codesign --force --deep --sign - "${app}"
  codesign --verify --deep --strict "${app}"

  # ditto, not zip: keeps the frameworks' symlinks and extended attributes intact.
  ditto -c -k --sequesterRsrc --keepParent "${app}" "${OUT}/${name}.zip"

  stage="$( mktemp -d )"
  ditto "${app}" "${stage}/Desiide.app"
  ln -s /Applications "${stage}/Applications"
  # hdiutil intermittently fails with "Resource busy" on CI runners; retrying is the usual fix.
  for attempt in 1 2 3; do
    if hdiutil create -volname "Desiide" -srcfolder "${stage}" -fs HFS+ -format UDZO -ov \
      "${OUT}/${name}.dmg"; then
      break
    fi
    [[ "${attempt}" == 3 ]] && { echo "hdiutil failed 3 times" >&2; exit 1; }
    sleep 10
  done
  rm -rf "${stage}"
}

# appimagetool and its runtime, pinned and checksum-verified (digests match GitHub's release assets).
APPIMAGETOOL_URL="https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage"
APPIMAGETOOL_SHA256="ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0"
APPIMAGE_RUNTIME_URL="https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64"
APPIMAGE_RUNTIME_SHA256="2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d"

fetch_verified() { # <url> <sha256> <dest>
  [[ -f "$3" ]] && echo "$2  $3" | sha256sum -c --quiet - 2> /dev/null && return 0
  curl -sfL -o "$3" "$1"
  echo "$2  $3" | sha256sum -c --quiet - || { rm -f "$3"; echo "checksum mismatch: $1" >&2; exit 1; }
}

package_linux() {
  local name="Desiide-${VERSION}-linux-${VSCODE_ARCH}" deb postinst tools appdir

  [[ "${VSCODE_ARCH}" == "x64" ]] || { echo "Linux packages are x64 only (Alpha)" >&2; exit 1; }

  # tar.gz with a top-level folder, so extracting doesn't spill into the current directory.
  tar -C "${EDITOR}" --transform "s|^VSCode-linux-${VSCODE_ARCH}|${name}|" \
    -czf "${OUT}/${name}.tar.gz" "VSCode-linux-${VSCODE_ARCH}"

  # .deb: upstream's gulp tasks, run in the tree build-editor.sh prepared.
  use_editor_node
  rm -rf "${EDITOR}/vscode/.build/linux/deb"
  ( cd "${EDITOR}/vscode" \
    && npm run gulp "vscode-linux-${VSCODE_ARCH}-prepare-deb" \
    && npm run gulp "vscode-linux-${VSCODE_ARCH}-build-deb" )
  deb="$( find "${EDITOR}/vscode/.build/linux/deb" -name '*.deb' | head -1 )"
  # Privacy rule: the install script must never register Microsoft's apt repo (see apply.sh, step 4).
  postinst="$( mktemp -d )"
  dpkg-deb -e "${deb}" "${postinst}"
  grep -q 'desiide-never-adds-microsoft-repo' "${postinst}/postinst" \
    || { echo "${deb}: postinst may add Microsoft's apt repo; refusing to ship it" >&2; exit 1; }
  rm -rf "${postinst}"
  cp "${deb}" "${OUT}/${name}.deb"

  # AppImage: a plain AppDir around the build, launched through the app's own launcher script.
  tools="${HOME}/.cache/desiide/appimage"
  mkdir -p "${tools}"
  fetch_verified "${APPIMAGETOOL_URL}" "${APPIMAGETOOL_SHA256}" "${tools}/appimagetool"
  fetch_verified "${APPIMAGE_RUNTIME_URL}" "${APPIMAGE_RUNTIME_SHA256}" "${tools}/runtime-x86_64"
  chmod +x "${tools}/appimagetool"
  appdir="$( mktemp -d )/Desiide.AppDir"
  mkdir -p "${appdir}"
  cp -a "${BUILD_DIR}/." "${appdir}/usr/"
  cp "${BUILD_DIR}/resources/app/resources/linux/code.png" "${appdir}/desiide.png"
  cat > "${appdir}/desiide.desktop" << 'EOF'
[Desktop Entry]
Name=Desiide
Comment=AI-native code editor
GenericName=Text Editor
Exec=desiide %F
Icon=desiide
Type=Application
StartupNotify=false
StartupWMClass=Desiide
Categories=TextEditor;Development;IDE;
MimeType=text/plain;inode/directory;
EOF
  cat > "${appdir}/AppRun" << 'EOF'
#!/bin/sh
HERE="$( dirname "$( readlink -f "$0" )" )"
exec "${HERE}/usr/desiide" "$@"
EOF
  chmod +x "${appdir}/AppRun"
  # --appimage-extract-and-run: CI runners have no FUSE. No update information is embedded (and the CI
  # variables appimagetool would guess it from are unset), so nothing points the AppImage at an update
  # feed (privacy rule).
  env -u GITHUB_ACTIONS -u GITHUB_REPOSITORY -u GITHUB_REF -u TRAVIS ARCH=x86_64 "${tools}/appimagetool" --appimage-extract-and-run --runtime-file "${tools}/runtime-x86_64" \
    "${appdir}" "${OUT}/Desiide-${VERSION}-linux-x86_64.AppImage"
  rm -rf "$( dirname "${appdir}" )"
}

case "${OS_NAME}" in
  osx) package_macos ;;
  linux) package_linux ;;
esac
ls -l "${OUT}"
