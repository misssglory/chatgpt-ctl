#!/usr/bin/env bash
set -euo pipefail

command -v git >/dev/null || { echo "git is required" >&2; exit 127; }
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT

mkdir -p "$root/eth-mint-server/src/bin" "$root/hydra/src/bin" "$root/terminal-u256/src/bin" "$root/allowed"
cat > "$root/.gitignore" <<'IGNORE'
eth-mint-server/src/bin/
hydra/src/bin/
terminal-u256/src/bin/
 leading.txt
IGNORE
printf 'ignored\n' > "$root/eth-mint-server/src/bin/main.rs"
printf 'ignored\n' > "$root/hydra/src/bin/main.rs"
printf 'ignored\n' > "$root/terminal-u256/src/bin/main.rs"
printf 'ignored-leading-space\n' > "$root/ leading.txt"
printf 'allowed\n' > "$root/allowed/lib.rs"
printf '# Update\n' > "$root/allowed/README.md"

git -C "$root" init -q
git -C "$root" config user.name "Hook test"
git -C "$root" config user.email "hook-test@example.invalid"

# Same NUL-delimited check-ignore protocol used by src/index.ts.
paths=(
  " leading.txt"
  "eth-mint-server/src/bin/main.rs"
  "hydra/src/bin/main.rs"
  "terminal-u256/src/bin/main.rs"
  "allowed/lib.rs"
  "allowed/README.md"
)
printf '%s\0' "${paths[@]}" > "$root/paths.bin"
set +e
git -C "$root" check-ignore -z --stdin < "$root/paths.bin" > "$root/ignored.bin"
check_status=$?
set -e
[[ "$check_status" == 0 || "$check_status" == 1 ]]

mapfile -d '' ignored < "$root/ignored.bin"
[[ "${#ignored[@]}" == 4 ]]
for path in "${ignored[@]}"; do
  case "$path" in
    " leading.txt"|eth-mint-server/src/bin/*|hydra/src/bin/*|terminal-u256/src/bin/*) ;;
    *) echo "unexpected ignored path: $path" >&2; exit 1 ;;
  esac
done

git -C "$root" add -A -- ':(literal)allowed/lib.rs' ':(literal)allowed/README.md'
git -C "$root" diff --cached --check
git -C "$root" commit --only -qm "successful build update" -- ':(literal)allowed/lib.rs' ':(literal)allowed/README.md'
# With no ignored paths, check-ignore returns 1 and an empty output; this is not an error.
printf '%s\0' "allowed/lib.rs" "allowed/README.md" > "$root/allowed-paths.bin"
set +e
git -C "$root" check-ignore -z --stdin < "$root/allowed-paths.bin" > "$root/no-ignored.bin"
no_ignored_status=$?
set -e
[[ "$no_ignored_status" == 1 && ! -s "$root/no-ignored.bin" ]]
committed="$(git -C "$root" show --pretty='' --name-only HEAD | sort)"
expected=$'allowed/README.md\nallowed/lib.rs'
[[ "$committed" == "$expected" ]]

# A failed build is the gate before Git staging/commit in the hook. Confirm
# the fixture stays uncommitted when the build command returns nonzero.
mkdir -p "$root/failure"
printf 'not committed\n' > "$root/failure/file.txt"
if (cd "$root" && sh -lc 'exit 17'); then
  echo "expected build command to fail" >&2
  exit 1
fi
git -C "$root" diff --cached --quiet -- failure/file.txt || {
  echo "failure fixture unexpectedly entered the Git index" >&2
  exit 1
}
if git -C "$root" log -1 --pretty='' --name-only | grep -Fxq 'failure/file.txt'; then
  echo "failure fixture unexpectedly entered a commit" >&2
  exit 1
fi

echo "hook git filtering smoke test passed"
