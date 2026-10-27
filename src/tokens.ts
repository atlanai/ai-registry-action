import path from "node:path";
import { type Environment, maskSecret } from "./action.ts";
import type { Registry } from "./aireg.ts";
import { GIT_ENVIRONMENT, MIN_REDACTED_TOKEN_CHARS, SYSTEM_PATH, TOKEN_PREFIX } from "./constants.ts";

export type Tokens = Record<string, string>;
export type SubprocessEnvironment = Readonly<Record<string, string>>;

const TOKEN_NAME = new RegExp(`^${TOKEN_PREFIX}[A-Z0-9_]{1,128}$`);

const PROXY_KEYS = [
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy"
] as const;
const TLS_KEYS = ["SSL_CERT_FILE", "SSL_CERT_DIR"] as const;
const LOCALE_KEYS = ["TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"] as const;
const RUNNER_KEYS = ["RUNNER_OS", "RUNNER_ARCH"] as const;
const INSTALL_KEYS = [...LOCALE_KEYS, ...PROXY_KEYS, ...TLS_KEYS, ...RUNNER_KEYS];
// The publisher holds registry tokens, so it keeps the system trust store rather than a caller-chosen one.
const PUBLISH_KEYS = [
  ...LOCALE_KEYS, ...PROXY_KEYS, ...RUNNER_KEYS, "CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "GITHUB_JOB", "GITHUB_REF", "GITHUB_REF_NAME",
  "GITHUB_REF_TYPE", "GITHUB_REPOSITORY", "GITHUB_RUN_ATTEMPT", "GITHUB_RUN_ID", "GITHUB_SHA", "GITHUB_WORKFLOW"
];
const FETCH_KEYS = [...PROXY_KEYS, ...TLS_KEYS];

function pick(environment: Environment, keys: readonly string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of keys) {
    const value = environment[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}

function runtimeEnvironment(environment: Environment, keys: readonly string[], runtimeDirectory: string): SubprocessEnvironment {
  if (!path.isAbsolute(runtimeDirectory)) throw new Error("the action-owned aireg home must be an absolute path");
  return {
    ...pick(environment, keys),
    HOME: runtimeDirectory,
    AIREG_HOME: path.join(runtimeDirectory, ".aireg"),
    AIREG_USER_SCOPE: path.join(runtimeDirectory, "registry"),
    // The action installs the verified release itself, so aireg must not look for another.
    AIREG_DISABLE_UPDATE_CHECK: "1",
    PATH: SYSTEM_PATH
  };
}

/** Adapter installs run downloaded code, so they get no credential of any kind. */
export function installEnvironment(environment: Environment, runtimeDirectory: string): SubprocessEnvironment {
  return runtimeEnvironment(environment, INSTALL_KEYS, runtimeDirectory);
}

/** For `aireg registry list`, which reads the manifest through git but never a registry. */
export function listingEnvironment(environment: Environment, runtimeDirectory: string): SubprocessEnvironment {
  return { ...installEnvironment(environment, runtimeDirectory), ...GIT_ENVIRONMENT };
}

export function publisherEnvironment(environment: Environment, tokens: Tokens, runtimeDirectory: string): SubprocessEnvironment {
  return { ...runtimeEnvironment(environment, PUBLISH_KEYS, runtimeDirectory), ...GIT_ENVIRONMENT, ...tokens };
}

export function fetchEnvironment(environment: Environment): Record<string, string> {
  return pick(environment, FETCH_KEYS);
}

export function tokenVariable(registry: string): string {
  return `${TOKEN_PREFIX}${registry.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}`;
}

export function suppliedTokens(environment: Environment): Tokens {
  const tokens: Tokens = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!name.startsWith(TOKEN_PREFIX) || value === undefined || value === "") continue;
    if (!TOKEN_NAME.test(name)) {
      const shown = /^\w{1,160}$/.test(name) ? name : "a registry token variable";
      throw new Error(`${shown} is not a name aireg reads: use AIREG_TOKEN_ and the registry's name in capitals, with any other character as _`);
    }
    if (/[\r\n]/.test(value)) throw new Error(`${name} must be one line`);
    maskSecret(value);
    tokens[name] = value;
  }
  return tokens;
}

const secretsByEnvironment = new WeakMap<Environment, string[]>();

function secretsOf(environment: Environment): string[] {
  let secrets = secretsByEnvironment.get(environment);
  if (!secrets) {
    // aireg's JSON answers escape quotes and backslashes, so a token is also looked for in its escaped form.
    secrets = Object.entries(environment)
      .filter(([name, value]) => name.startsWith(TOKEN_PREFIX) && value !== undefined && value.length >= MIN_REDACTED_TOKEN_CHARS)
      .flatMap(([, value]) => [...new Set([JSON.stringify(value).slice(1, -1), value as string])]);
    secretsByEnvironment.set(environment, secrets);
  }
  return secrets;
}

/** Log masking does not cover comments, summaries or outputs, so every rendered value passes through here first. */
export function redact(text: unknown, environment: Environment): string {
  return secretsOf(environment).reduce((plain, secret) => plain.replaceAll(secret, "***"), String(text));
}

/** Keeps tokens only when the pull request declares `registries:` exactly as its base does. Any change withholds every
 *  token, because a registry the pull request adds or repoints runs its adapter beside the others' credentials. An
 *  unreadable base (`undefined`) keeps none. */
export function unchangedRegistryTokens(tokens: Tokens, head: readonly Registry[], base: readonly Registry[] | undefined): { tokens: Tokens; withheld: string[] } {
  const declared = (list: readonly Registry[]) => JSON.stringify(list.map(entry => [entry.registry, entry.declaration]).sort());
  const reading = head.filter(entry => Object.hasOwn(tokens, tokenVariable(entry.registry)));
  if (base === undefined || declared(head) !== declared(base)) {
    return { tokens: {}, withheld: [...new Set(reading.map(entry => entry.registry))].sort() };
  }
  const kept: Tokens = {};
  for (const entry of reading) kept[tokenVariable(entry.registry)] = tokens[tokenVariable(entry.registry)] as string;
  return { tokens: kept, withheld: [] };
}
