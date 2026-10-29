#!/bin/sh
# One version for every package: set it, commit, tag. Pushing the tag publishes (release.yml).
set -e
v="$1"
[ -n "$v" ] || { echo "usage: pnpm release <version>"; exit 2; }
git diff --quiet && git diff --cached --quiet || { echo "commit your work first"; exit 1; }
npm pkg set version="$v"
for p in packages/*/package.json; do (cd "${p%/package.json}" && npm pkg set version="$v"); done
git commit -q -m "v$v" -- package.json packages/*/package.json
git tag "v$v"
echo "tagged v$v; publish with: git push && git push origin v$v"
