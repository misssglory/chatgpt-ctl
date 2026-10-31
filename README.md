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
chatgpt-ctl close <CHAT|INDEX>               # close by UUID/title or 0-based chats index
chatgpt-ctl new-chat                         # open a blank chat in a separate pane
chatgpt-ctl download-last-zip [DIRECTORY] [--chat CHAT] [--extract-to DIR]  # virtual focus or routed chat
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

For **zsh without Nix**, build the Rust CLI and install completions directly from that binary:

```bash
cargo build --release --manifest-path ctl/Cargo.toml
./scripts/install-zsh-completion.sh ./ctl/target/release/chatgpt-ctl
```

Ensure `~/.zshrc` contains the following before starting a new shell:

```zsh
fpath=("${ZDOTDIR:-$HOME}/.zfunc" $fpath)
autoload -Uz compinit && compinit
```

Then refresh the completion cache and start a new shell:

```bash
rm -f "${ZDOTDIR:-$HOME}"/.zcompdump*
exec zsh
```

The completion file is regenerated from the current binary, supports
`chatgpt-ctl`, the short command name `ctl`, and executable paths ending in `chatgpt-ctl`
(such as `./ctl/target/release/chatgpt-ctl`). It completes all current subcommands and options,
uses directory completion for `hook set --folder` and `--child-folder`, and file/directory
completion for attachment and ZIP paths. Chat-taking arguments also query PostgreSQL for UUID
candidates and display their titles; this dynamic part needs a working `CHATGPT_DATABASE_URL`.

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
`chatgpt-ctl chats` marks every opened conversation with a cyan `●`. `chatgpt-ctl close <CHAT>`
closes a pane by UUID or unique title substring; `chatgpt-ctl close 0` resolves the first row
in the combined `chats` table and closes it when that chat is open. Numeric selectors use the
same stable order as the unfiltered `chats` listing. Closing the active pane focuses another open conversation,
or creates a blank ChatGPT page if none remain. `chatgpt-ctl send` submits into the virtual-focus chat by default. Use `--chat CHAT` to
send to a specific chat by UUID or title substring; if it is not already open, the watcher creates
a new pane for it. Sending focuses the destination pane. Browser tab focus is tracked from page
focus/visibility events, in addition to `open` and `send` commands.
`chatgpt-ctl new-chat` opens a separate browser pane at ChatGPT's root URL (`/`), leaving
existing conversation panes untouched. Set `CHATGPT_CTL_ADDR` for the CLI
or `CHATGPT_CTL_HOST` / `CHATGPT_CTL_PORT` for the watcher to override the address.
The interactive `open` prompt uses cached PostgreSQL chat titles and UUIDs for TAB completion.

`chatgpt-ctl download-last-zip [DIRECTORY]` asks the watcher to download the newest ZIP attachment
belonging to the latest assistant message in the virtual-focus conversation. Hook runs use the same
strict message-identity check and refuse to fall back to an older attachment when the latest assistant
message has no identifiable ZIP control. Pass `--chat CHAT` to route to a UUID, title, or chats index. With no directory it uses `[downloads].directory` from
`config.toml` (default `./var/downloads`). Add `--extract-to DIR` (alias `--unzip-to`) to
extract the downloaded archive into `DIR`; the original ZIP is kept. If the archive contains
exactly one top-level directory, its contents are merged directly into `DIR` (so no redundant
wrapper directory is created). Existing directories are merged recursively; files supplied by the
archive replace files at the same relative path, while unrelated existing files are preserved.
Relative paths are resolved from the directory where you run
`chatgpt-ctl`; `--extract-to` is marked as a directory argument for shell path completion. Example:

```bash
chatgpt-ctl download-last-zip ./var/downloads --extract-to ./work/latest-project
```

`chatgpt-ctl send "message text" [--chat CHAT | --new-chat] [-f PATH]... [--draft]` uses the watcher's browser
context. Without `--chat`, it sends to the virtual-focus pane. With `--chat`, it resolves a
UUID, title substring, or unfiltered chats index and sends to that conversation in its mapped
browser, opening a new pane if necessary. Use
`--new-chat` (alias `--new`) to create a separate blank pane, send the first message, wait for
ChatGPT to assign the conversation UUID, and print that acquired UUID. The watcher immediately persists the acquired UUID and first visible messages to PostgreSQL,
so the new conversation is available to `chats`, `open`, and `history` without waiting for the
next poll. The `--chat` and `--new-chat` options are mutually exclusive. It can also send file
attachments without message text. Add `--draft` (alias `--no-send`) to attach the files and fill the
composer without submitting; the draft remains editable in the selected browser pane. `--draft`
cannot be combined with `--new-chat` because ChatGPT does not assign a conversation UUID until a
message is submitted. Examples:

