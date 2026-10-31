#!/usr/bin/env sh
set -eu

BIN=${1:-${CHATGPT_CTL_BIN:-chatgpt-ctl}}
if [ ! -x "$BIN" ]; then
  printf 'chatgpt-ctl binary is not executable: %s\n' "$BIN" >&2
  printf 'Usage: %s /path/to/chatgpt-ctl\n' "$0" >&2
  exit 1
fi

ZDOTDIR=${ZDOTDIR:-$HOME}
DEST_DIR="$ZDOTDIR/.zfunc"
DEST="$DEST_DIR/_chatgpt-ctl"
mkdir -p "$DEST_DIR"
TMP="$DEST.tmp.$$"
trap 'rm -f "$TMP"' EXIT HUP INT TERM
"$BIN" completions zsh > "$TMP"
chmod 0644 "$TMP"
mv "$TMP" "$DEST"
trap - EXIT HUP INT TERM
printf 'Installed zsh completion: %s\n' "$DEST"
printf '\nEnsure ~/.zshrc contains:\n'
printf '  fpath=("${ZDOTDIR:-$HOME}/.zfunc" $fpath)\n'
printf '  autoload -Uz compinit && compinit\n'
printf '\nThen reload: rm -f "${ZDOTDIR:-$HOME}"/.zcompdump*; exec zsh\n'
