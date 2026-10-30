# chatgpt-ctl

CLI (+ optional Bun scraper) for **ChatGPT conversation history** stored in **PostgreSQL**.

- **`chatgpt-ctl`** — minimal Rust binary (no Bun, Chromium, rustc, or PostgreSQL client in the runtime closure)
- Shell **completions** installed with the package (bash / zsh / fish), plus DB-backed chat suggestions
- **NixOS module** for global install + optional local DB/schema
- Optional **watcher** (`bun run watch`) that scrapes chatgpt.com using a persistent Chromium profile

---

## Install `chatgpt-ctl` only on NixOS (global)

### 1. Flake input

```nix
# flake.nix
{
  inputs.chatgpt-ctl.url = "github:YOUR_USER/chatgpt-ctl";  # or path:./chatgpt-ctl

  outputs = { self, nixpkgs, chatgpt-ctl, ... }: {
    nixosConfigurations.yourHost = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        ./configuration.nix
        chatgpt-ctl.nixosModules.default
        {
          nixpkgs.overlays = [ chatgpt-ctl.overlays.default ];
        }
      ];
    };
  };
}
```

### 2. Module options

```nix
# configuration.nix (or a dedicated module)
{
  programs.chatgpt-ctl = {
    enable = true;

    # Optional: create role + database + apply schema via systemd oneshot
    # (starts services.postgresql if needed)
    database.ensureLocal = true;
    database.name = "chatgpt_history";
    database.user = "chatgpt";
    # database.passwordFile = "/run/secrets/chatgpt-db-password";  # optional

    # Default CHATGPT_DATABASE_URL for shells (socket peer auth when ensureLocal)
    # databaseUrl = "postgres://chatgpt@/chatgpt_history?host=/run/postgresql";
  };
}
```

Then:

```bash
sudo nixos-rebuild switch
chatgpt-ctl chats
chatgpt-ctl history current
```

Completions ship with the package (`share/bash-completion`, `share/zsh/site-functions`, …). With bash/zsh completion enabled they load automatically.

### 3. Package-only (no module)

```bash
# one-off
nix profile install github:YOUR_USER/chatgpt-ctl

# or in configuration.nix without the module:
environment.systemPackages = [ inputs.chatgpt-ctl.packages.${system}.chatgpt-ctl ];
```

If you already ran `nix run .#setup-db`, set `CHATGPT_DATABASE_URL` to that instance:

```bash
export CHATGPT_DATABASE_URL='postgres://chatgpt:chatgpt@127.0.0.1:5432/chatgpt_history'
# or socket:
export CHATGPT_DATABASE_URL='postgres://chatgpt@/chatgpt_history?host=/run/postgresql'
```

### 4. Build from this repo

```bash
nix build .#chatgpt-ctl          # root flake
nix build ./ctl#chatgpt-ctl      # ctl-only flake (no watcher inputs)
nix run .#chatgpt-ctl -- chats
```

Runtime of the result is only the binary + completions + `share/chatgpt-ctl/*.sql`.  
**Not** pulled in: Bun, Chromium, rustc, PostgreSQL server/client, GTK, etc.

---

## `ctl/flake.nix`

Standalone flake for the Rust CLI alone:

```bash
cd ctl
nix build
./result/bin/chatgpt-ctl --help
```

---

## CLI usage

```text
chatgpt-ctl chats [--limit N] [-q substring] [--refresh]
chatgpt-ctl send "message text" [--chat CHAT | --new-chat] [-f PATH]...  # focused, targeted, or new chat
chatgpt-ctl open [CHAT|current]              # UUID/title; new pane unless already open
chatgpt-ctl close <CHAT|INDEX>               # close by UUID/title or 0-based open-pane index
chatgpt-ctl new-chat                         # blank chat at / (no conversation UUID in URL)
chatgpt-ctl download-last-zip [DIRECTORY] [--extract-to DIR]  # download, optionally extract
chatgpt-ctl history [CHAT|current] [--all] [--follow] [--json]
chatgpt-ctl retry <CHAT> enable|disable      # auto-click the final Retry button per chat
chatgpt-ctl history                          # interactive; TAB completes titles/UUIDs from DB
chatgpt-ctl message <uuid>
chatgpt-ctl hook set|list|show|enable|disable|remove ...
chatgpt-ctl completions bash|zsh|fish|elvish|powershell
```

