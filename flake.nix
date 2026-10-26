{
  description = "chatgpt-history-watcher — scrape ChatGPT chats into PostgreSQL + rust ctl";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # Default DB settings (override with env or config.toml)
        dbName = "chatgpt_history";
        dbUser = "chatgpt";
        dbPass = "chatgpt";
        dbHost = "127.0.0.1";
        dbPort = "5432";
        databaseUrl = "postgres://${dbUser}:${dbPass}@${dbHost}:${dbPort}/${dbName}";

        chatgpt-ctl = pkgs.rustPlatform.buildRustPackage {
          pname = "chatgpt-ctl";
          version = "0.1.0";
          src = ./ctl;
          cargoLock = {
            lockFile = ./ctl/Cargo.lock;
          };
          nativeBuildInputs = [ pkgs.pkg-config ];
          buildInputs = [ pkgs.openssl ] ++ pkgs.lib.optionals pkgs.stdenv.isDarwin [
            pkgs.darwin.apple_sdk.frameworks.Security
          ];
        };

        # Prefer building ctl via cargo in the dev shell; expose a thin wrapper app.
        ctlScript = pkgs.writeShellApplication {
          name = "chatgpt-ctl";
          runtimeInputs = [ pkgs.postgresql pkgs.jq ];
          text = ''
            set -euo pipefail
            ROOT="$(${pkgs.git}/bin/git rev-parse --show-toplevel 2>/dev/null || pwd)"
            CTL_DIR="$ROOT/ctl"
            export DATABASE_URL="''${DATABASE_URL:-${databaseUrl}}"
            if [[ -x "$CTL_DIR/target/release/chatgpt-ctl" ]]; then
              exec "$CTL_DIR/target/release/chatgpt-ctl" "$@"
            elif [[ -x "$CTL_DIR/target/debug/chatgpt-ctl" ]]; then
              exec "$CTL_DIR/target/debug/chatgpt-ctl" "$@"
            else
              echo "chatgpt-ctl binary not found. Build it with:" >&2
              echo "  cd ctl && cargo build --release" >&2
              echo "Or: nix develop -c cargo build --release --manifest-path ctl/Cargo.toml" >&2
              exit 127
            fi
          '';
        };

        setupDb = pkgs.writeShellApplication {
          name = "setup-db";
          runtimeInputs = [ pkgs.postgresql pkgs.coreutils ];
          text = ''
            set -euo pipefail
            export PGHOST="''${PGHOST:-${dbHost}}"
            export PGPORT="''${PGPORT:-${dbPort}}"
            export PGUSER="''${PGUSER:-postgres}"
            ROOT="$(cd "$(dirname "$0")/.." 2>/dev/null; pwd)"
            # When run via nix run, locate schema relative to flake
            SCHEMA="''${SCHEMA_SQL:-}"
            if [[ -z "$SCHEMA" ]]; then
              for c in ./sql/schema.sql "$ROOT/sql/schema.sql" "${./sql/schema.sql}"; do
                if [[ -f "$c" ]]; then SCHEMA="$c"; break; fi
              done
            fi
            if [[ -z "''${SCHEMA:-}" || ! -f "$SCHEMA" ]]; then
              echo "schema.sql not found" >&2
              exit 1
            fi

            echo "[setup-db] ensuring role ${dbUser} and database ${dbName}…"
            # Create role if missing
            if ! psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${dbUser}'" | grep -q 1; then
              psql -v ON_ERROR_STOP=1 -c "CREATE ROLE ${dbUser} LOGIN PASSWORD '${dbPass}';"
            fi
            # Create database if missing
            if ! psql -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'" | grep -q 1; then
              psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${dbName} OWNER ${dbUser};"
            fi
            psql -v ON_ERROR_STOP=1 -d ${dbName} -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
            psql -v ON_ERROR_STOP=1 -d ${dbName} -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;" || true
            echo "[setup-db] applying $SCHEMA"
            PGPASSWORD='${dbPass}' psql -v ON_ERROR_STOP=1 -h "$PGHOST" -p "$PGPORT" -U ${dbUser} -d ${dbName} -f "$SCHEMA"
            echo "[setup-db] done. DATABASE_URL=${databaseUrl}"
          '';
        };

        flushDb = pkgs.writeShellApplication {
          name = "flush-db";
          runtimeInputs = [ pkgs.postgresql ];
          text = ''
            set -euo pipefail
            export PGHOST="''${PGHOST:-${dbHost}}"
            export PGPORT="''${PGPORT:-${dbPort}}"
            ROOT="$(pwd)"
            FLUSH="''${FLUSH_SQL:-}"
            if [[ -z "$FLUSH" ]]; then
              for c in ./sql/flush.sql "$ROOT/sql/flush.sql" "${./sql/flush.sql}"; do
                if [[ -f "$c" ]]; then FLUSH="$c"; break; fi
              done
            fi
            if [[ -z "''${FLUSH:-}" || ! -f "$FLUSH" ]]; then
              echo "flush.sql not found" >&2
              exit 1
            fi
            echo "[flush-db] truncating chats + messages in ${dbName}…"
            PGPASSWORD='${dbPass}' psql -v ON_ERROR_STOP=1 -h "$PGHOST" -p "$PGPORT" -U ${dbUser} -d ${dbName} -f "$FLUSH"
            echo "[flush-db] done"
          '';
        };

      in {
        packages = {
          default = ctlScript;
          chatgpt-ctl = ctlScript;
          setup-db = setupDb;
          flush-db = flushDb;
        };

        apps = {
          default = {
            type = "app";
            program = "${ctlScript}/bin/chatgpt-ctl";
          };
          setup-db = {
            type = "app";
            program = "${setupDb}/bin/setup-db";
          };
          flush-db = {
            type = "app";
            program = "${flushDb}/bin/flush-db";
          };
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            typescript
            postgresql
            rustc
            cargo
            rustfmt
            clippy
            pkg-config
            openssl
            # chromium
            jq
          ];
          DATABASE_URL = databaseUrl;
          shellHook = ''
            echo "chatgpt-history-watcher dev shell"
            echo "  DATABASE_URL=$DATABASE_URL"
            echo "  nix run .#setup-db     # create role/db + apply schema"
            echo "  nix run .#flush-db     # TRUNCATE chats/messages"
            echo "  bun run login          # manual Chromium login → var/chatgpt-profile"
            echo "  bun run migrate        # apply sql/schema.sql via postgres.js"
            echo "  bun run watch          # scrape current chat, persist completed msgs"
            echo "  cargo run -p chatgpt-ctl -- history   # rust ctl"
          '';
        };
      });
}
