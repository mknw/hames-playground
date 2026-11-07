   # deploy/modal's own shell: uv for the Modal deployment commands (README.md).
   # Direnv drops you into it via .envrc (`use flake`).
   {
     description = "Modal deployment shell: uv for deploy/modal commands";

     inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

     outputs = { self, nixpkgs }:
       let
         systems = [ "x86_64-darwin" "aarch64-darwin" "x86_64-linux" "aarch64-linux" ];
         forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
       in
       {
         devShells = forAllSystems (pkgs: {
           default = pkgs.mkShell {
             packages = [ pkgs.uv ];
           };
         });
       };
   }