The generated shell completions include all CLI subcommands and options. Chat arguments also have
DB-backed suggestions available through the hidden `__complete-chat` helper; `open` and `history`
retain their interactive TAB-completion prompts when invoked without a chat argument. For Bash,
add this after sourcing the generated completion file to enable dynamic chat UUID suggestions:

```bash
# Preserve the generated clap completion function, then augment chat arguments.
if declare -f _chatgpt_ctl >/dev/null; then
  eval "$(declare -f _chatgpt_ctl | sed '1s/_chatgpt_ctl/_chatgpt_ctl_static/')"
fi
_chatgpt_ctl() {
  local cur prev words cword
  _init_completion || return
  case "${words[1]}" in
    open|history|retry|close)
      if (( cword == 2 )); then
        mapfile -t COMPREPLY < <(chatgpt-ctl __complete-chat "$cur" 2>/dev/null | cut -f1)
        (( ${#COMPREPLY[@]} )) && return
      fi ;;
    hook)
      if [[ "${words[2]}" =~ ^(set|show|enable|disable|remove)$ ]] && (( cword == 3 )); then
        mapfile -t COMPREPLY < <(chatgpt-ctl __complete-chat "$cur" 2>/dev/null | cut -f1)
        (( ${#COMPREPLY[@]} )) && return
      fi ;;
  esac
  _chatgpt_ctl_static "$@"
}
complete -o default -F _chatgpt_ctl chatgpt-ctl
```

After updating the binary, regenerate shell completion files or rebuild/reinstall the Nix package.

`CHAT` may be a UUID, a title substring, or `current` (most recently updated chat).
`open` without an argument and `history` without an argument provide interactive title/UUID autocomplete.

The browser-backed commands (`chats --refresh`, `open`, `new-chat`, and `send`) require Bun and the optional watcher.
Run them from the repository root, or set `CHATGPT_WATCHER=/absolute/path/to/src/index.ts`.
`CHATGPT_WATCHER_CONFIG` selects a non-default watcher config. For example:

```bash
chatgpt-ctl chats --refresh                 # fetch all sidebar chats and proper titles
chatgpt-ctl open "NixOS Wayland"            # unique title substring
chatgpt-ctl open                            # interactive title/UUID completion
chatgpt-ctl send "Review these files" -f ./notes.md -f ./src/main.rs
```

The watcher performs a full sidebar synchronization at startup and refreshes visible titles on every
watch tick, so renamed chats are updated in PostgreSQL. `chats --refresh` forces another full scan.

While `bun run watch` is running, it exposes a localhost control endpoint
(default `127.0.0.1:17381`). Each conversation is kept in its own Chromium tab/page:
`chatgpt-ctl open <CHAT>` focuses the existing page when that chat is already open,
or creates a new page and opens it otherwise. The watcher polls and persists messages,
Retry settings, and ZIP/build hooks independently in every open conversation page.
`chatgpt-ctl chats` marks every opened conversation with a cyan `●` and its 0-based
pane index. `chatgpt-ctl close <CHAT>` closes a pane by UUID or unique title substring;
`chatgpt-ctl close 0` closes the first currently opened conversation pane (indices follow
the order shown by `chats`). Closing the active pane focuses another open conversation,
or creates a blank ChatGPT page if none remain. `chatgpt-ctl send` submits into the currently focused browser tab by default. Use `--chat CHAT` to
send to a specific chat by UUID or title substring; if it is not already open, the watcher creates
a new pane for it. Sending focuses the destination pane. Browser tab focus is tracked from page
focus/visibility events, in addition to `open` and `send` commands.
`chatgpt-ctl new-chat` navigates that pane to ChatGPT's root URL (`/`), opening a blank composer. Set `CHATGPT_CTL_ADDR` for the CLI
or `CHATGPT_CTL_HOST` / `CHATGPT_CTL_PORT` for the watcher to override the address.
The interactive `open` prompt uses cached PostgreSQL chat titles and UUIDs for TAB completion.

