#!/bin/sh
# One package's build, run from its folder. tsc writes dist.next, then dist swaps in at once:
# a CLI that runs from dist mid-build never finds it empty. Args: files under dist to mark executable.
set -e
rm -rf dist.next dist.old
tsc --outDir dist.next
for f in "$@"; do chmod +x "dist.next/$f"; done
[ -d dist ] && mv dist dist.old
mv dist.next dist
rm -rf dist.old
