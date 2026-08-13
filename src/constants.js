export const GENERATOR_NAME = "create-ai-native-sdlc";
export const TEMPLATE_SET = "core/v1";
export const DEFAULT_CONFIG_PATH = "ai-native.yaml";
export const MANIFEST_PATH = ".ai-sdlc/manifest.json";

export const BLOCK_MARKERS = {
  markdown: {
    start: "<!-- ai-native-sdlc:start -->",
    end: "<!-- ai-native-sdlc:end -->"
  },
  hash: {
    start: "# ai-native-sdlc:start",
    end: "# ai-native-sdlc:end"
  }
};
