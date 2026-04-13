{
  description = "Sandboxed pi launcher for NixOS using bubblewrap";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        lib = pkgs.lib;

        piVersion = "0.65.2";
        defaultControlRoot = "/home/kaddu/.local/share/cogitator";
        workflowExtension = ./extensions/workflow-mode.ts;
        controlRootGitignore = ./control-root.gitignore;
        piPackageLock = ./pi-package-lock.json;

        piSrc = pkgs.fetchzip {
          url = "https://registry.npmjs.org/@mariozechner/pi-coding-agent/-/pi-coding-agent-${piVersion}.tgz";
          hash = "sha256-2b/PMyyNUGVXUVZ754e72RKQPIxkogFV2Te4/L+Ol1s=";
          stripRoot = false;
        };

        piBasePkg = pkgs.buildNpmPackage rec {
          pname = "pi-coding-agent";
          version = piVersion;
          src = piSrc;
          sourceRoot = "source/package";
          npmDepsHash = "sha256-WGRqUm73WJAjinKdyIMi0d2JTkVnTCL/PxuQ6GR2wiM=";

          dontNpmBuild = true;
          npmPackFlags = [ "--ignore-scripts" ];

          postPatch = ''
            cp ${piPackageLock} package-lock.json
          '';

          postInstall = ''
            mkdir -p $out/share/pi
            cp -r dist docs examples package.json CHANGELOG.md README.md $out/share/pi/

            makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/pi \
              --add-flags $out/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js \
              --prefix PATH : ${lib.makeBinPath [ pkgs.git ]}
          '';

          nativeBuildInputs = [ pkgs.makeWrapper ];
        };

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

        renderReadonlyBindLines = bindings:
          lib.concatStringsSep "\n" (
            map (
              binding: ''
                if [[ -f ${lib.escapeShellArg binding.source} ]]; then
                  resolved_source="$(readlink -f ${lib.escapeShellArg binding.source})"
                  if [[ -f "$resolved_source" ]]; then
                    bind_args+=(--ro-bind "$resolved_source" ${lib.escapeShellArg binding.target})
                  fi
                fi
              ''
            ) bindings
          );

        mkSecretBindings = secretFiles:
          lib.mapAttrsToList (name: path: {
            source = toString path;
            target = "/run/cogitator-secrets/${name}";
          }) secretFiles;

        mkPiProviderAuthAttrs = providerId: cfg:
          let
            mountedApiKey = "!cat /run/cogitator-secrets/provider-${providerId}.key";
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
            protectedSecretPaths = map (binding: binding.target) secretBindings;
            extensions = [ workflowExtension ] ++ extraExtensions;
            extensionFlags = lib.concatStringsSep " \\\n            " (
              map (path: "--extension ${lib.escapeShellArg (toString path)}") extensions
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
                ripgrep
                fd
                bubblewrap
                cacert
                nodejs_22
                python3
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

              usage() {
                cat <<'EOF'
Usage: cogi [--workspace PATH] [--control-root PATH] [--project-id ID] [--host-pi-auth] [--bind-ro SRC[:DEST]] [--bind-rw SRC[:DEST]] [--] [pi args...]

Options:
  --workspace PATH     Workspace to mount writable inside the sandbox.
                       Defaults to current working directory.
  --control-root PATH  Central cogitator control root containing projects/<id>/project.json.
                       Default: ${controlRoot}
  --project-id ID      Preselect a cogitator project id instead of prompting at startup.
  --host-pi-auth       Use host ~/.pi/agent auth.json and models.json inside the sandbox agent dir.
  --bind-ro SPEC       Extra read-only bind mount. SPEC is SRC or SRC:DEST.
  --bind-rw SPEC       Extra read-write bind mount. SPEC is SRC or SRC:DEST.
  --help               Show this help.

Level 2 defaults:
  - workspace is writable
  - control root is writable for project state and artifacts, but only the configured control-root subtree is exposed at its host absolute path
  - /nix/store is mounted read-only
  - HOME is isolated at /tmp/home
  - private /tmp
  - network is enabled for cloud providers
  - no access to host home, /var, or /run unless explicitly bound
EOF
              }

              workspace="$PWD"
              control_root="${controlRoot}"
              project_id="${if defaultProjectId == null then "" else defaultProjectId}"
              bind_host_pi_auth=0
              declare -a extra_ro_binds=()
              declare -a extra_rw_binds=()
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
                  --project-id)
                    project_id="$2"
                    shift 2
                    ;;
                  --host-pi-auth)
                    bind_host_pi_auth=1
                    shift
                    ;;
                  --bind-ro)
                    extra_ro_binds+=("$2")
                    shift 2
                    ;;
                  --bind-rw)
                    extra_rw_binds+=("$2")
                    shift 2
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

              mkdir -p "$control_root/projects"

              gitignore_path="$control_root/.gitignore"
              if [[ ! -e "$gitignore_path" ]]; then
                cp ${controlRootGitignore} "$gitignore_path"
              fi

              workspace="$(readlink -f "$workspace")"
              control_root="$(readlink -f "$control_root")"

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
              if [[ -n "${HOME:-}" ]]; then
                mkdir -p "$HOME/.pi/agent"
                host_pi_agent_dir="$(readlink -f "$HOME/.pi/agent")"
                host_pi_settings_json="$host_pi_agent_dir/settings.json"
                host_pi_models_json="$host_pi_agent_dir/models.json"
                host_pi_auth_json="$host_pi_agent_dir/auth.json"
              elif [[ "$bind_host_pi_auth" -eq 1 ]]; then
                echo "--host-pi-auth requires HOME to be set in the calling environment" >&2
                exit 1
              fi

              agent_dir_host="$(mktemp -d)"
              trap 'if [[ -n "$host_pi_auth_json" && -e "$agent_dir_host/auth.json" ]]; then cp "$agent_dir_host/auth.json" "$host_pi_auth_json"; fi; rm -rf "$agent_dir_host"' EXIT
              cat > "$agent_dir_host/cogitator-models.json" <<'EOF'
