#!/usr/bin/env bash
# One-step setup of the Mercury recipients connector (mercury-mcp) on a Mac, for the Claude desktop app and Claude Code.
# Run from inside this repo:   bash setup-mercury.sh
# Safe to re-run: it rebuilds, re-registers, and lets you replace the saved token.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$REPO_DIR/packages/mercury/dist/cli.js"

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\n\033[31mStopped: %s\033[0m\n' "$1" >&2; exit 1; }

say "1/5  Checking this computer has what it needs..."
command -v node >/dev/null 2>&1 || fail "Node.js isn't installed. Download the LTS version from https://nodejs.org, install it, then run this again."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js is too old (version $NODE_MAJOR). Install the LTS version from https://nodejs.org, then run this again."

say "2/5  Downloading supporting software and building (1-2 minutes)..."
cd "$REPO_DIR"
npm ci --cache "${TMPDIR:-/tmp}/tc-mcp-npm-cache" --no-audit --no-fund
npm run build
[ -f "$CLI" ] || fail "The build finished but $CLI is missing."

say "3/5  Connecting it to Claude..."
node "$CLI" install claude-desktop
if command -v claude >/dev/null 2>&1; then node "$CLI" install claude-code; fi

if node "$CLI" check >/dev/null 2>&1; then
  read -r -p "A working Mercury token is already saved. Replace it? (y/N) " replace
  if [[ ! "$replace" =~ ^[yY] ]]; then
    say "Done. Fully quit Claude (Cmd+Q) and reopen it."
    exit 0
  fi
fi

say "4/5  Create the Mercury API token"
IP="$(node "$CLI" my-ip)" || fail "Couldn't look up this computer's public IP address."
printf '%s' "$IP" | pbcopy
echo "This computer's public IP is $IP (already copied to your clipboard)."
echo "Mercury is opening in your browser. There:"
echo "  1. Go to Settings > API Tokens and click to add a token."
echo "  2. Choose 'Read and Write' (needed to add recipients)."
echo "  3. When it asks for allowed IP addresses, paste $IP (Cmd+V)."
echo "  4. Copy the token Mercury shows you. It is shown only once."
open "https://app.mercury.com/settings/tokens"
read -r -p "Press Enter once you've copied the token"

say "5/5  Saving the token (it's checked first, then stored in your Keychain)..."
node "$CLI" set-token || fail "The token didn't work (see the message above). Run this again to retry."

say "Done. Fully quit Claude (Cmd+Q), reopen it, and ask: \"List our Mercury recipients.\""
