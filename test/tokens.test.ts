import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { declaredRegistries } from "../src/aireg.ts";
import { SYSTEM_PATH } from "../src/constants.ts";
import {
  fetchEnvironment, installEnvironment, listingEnvironment, publisherEnvironment, redact, suppliedTokens, tokenVariable,
  unchangedRegistryTokens
} from "../src/tokens.ts";
import { captureStdout } from "./helpers/action.ts";
import { registryList } from "./helpers/fixtures.ts";

describe("suppliedTokens", () => {
  it("keeps each non-empty AIREG_TOKEN_* value and masks it in the log", t => {
    const written = captureStdout(t);
    const tokens = suppliedTokens({
      AIREG_TOKEN_ACME: "synthetic-a", AIREG_TOKEN_TEAM_B: "synthetic-b", AIREG_TOKEN_WITHHELD: "", AIREG_TOKEN_UNSET: undefined,
      OTHER_TOKEN: "synthetic-other"
    });
    assert.deepEqual(tokens, { AIREG_TOKEN_ACME: "synthetic-a", AIREG_TOKEN_TEAM_B: "synthetic-b" });
    assert.deepEqual(written, ["::add-mask::synthetic-a\n", "::add-mask::synthetic-b\n"]);
  });

  for (const [name, message] of [
    ["AIREG_TOKEN_acme", /^AIREG_TOKEN_acme is not a name aireg reads: use AIREG_TOKEN_ and the registry's name in capitals/],
    ["AIREG_TOKEN_A-B", /^a registry token variable is not a name aireg reads/],
    ["AIREG_TOKEN_\u202eX", /^a registry token variable is not a name aireg reads/],
    [`AIREG_TOKEN_${"A".repeat(200)}`, /^a registry token variable is not a name aireg reads/]
  ] as const) {
    it(`refuses the variable ${JSON.stringify(name.slice(0, 24))} before masking anything`, t => {
      const written = captureStdout(t);
      assert.throws(() => suppliedTokens({ [name]: "synthetic-token" }), { message });
      assert.deepEqual(written, []);
    });
  }

  it("refuses a value with a line break, naming only the variable", t => {
    captureStdout(t);
    assert.throws(() => suppliedTokens({ AIREG_TOKEN_ACME: "synthetic\ntoken" }), { message: "AIREG_TOKEN_ACME must be one line" });
  });
});

describe("redact", () => {
  it("replaces every occurrence of each registry token of at least eight characters", () => {
    const environment = { AIREG_TOKEN_ACME: "synthetic-a", AIREG_TOKEN_TEAM: "synthetic-team", AIREG_TOKEN_SHORT: "1.2.3", GITHUB_TOKEN: "synthetic-github" };
    assert.equal(
      redact("synthetic-a refused synthetic-team; synthetic-a again; 1.2.3 and synthetic-github stay", environment),
      "*** refused ***; *** again; 1.2.3 and synthetic-github stay"
    );
  });

  it("also replaces a token as a JSON answer escapes it", () => {
    const token = 'synthetic"registry\\token';
    const answer = JSON.stringify({ error: { message: `refused ${token}` } });
    const redacted = redact(answer, { AIREG_TOKEN_ACME: token });
    assert.doesNotMatch(redacted, /synthetic/);
    assert.deepEqual(JSON.parse(redacted), { error: { message: "refused ***" } });
    assert.equal(redact(`raw ${token}`, { AIREG_TOKEN_ACME: token }), "raw ***");
  });

  it("renders non-string values as text", () => {
    assert.equal(redact(12345678, { AIREG_TOKEN_ACME: "12345678" }), "***");
    assert.equal(redact(undefined, {}), "undefined");
  });
});

describe("tokenVariable", () => {
  for (const [registry, variable] of [["acme", "AIREG_TOKEN_ACME"], ["team-b", "AIREG_TOKEN_TEAM_B"], ["my.registry", "AIREG_TOKEN_MY_REGISTRY"]] as const) {
    it(`names ${registry}'s token ${variable}`, () => {
      assert.equal(tokenVariable(registry), variable);
    });
  }
});

describe("unchangedRegistryTokens", () => {
  const declared = (...entries: unknown[]) => declaredRegistries(registryList(entries));
  const acme = { registry: "acme", address: "https://registry.example.com", adapter: "acme", config: {} };
  const team = { registry: "team", address: "https://github.com/acme/registry", adapter: "git", config: { ref: "main" } };
  const tokens = { AIREG_TOKEN_ACME: "synthetic-a", AIREG_TOKEN_TEAM: "synthetic-t" };
  const keep = (head: unknown[], base: unknown[] | undefined) =>
    unchangedRegistryTokens(tokens, declared(...head), base === undefined ? undefined : declared(...base));

  const cases: [string, unknown[], unknown[] | undefined, ReturnType<typeof keep>][] = [
    ["keeps tokens whose declarations match in any key order", [acme, team],
      [{ config: { ref: "main" }, adapter: "git", address: team.address, registry: "team" }, acme], { tokens, withheld: [] }],
    ["passes only the tokens of declared registries", [acme], [acme], { tokens: { AIREG_TOKEN_ACME: "synthetic-a" }, withheld: [] }],
    ["withholds every token when the pull request adds a registry", [acme, team], [acme], { tokens: {}, withheld: ["acme", "team"] }],
    ["withholds every token when the pull request removes a registry", [acme], [acme, team], { tokens: {}, withheld: ["acme"] }],
    ["withholds every token when one address is repointed", [{ ...acme, address: "https://registry.example" }, team], [acme, team], { tokens: {}, withheld: ["acme", "team"] }],
    ["withholds every token when one adapter changes", [{ ...acme, adapter: "well-known" }, team], [acme, team], { tokens: {}, withheld: ["acme", "team"] }],
    ["withholds every token when one configuration changes", [{ ...acme, config: { namespace: "other" } }, team], [acme, team], { tokens: {}, withheld: ["acme", "team"] }],
    ["withholds every token when an adapter is removed", [{ ...acme, adapter: undefined }, team], [acme, team], { tokens: {}, withheld: ["acme", "team"] }],
    ["withholds every token when another registry name collides onto one", [acme, team, { ...team, registry: "TEAM" }], [acme, team],
      { tokens: {}, withheld: ["TEAM", "acme", "team"] }],
    ["withholds every token when the base declares no registries", [acme, team], [], { tokens: {}, withheld: ["acme", "team"] }],
    ["withholds every token when the base is unreadable", [acme, team], undefined, { tokens: {}, withheld: ["acme", "team"] }]
  ];
  for (const [name, head, base, expected] of cases) {
    it(name, () => {
      assert.deepEqual(keep(head, base), expected);
    });
  }
});

describe("installEnvironment, listingEnvironment, publisherEnvironment and fetchEnvironment", () => {
  const hostile = {
    HOME: "/caller/home",
    PATH: "/hostile/bin",
    LANG: "en_US.UTF-8",
    TMPDIR: "/runner/tmp",
    HTTPS_PROXY: "http://proxy.example:3128",
    no_proxy: "localhost",
    RUNNER_OS: "Linux",
    GITHUB_REPOSITORY: "acme/skills",
    LD_PRELOAD: "/hostile/inject.so",
    DYLD_INSERT_LIBRARIES: "/hostile/inject.dylib",
    GIT_EXEC_PATH: "/hostile/git-core",
    SSL_CERT_FILE: "/hostile/ca.pem",
    SSL_CERT_DIR: "/hostile/certs",
    AIREG_HOME: "/caller/aireg",
    AIREG_TOKEN_OTHER: "synthetic-caller-token",
    ACTIONS_RUNTIME_TOKEN: "synthetic-runner-token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-oidc-token",
    "INPUT_GITHUB-TOKEN": "synthetic-github-token",
    UNEXPECTED_SECRET: "synthetic-future-secret"
  };
  const owned = {
    HOME: "/action-owned/runtime",
    AIREG_HOME: "/action-owned/runtime/.aireg",
    AIREG_USER_SCOPE: "/action-owned/runtime/registry",
    AIREG_DISABLE_UPDATE_CHECK: "1",
    PATH: SYSTEM_PATH
  };
  const git = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  const installing = {
    LANG: "en_US.UTF-8", TMPDIR: "/runner/tmp", HTTPS_PROXY: "http://proxy.example:3128", no_proxy: "localhost", RUNNER_OS: "Linux",
    SSL_CERT_FILE: "/hostile/ca.pem", SSL_CERT_DIR: "/hostile/certs"
  };

  it("gives installation the runtime home and network settings, and no credential", () => {
    assert.deepEqual(installEnvironment(hostile, owned.HOME), { ...installing, ...owned });
  });

  it("gives registry listing the installation environment plus isolated git", () => {
    assert.deepEqual(listingEnvironment(hostile, owned.HOME), { ...installing, ...owned, ...git });
  });

  it("gives the publisher its tokens and run identity, but not a caller trust store", () => {
    assert.deepEqual(publisherEnvironment(hostile, { AIREG_TOKEN_ACME: "synthetic-publish-token" }, owned.HOME), {
      LANG: "en_US.UTF-8", TMPDIR: "/runner/tmp", HTTPS_PROXY: "http://proxy.example:3128", no_proxy: "localhost", RUNNER_OS: "Linux",
      GITHUB_REPOSITORY: "acme/skills", ...owned, ...git, AIREG_TOKEN_ACME: "synthetic-publish-token"
    });
  });

  it("gives the base fetch only proxy and trust-store settings", () => {
    assert.deepEqual(fetchEnvironment(hostile), {
      HTTPS_PROXY: "http://proxy.example:3128", no_proxy: "localhost", SSL_CERT_FILE: "/hostile/ca.pem", SSL_CERT_DIR: "/hostile/certs"
    });
  });

  for (const build of [installEnvironment, listingEnvironment, (environment: typeof hostile, directory: string) => publisherEnvironment(environment, {}, directory)]) {
    it(`refuses a relative runtime directory (${build.name || "publisher"})`, () => {
      assert.throws(() => build(hostile, "runtime"), /must be an absolute path/);
    });
  }
});