```bash
chatgpt-ctl send "Review this" -f ./src/main.rs
chatgpt-ctl send --chat "NixOS Wayland" "Check this fix"
chatgpt-ctl send --chat 6ae4c5ad-6410-83ed-abf0-7944c8969abf -f ./archive.zip
chatgpt-ctl send -f ./archive.zip
chatgpt-ctl send --new-chat "Start a new project and inspect this archive" -f ./archive.zip
chatgpt-ctl send --new "First message in a new chat"
chatgpt-ctl send --draft "Please inspect these files" -f ./src/main.rs -f ./project.zip
chatgpt-ctl send --chat "NixOS Wayland" --draft "Review this config" -f ./configuration.nix
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
chatgpt-ctl hook set "Docs chat" --folder ~/src/docs --child-folder website --build-command "bun run build"
chatgpt-ctl hook set "No build chat" --folder ~/src/docs --child-folder website --build-command none
chatgpt-ctl hook list
chatgpt-ctl hook show "My project chat"
chatgpt-ctl hook run                           # run against the virtual-focus chat
chatgpt-ctl hook run "My project chat"      # manually use the newest ZIP in a specific chat
chatgpt-ctl hook disable "My project chat"  # keep configuration, pause automation
chatgpt-ctl hook enable "My project chat"
chatgpt-ctl hook remove "My project chat"
```

`--folder` is resolved and stored as an absolute path. `--child-folder` defaults to `.`.
`--build-command` is a shell command executed with the child folder as its working directory;
it defaults to `wcc build`. Set it to `none` to skip the build step entirely. With
`--nix-flake`, the command runs inside `nix develop <build-dir> -c sh -lc <build-command>`.
The clipboard command defaults to
`wl-paste -n`; override it with `--clipboard-command xclip --clipboard-arg -selection
--clipboard-arg clipboard --clipboard-arg -o` (repeat `--clipboard-arg` for each argument).

When a conversation pane is opened or navigated to, the watcher scrolls to the bottom, waits for
the composer and conversation UI to hydrate, and requires several consecutive stable message-list
snapshots with no active generation. It then persists the existing history and records the latest
assistant turn, latest user turn/message, and all existing ZIP controls as a baseline; this
initialization never runs a hook. Automatic hooks additionally require a newly completed latest
assistant message and a genuinely new user turn beyond that baseline. Before clicking, the watcher
re-resolves the ZIP target by its message identity; if the target is no longer uniquely present or
Playwright does not report a download, it refuses to click a fallback button and skips the hook.
This is deliberately fail-closed to avoid accidental clicks while switching chats or editing old turns.
After initialization, automatic processing is restricted to a ZIP control whose stable message UUID
belongs to the latest assistant message, or whose stable turn number exactly matches that latest
assistant message when a DIL portal exposes a different ancestor UUID. The turn must be newer than
the baseline, and its assistant message must have just completed. Historical ZIP links revealed by
scrolling, revisiting, or editing older turns are therefore ignored. ZIP controls without stable
message/turn metadata fail closed rather than triggering automation. Run `chatgpt-ctl hook run [chat]` (also available as `hook trigger`) to
manually download the ZIP attached to the latest assistant message in that conversation and run the same extraction,
build, and Git commit pipeline immediately. It refuses to substitute an older attachment if the latest
assistant message has no ZIP. An explicit chat argument opens that chat in its owning browser pane
if needed; with no argument, the watcher uses the already selected virtual-focus page. Manual runs
also work while a hook is disabled; disabling only pauses automatic
processing of new attachments. Omitting the chat argument (or using `hook trigger`)
selects the conversation under virtual focus across all browser profiles. With no argument,
`chatgpt-ctl` does not need to open its own PostgreSQL connection; the running watcher resolves
virtual focus and returns the selected chat UUID. If virtual focus is on a blank/new-chat page
rather than a conversation, the watcher returns an explicit error instead of guessing another chat. Each new ZIP is saved under
`<folder>/.chatgpt-ctl-downloads/`, checked for path-traversal entries, and extracted into
`folder`. The configured `build_command` runs from `child_folder` (or `.`) before any Git staging
or commit. The default is `wcc build`; set `--build-command none` to skip building explicitly.
A nonzero build exit sends the diagnostic to the hooked conversation, keeps the extracted files for
inspection, and stops without staging or committing anything. After a successful build (or when
building is explicitly disabled), the hook stages only actual files supplied by the archive and
skips paths matched by the repository's `.gitignore` rules. It commits the archive's Markdown diff
as the commit message (or `Auto update` if no Markdown changes are present). `--nix-flake` runs
the configured build command inside that directory's Nix flake dev shell. Build failures read the
configured clipboard command (default `wl-paste -n`) and send that diagnostic to the hooked conversation.

