#!/usr/bin/env bash
# `mise run doctor`: this machine against what the repository says it needs,
# and the command that fixes each thing it lacks.
#
# It reads the pins rather than knowing them — mise.toml through
# scripts/mise_pin.sh, and the files that keep their own — and holds a machine
# to two tiers. **Required** is what working on this repository at all needs:
# a commit runs the hooks, a push runs the suite. A miss there fails. The rest
# belongs to one group (a platform, a maintainer's task) and only warns.
#
# It probes with mise's shims first on PATH, as the secret-scan hook puts
# them, and with mise's auto-install off: a shim installs a pin it lacks the
# first time it runs, and a check should report that rather than download it.
#
# The part above "This repository" is the same in every binding; below it is
# this one's list.
set -uo pipefail
cd "$(dirname "$0")/.."

shims="${MISE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mise}/shims"
[ -d "$shims" ] && PATH="$shims:$PATH"
export PATH MISE_AUTO_INSTALL=0

failed=0
fixes=()

have() { command -v "$1" > /dev/null 2>&1; }

# The first version-shaped string a command prints, or nothing.
version_of() { "$@" 2>&1 | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1; }

section() { printf '\n%s\n' "$1"; }

# row <ok 0|1> <required 0|1> <name> <detail> <fix>
row() {
  local mark='✓'
  if [ "$1" != 1 ]; then
    if [ "$2" = 1 ]; then mark='✗' && failed=1; else mark='!'; fi
    fixes+=("$5")
  fi
  printf '  %s %-30s %s\n' "$mark" "$3" "$4"
}

# tool <required> <name> <fix> <command> [args to print a version]
tool() {
  local required=$1 name=$2 fix=$3
  shift 3
  if have "$1"; then
    local found
    found=$(version_of "$@")
    row 1 "$required" "$name" "${found:-present}" "$fix"
  else
    row 0 "$required" "$name" missing "$fix"
  fi
}

# pin <required> <mise.toml key> <command> [version flag]
pin() {
  local required=$1 key=$2 command=$3 flag=${4:---version} wanted found
  wanted=$(bash scripts/mise_pin.sh "$key")
  found=$(have "$command" && version_of "$command" "$flag")
  if [ "$found" = "$wanted" ]; then
    row 1 "$required" "$command" "$wanted" 'mise install'
  else
    row 0 "$required" "$command" "${found:-missing}, wants $wanted" 'mise install'
  fi
}

# check <required> <name> <fix> <test...>
check() {
  local required=$1 name=$2 fix=$3
  shift 3
  if "$@" > /dev/null 2>&1; then row 1 "$required" "$name" '' "$fix"; else row 0 "$required" "$name" '' "$fix"; fi
}

hooks_installed() {
  local dir
  dir=$(git rev-parse --git-path hooks) || return 1
  grep -q pre-commit "$dir/pre-commit" 2> /dev/null && grep -q pre-commit "$dir/pre-push" 2> /dev/null
}

report() {
  if [ ${#fixes[@]} -eq 0 ]; then
    printf '\nEverything this repository asks for is here.\n'
    return
  fi
  printf '\nTo fix:\n'
  printf '%s\n' "${fixes[@]}" | awk '!seen[$0]++ { print "  " $0 }'
  if [ "$failed" = 1 ]; then
    printf '\n✗ is needed to work on this repository at all; ! only by the group it is in.\n'
  fi
}

windows=0
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) windows=1 ;; esac

# --- This repository ----------------------------------------------------------

# This repository installs the commit hook only: there is no pre-push stage.
hooks_installed() {
  local dir
  dir=$(git rev-parse --git-path hooks) || return 1
  grep -q pre-commit "$dir/pre-commit" 2> /dev/null
}

section required
pin 1 node node
# pnpm is package.json's packageManager, which pnpm switches to by itself.
pnpm_pin=$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' package.json)
pnpm_found=$(have pnpm && version_of pnpm --version)
row "$([ "$pnpm_found" = "$pnpm_pin" ] && echo 1 || echo 0)" 1 pnpm "${pnpm_found:-missing}${pnpm_found:+, }packageManager says $pnpm_pin" \
  'npm install -g pnpm   (it then follows packageManager)'
tool 1 tar 'your package manager: tar' tar --version
pin 1 aqua:jqlang/jq jq
pin 1 aqua:trufflesecurity/trufflehog trufflehog
if [ "$windows" = 1 ]; then
  tool 1 pre-commit 'pip install pre-commit' pre-commit --version
else
  pin 1 aqua:pre-commit/pre-commit pre-commit
fi
check 1 'hooks installed' 'pre-commit install' hooks_installed

section 'the engine (pnpm engine)'
check 0 'packages installed' 'pnpm install' test -d node_modules
check 0 'an engine fetched into engine/' 'pnpm engine' test -d engine
if [ -f engine/UNVERIFIED ]; then
  row 0 0 'a released engine' "engine/ is a tree's (UNVERIFIED)" 'pnpm engine   (without RIPPLE_ENGINE_TREE, for the pinned release)'
fi

section 'the browser pass (pnpm … browsers)'
playwright_cache="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
[ "$(uname -s)" = Darwin ] && playwright_cache="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/Library/Caches/ms-playwright}"
check 0 "Playwright's browsers" 'pnpm --filter @ripplefx/player exec playwright install --with-deps chromium firefox webkit' \
  bash -c "ls -d '$playwright_cache'/chromium-* '$playwright_cache'/firefox-* '$playwright_cache'/webkit-*"

report
exit "$failed"
