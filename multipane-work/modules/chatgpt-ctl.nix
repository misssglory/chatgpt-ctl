# NixOS module: install chatgpt-ctl system-wide + optional local PostgreSQL DB.
#
# Usage (flake):
#   imports = [ inputs.chatgpt-ctl.nixosModules.default ];
#   programs.chatgpt-ctl.enable = true;
#   programs.chatgpt-ctl.database.ensureLocal = true;  # optional
#
# Runtime closure is only the Rust binary (+ libc/openssl). No Bun, Chromium,
# rustc, or graphical libs. PostgreSQL is only started if ensureLocal = true.

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.chatgpt-ctl;
  inherit (lib)
    mkEnableOption
    mkOption
    mkIf
    mkDefault
    types
    optionalString
    ;
in
{
  options.programs.chatgpt-ctl = {
    enable = mkEnableOption "chatgpt-ctl (CLI for ChatGPT history in PostgreSQL)";

    package = mkOption {
      type = types.package;
      default = pkgs.chatgpt-ctl or (throw ''
        pkgs.chatgpt-ctl is missing. Add the flake overlay:

          nixpkgs.overlays = [ inputs.chatgpt-ctl.overlays.default ];
      '');
      defaultText = lib.literalExpression "pkgs.chatgpt-ctl";
      description = "chatgpt-ctl package to install into environment.systemPackages.";
    };

    # Default connection string exported for interactive shells / systemd user sessions
    # that source /etc/set-environment. Override per-user with CHATGPT_DATABASE_URL if needed.
    databaseUrl = mkOption {
      type = types.str;
      default = "postgres://${cfg.database.user}@/${cfg.database.name}?host=/run/postgresql";
      defaultText = lib.literalExpression ''
        "postgres://''${config.programs.chatgpt-ctl.database.user}@/''${config.programs.chatgpt-ctl.database.name}?host=/run/postgresql"
      '';
      description = ''
        Default CHATGPT_DATABASE_URL written to the environment when enable = true.
        For a local socket-authenticated DB (ensureLocal) the default uses peer auth
        via /run/postgresql. For a remote DB, set this to a full URL.
      '';
    };

    database = {
      ensureLocal = mkEnableOption ''
        Create a local PostgreSQL role + database and apply the chatgpt-ctl schema.
        Requires services.postgresql.enable (enabled automatically when this is true).
      '';

      name = mkOption {
        type = types.str;
        default = "chatgpt_history";
        description = "Database name.";
      };

      user = mkOption {
        type = types.str;
        default = "chatgpt";
        description = "PostgreSQL role that owns the database (peer auth as that OS user is not required; the role is for SQL ownership).";
      };

      # Optional password for password auth (empty = peer/trust only as configured by NixOS postgres)
      password = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = ''
          If set, the role is created WITH PASSWORD. Prefer passwordFile in production.
          Leave null for socket/peer-style access from local tools.
        '';
      };

      passwordFile = mkOption {
        type = types.nullOr types.path;
        default = null;
        description = "Path to a file containing the DB role password (takes precedence over password).";
      };

      schemaPackage = mkOption {
        type = types.package;
        default = cfg.package;
        defaultText = lib.literalExpression "config.programs.chatgpt-ctl.package";
        description = "Package that provides share/chatgpt-ctl/schema.sql (the chatgpt-ctl package).";
      };
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.database.password == null || cfg.database.passwordFile == null;
        message = "programs.chatgpt-ctl.database: set only one of password or passwordFile";
      }
    ];

    environment.systemPackages = [ cfg.package ];

    environment.sessionVariables = {
      CHATGPT_DATABASE_URL = cfg.databaseUrl;
    };

    # Local DB setup ----------------------------------------------------------
    services.postgresql = mkIf cfg.database.ensureLocal {
      enable = true;
      ensureDatabases = [ cfg.database.name ];
      ensureUsers = [
        {
          name = cfg.database.user;
          ensureDBOwnership = true;
        }
      ];
    };

    # Apply schema after postgres is up. Runs once per activation when the
    # stamp file is missing or the schema package changed.
    systemd.services.chatgpt-ctl-schema = mkIf cfg.database.ensureLocal {
      description = "Apply chatgpt-ctl PostgreSQL schema";
      after = [ "postgresql.service" ];
      wants = [ "postgresql.service" ];
      wantedBy = [ "multi-user.target" ];

      path = [ config.services.postgresql.package pkgs.coreutils ];

      serviceConfig = {
        Type = "oneshot";
        User = "postgres";
        RemainAfterExit = true;
      };

      script =
        let
          schema = "${cfg.database.schemaPackage}/share/chatgpt-ctl/schema.sql";
          passSet =
            if cfg.database.passwordFile != null then
              ''
                PASS=$(cat ${lib.escapeShellArg (toString cfg.database.passwordFile)})
                psql -v ON_ERROR_STOP=1 -c "ALTER ROLE ${cfg.database.user} WITH PASSWORD '$PASS';"
              ''
            else if cfg.database.password != null then
              ''
                psql -v ON_ERROR_STOP=1 -c "ALTER ROLE ${cfg.database.user} WITH PASSWORD '${cfg.database.password}';"
              ''
            else
              "";
        in
        ''
          set -euo pipefail
          ${passSet}
          psql -v ON_ERROR_STOP=1 -d ${cfg.database.name} -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
          psql -v ON_ERROR_STOP=1 -d ${cfg.database.name} -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;" || true
          if [[ -f ${lib.escapeShellArg schema} ]]; then
            psql -v ON_ERROR_STOP=1 -d ${cfg.database.name} -f ${lib.escapeShellArg schema}
          else
            echo "warning: schema.sql not found at ${schema}" >&2
          fi
        '';
    };
  };
}
