# chatgpt-ctl

CLI (+ optional Bun scraper) for **ChatGPT conversation history** stored in **PostgreSQL**.

- **`chatgpt-ctl`** — minimal Rust binary (no Bun, Chromium, rustc, or PostgreSQL client in the runtime closure)
- Shell **completions** installed with the package (bash / zsh / fish)
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

    # Default DATABASE_URL for shells (socket peer auth when ensureLocal)
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

If you already ran `nix run .#setup-db`, set `DATABASE_URL` to that instance:

```bash
export DATABASE_URL='postgres://chatgpt:chatgpt@127.0.0.1:5432/chatgpt_history'
# or socket:
export DATABASE_URL='postgres://chatgpt@/chatgpt_history?host=/run/postgresql'
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
chatgpt-ctl chats [--limit N] [-q substring]
chatgpt-ctl history [CHAT|current] [--all] [--follow] [--json]
chatgpt-ctl history                 # interactive; TAB completes titles/UUIDs from DB
chatgpt-ctl message <uuid>
chatgpt-ctl completions bash|zsh|fish|elvish|powershell
```

`CHAT` may be a UUID, a title substring, or `current` (most recently updated chat).

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

If you previously ran `nix run .#setup-db`, the module’s `database.ensureLocal` is optional — point `DATABASE_URL` at that instance and install only the package:

```nix
programs.chatgpt-ctl.enable = true;
programs.chatgpt-ctl.database.ensureLocal = false;
programs.chatgpt-ctl.databaseUrl =
  "postgres://chatgpt:chatgpt@127.0.0.1:5432/chatgpt_history";
```
