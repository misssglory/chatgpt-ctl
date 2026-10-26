{
  description = "chatgpt-ctl — CLI for ChatGPT history in PostgreSQL (minimal NixOS package + module)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, flake-utils }:
    let
      # Shared package builder (no Bun / Chromium / rustc / postgresql in the *runtime* closure)
      mkChatgptCtl =
        pkgs:
        pkgs.rustPlatform.buildRustPackage {
          pname = "chatgpt-ctl";
          version = "0.1.0";
          src = ./ctl;

          cargoLock = {
            lockFile = ./ctl/Cargo.lock;
          };

          nativeBuildInputs = [
            pkgs.pkg-config
            pkgs.installShellFiles
          ];

          # tokio-postgres is used with NoTls; keep runtime deps minimal.
          buildInputs = pkgs.lib.optionals pkgs.stdenv.isDarwin [
            pkgs.darwin.apple_sdk.frameworks.Security
          ];

          # Generate and install shell completions at build time (no runtime deps).
          postInstall = ''
            installShellCompletion --cmd chatgpt-ctl \
              --bash <($out/bin/chatgpt-ctl completions bash) \
              --zsh  <($out/bin/chatgpt-ctl completions zsh) \
              --fish <($out/bin/chatgpt-ctl completions fish)

            # Ship schema next to the binary for the NixOS module / manual setup
            mkdir -p $out/share/chatgpt-ctl
            cp ${./sql/schema.sql} $out/share/chatgpt-ctl/schema.sql
            cp ${./sql/flush.sql}  $out/share/chatgpt-ctl/flush.sql
          '';

          meta = with pkgs.lib; {
            description = "CLI to browse ChatGPT conversation history stored in PostgreSQL";
            homepage = "https://github.com/mg/chatgpt-ctl";
            license = licenses.mit;
            mainProgram = "chatgpt-ctl";
            platforms = platforms.unix;
          };
        };

      overlay = final: prev: {
        chatgpt-ctl = mkChatgptCtl final;
      };
    in
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ overlay ];
        };
        chatgpt-ctl = pkgs.chatgpt-ctl;

        # Optional helper scripts for non-NixOS / first-time DB setup (postgresql *client* only)
        setupDb = pkgs.writeShellApplication {
          name = "chatgpt-ctl-setup-db";
          runtimeInputs = [ pkgs.postgresql ];
          text = ''
            set -euo pipefail
            DB_NAME="''${DB_NAME:-chatgpt_history}"
            DB_USER="''${DB_USER:-chatgpt}"
            SCHEMA="''${SCHEMA:-${chatgpt-ctl}/share/chatgpt-ctl/schema.sql}"
            export PGHOST="''${PGHOST:-/run/postgresql}"
            export PGUSER="''${PGUSER:-postgres}"

            echo "[setup-db] role=$DB_USER database=$DB_NAME schema=$SCHEMA"
            if ! psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
              psql -v ON_ERROR_STOP=1 -c "CREATE ROLE $DB_USER LOGIN;"
            fi
            if ! psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
              psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"
            fi
            psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
            psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;" || true
            psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$SCHEMA"
            echo "[setup-db] done"
          '';
        };

        flushDb = pkgs.writeShellApplication {
          name = "chatgpt-ctl-flush-db";
          runtimeInputs = [ pkgs.postgresql ];
          text = ''
            set -euo pipefail
            DB_NAME="''${DB_NAME:-chatgpt_history}"
            FLUSH="''${FLUSH:-${chatgpt-ctl}/share/chatgpt-ctl/flush.sql}"
            export PGHOST="''${PGHOST:-/run/postgresql}"
            export PGUSER="''${PGUSER:-postgres}"
            echo "[flush-db] truncating $DB_NAME …"
            psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$FLUSH"
            echo "[flush-db] done"
          '';
        };
      in
      {
        packages = {
          default = chatgpt-ctl;
          chatgpt-ctl = chatgpt-ctl;
          setup-db = setupDb;
          flush-db = flushDb;
        };

        apps = {
          default = {
            type = "app";
            program = "${chatgpt-ctl}/bin/chatgpt-ctl";
          };
          setup-db = {
            type = "app";
            program = "${setupDb}/bin/chatgpt-ctl-setup-db";
          };
          flush-db = {
            type = "app";
            program = "${flushDb}/bin/chatgpt-ctl-flush-db";
          };
        };

        # Minimal shell for *building* ctl only — no Chromium, no Bun, no postgres server
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            rustc
            cargo
            rustfmt
            clippy
            pkg-config
          ];
          shellHook = ''
            echo "chatgpt-ctl build shell (Rust only)"
            echo "  cargo build --release --manifest-path ctl/Cargo.toml"
            echo "  nix build .#chatgpt-ctl"
          '';
        };

        # Full watcher shell (Bun + system chromium via PATH) — opt-in
        devShells.watcher = pkgs.mkShell {
          packages = with pkgs; [
            bun
            typescript
            postgresql
            rustc
            cargo
            jq
          ];
          shellHook = ''
            echo "chatgpt-history-watcher shell (Bun scraper + ctl)"
            echo "  Set config.toml [browser].executable_path to your chromium-regular"
            echo "  bun run login | watch | migrate"
          '';
        };

        checks.chatgpt-ctl = chatgpt-ctl;
      }
    )
    // {
      overlays.default = overlay;

      nixosModules.default = import ./modules/chatgpt-ctl.nix;
      nixosModules.chatgpt-ctl = import ./modules/chatgpt-ctl.nix;
    };
}