`chatgpt-ctl download-last-zip [DIRECTORY]` asks the watcher to download the newest ZIP attachment
from the currently open conversation. With no directory it uses `[downloads].directory` from
`config.toml` (default `./var/downloads`). Add `--extract-to DIR` (alias `--unzip-to`) to
extract the downloaded archive into `DIR`; the original ZIP is kept. Relative paths are resolved
from the directory where you run `chatgpt-ctl`. Example:

```bash
chatgpt-ctl download-last-zip ./var/downloads --extract-to ./work/latest-project
```

`chatgpt-ctl send "message text" [--chat CHAT | --new-chat] [-f PATH]...` sends through the watcher's browser
context. Without `--chat`, it sends to the currently focused pane. With `--chat`, it resolves a
UUID or title substring and sends to that conversation, opening a new pane if necessary. Use
`--new-chat` (alias `--new`) to create a separate blank pane, send the first message, wait for
ChatGPT to assign the conversation UUID, and print that acquired UUID. The watcher immediately persists the acquired UUID and first visible messages to PostgreSQL,
so the new conversation is available to `chats`, `open`, and `history` without waiting for the
next poll. The `--chat` and `--new-chat` options are mutually exclusive. It can also send file
attachments without message text:

```bash
chatgpt-ctl send "Review this" -f ./src/main.rs
chatgpt-ctl send --chat "NixOS Wayland" "Check this fix"
chatgpt-ctl send --chat 6ae4c5ad-6410-83ed-abf0-7944c8969abf -f ./archive.zip
chatgpt-ctl send -f ./archive.zip
chatgpt-ctl send --new-chat "Start a new project and inspect this archive" -f ./archive.zip
chatgpt-ctl send --new "First message in a new chat"
```

### Per-chat automatic Retry button

Automatic retry clicking is configured independently from ZIP/build hooks and persisted in
PostgreSQL. The watcher checks the currently open conversation on each poll and, when enabled,
clicks the last visible button whose accessible name is exactly `Retry`. This targets the Retry
action at the end of the conversation (including the delivery-timeout alert shown in the supplied
ChatGPT page snapshot). A 30-second per-chat cooldown prevents repeated clicks if the UI keeps the
button visible after a click.

```bash
chatgpt-ctl retry "My project chat" enable
chatgpt-ctl retry "My project chat" disable
```

The command accepts a chat UUID or unique title substring. It can be used without configuring a
ZIP/build hook. The setting is stored in `chat_retry_settings` and takes effect on the next watcher
poll; no watcher restart is required. Automatic clicking only applies while the watcher is on that
conversation and a visible, enabled exact-name `Retry` button is present.

### Per-chat ZIP automation hooks

Hooks are managed dynamically by `chatgpt-ctl` and stored in PostgreSQL; no hook entries are
needed in `config.toml`, and changes are picked up by the running watcher on its next poll.

```bash
chatgpt-ctl hook set "My project chat" --folder ~/src/my-project
chatgpt-ctl hook set "My Rust chat" --folder ~/src/my-project --child-folder rust-edge-gui --nix-flake
chatgpt-ctl hook list
chatgpt-ctl hook show "My project chat"
chatgpt-ctl hook run "My project chat"      # manually use the newest ZIP already in that chat
chatgpt-ctl hook disable "My project chat"  # keep configuration, pause automation
chatgpt-ctl hook enable "My project chat"
chatgpt-ctl hook remove "My project chat"
```

`--folder` is resolved and stored as an absolute path. `--child-folder` defaults to `.`;
`--nix-flake` runs `nix develop <build-dir> -c wcc build`. The clipboard command defaults to
`wl-paste -n`; override it with `--clipboard-command xclip --clipboard-arg -selection
--clipboard-arg clipboard --clipboard-arg -o` (repeat `--clipboard-arg` for each argument).

