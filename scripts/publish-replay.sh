#!/usr/bin/env bash
# Publishes the static replay (web/dist-static) to the gh-pages branch so judges can
# click through a real overnight run with nothing installed.
# Needs: a running API (npm start), and a public repository (or a plan with private Pages).
set -euo pipefail
cd "$(dirname "$0")/.."
API="${1:-http://localhost:8787}"
node web/scripts/export-replay.mjs --api "$API"
npm run build:static -w web
OUT="$(mktemp -d)"
cp -R web/dist-static/. "$OUT/"
touch "$OUT/.nojekyll"
REMOTE="$(git remote get-url origin)"
(
  cd "$OUT"
  git init -q -b gh-pages
  git add -A
  git -c user.name="$(git -C "$OLDPWD" config user.name || echo nightlist)" -c user.email="$(git -C "$OLDPWD" config user.email || echo nightlist@example.com)" commit -q -m "Publish replay of a real overnight run"
  git push -q -f "$REMOTE" gh-pages
)
echo "Pushed gh-pages. Enable Pages for the gh-pages branch if it is not on yet:"
echo "  gh api -X POST repos/{owner}/{repo}/pages -f 'source[branch]=gh-pages' -f 'source[path]=/'"
