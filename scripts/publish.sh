#!/bin/sh
# Publish each package at the tag's version, dependencies first. `pnpm pack` turns `workspace:*`
# into the exact version; `npm publish` of the tarball uses trusted publishing (no token). A
# version already on npm is skipped, so a rerun finishes a half-done release.
set -e
v="$(node -p 'require("./package.json").version')"
if [ -n "$GITHUB_REF_NAME" ] && [ "$GITHUB_REF_NAME" != "v$v" ]; then
  echo "tag $GITHUB_REF_NAME is not v$v"; exit 1
fi
mkdir -p .pack
for name in models raven falcon weaver orrery; do
  dir="packages/$name"
  pkg="$(node -p "require('./$dir/package.json').name")"
  if npm view "$pkg@$v" version >/dev/null 2>&1; then echo "$pkg@$v is on npm"; continue; fi
  tgz="$(cd "$dir" && pnpm pack --pack-destination ../../.pack | tail -1)"
  npm publish "$tgz" --access public
done
