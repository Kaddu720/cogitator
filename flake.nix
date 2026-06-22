{
  description = "pi launcher with Gondolin micro-VM isolation and a project-aware workflow extension";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    pi = {
      url = "github:earendil-works/pi/v0.79.9";
      flake = false;
    };
    pi-web-access = {
      url = "git+https://github.com/nicobailon/pi-web-access.git";
      flake = false;
    };
    pi-mcp-adapter = {
      url = "git+https://github.com/nicobailon/pi-mcp-adapter.git";
      flake = false;
    };
    ponytail = {
      url = "github:DietrichGebert/ponytail";
      flake = false;
    };
    gondolin = {
      # Tracks a release tag, pi-style: `nix flake update gondolin` (or bumping
      # the tag) advances the version; the prebuilt npm tarball hash + npmDepsHash
      # below are updated per bump.
      url = "github:earendil-works/gondolin/v0.12.0";
      flake = false;
    };
  };

  outputs = inputs@{ self, nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        lib = pkgs.lib;
        isLinux = pkgs.stdenv.isLinux;

        defaultControlRoot = "$HOME/.local/share/cogitator";
        # Reference the entry within the flake source tree (via self) so its
        # sibling modules (./commands.js, …) and ../resources/ are present next to
        # it, and the store reference carries proper context (no toString warning).
        workflowExtension = "${self}/extensions/workflow-mode.ts";
        cogitatorSkillsDir = ./skills;
        controlRootGitignore = ./control-root.gitignore;
        # Version auto-derived from flake input; hashes updated manually per bump.
        piVersion = (builtins.fromJSON (builtins.readFile "${inputs.pi}/packages/coding-agent/package.json")).version;
        piPackageLock = ./pi-package-lock.json;
        piWebAccessSrc = inputs.pi-web-access;
        ponytailSrc = inputs.ponytail;
        # pi-mcp-adapter (community MCP bridge, same author as pi-web-access). The
        # repo ships no lockfile, so vendor a generated production lock and strip
        # dev/optional deps so importNpmLock + npm ci agree. At runtime the adapter
        # reads .mcp.json (mirroring the host MCP config; secrets stay out of the repo).
        piMcpAdapterSrc = inputs.pi-mcp-adapter;
        piMcpAdapterPackageLock = ./pi-mcp-adapter-package-lock.json;
        # Gondolin micro-VM sandbox: version auto-derived from the input's host
        # package; the prebuilt npm tarball is fetched + built (pi-style).
        gondolinVersion = (builtins.fromJSON (builtins.readFile "${inputs.gondolin}/host/package.json")).version;
        gondolinPackageLock = ./gondolin-package-lock.json;

        piRawSrc = pkgs.fetchzip {
          url = "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-${piVersion}.tgz";
          hash = "sha256-mzolHO39SycdFsZM5jEc5QY6FTdvS//tjK1X9mZBKIo=";
          stripRoot = false;
        };

        # The published tarball ships an npm-shrinkwrap.json that npm tooling
        # (incl. fetchNpmDeps) prefers over package-lock.json, but it omits
        # integrity for the @earendil-works/* workspace siblings. Pre-patch the
        # source: drop the shrinkwrap and use our integrity-completed lock so the
        # deps fetch and `npm ci` read identical, valid content.
        # Named "source" so stdenv's unpackPhase yields source/package,
        # matching buildNpmPackage's sourceRoot below.
        piSrc = pkgs.runCommand "source" {} ''
          cp -r ${piRawSrc} $out
          chmod -R u+w $out
          rm -f $out/package/npm-shrinkwrap.json
          cp ${piPackageLock} $out/package/package-lock.json
          # Drop devDependencies so package.json matches the production lock;
          # `npm ci` validates the lock against ALL of package.json (incl. dev)
          # and pi ships prebuilt dist/, so dev deps are never needed.
          ${pkgs.jq}/bin/jq 'del(.devDependencies)' $out/package/package.json > $out/package/package.json.tmp
          mv $out/package/package.json.tmp $out/package/package.json
        '';

        piBasePkg = pkgs.buildNpmPackage rec {
          pname = "pi-coding-agent";
          version = piVersion;
          src = piSrc;
          sourceRoot = "source/package";
          npmDepsHash = "sha256-IDH/RyRidsGqpTOpUhNAjdxjLyUPB4xZKfsohzUgDb4=";

          dontNpmBuild = true;
          npmPackFlags = [ "--ignore-scripts" ];
          # The published npm-shrinkwrap.json is a production lock (no devDeps),
          # so install runtime deps only. pi ships prebuilt dist/, so dev deps
          # (e.g. @types/*) are never needed here.
          npmFlags = [ "--omit=dev" ];

          postInstall = ''
            mkdir -p $out/share/pi
            cp -r dist docs examples package.json CHANGELOG.md README.md $out/share/pi/

            # Place pi-web-access OUTSIDE node_modules so jiti will
            # transform its TypeScript (jiti skips node_modules).
            pwa_dir="$out/share/pi-web-access"
            cp -r ${piWebAccessPkg}/lib/node_modules/pi-web-access "$pwa_dir"
            chmod -R u+w "$pwa_dir"

            # Symlink pi core peer dependencies into pi-web-access's
            # node_modules so bare imports like @earendil-works/* and
            # @sinclair/typebox resolve correctly.
            pi_nm="$out/lib/node_modules/@earendil-works/pi-coding-agent/node_modules"
            pwa_nm="$pwa_dir/node_modules"
            for pkg in @earendil-works/pi-coding-agent @earendil-works/pi-ai @earendil-works/pi-tui @sinclair/typebox; do
              if [ -d "$pi_nm/$pkg" ]; then
                mkdir -p "$pwa_nm/$(dirname $pkg)"
                ln -sfn "$pi_nm/$pkg" "$pwa_nm/$pkg"
              fi
            done

            # Same pattern for pi-mcp-adapter, but it has real non-peer deps (the
            # MCP SDK etc.), so symlink-copy its full installed node_modules, then
            # override the pi core packages with the running pi's own versions.
            mcp_dir="$out/share/pi-mcp-adapter"
            cp -r ${piMcpAdapterPkg}/lib/node_modules/pi-mcp-adapter "$mcp_dir"
            chmod -R u+w "$mcp_dir"
            mcp_nm="$mcp_dir/node_modules"
            mkdir -p "$mcp_nm"
            cp -rs ${piMcpAdapterPkg}/lib/node_modules/. "$mcp_nm/"
            chmod -R u+w "$mcp_nm"
            rm -rf "$mcp_nm/pi-mcp-adapter"
            for pkg in @earendil-works/pi-coding-agent @earendil-works/pi-ai @earendil-works/pi-tui; do
              if [ -d "$pi_nm/$pkg" ]; then
                mkdir -p "$mcp_nm/$(dirname $pkg)"
                rm -rf "$mcp_nm/$pkg"
                ln -sfn "$pi_nm/$pkg" "$mcp_nm/$pkg"
              fi
            done

            makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/pi \
              --add-flags $out/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
              --prefix PATH : ${lib.makeBinPath [ pkgs.git ]}
          '';

          nativeBuildInputs = [ pkgs.makeWrapper ];
        };

        piWebAccessPkg = pkgs.buildNpmPackage rec {
          pname = "pi-web-access";
          version = inputs.pi-web-access.rev or "unstable";
          src = piWebAccessSrc;
          npmDeps = pkgs.importNpmLock {
            npmRoot = piWebAccessSrc;
          };
          npmConfigHook = pkgs.importNpmLock.npmConfigHook;

          dontNpmBuild = true;
          npmPackFlags = [ "--ignore-scripts" ];
        };

        piMcpAdapterSrcWithLock = pkgs.runCommand "pi-mcp-adapter-src" {} ''
          cp -r ${piMcpAdapterSrc} $out
          chmod -R u+w $out
          cp ${piMcpAdapterPackageLock} $out/package-lock.json
          ${pkgs.jq}/bin/jq 'del(.devDependencies, .optionalDependencies)' $out/package.json > $out/package.json.tmp
          mv $out/package.json.tmp $out/package.json
        '';

        piMcpAdapterPkg = pkgs.buildNpmPackage {
          pname = "pi-mcp-adapter";
          version = inputs.pi-mcp-adapter.rev or "unstable";
          src = piMcpAdapterSrcWithLock;
          npmDeps = pkgs.importNpmLock {
            npmRoot = piMcpAdapterSrcWithLock;
          };
          npmConfigHook = pkgs.importNpmLock.npmConfigHook;
          dontNpmBuild = true;
          npmPackFlags = [ "--ignore-scripts" ];
        };

        ponytailPkg = pkgs.runCommand "ponytail-package" {} ''
          mkdir -p "$out/share"
          cp -r ${ponytailSrc} "$out/share/ponytail"
          chmod -R u+w "$out/share/ponytail"
          cat > "$out/share/ponytail/package.json" <<'EOF'
{
  "name": "ponytail-package",
  "version": "0.0.0-${inputs.ponytail.rev or "unstable"}",
  "keywords": ["pi-package"],
  "pi": {
    "skills": ["./.openclaw/skills"]
  }
}
EOF
        '';

        # Cogitator's own skills (e.g. new-project), shipped from ./skills and
        # registered as a pi package so /new-project can kick them off.
        cogitatorSkillsPkg = pkgs.runCommand "cogitator-skills-package" {} ''
          mkdir -p "$out/share/cogitator-skills"
          cp -r ${cogitatorSkillsDir}/. "$out/share/cogitator-skills/skills/"
          chmod -R u+w "$out/share/cogitator-skills"
          cat > "$out/share/cogitator-skills/package.json" <<'EOF'
{
  "name": "cogitator-skills-package",
  "version": "0.0.0",
  "keywords": ["pi-package"],
  "pi": {
    "skills": ["./skills"]
  }
}
EOF
        '';

        # Gondolin SDK/CLI built from its prebuilt npm tarball (ships dist/).
        gondolinRawSrc = pkgs.fetchzip {
          url = "https://registry.npmjs.org/@earendil-works/gondolin/-/gondolin-${gondolinVersion}.tgz";
          hash = "sha256-sUV/S7xePwGCKTET5aJkEERuWxJwkKCNgdiU2ztaaUo=";
          stripRoot = false;
        };
        # Tarball has no lockfile; vendor a production lock and strip dev/optional
        # deps so `npm ci` matches it (we use the default QEMU backend, not krun).
        gondolinSrc = pkgs.runCommand "source" {} ''
          cp -r ${gondolinRawSrc} $out
          chmod -R u+w $out
          cp ${gondolinPackageLock} $out/package/package-lock.json
          ${pkgs.jq}/bin/jq 'del(.devDependencies, .optionalDependencies)' $out/package/package.json > $out/package/package.json.tmp
          mv $out/package/package.json.tmp $out/package/package.json
        '';
        gondolinPkg = pkgs.buildNpmPackage {
          pname = "gondolin";
          version = gondolinVersion;
          src = gondolinSrc;
          sourceRoot = "source/package";
          npmDepsHash = "sha256-JH+4wUsc8nxVxpQwMluxLHzf6jPdYjemqkqfx9JiILI=";
          dontNpmBuild = true;
          npmPackFlags = [ "--ignore-scripts" ];
          npmFlags = [ "--omit=dev" "--omit=optional" ];
        };

        # Pi extension that routes pi's read/write/edit/bash into the Gondolin
        # micro-VM. Uses the version-aligned example bundled in the pi package,
        # placed outside node_modules so jiti transforms its TypeScript, with the
        # gondolin SDK and pi core resolvable as peer deps.
        gondolinExtPkg = pkgs.runCommand "pi-extension-gondolin" {} ''
          dir="$out/share/pi-extension-gondolin"
          mkdir -p "$dir"
          cp -r ${piBasePkg}/share/pi/examples/extensions/gondolin/. "$dir/"
          chmod -R u+w "$dir"
          nm="$dir/node_modules/@earendil-works"
          mkdir -p "$nm"
          ln -sfn ${gondolinPkg}/lib/node_modules/@earendil-works/gondolin "$nm/gondolin"
          ln -sfn ${piBasePkg}/lib/node_modules/@earendil-works/pi-coding-agent "$nm/pi-coding-agent"
        '';

        # pi's bundled `handoff` example as a registered package: lossless-ish
        # session transfer (continuity across compaction). In-process, no separate
        # execution sandbox, so it composes with Gondolin. Needs pi core + pi-ai +
        # pi-agent-core resolvable as peers (it imports all three at the top level).
        handoffExtPkg = pkgs.runCommand "pi-extension-handoff" {} ''
          dir="$out/share/pi-extension-handoff"
          mkdir -p "$dir/node_modules/@earendil-works"
          cp ${piBasePkg}/share/pi/examples/extensions/handoff.ts "$dir/handoff.ts"
          cat > "$dir/package.json" <<'EOF'
{
  "name": "pi-extension-handoff",
  "private": true,
  "type": "module",
  "pi": { "extensions": ["./handoff.ts"] }
}
EOF
          pi_nm="${piBasePkg}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules"
          ln -sfn ${piBasePkg}/lib/node_modules/@earendil-works/pi-coding-agent "$dir/node_modules/@earendil-works/pi-coding-agent"
          for pkg in pi-ai pi-tui pi-agent-core; do
            ln -sfn "$pi_nm/@earendil-works/$pkg" "$dir/node_modules/@earendil-works/$pkg"
          done
        '';

        validEnvVarPattern = "^[A-Z_][A-Z0-9_]*$";

        validateEnvMap = name: attrs:
          let
            invalid = lib.filter (key: builtins.match validEnvVarPattern key == null) (builtins.attrNames attrs);
          in
            if invalid == []
            then attrs
            else throw "${name} contains invalid environment variable names: ${lib.concatStringsSep ", " invalid}";

        renderPlainEnvExports = attrs:
          lib.concatStringsSep "\n" (
            lib.mapAttrsToList (key: value: ''
              export ${key}=${lib.escapeShellArg value}
            '') attrs
          );

        mkSecretBindings = secretFiles:
          lib.mapAttrsToList (name: path: {
            source = toString path;
            target = "/tmp/cogitator-pi-agent/secrets/${name}";
          }) secretFiles;

        renderSecretStagingLines = bindings:
          lib.concatStringsSep "\n" (
            map (
              binding: ''
                if [[ -f ${lib.escapeShellArg binding.source} ]]; then
                  resolved_source="$(resolve_path ${lib.escapeShellArg binding.source})"
                  if [[ -f "$resolved_source" ]]; then
                    cp "$resolved_source" "$agent_secrets_dir/${baseNameOf binding.target}"
                    chmod 600 "$agent_secrets_dir/${baseNameOf binding.target}"
                  fi
                fi
              ''
            ) bindings
          );

        mkPiProviderAuthAttrs = providerId: cfg:
          let
            mountedApiKey = "!cat \"$PI_CODING_AGENT_DIR/secrets/provider-${providerId}.key\"";
            authCfg = cfg.auth or null;
          in
            if authCfg == null
            then
              (lib.optionalAttrs (cfg ? authHeader) { authHeader = cfg.authHeader; })
              // (lib.optionalAttrs (cfg ? headers) { headers = cfg.headers; })
              // (lib.optionalAttrs (cfg ? apiKeyFile) { apiKey = mountedApiKey; })
            else if !(cfg ? apiKeyFile)
            then throw "providerConfigs.${providerId}.auth requires apiKeyFile"
            else if authCfg.type == "bearer"
            then
              {
                authHeader = true;
                apiKey = mountedApiKey;
              }
              // (lib.optionalAttrs (cfg ? headers) { headers = cfg.headers; })
            else if authCfg.type == "header"
            then
              if !(authCfg ? header)
              then throw "providerConfigs.${providerId}.auth.type='header' requires auth.header"
              else {
                apiKey = mountedApiKey;
                headers = (cfg.headers or { }) // (builtins.listToAttrs [
                  {
                    name = authCfg.header;
                    value = mountedApiKey;
                  }
                ]);
              }
            else throw "providerConfigs.${providerId}.auth.type must be 'bearer' or 'header'";

        mkPiModelsConfig = providerConfigs: {
          providers = lib.mapAttrs (
            providerId: cfg:
            {
              baseUrl = cfg.baseUrl;
              api = cfg.api;
            }
            // mkPiProviderAuthAttrs providerId cfg
            // lib.optionalAttrs (cfg ? models) { models = cfg.models; }
          ) providerConfigs;
        };

        mkProviderSecretFiles = providerConfigs:
          lib.mapAttrs' (
            providerId: cfg:
            lib.nameValuePair "provider-${providerId}.key" cfg.apiKeyFile
          ) (lib.filterAttrs (_: cfg: cfg ? apiKeyFile) providerConfigs);

        mkCogitator = {
          controlRoot ? defaultControlRoot,
          plainEnv ? {},
          secretEnvFiles ? {},
          providerConfigs ? {},
          extraExtensions ? [],
          extraRuntimeTools ? [],
          defaultProjectId ? null,
        }:
          let
            checkedPlainEnv = validateEnvMap "plainEnv" plainEnv;
            checkedSecretEnvFiles = validateEnvMap "secretEnvFiles" secretEnvFiles;
            piModelsConfig = mkPiModelsConfig providerConfigs;
            providerSecretFiles = mkProviderSecretFiles providerConfigs;
            allSecretFiles = checkedSecretEnvFiles // providerSecretFiles;
            secretBindings = mkSecretBindings allSecretFiles;
            extensions = [ workflowExtension ] ++ extraExtensions;
            extensionFlags = lib.concatStringsSep " \\\n            " (
              map (path: "--extension ${lib.escapeShellArg "${path}"}") extensions
            );

            runtimeTools =
              (with pkgs; [
                bash
                coreutils
                findutils
                gnugrep
                gnused
                gawk
                diffutils
                git
                gh
                ripgrep
                fd
                cacert
                ffmpeg
                yt-dlp
                nodejs_24
                python3
              ])
              ++ lib.optionals isLinux (with pkgs; [
                xdg-utils
                qemu
              ])
              ++ extraRuntimeTools;

            runtimePath = lib.makeBinPath runtimeTools;

            piPkg = pkgs.writeShellScriptBin "pi" ''
              set -euo pipefail
              ${renderPlainEnvExports checkedPlainEnv}
              exec ${piBasePkg}/bin/pi \
                ${extensionFlags} \
                "$@"
            '';

            cogitatorInitProject = pkgs.writeShellScriptBin "cogitator-init-project" ''
              set -euo pipefail

              usage() {
                cat <<'EOF'
Usage: cogitator-init-project <project-id> [options]

Options:
  --name NAME            Human-readable project name. Default: derived from project id.
  --description TEXT     Short description shown in the project picker.
  --control-root PATH    Cogitator control root. Default: ${controlRoot}
  --repo PATH            Linked repo path. Repeatable.
  --tag TAG              Project tag. Repeatable.
  --context PATH         Repo context file path relative to the project dir. Repeatable.
  --force                Overwrite existing project.json and state.md if present.
  --help                 Show this help.

Creates:
  <control-root>/projects/<project-id>/
    project.json
    state.md
    artifacts/
    repoContexts/
EOF
              }

              if [[ $# -lt 1 ]]; then
                usage >&2
                exit 1
              fi

              project_id=""
              project_name=""
              description=""
              control_root="${controlRoot}"
              force=0
              declare -a repos=()
              declare -a tags=()
              declare -a contexts=()

              while [[ $# -gt 0 ]]; do
                case "$1" in
                  --name)
                    project_name="$2"
                    shift 2
                    ;;
                  --description)
                    description="$2"
                    shift 2
                    ;;
                  --control-root)
                    control_root="$2"
                    shift 2
                    ;;
                  --repo)
                    repos+=("$2")
                    shift 2
                    ;;
                  --tag)
                    tags+=("$2")
                    shift 2
                    ;;
                  --context)
                    contexts+=("$2")
                    shift 2
                    ;;
                  --force)
                    force=1
                    shift
                    ;;
                  --help|-h)
                    usage
                    exit 0
                    ;;
                  --*)
                    echo "Unknown option: $1" >&2
                    exit 1
                    ;;
                  *)
                    if [[ -z "$project_id" ]]; then
                      project_id="$1"
                    else
                      echo "Unexpected argument: $1" >&2
                      exit 1
                    fi
                    shift
                    ;;
                esac
              done

              if [[ -z "$project_id" ]]; then
                echo "Missing project id" >&2
                exit 1
              fi

              if [[ -z "$project_name" ]]; then
                project_name="$(printf '%s' "$project_id" | tr '-' ' ' | awk '{ for (i = 1; i <= NF; i++) $i = toupper(substr($i, 1, 1)) substr($i, 2); print }')"
              fi

              mkdir -p "$control_root/projects"

              gitignore_path="$control_root/.gitignore"
              if [[ ! -e "$gitignore_path" ]]; then
                cp ${controlRootGitignore} "$gitignore_path"
              fi

              project_dir="$control_root/projects/$project_id"
              project_json="$project_dir/project.json"
              state_md="$project_dir/state.md"
              artifacts_dir="$project_dir/artifacts"
              repo_contexts_dir="$project_dir/repoContexts"

              if [[ -e "$project_json" && "$force" -ne 1 ]]; then
                echo "Project already exists: $project_json" >&2
                echo "Use --force to overwrite." >&2
                exit 1
              fi

              mkdir -p "$project_dir" "$artifacts_dir" "$repo_contexts_dir"

              repo_json="$(${pkgs.python3}/bin/python - <<'PY' "''${repos[@]}"