${builtins.toJSON piModelsConfig}
EOF
              cat > "$agent_dir_host/cogitator-settings.json" <<'EOF'
${builtins.toJSON ({
                defaultProvider = checkedPlainEnv.COGITATOR_DEFAULT_PROVIDER or null;
                defaultModel = checkedPlainEnv.COGITATOR_DEFAULT_MODEL or null;
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
    if value is not None:
        result[key] = value

with open(sys.argv[3], "w", encoding="utf-8") as handle:
    json.dump(result, handle, indent=2)
    handle.write("\n")
PY
              if [[ -n "$host_pi_auth_json" && -e "$host_pi_auth_json" ]]; then
                cp "$host_pi_auth_json" "$agent_dir_host/auth.json"
              fi

              matching_project_dirs="$(${pkgs.python3}/bin/python - <<'PY' "$control_root/projects" "$workspace" "$project_id"
import json
import os
import sys

projects_root = sys.argv[1]
workspace = os.path.realpath(sys.argv[2])
project_id = sys.argv[3].strip()


def matches_workspace(project_json_path: str) -> bool:
    try:
        with open(project_json_path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return False

    repos = data.get("repos")
    if not isinstance(repos, list):
        return False

    for repo in repos:
        if not isinstance(repo, dict):
            continue
        repo_path = repo.get("path")
        if not isinstance(repo_path, str) or not repo_path:
            continue

        linked = os.path.realpath(repo_path)
        try:
            common = os.path.commonpath([workspace, linked])
        except ValueError:
            continue

        if common == linked or common == workspace:
            return True

    return False


if project_id:
    project_dir = os.path.join(projects_root, project_id)
    if os.path.isdir(project_dir):
        print(os.path.realpath(project_dir))
elif os.path.isdir(projects_root):
    for entry in sorted(os.listdir(projects_root)):
        project_dir = os.path.join(projects_root, entry)
        if not os.path.isdir(project_dir):
            continue
        if matches_workspace(os.path.join(project_dir, "project.json")):
            print(os.path.realpath(project_dir))
PY
              )"

              add_bind() {
                local mode="$1"
                local spec="$2"
                local src dest
                if [[ "$spec" == *:* ]]; then
                  src="''${spec%%:*}"
                  dest="''${spec#*:}"
                else
                  src="$spec"
                  dest="$spec"
                fi
                src="$(readlink -f "$src")"
                if [[ ! -e "$src" ]]; then
                  echo "Bind source does not exist: $src" >&2
                  exit 1
                fi
                bind_args+=("$mode" "$src" "$dest")
              }

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

              declare -a bind_args=()
              sandbox_agent_dir="/tmp/cogitator-pi-agent"
              bind_args+=(--dir "$sandbox_agent_dir")
              bind_args+=(--bind "$agent_dir_host" "$sandbox_agent_dir")

              declare -A mounted_repo_paths=()
              mounted_repo_paths["$workspace"]=1

              if [[ "$control_root" != "$workspace" ]]; then
                # Preserve the host absolute control-root path in the sandbox, but only
                # bind the control-root subtree itself. Parent directories such as
                # ~/.local and ~/.local/share stay synthetic so the model only sees
                # ~/.local/share/cogitator, not unrelated host files under ~/.local.
                bind_args+=(--dir "$control_root")
                bind_args+=(--dir "$control_root/projects")
                bind_args+=(--dir "$sessions_root")
                bind_args+=(--bind "$sessions_root" "$sessions_root")

                if [[ -e "$gitignore_path" ]]; then
                  bind_args+=(--ro-bind "$gitignore_path" "$control_root/.gitignore")
                fi

                while IFS= read -r project_dir; do
                  if [[ -z "$project_dir" ]]; then
                    continue
                  fi
                  project_name="$(basename "$project_dir")"
                  bind_args+=(--dir "$control_root/projects/$project_name")
                  bind_args+=(--bind "$project_dir" "$control_root/projects/$project_name")

                  project_repo_paths="$(${pkgs.python3}/bin/python - <<'PY' "$project_dir/project.json"
import json
import os
import sys

project_json_path = sys.argv[1]

try:
    with open(project_json_path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
except Exception:
    sys.exit(0)

repos = data.get("repos")
if not isinstance(repos, list):
    sys.exit(0)

for repo in repos:
    if not isinstance(repo, dict):
        continue
    repo_path = repo.get("path")
    if not isinstance(repo_path, str) or not repo_path:
        continue
    print(os.path.realpath(repo_path))
PY
                  )"

                  while IFS= read -r repo_path; do
                    if [[ -z "$repo_path" || -n "''${mounted_repo_paths[$repo_path]:-}" ]]; then
                      continue
                    fi
                    if [[ ! -d "$repo_path" ]]; then
                      echo "Warning: linked repo path is missing, skipping bind: $repo_path" >&2
                      continue
                    fi
                    mounted_repo_paths["$repo_path"]=1
                    bind_args+=(--bind "$repo_path" "$repo_path")
                  done <<< "$project_repo_paths"
                done <<< "$matching_project_dirs"
              fi

              for etc_name in hosts resolv.conf nsswitch.conf; do
                if [[ -e "/etc/$etc_name" ]]; then
                  resolved_etc="$(readlink -f "/etc/$etc_name")"
                  if [[ -e "$resolved_etc" ]]; then
                    bind_args+=(--ro-bind "$resolved_etc" "/etc/$etc_name")
                  fi
                fi
              done

              ${renderReadonlyBindLines secretBindings}

              for spec in "''${extra_ro_binds[@]}"; do
                add_bind --ro-bind "$spec"
              done
              for spec in "''${extra_rw_binds[@]}"; do
                add_bind --bind "$spec"
              done

              declare -a bwrap_args=(
                --unshare-all
                --share-net
                --die-with-parent
                --new-session
                --ro-bind /nix/store /nix/store
                --proc /proc
                --dev /dev
                --dir /bin
                --dir /etc
                --symlink ${pkgs.bash}/bin/bash /bin/sh
                --symlink ${pkgs.bash}/bin/bash /bin/bash
                --tmpfs /tmp
                --dir /run
                --dir /run/cogitator-secrets
                --bind "$workspace" "$workspace"
                --chdir "$workspace"
                --clearenv
                --setenv HOME /tmp/home
                --dir /tmp/home
                --setenv TMPDIR /tmp
                --setenv PATH "${runtimePath}"
                --setenv SSL_CERT_FILE "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                --setenv NIX_SSL_CERT_FILE "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                --setenv PI_SKIP_VERSION_CHECK 1
                --setenv PI_CODING_AGENT_DIR "$sandbox_agent_dir"
                --setenv COGITATOR_CONTROL_ROOT "$control_root"
              )

              if [[ -n "$project_id" ]]; then
                bwrap_args+=(--setenv COGITATOR_PROJECT_ID "$project_id")
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
                    resolved_bin="$(readlink -f "$editor_bin")"
                  fi
                else
                  local host_editor_path=""
                  host_editor_path="$(command -v "$editor_bin" 2>/dev/null || true)"
                  if [[ -n "$host_editor_path" && -e "$host_editor_path" ]]; then
                    resolved_bin="$(readlink -f "$host_editor_path")"
                  fi
                fi

                if [[ -n "$resolved_bin" ]]; then
                  printf '%s%s\n' "$resolved_bin" "$editor_rest"
                else
                  printf '%s\n' "$editor_cmd"
                fi
              }

              resolved_editor="$(resolve_host_editor_cmd "''${EDITOR:-}")"
              if [[ -n "$resolved_editor" ]]; then
                bwrap_args+=(--setenv EDITOR "$resolved_editor")
              fi

              resolved_visual="$(resolve_host_editor_cmd "''${VISUAL:-}")"
              if [[ -n "$resolved_visual" ]]; then
                bwrap_args+=(--setenv VISUAL "$resolved_visual")
              fi

              bwrap_args+=("''${bind_args[@]}")

              ${pkgs.bubblewrap}/bin/bwrap \
                "''${bwrap_args[@]}" \
                ${piPkg}/bin/pi \
                "''${pi_args[@]}"
            '';
          in {
            inherit cogitatorInitProject piBasePkg piPkg piSandbox runtimePath runtimeTools;
          };

        defaultCogitator = mkCogitator { };
      in {
        lib = {
          inherit mkCogitator;
        };

        overlays.default = final: prev:
          let
            cog = self.lib.${final.system}.mkCogitator { };
          in {
            cogitator = cog.piSandbox;
            cogitator-pi = cog.piPkg;
            cogitator-pi-base = cog.piBasePkg;
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
          cogitator-pi = defaultCogitator.piPkg;
          cogitator-pi-base = defaultCogitator.piBasePkg;
          pi = defaultCogitator.piPkg;
          pi-base = defaultCogitator.piBasePkg;
          pi-sandbox = defaultCogitator.piSandbox;
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
          pi = {
            type = "app";
            program = "${defaultCogitator.piPkg}/bin/pi";
          };
          pi-base = {
            type = "app";
            program = "${defaultCogitator.piBasePkg}/bin/pi";
          };
          pi-sandbox = {
            type = "app";
            program = "${defaultCogitator.piSandbox}/bin/cogi";
          };
        };

      });
}
