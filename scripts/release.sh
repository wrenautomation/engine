#!/bin/sh
# One version for every package: set it, commit, push main, tag on GitHub. The tag publishes (release.yml).
# Shared checkout: other sessions' uncommitted files are theirs, so only the package.json files must be clean.
# The tag goes through the GitHub API: an SSH tag push hangs.
set -e
v="$1"
[ -n "$v" ] || { echo "usage: pnpm release <version>"; exit 2; }
files="package.json $(ls packages/*/package.json | tr '\n' ' ')"
# shellcheck disable=SC2086
git diff --quiet -- $files && git diff --cached --quiet -- $files || { echo "a package.json has uncommitted changes"; exit 1; }
for f in $files; do (cd "$(dirname "$f")" && npm pkg set version="$v"); done
# shellcheck disable=SC2086
if command -v peers >/dev/null; then echo $files | xargs peers commit -m "v$v"; else git commit -q -m "v$v" -- $files; fi
git push -q origin HEAD:main
gh api "repos/wrenautomation/engine/git/refs" -f ref="refs/tags/v$v" -f sha="$(git rev-parse HEAD)" --jq .ref
echo "released v$v: main pushed, tag made; release.yml publishes"
