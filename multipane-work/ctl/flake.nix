{
  description = "chatgpt-ctl only — minimal flake (no Bun/Chromium/PostgreSQL server)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };

        chatgpt-ctl = pkgs.rustPlatform.buildRustPackage {
          pname = "chatgpt-ctl";
          version = "0.1.0";
          src = ./.;

          cargoLock.lockFile = ./Cargo.lock;

          nativeBuildInputs = [
            pkgs.pkg-config
            pkgs.installShellFiles
          ];

          buildInputs = pkgs.lib.optionals pkgs.stdenv.isDarwin [
            pkgs.darwin.apple_sdk.frameworks.Security
          ];

          postInstall = ''
            installShellCompletion --cmd chatgpt-ctl \
              --bash <($out/bin/chatgpt-ctl completions bash) \
              --zsh  <($out/bin/chatgpt-ctl completions zsh) \
              --fish <($out/bin/chatgpt-ctl completions fish)

            # Schema lives in parent repo; optional when building from ctl/ alone
            mkdir -p $out/share/chatgpt-ctl
            if [[ -f ${../sql/schema.sql} ]]; then
              cp ${../sql/schema.sql} $out/share/chatgpt-ctl/schema.sql
              cp ${../sql/flush.sql}  $out/share/chatgpt-ctl/flush.sql
            fi
          '';

          meta = with pkgs.lib; {
            description = "CLI for ChatGPT history stored in PostgreSQL";
            license = licenses.mit;
            mainProgram = "chatgpt-ctl";
            platforms = platforms.unix;
          };
        };
      in
      {
        packages.default = chatgpt-ctl;
        packages.chatgpt-ctl = chatgpt-ctl;
        apps.default = {
          type = "app";
          program = "${chatgpt-ctl}/bin/chatgpt-ctl";
        };
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.rustc
            pkgs.cargo
            pkgs.rustfmt
            pkgs.clippy
          ];
        };
      }
    );
}
