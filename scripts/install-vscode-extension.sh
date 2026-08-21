#!/usr/bin/env bash
#
# Install this directory as a VS Code extension by copying it into the
# extensions folder. There is nothing to compile and nothing to download, so
# this works on a machine with no Node.js and no build tooling.
#
# Usage:  ./scripts/install-vscode-extension.sh [--target code|code-insiders|cursor|windsurf]

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="code"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="${2:?--target needs a value}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$TARGET" in
  code)          EXT_DIR="$HOME/.vscode/extensions" ;;
  code-insiders) EXT_DIR="$HOME/.vscode-insiders/extensions" ;;
  cursor)        EXT_DIR="$HOME/.cursor/extensions" ;;
  windsurf)      EXT_DIR="$HOME/.windsurf/extensions" ;;
  *)
    echo "Unknown target '$TARGET' (expected code, code-insiders, cursor, or windsurf)" >&2
    exit 2
    ;;
esac

# Read name/publisher/version without needing jq or node.
read_field() {
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$SOURCE_DIR/package.json" | head -1
}

PUBLISHER="$(read_field publisher)"
NAME="$(read_field name)"
VERSION="$(read_field version)"
DEST="$EXT_DIR/$PUBLISHER.$NAME-$VERSION"

if [[ -z "$PUBLISHER" || -z "$NAME" || -z "$VERSION" ]]; then
  echo "Could not read publisher/name/version from package.json" >&2
  exit 1
fi

mkdir -p "$EXT_DIR"

# Clear any previous install of this extension, whatever publisher or version
# it carried. Leaving one behind means two copies activate at once and race for
# the same port — which is exactly what a publisher rename would cause.
shopt -s nullglob
for stale in "$EXT_DIR"/*."$NAME"-*; do
  [[ -d "$stale" ]] || continue
  echo "Removing previous install: $(basename "$stale")"
  rm -rf "$stale"
done
shopt -u nullglob

mkdir -p "$DEST"

cp -R \
  "$SOURCE_DIR/package.json" \
  "$SOURCE_DIR/extension.js" \
  "$SOURCE_DIR/inspector-panel.js" \
  "$SOURCE_DIR/server.js" \
  "$SOURCE_DIR/src" \
  "$SOURCE_DIR/media" \
  "$SOURCE_DIR/README.md" \
  "$DEST/"

echo "Installed to $DEST"
echo
echo "Next: fully restart $TARGET (reloading the window is not enough for a"
echo "newly installed extension), then run \"Gitpod Proxy: Start Proxy\" from"
echo "the command palette."
