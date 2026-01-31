#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Installing dependencies..."
npm ci

echo "Building TypeScript..."
npm run build

echo "Starting mediator in production mode..."
NODE_ENV=production npm run start:prod