The hook requires `unzip` and `git`; the configured build executable and, when `--nix-flake` is
used, `nix` must be on the watcher's `PATH`. The target folder must already be a Git repository with commit identity configured.

```bash
# Generate from the current binary; use the installer above for path + DB chat support.
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

Chromium launched by Playwright uses `chromiumSandbox = true` by default, so Playwright does not pass `--no-sandbox` and Chromium does not display its unsupported-flag warning. This can be changed in `[browser]` in `config.toml`; keep it enabled unless the host cannot provide a working Chromium sandbox.

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


## Multiple isolated browser accounts

The watcher now manages one Chromium profile per browser name while keeping a single
control server on the existing `127.0.0.1:17381` port. The existing
`[chatgpt].profile_dir` remains the `default` browser profile, so existing login
cookies and local storage are reused without moving the profile.

The existing profile is named `default`; `bun run login` creates/opens that profile.
Create another independently authenticated profile with:

```bash
bun run login --browser-name work
bun run login --browser-name research
```

Both `--browser-name name` and `--browser-name=name` are accepted. Stop the watcher
before logging into a profile that it currently has open; otherwise Chromium may refuse
to acquire the profile lock. After adding a new profile, restart `bun run watch` so it
can discover and attach to it.

Each command launches a normal Chromium window for ChatGPT. Sign into the account,
then close the window. Named profiles are stored beside the default profile in a
`<profile_dir>.profiles/<browser-name>/` directory. Browser names are lowercase
letters, digits, `_` or `-`; `default` is reserved for the original profile.

Start the watcher normally:

```bash
bun run watch
```

It discovers `default` and every named profile directory and attaches a separate
persistent Playwright context to each. Cookies, local storage, and browser session
state remain isolated. No browser-name option is needed for chat commands: a chat's
saved browser mapping determines where the command runs.

`chatgpt-ctl chats` now displays one combined table for all browser profiles (all rows by default; use `--limit N` to cap it), with
browser name, open/focused state, and a zero-based global row index. The index can be used
where a chat selector is accepted, for example `chatgpt-ctl open 0` or
`chatgpt-ctl send --chat 1 "message"`. Titles must resolve uniquely; duplicate
matches are reported with their browser names. `chatgpt-ctl chats --refresh` asks
the running watcher to refresh all profiles, avoiding a second Chromium process
trying to lock the same profile.

The watcher maintains a virtual focus shared across browser profiles. `open` sets
it to the requested chat; focusing or manually navigating to a conversation in any profile
updates it as well. Blank tabs and non-conversation pages do not steal the last-chat focus.
Commands
without an explicit chat target (such as `send` and `download-last-zip`) use that
virtual focus. `download-last-zip --chat CHAT` also accepts a UUID, title, or chats index
and opens/routs that target automatically. A chat-specific command (`open`, `send --chat`, `retry`, or `hook run`)
is dispatched to the profile associated with that chat.

Open conversation panes and virtual focus are persisted continuously (debounced) whenever
a tab is opened, navigated, focused, or closed—not only on **Ctrl+C**. The watcher also
forces a final checkpoint on Ctrl+C/SIGTERM. On the next `bun run watch`, it reopens those
conversations in the same browser profiles, retains their per-browser tab order, and
restores the last focused conversation as virtual focus. Blank tabs and transient new-chat
pages are not saved. If a saved conversation is no longer accessible and ChatGPT redirects away from
that conversation, that entry is skipped rather than becoming the restored focus.
The session is stored in the additive `chatgpt_watcher_open_chats` PostgreSQL table; no
manual migration is needed because the watcher creates it automatically.

Focusing a chat that is already open no longer waits for the full conversation
readiness scan or re-scrapes the message history. It focuses the existing page and
returns immediately; the normal watcher scan continues to enforce conversation
readiness before persistence and automatic hooks. Newly opened chats still wait for
the initial page readiness gate. `chatgpt-ctl open` reports both total command time
and watcher-side time, which separates database/CLI delay from browser focus delay.

### Persistence regression check

The repeated-message persistence regression can be checked against any PostgreSQL database (the test uses a temporary table and rolls back):

```bash
psql "$CHATGPT_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/persistence-idempotency.sql
```

It verifies that identical watcher polls do not update message rows and that an incomplete-to-completed transition is reported only once.
