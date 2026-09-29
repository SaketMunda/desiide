#!/usr/bin/env bash
# Typecheck + lint + test. Must be green before any task is called done.
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm -r typecheck
pnpm lint
pnpm test