import json, sys
repos = []
for path in sys.argv[1:]:
    repos.append({"path": path})
print(json.dumps(repos, indent=2))
PY
)"

              tags_json="$(${pkgs.python3}/bin/python - <<'PY' "''${tags[@]}"
import json, sys
print(json.dumps(sys.argv[1:], indent=2))
PY
)"

              contexts_json="$(${pkgs.python3}/bin/python - <<'PY' "''${contexts[@]}"
import json, sys
print(json.dumps(sys.argv[1:], indent=2))
PY
)"

              ${pkgs.python3}/bin/python - <<'PY' \
                "$project_json" \
                "$project_id" \
                "$project_name" \
                "$description" \
                "$repo_json" \
                "$contexts_json" \
                "$tags_json"
import json, sys
path, project_id, project_name, description, repos_json, contexts_json, tags_json = sys.argv[1:]
data = {
    "id": project_id,
    "name": project_name,
    "description": description,
    "stateFile": "state.md",
    "artifactsDir": "artifacts",
    "repos": json.loads(repos_json),
    "repoContexts": json.loads(contexts_json),
    "tags": json.loads(tags_json),
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

              if [[ ! -e "$state_md" || "$force" -eq 1 ]]; then
                cat > "$state_md" <<EOF
# $project_name

## Executive Summary
- Status: todo
- Goal: 

## Background & Context
- status: todo
- repo(s):
$(for repo in "''${repos[@]}"; do printf -- "- %s\n" "$repo"; done)

## Architecture Decisions
- decision: TBD
  rationale: 
  date: $(date +%F)
  owner: 
  status: todo

## Implementation Plan
- [ ] Define scope
- [ ] Capture repo context
- [ ] Record next concrete steps

## Open Questions & Blockers
- status: todo
- None recorded yet

## Key File Locations
- $(basename "$project_json"): project metadata
- state.md: project working state
- artifacts/: generated outputs
- repoContexts/: repo-specific private guidance

## Progress Tracking
- todo: initialize project tracking
- in_progress: 
- blocked: 
- done: 
- deferred: 

## Next Steps
- Select this project in pi with /project
- Update this state file with real scope, owners, and decisions
EOF
              fi

              echo "Created project: $project_id"
              echo "Project directory: $project_dir"
              echo "Metadata: $project_json"
              echo "State file: $state_md"
              echo "Artifacts dir: $artifacts_dir"
            '';

            piSandbox = pkgs.writeShellScriptBin "cogi" ''
              set -euo pipefail
              export PATH="${runtimePath}:''${PATH:-}"

              usage() {
                cat <<'EOF'
Usage: cogi [--workspace PATH] [--control-root PATH] [--project-id ID] [--host-pi-auth] [--] [pi args...]

Options:
  --workspace PATH         Workspace directory; defaults to the current directory.
  --control-root PATH      Cogitator runtime root (sessions, gitignore). Default: ${controlRoot}
  --project-states-dir PATH  Directory of markdown project state files + INDEX.md.
                           Default: \$COGITATOR_PROJECT_STATES_DIR or ~/Projects/projectStates
  --project-id ID          Preselect a project (state-file slug) instead of prompting.
  --host-pi-auth           Use host ~/.pi/agent auth.json and models.json.
  --help                   Show this help.

Isolation:
  Process isolation is provided by Gondolin, wired in as a pi extension that
  routes pi's read/write/edit/bash tools into a local QEMU micro-VM with the
  workspace mounted at /workspace. cogi itself runs pi directly on the host.
EOF
              }

              workspace="$PWD"
              control_root="${controlRoot}"
              project_states_dir="''${COGITATOR_PROJECT_STATES_DIR:-''${HOME:-/home/kaddu}/Projects/projectStates}"
              project_id="${if defaultProjectId == null then "" else defaultProjectId}"
              bind_host_pi_auth=0
              declare -a pi_args=()

              while [[ $# -gt 0 ]]; do
                case "$1" in
                  --workspace)
                    workspace="$2"
                    shift 2
                    ;;
                  --control-root)
                    control_root="$2"
                    shift 2
                    ;;
                  --project-states-dir)
                    project_states_dir="$2"
                    shift 2
                    ;;
                  --project-id)
                    project_id="$2"
                    shift 2
                    ;;
                  --host-pi-auth)
                    bind_host_pi_auth=1
                    shift
                    ;;
                  --help|-h)
                    usage
                    exit 0
                    ;;
                  --)
                    shift
                    pi_args=("$@")
                    break
                    ;;
                  *)
                    pi_args+=("$1")
                    shift
                    ;;
                esac
              done

              resolve_path() {
                ${pkgs.python3}/bin/python - <<'PY' "$1"
import os
import sys
print(os.path.realpath(sys.argv[1]))
PY
              }

              mkdir -p "$control_root/projects"

              gitignore_path="$control_root/.gitignore"
              if [[ ! -e "$gitignore_path" ]]; then
                cp ${controlRootGitignore} "$gitignore_path"
              fi

              workspace="$(resolve_path "$workspace")"
              control_root="$(resolve_path "$control_root")"
              mkdir -p "$project_states_dir"
              project_states_dir="$(resolve_path "$project_states_dir")"

              if [[ ! -d "$workspace" ]]; then
                echo "Workspace does not exist or is not a directory: $workspace" >&2
                exit 1
              fi

              if [[ ! -d "$control_root" ]]; then
                echo "Control root does not exist or is not a directory: $control_root" >&2
                exit 1
              fi

              session_dir_name="$(${pkgs.python3}/bin/python - <<'PY' "$workspace"
