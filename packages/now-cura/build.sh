#!/bin/bash
set -euo pipefail

bridge_defs="$(dirname $(pwd))/now-node-bridge/src/bridge.ts"

cp -v "$bridge_defs" src

# build ts files
tsc

# use types.d.ts as the main types export
mv dist/types.d.ts dist/types
rm dist/*.d.ts
mv dist/types dist/index.d.ts

# bundle helpers.ts with ncc
rm dist/helpers.js
ncc build src/helpers.ts -o dist/helpers
mv dist/helpers/index.js dist/helpers.js
rm -rf dist/helpers

ncc build src/index.ts -o dist/main
mv dist/main/index.js dist/index.js
rm -rf dist/main