When a conversation pane is opened or navigated to, the watcher scrolls to the bottom, waits for
the composer and conversation UI to hydrate, and requires several consecutive stable message-list
snapshots with no active generation. It then persists the existing history and records the latest
assistant turn and all existing ZIP controls as a baseline; this initialization never runs a hook.
After initialization, automatic processing is restricted to a ZIP control whose stable message UUID
belongs to the latest assistant message, whose turn number is newer than the baseline, and whose
message has just completed. Historical ZIP links revealed by scrolling, revisiting, or editing older
turns are therefore ignored. ZIP controls without stable message/turn metadata fail closed rather
than triggering automation. Run `chatgpt-ctl hook run <chat>` (also available as `hook trigger`) to
manually download the newest ZIP attachment in that conversation and run the same extraction, Git
commit, and build pipeline immediately. The command opens the specified chat in the active watcher
pane if needed. Manual runs also work while a hook is disabled; disabling only pauses automatic
processing of new attachments. Each new ZIP is saved under
`<folder>/.chatgpt-ctl-downloads/`, checked for path-traversal entries, and extracted into
`folder`. The hook stages only archive paths, commits the archive's Markdown diff as the commit
message (or `Auto update` if no Markdown changes are present), then runs `wcc build` from
`child_folder` (or `.`). Set `nix_flake = true` to run the build inside that directory's Nix
flake dev shell. On build failure it reads the configured clipboard command (default
`wl-paste -n`) and sends that diagnostic to the hooked conversation.

The hook requires `unzip`, `git`, `wcc`, and, when `--nix-flake` is used, `nix` on the watcher's
`PATH`. The target folder must already be a Git repository with commit identity configured.

```bash
# static shell completion (also installed by the Nix package)
chatgpt-ctl completions zsh > ~/.zfunc/_chatgpt-ctl
```

---

## Optional: Bun watcher (scraper)

Only needed if you scrape chatgpt.com into the same DB. **Not** required for the global `chatgpt-ctl` install.

```bash
nix develop .#watcher          # Bun + tools; no Chromium package (use your profile binary)
# config.toml:
#   [browser]
#   executable_path = "/home/YOU/.nix-profile/bin/chromium-regular"

bun install
bun run login                  # normal Chromium → var/chatgpt-profile
bun run migrate                # or rely on NixOS module schema service
bun run watch                  # persist messages when streaming completes
```

Login uses a **non-Playwright** Chromium process with `--user-data-dir` so Google/OpenAI cookies land in the profile; `watch` reuses it via `launchPersistentContext`.

---

## Layout

| Path | Purpose |
|------|---------|
| `ctl/` | Rust `chatgpt-ctl` source + `ctl/flake.nix` |
| `modules/chatgpt-ctl.nix` | NixOS module (`programs.chatgpt-ctl`) |
| `flake.nix` | Package, overlay, nixosModule, setup-db/flush-db apps |
| `sql/` | `schema.sql` / `flush.sql` (also under `$out/share/chatgpt-ctl/`) |
| `src/` | Optional Bun/Playwright watcher |
| `config.toml` | Watcher config |

---

## Database (already set up)

If you previously ran `nix run .#setup-db`, the module’s `database.ensureLocal` is optional — point `CHATGPT_DATABASE_URL` at that instance and install only the package:

```nix
programs.chatgpt-ctl.enable = true;
programs.chatgpt-ctl.database.ensureLocal = false;
programs.chatgpt-ctl.databaseUrl =
  "postgres://chatgpt:chatgpt@127.0.0.1:5432/chatgpt_history";
```

## ZIP download selection fix (2026-10-30)

The `download-last-zip` watcher checks ancestor conversation metadata for turn
numbers, logs detected ZIP candidates, and prefers candidates with a known
conversation turn over unpositioned resource-card attachments. This prevents
an uploaded ZIP card without turn metadata from overriding an assistant
attachment whose conversation position is known.
\n
## Watch hook repair (2026-10-30)

The automatic ZIP hook now shares the same `findZipTargets` and
`downloadZipTarget` helpers as the manual `download-last-zip` command. ZIP
attachments are de-duplicated using their containing message ID and filename,
and existing attachments are marked as the initial baseline when a hook starts.


## Conversation loading and hook safety (2026-10-31)

Every pane now has an initialization barrier: navigate, scroll to the bottom, wait for the composer
and message list to hydrate, then wait for three consecutive stable snapshots while generation is
idle. The watcher persists this snapshot and establishes the per-chat hook baseline before processing
any automation. Hook candidates must be the newest completed assistant message and have a stable
turn number greater than the initialization baseline. This prevents historical ZIP links that appear
when scrolling through or editing older messages from being clicked by automatic hooks.
