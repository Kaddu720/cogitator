{ config, lib, pkgs, cogitator, ... }:
let
  cfg = config.ai.cogitator;
  cog = cogitator.lib.${pkgs.system}.mkCogitator {
    plainEnv = cfg.plainEnv;
    secretEnvFiles = cfg.secretEnvFiles;
    providerConfigs = cfg.providerConfigs;
    modeModels = cfg.modeModels;
    extraExtensions = cfg.extraExtensions;
    extraRuntimeTools = cfg.extraRuntimeTools;
    defaultProjectId = cfg.defaultProjectId;
  };
in {
  options.ai.cogitator = {
    enable = lib.mkEnableOption "Cogitator Home Manager integration";

    plainEnv = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Plain environment variables passed through to Cogitator.";
    };

    secretEnvFiles = lib.mkOption {
      type = lib.types.attrsOf lib.types.path;
      default = { };
      description = "Environment variable names mapped to secret file paths staged for Cogitator.";
    };

    providerConfigs = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = { };
      description = "Provider configuration attrset passed to mkCogitator.";
    };

    modeModels = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = { };
      description = "Mode-specific model configuration passed to mkCogitator.";
    };

    extraExtensions = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ ];
      description = "Additional Pi extensions to load into Cogitator.";
    };

    extraRuntimeTools = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      description = "Additional runtime tools available to Cogitator.";
    };

    defaultProjectId = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Default Cogitator project ID.";
    };

    package = lib.mkOption {
      type = lib.types.enum [ "piSandbox" "cogitatorInitProject" ];
      default = "piSandbox";
      description = "Which Cogitator package to install via Home Manager.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cog.${cfg.package} ];
  };
}
