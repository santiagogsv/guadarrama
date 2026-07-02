#!/usr/bin/env bash
set -euo pipefail

bun scripts/build-stops.mjs
zola build
