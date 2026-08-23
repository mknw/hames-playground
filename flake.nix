# The owner's LOCAL DEV ENVIRONMENT — nix-darwin on aarch64-darwin, and only
# that. `system` below is hardcoded and the docker-mcp fetch pulls the
# darwin-arm64 tarball, so this devshell does not evaluate anywhere else.
#
# That is deliberate and it is not the deployment story: DEPLOYMENT GOES VIA
# DOCKER (`app/Dockerfile` + the `app` compose service, #197), and CI runs on
# `ubuntu-latest` with its own toolchain setup. Nothing outside one Mac plans
# around this file.
#
# So: do NOT extend it. No `flake-utils.lib.eachDefaultSystem`, no per-system
# docker-mcp source, no second platform — a portable devshell would be a third
# toolchain to keep in step with the Dockerfile and the CI workflow, for no
# consumer that exists. If you need a reproducible cross-platform environment,
# that is the Docker image's job.
{
  inputs = {
    # Your stable base (what you already use)
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-25.11-darwin";
  };

  outputs = { self, nixpkgs }:
    let
      system = "aarch64-darwin";
      pkgs = import nixpkgs { inherit system; };

      docker-mcp = pkgs.stdenvNoCC.mkDerivation rec {
        pname = "docker-mcp";
        version = "0.37.0";

        src = pkgs.fetchurl {
          url = "https://github.com/docker/mcp-gateway/releases/download/v${version}/docker-mcp-darwin-arm64.tar.gz";
          sha256 = "sha256:104a9da9c3d60017aa95f15fec370e40a2e8a6ec0d5e4db183d42127f16510d4";
        };

        unpackPhase = ''
          mkdir -p unpack
          tar -xzf "$src" -C unpack
        '';

        installPhase = ''
          mkdir -p $out/bin
          if [ -f unpack/docker-mcp ]; then
            cp unpack/docker-mcp $out/bin/docker-mcp
          else
            cp unpack/*/docker-mcp $out/bin/docker-mcp
          fi
          chmod +x $out/bin/docker-mcp
        '';
      };

    in
    {
      packages.${system} = {
        inherit docker-mcp;
      };

      devShells.${system}.default = pkgs.mkShell {
        packages = [
          pkgs.nodejs_22
          pkgs.corepack_22
          pkgs.docker-client

          docker-mcp
        ];

        shellHook = ''
          # Keep docker config local to the repo (optional, but nice)
          export DOCKER_CONFIG="$PWD/.docker"
          mkdir -p "$DOCKER_CONFIG/cli-plugins"
          # Bridge the system docker contexts dir into the worktree-local
          # DOCKER_CONFIG so the active context (e.g. colima) can resolve its
          # endpoint metadata. Without this, `docker build` / `docker run`
          # fail from inside the nix shell with
          # `context "colima": context not found: open .docker/contexts/meta/...`
          # because DOCKER_CONFIG redirects context lookup to the (empty)
          # worktree-local dir. The symlink keeps the rest of DOCKER_CONFIG
          # worktree-local (for the nix-store-backed CLI plugins below).
          [ -d "$HOME/.docker/contexts" ] && ln -sfn "$HOME/.docker/contexts" "$DOCKER_CONFIG/contexts"

          # Store-backed Docker CLI plugins
          ln -sf "${docker-mcp}/bin/docker-mcp" \
            "$DOCKER_CONFIG/cli-plugins/docker-mcp"


          echo "docker-mcp ready: try 'docker mcp --help'"
          echo "docker-model ready: try 'docker model --help'"
        '';
      };
    };
}
