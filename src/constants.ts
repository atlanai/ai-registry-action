export const GITHUB_SERVER = "https://github.com";
export const GITHUB_API = "https://api.github.com";
export const GITHUB_API_VERSION = "2026-03-10";
export const ACTION_NAME = "ai-registry Action";
export const USER_AGENT = "ai-registry-action";
export const REQUEST_TIMEOUT_MS = 30_000;

export const MAX_EVENT_BYTES = 1024 * 1024;
export const MAX_GITHUB_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_GITHUB_COMMENT_BYTES = 65_000;
export const COMMENT_PAGE_SIZE = 50;
export const MAX_COMMENT_PAGES = 20;

export const COMMIT_SHA = /^[a-f0-9]{40}$/i;

export const MANIFEST_FILE = ".registry/manifest.yml";
export const USAGE_URL = "https://github.com/atlanai/ai-registry-action#quick-start";
export const TOKEN_PREFIX = "AIREG_TOKEN_";
export const PREVIEW_MARKER = "<!-- aireg-publish-preview -->";
export const PUBLISH_FAILURE_MARKER = "<!-- aireg-publish-failure -->";
// Coding-agent handoffs must be https: GitHub strips other link schemes from comments.
export const CLAUDE_CODE_URL = "https://claude.ai/code/new";
export const CODEX_URL = "https://chatgpt.com/codex/deeplink";
export const MAX_FIX_PROMPT_CHARS = 2000;
export const AI_REGISTRY_URL = "https://github.com/atlanai/ai-registry";
// The fix buttons, served from the published action; versioned with its major tag.
export const ASSETS_URL = "https://raw.githubusercontent.com/atlanai/ai-registry-action/v1/docs/assets";
export const RUNTIME_PREFIX = "aireg-publish-";
export const BASE_CHECKOUT_PREFIX = "aireg-publish-base-";

export const CLI_ORIGIN = "https://aireg.sh";
export const CLI_MANIFEST_PATH = "/channels/stable/manifest.json";
export const CLI_ARTIFACT_PATH = "/artifacts/v";
// aireg's release signing keys (ai-registry's RELEASE_TRUSTED_KEYS); only a release one of them signed is run.
export const CLI_RELEASE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "aireg-prod-2026-10-v1": "85sNSOExag/SLliAuZPWqrYqFuGeIaqZbNa9v7mBCHU="
});
// An old signed manifest could be replayed to roll aireg back, so older releases are refused.
export const MINIMUM_CLI_VERSION = "0.1.7";
export const CLI_DOWNLOAD_TIMEOUT_MS = 60_000;
export const BUILT_IN_ADAPTERS: readonly string[] = Object.freeze(["git", "local", "well-known"]);

export const MAX_CLI_BYTES = 192 * 1024 * 1024;
export const MAX_CLI_MANIFEST_BYTES = 1024 * 1024;
export const MAX_CLI_OUTPUT_BYTES = 1024 * 1024;
export const MAX_CONFIG_BYTES = 256 * 1024;
export const MAX_REGISTRIES = 50;
export const MAX_PUBLISHED_ARTIFACTS = 1000;
export const MAX_ARTIFACT_DEPENDENCIES = 100;
export const MAX_CHANGED_FILES = 1000;
export const MAX_CHANGED_PATH_CHARS = 1024;
export const MAX_FIELD_CHARS = 200;
export const MAX_REASON_CHARS = 1000;
export const MAX_SKIP_REASON_CHARS = 500;
export const MAX_FAILURE_MESSAGE_CHARS = 500;
export const MAX_LISTED_CHANGES = 20;
export const MAX_COMMENT_LISTED_CHANGES = 3;
// Shorter values are too likely to match ordinary report text, such as a version.
export const MIN_REDACTED_TOKEN_CHARS = 8;

export const GIT_TIMEOUT_MS = 120_000;
export const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
export const SYSTEM_PATH = "/usr/bin:/bin";
export const GIT_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  PATH: SYSTEM_PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0"
});
