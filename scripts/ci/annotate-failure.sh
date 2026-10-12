#!/usr/bin/env bash
# Posts the end of a failed step's log as one GitHub annotation (REL-1). Annotations are readable
# without signing in, unlike job logs, so anyone can see why a public release build failed.
#
#   scripts/ci/annotate-failure.sh <title> <log file> [lines]
set -euo pipefail

TITLE="${1:?usage: annotate-failure.sh <title> <log file> [lines]}"
LOG="${2:?usage: annotate-failure.sh <title> <log file> [lines]}"
LINES="${3:-60}"
[[ -f "${LOG}" ]] || exit 0

case "${OSTYPE}" in
  darwin*) memory="$(( $( sysctl -n hw.memsize ) / 1024 / 1024 )) MB RAM, $( sysctl -n hw.ncpu ) CPUs" ;;
  *) memory="$( free -m | awk '/^Mem:/ { print $2 " MB RAM" }' ), $( nproc ) CPUs" ;;
esac

# Workflow-command escaping: %, CR and LF (https://docs.github.com/actions/reference/workflow-commands).
body="$( { echo "${memory}; last ${LINES} lines of ${LOG##*/}:"; tail -n "${LINES}" "${LOG}"; } \
  | sed -e 's/\x1b\[[0-9;]*m//g' -e 's/%/%25/g' -e 's/\r/%0D/g' | awk '{ printf "%s%%0A", $0 }' )"
# Property values also escape `:` and `,`.
title="$( printf '%s' "${TITLE}" | sed -e 's/%/%25/g' -e 's/:/%3A/g' -e 's/,/%2C/g' )"
echo "::error title=${title}::${body}"