import sys
print("--" + sys.argv[1].replace("/", "-") + "--")
PY
              )"
              sessions_root="$control_root/sessions"
              session_dir="$sessions_root/$session_dir_name"
              mkdir -p "$sessions_root" "$session_dir"

              host_pi_agent_dir=""
              host_pi_settings_json=""
              host_pi_models_json=""
              host_pi_auth_json=""
              host_pi_keybindings_json=""
              if [[ -n "${HOME:-}" ]]; then
                mkdir -p "$HOME/.pi/agent"
                host_pi_agent_dir="$(resolve_path "$HOME/.pi/agent")"
                host_pi_settings_json="$host_pi_agent_dir/settings.json"
                host_pi_models_json="$host_pi_agent_dir/models.json"
                host_pi_auth_json="$host_pi_agent_dir/auth.json"
                host_pi_keybindings_json="$host_pi_agent_dir/keybindings.json"
              elif [[ "$bind_host_pi_auth" -eq 1 ]]; then
                echo "--host-pi-auth requires HOME to be set in the calling environment" >&2
                exit 1
              fi

              agent_dir_host="$(mktemp -d)"
              agent_secrets_dir="$agent_dir_host/secrets"
              mkdir -p "$agent_secrets_dir"
              trap '
                if [[ -n "$host_pi_agent_dir" ]]; then
                  for f in "$agent_dir_host"/*; do
                    [[ -f "$f" ]] || continue
                    base="$(basename "$f")"
                    case "$base" in cogitator-*.json|secrets) continue ;; esac
                    cp "$f" "$host_pi_agent_dir/$base"
                  done
                fi
                rm -rf "$agent_dir_host"
              ' EXIT
${renderSecretStagingLines secretBindings}
              cat > "$agent_dir_host/cogitator-models.json" <<'EOF'
${builtins.toJSON piModelsConfig}
EOF
              cat > "$agent_dir_host/cogitator-settings.json" <<'EOF'
${builtins.toJSON ({
                defaultProvider = checkedPlainEnv.COGITATOR_DEFAULT_PROVIDER or null;
                defaultModel = checkedPlainEnv.COGITATOR_DEFAULT_MODEL or null;
                packages = [
                  "${piBasePkg}/share/pi-web-access"
                  "${piBasePkg}/share/pi-mcp-adapter"
                  "${ponytailPkg}/share/ponytail"
                  "${cogitatorSkillsPkg}/share/cogitator-skills"
                  "${gondolinExtPkg}/share/pi-extension-gondolin"
                  "${handoffExtPkg}/share/pi-extension-handoff"
                ];
              })}
EOF
              cat > "$agent_dir_host/cogitator-keybindings.json" <<'EOF'
${builtins.toJSON ({
                "app.thinking.cycle" = [ ];
              })}
EOF
              ${pkgs.python3}/bin/python - <<'PY' "$host_pi_models_json" "$agent_dir_host/cogitator-models.json" "$agent_dir_host/models.json"
import json
import os
import sys


def load_json(path: str):
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def merge(base, overlay):
    if isinstance(base, dict) and isinstance(overlay, dict):
        result = dict(base)
        for key, value in overlay.items():
            if key in result:
                result[key] = merge(result[key], value)
            else:
                result[key] = value
        return result
    return overlay


result = merge(load_json(sys.argv[1]), load_json(sys.argv[2]))
with open(sys.argv[3], "w", encoding="utf-8") as handle:
    json.dump(result, handle, indent=2)
    handle.write("\n")
PY
              ${pkgs.python3}/bin/python - <<'PY' "$host_pi_settings_json" "$agent_dir_host/cogitator-settings.json" "$agent_dir_host/settings.json"
import json
import os
import sys


def load_json(path: str):
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


result = load_json(sys.argv[1])
overlay = load_json(sys.argv[2])
for key, value in overlay.items():
    if value is None:
        continue
    if key == "packages" and isinstance(value, list):
        existing = result.get(key)
        merged = []
        for candidate in value + (existing if isinstance(existing, list) else []):
            if candidate not in merged:
                merged.append(candidate)
        result[key] = merged
        continue
    result[key] = value

with open(sys.argv[3], "w", encoding="utf-8") as handle:
    json.dump(result, handle, indent=2)
    handle.write("\n")
PY
              ${pkgs.python3}/bin/python - <<'PY' "$host_pi_keybindings_json" "$agent_dir_host/cogitator-keybindings.json" "$agent_dir_host/keybindings.json"
import json
import os
import sys


def load_json(path: str):
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


result = load_json(sys.argv[1])
overlay = load_json(sys.argv[2])
for key, value in overlay.items():
    result[key] = value

with open(sys.argv[3], "w", encoding="utf-8") as handle:
    json.dump(result, handle, indent=2)
    handle.write("\n")
PY
              if [[ -n "$host_pi_agent_dir" ]]; then
                for f in "$host_pi_agent_dir"/*; do
                  [[ -f "$f" ]] || continue
                  base="$(basename "$f")"
                  case "$base" in cogitator-*.json) continue ;; esac
                  cp "$f" "$agent_dir_host/$base"
                done
              fi

              session_flag_already_set=0
              session_flag_takes_value=0
              for arg in "''${pi_args[@]}"; do
                if [[ "$session_flag_takes_value" -eq 1 ]]; then
                  session_flag_takes_value=0
                  continue
                fi
                case "$arg" in
                  --session-dir|--session|--fork)
                    session_flag_already_set=1
                    session_flag_takes_value=1
                    ;;
                  --no-session)
                    session_flag_already_set=1
                    ;;
                esac
              done
              if [[ "$session_flag_already_set" -eq 0 ]]; then
                pi_args=(--session-dir "$session_dir" "''${pi_args[@]}")
              fi

              resolve_host_editor_cmd() {
                local editor_cmd="$1"
                if [[ -z "$editor_cmd" ]]; then
                  return 0
                fi
                local editor_bin="''${editor_cmd%% *}"
                local editor_rest=""
                if [[ "$editor_cmd" != "$editor_bin" ]]; then
                  editor_rest="''${editor_cmd#"$editor_bin"}"
                fi
                local resolved_bin=""
                if [[ "$editor_bin" == */* ]]; then
                  if [[ -e "$editor_bin" ]]; then
                    resolved_bin="$(resolve_path "$editor_bin")"
                  fi
                else
                  local host_editor_path=""
                  host_editor_path="$(command -v "$editor_bin" 2>/dev/null || true)"
                  if [[ -n "$host_editor_path" && -e "$host_editor_path" ]]; then
                    resolved_bin="$(resolve_path "$host_editor_path")"
                  fi
                fi
                if [[ -n "$resolved_bin" ]]; then
                  printf '%s%s\n' "$resolved_bin" "$editor_rest"
                else
                  printf '%s\n' "$editor_cmd"
                fi
              }

              # Process isolation is provided by Gondolin (a QEMU micro-VM wired in
              # as a pi extension that routes tool execution into the guest), so
              # cogi runs pi directly on the host. It only prepares the agent dir
              # (merged config + staged provider secrets) and the environment.
              export SSL_CERT_FILE="${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
              export NIX_SSL_CERT_FILE="${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
              export PI_SKIP_VERSION_CHECK=1
              # Use 1-hour ("long") prompt-cache retention where the model supports
              # it, matching the extended-cache behavior used in Claude Code.
              export PI_CACHE_RETENTION="''${PI_CACHE_RETENTION:-long}"
              export PI_CODING_AGENT_DIR="$agent_dir_host"
              export COGITATOR_CONTROL_ROOT="$control_root"
              export COGITATOR_PROJECT_STATES_DIR="$project_states_dir"
              if [[ -n "$project_id" ]]; then
                export COGITATOR_PROJECT_ID="$project_id"
              fi

              resolved_editor="$(resolve_host_editor_cmd "''${EDITOR:-}")"
              if [[ -n "$resolved_editor" ]]; then
                export EDITOR="$resolved_editor"
              fi
              resolved_visual="$(resolve_host_editor_cmd "''${VISUAL:-}")"
              if [[ -n "$resolved_visual" ]]; then
                export VISUAL="$resolved_visual"
              fi

              cd "$workspace"
              exec ${piPkg}/bin/pi "''${pi_args[@]}"
            '';
          in {
            inherit cogitatorInitProject piBasePkg piPkg piSandbox runtimePath runtimeTools;
          };

        defaultCogitator = mkCogitator { };

        # Runs the extension unit tests against the working tree. Provides the pi
        # packages the extensions import (pi-coding-agent + nested pi-ai/pi-tui/
        # pi-agent-core) via a node_modules tree, and `type: module` so Node loads
        # the ESM-only pi-ai correctly. tsx resolves the .js-specifier/.ts files.
        cogitatorTestRunner = pkgs.writeShellScriptBin "cogitator-test" ''
          set -euo pipefail
          repo="''${COGITATOR_REPO:-$PWD}"
          if [[ ! -f "$repo/extensions/tests/unit.ts" ]]; then
            echo "cogitator-test: run from the cogitator repo root (no extensions/tests/unit.ts under $repo)" >&2
            exit 1
          fi
          work="$(mktemp -d)"
          trap 'rm -rf "$work"' EXIT
          pi_nm="${defaultCogitator.piBasePkg}/lib/node_modules/@earendil-works/pi-coding-agent"
          mkdir -p "$work/node_modules/@earendil-works"
          ln -s "$pi_nm" "$work/node_modules/@earendil-works/pi-coding-agent"
          for p in pi-ai pi-tui pi-agent-core; do
            ln -s "$pi_nm/node_modules/@earendil-works/$p" "$work/node_modules/@earendil-works/$p"
          done
          printf '{ "type": "module" }\n' > "$work/package.json"
          cp -r "$repo/extensions" "$work/extensions"
          cd "$work"
          exec ${pkgs.tsx}/bin/tsx extensions/tests/unit.ts
        '';
      in {
        lib = {
          inherit mkCogitator;
        };

        overlays.default = final: prev:
          let
            cog = self.lib.${final.system}.mkCogitator { };
          in {
            cogitator = cog.piSandbox;
            cogitator-init-project = cog.cogitatorInitProject;
            cogitatorLib = {
              mkCogitator = self.lib.${final.system}.mkCogitator;
            };
          };

        packages = {
          default = defaultCogitator.piSandbox;
          cogi = defaultCogitator.piSandbox;
          cogitator = defaultCogitator.piSandbox;
          cogitator-init-project = defaultCogitator.cogitatorInitProject;
          pi-sandbox = defaultCogitator.piSandbox;
          tests = cogitatorTestRunner;
        };

        devShells.default = pkgs.mkShell {
          packages = [ pkgs.nodejs_24 pkgs.tsx cogitatorTestRunner ];
        };

        apps = {
          default = {
            type = "app";
            program = "${defaultCogitator.piSandbox}/bin/cogi";
          };
          cogi = {
            type = "app";
            program = "${defaultCogitator.piSandbox}/bin/cogi";
          };
          cogitator-init-project = {
            type = "app";
            program = "${defaultCogitator.cogitatorInitProject}/bin/cogitator-init-project";
          };
          pi-sandbox = {
            type = "app";
            program = "${defaultCogitator.piSandbox}/bin/cogi";
          };
          test = {
            type = "app";
            program = "${cogitatorTestRunner}/bin/cogitator-test";
          };
        };

      });
}
