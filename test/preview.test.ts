import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { Artifact, Command } from "../src/aireg.ts";
import type { GitHubRequest, GitHubRequestOptions } from "../src/github.ts";
import { type Install, installCli } from "../src/install.ts";
import { type Checkout, checkoutBase, registryChanges, runPreview } from "../src/preview.ts";
import { type Git, type GitResult, runGit } from "../src/workspace.ts";
import { assertMarkdownSnapshot, captureStdout, outputsOf, outputValue, temporaryDirectory } from "./helpers/action.ts";
import {
  ECHOED_ENVIRONMENT, echoedResult, exported, EXPORTS, MANIFEST, PLANNER, publishAnswer, pullRequestCheckout,
  pullRequestPayload, refusal, registryList, stepEnvironment
} from "./helpers/fixtures.ts";
import { git, writeFiles } from "./helpers/git.ts";

type Answer = () => string;

interface PreviewCase {
  answer: Answer;
  baseAnswer?: Answer;
  environment?: Record<string, string>;
  manifest?: string | null;
  base?: string | null;
  head?: string | null;
  existing?: unknown[];
  payload?: (baseSha: string) => unknown;
  checkout?: Checkout;
  install?: Install;
}

interface Dispatched {
  at: "head" | "base" | "runtime";
  args: string[];
  tokens: string[];
}

const TOKENS = { AIREG_TOKEN_ACME: "synthetic-acme-token", AIREG_TOKEN_TEAM: "synthetic-team-token" };
const ACME = "acme: { source: https://registry.example.com, adapter: acme }";
const TEAM = "team: { source: https://github.com/acme/registry, adapter: git }";
const declare = (...registries: string[]) => `registries:\n${registries.map(line => `  ${line}\n`).join("")}exports:\n  - skills/*\npublish:\n  to: acme/engineering\n`;
const dryRunOf = (artifacts: unknown[], options: Parameters<typeof publishAnswer>[1] = {}) => () => publishAnswer(artifacts, { ...options, dryRun: true });
const refused = (code: string, message: string, hint: string): Answer => () => {
  throw refusal(code, message, hint);
};
const unauthorized = refused("unauthorized", "Sign in to acme.", "Set AIREG_TOKEN_ACME.");
const rejected = refused("rejected", "skill review: its description is empty.", "Add a description.");

const settled = (raw: string): string => {
  const answer = JSON.parse(raw) as { data: { artifacts: Artifact[] } };
  answer.data.artifacts = answer.data.artifacts.map(item => ({ ...item, version: item.from ?? item.version, published: false }));
  return JSON.stringify(answer);
};

function listRegistries(manifest: string): string {
  const registries = [];
  for (const line of manifest.split("\n")) {
    const match = /^ {2}([\w.-]+): \{ source: ([^,}]+?)(?:, adapter: ([\w-]+))?(?:, (.+?))? \}$/.exec(line);
    if (match) registries.push({ registry: match[1], address: match[2], ...(match[3] ? { adapter: match[3] } : {}), config: match[4] ? { rest: match[4] } : {} });
  }
  return registryList(registries);
}

async function previewRun(t: TestContext, {
  answer, baseAnswer = () => settled(answer()), environment = {}, manifest = MANIFEST, base = manifest, head = "acme/skills", existing = [],
  payload, checkout, install: given
}: PreviewCase) {
  const { workspace, baseSha } = await pullRequestCheckout(t, { base, manifest });
  const step = await stepEnvironment(t, {
    "INPUT_GITHUB-TOKEN": "synthetic-github-token", GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: "acme/skills",
    GITHUB_WORKSPACE: workspace, ...environment
  });
  const stdout = captureStdout(t);
  const dispatched: Dispatched[] = [];
  const runtimes: string[] = [];
  const execute = async ({ args, cwd, env }: Command) => {
    const at = cwd === workspace ? "head" : cwd.endsWith(`${path.sep}base`) ? "base" : "runtime";
    dispatched.push({ at, args: [...args], tokens: Object.keys(env).filter(key => key.startsWith("AIREG_TOKEN_")).sort() });
    if (args[0] === "registry") {
      const listed = await readFile(path.join(cwd, ".registry", "manifest.yml"), "utf8");
      return listed.includes("# unlistable") ? "not json" : listRegistries(listed);
    }
    if (args[0] !== "publish") return "";
    return at === "head" ? answer() : baseAnswer();
  };
  const install: Install = given ?? (async options => {
    const installed = await installCli({ ...options, release: async () => ({ version: "0.2.0", artifacts: [] }), download: async () => Buffer.from(""), execute });
    runtimes.push(installed.directory);
    return installed;
  });
  const github: GitHubRequestOptions[] = [];
  const request: GitHubRequest = async options => {
    github.push(options);
    if (options.requestPath === "/user") return { login: "github-actions[bot]", type: "Bot" };
    if (options.requestPath.includes("/issues/8/comments?")) return existing;
    return { id: options.method === "PATCH" ? (existing[0] as { id: number }).id : 101 };
  };
  const error = await runPreview({
    environment: step.environment, payload: payload ? payload(baseSha) : pullRequestPayload({ baseSha, headRepository: head }), request, install, execute,
    ...(checkout ? { checkout } : {})
  }).then(() => undefined, (caught: unknown) => caught as Error);
  assert.equal(git(workspace, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1, "the base worktree is removed");
  for (const runtime of runtimes) assert.equal(existsSync(runtime), false, "the runtime directory is removed");
  const write = github.find(options => options.method === "POST" || options.method === "PATCH");
  const publishes = dispatched.filter(call => call.args[0] === "publish");
  return {
    error, github, write, stdout, dispatched, publishes,
    body: (write?.body as { body?: string } | undefined)?.body ?? "",
    output: await outputsOf(step.output),
    summary: await outputsOf(step.summary)
  };
}

const tokensSeen = (run: { publishes: Dispatched[] }) => [...new Set(run.publishes.flatMap(call => call.tokens))].sort();
const ANSWER = dryRunOf(EXPORTS, { skipped: [PLANNER] });

describe("registryChanges", () => {
  it("names registries the pull request adds, removes, or declares differently", () => {
    const entry = (registry: string, declaration = registry) => ({ registry, declaration });
    assert.deepEqual(registryChanges([entry("acme", "new"), entry("team"), entry("same")], [entry("acme"), entry("old"), entry("same")]), {
      added: ["team"], removed: ["old"], changed: ["acme"]
    });
    assert.deepEqual(registryChanges([], []), { added: [], removed: [], changed: [] });
  });
});

describe("runPreview", () => {
  it("dry-runs head and base with the same tokens and comments what merging publishes", async t => {
    const run = await previewRun(t, { answer: ANSWER, environment: { AIREG_TOKEN_ACME: TOKENS.AIREG_TOKEN_ACME } });
    assert.equal(run.error, undefined);
    assert.deepEqual(run.publishes, [
      { at: "head", args: ["publish", "--yes", "--json", "--dry-run"], tokens: ["AIREG_TOKEN_ACME"] },
      { at: "base", args: ["publish", "--yes", "--json", "--dry-run"], tokens: ["AIREG_TOKEN_ACME"] }
    ]);
    assert.deepEqual(run.write && { method: run.write.method, requestPath: run.write.requestPath }, { method: "POST", requestPath: "/repos/acme/skills/issues/8/comments" });
    assert.match(run.body, /^<!-- aireg-publish-preview -->\n<h3>✅ Ready to merge<\/h3>\n<p>Merging publishes <b>2 artifacts<\/b> to <code>acme\/engineering<\/code> · 1 new · 1 update<\/p>$/m);
    assert.equal(run.summary, `${run.body.slice("<!-- aireg-publish-preview -->\n".length)}\n`);
    assert.deepEqual(run.output.split("\n").map(line => line.slice(0, line.indexOf("="))), [
      "comment-id", "published", "unchanged", "skipped", "conflict-count", "status", "aireg-version", ""
    ]);
    assert.match(run.output, /^comment-id=101\n[\s\S]*\nconflict-count=0\nstatus=success\naireg-version=0\.2\.0\n$/);
    assert.deepEqual((outputValue(run.output, "published") as { name: string }[]).map(item => item.name), ["review", "triage"]);
    assert.deepEqual((outputValue(run.output, "unchanged") as { name: string }[]).map(item => item.name), ["sql-style"]);
    assert.deepEqual(outputValue(run.output, "skipped"), [PLANNER]);
  });

  it("gives registry tokens only to the dry runs, never to installation or listing", async t => {
    const run = await previewRun(t, { answer: ANSWER, environment: TOKENS });
    const installing = run.dispatched.filter(call => call.args[0] !== "publish");
    assert.deepEqual(installing.map(call => call.args.slice(0, 2).join(" ")), ["registry list", "registry list", "adapter install"]);
    assert.deepEqual(installing.flatMap(call => call.tokens), []);
    assert.ok(run.stdout.includes("::add-mask::synthetic-github-token\n"));
    assert.ok(run.stdout.includes("::add-mask::synthetic-acme-token\n"));
  });

  it("updates the bot's existing comment instead of adding another", async t => {
    const existing = [{ id: 55, body: "<!-- aireg-publish-preview -->\nold", user: { login: "github-actions[bot]", type: "Bot" } }];
    const run = await previewRun(t, { answer: dryRunOf([]), existing });
    assert.deepEqual(run.write && { method: run.write.method, requestPath: run.write.requestPath }, { method: "PATCH", requestPath: "/repos/acme/skills/issues/comments/55" });
    assert.match(run.body, /^<h3>✅ Ready to merge<\/h3>\n<p>The manifest exports nothing\.<\/p>$/m);
    assert.match(run.output, /^comment-id=55\n/);
  });

  it("says merging publishes nothing when the target takes none of the exports", async t => {
    const run = await previewRun(t, { answer: dryRunOf([], { skipped: [{ name: "planner", kind: "agent", reason: "not taken" }] }) });
    assert.match(run.body, /^<h3>✅ Ready to merge<\/h3>\n<p><code>acme\/engineering<\/code> accepts none of these exports\.<\/p>\n\n<details><summary>Not published: 1 skipped<\/summary>\n\n<table>\n<tr><th align="left" width="330">Artifact<\/th><th align="left" width="430">Why<\/th><\/tr>\n<tr><td><code>planner<\/code> <sub>agent<\/sub><\/td><td>not taken<\/td><\/tr>\n<\/table>\n\n<\/details>$/m);
  });

  describe("reads a dry run that names no target as exporting nothing", () => {
    const nothing = dryRunOf([], { target: null });

    it("in the head", async t => {
      const run = await previewRun(t, { answer: nothing, baseAnswer: dryRunOf([exported("review", "0.3.1", "0.3.1")]), environment: TOKENS });
      assert.equal(run.error, undefined);
      assertMarkdownSnapshot(t, run.body);
      assert.match(run.output, /^comment-id=101\npublished=\[\]\nunchanged=\[\]\nskipped=\[\]\nconflict-count=0\nstatus=success\naireg-version=0\.2\.0\n$/);
    });

    it("in the base", async t => {
      const run = await previewRun(t, { answer: dryRunOf([exported("review", null, "0.1.0")]), baseAnswer: nothing, environment: TOKENS });
      assert.equal(run.error, undefined);
      assert.match(run.body, /^<tr><td><code>review<\/code> <sub>skill<\/sub><\/td><td>🆕 New<\/td><td><code>0\.1\.0<\/code><\/td><\/tr>$/m);
      assert.doesNotMatch(run.body, /changes the manifest/);
      assert.doesNotMatch(run.body, /Conflicts were not checked/);
      assert.match(run.body, /^<h3>✅ Ready to merge<\/h3>\n<p>Merging publishes <b>1 artifact<\/b> to <code>acme\/engineering<\/code> · 1 new<\/p>$/m);
    });
  });

  it("fails the check on aireg's refusal, after commenting", async t => {
    const run = await previewRun(t, { answer: rejected, environment: TOKENS });
    assert.match(run.error?.message ?? "", /its description is empty/);
    assert.match(run.body, /^<h3>❌ aireg can't publish this<\/h3>\n<p>skill review: its description is empty\.<\/p>\n<p><b>To fix:<\/b> push a fix to this branch\. This check fails until then\.<br><sub>aireg suggests: Add a description\.<\/sub><\/p>$/m);
    assert.match(run.output, /published=\[\]\nunchanged=\[\]\nskipped=\[\]\nconflict-count=0\nstatus=failed\naireg-version=0\.2\.0\n$/);
    assert.deepEqual(run.publishes.map(call => call.at), ["head"]);
  });

  it("reports an unauthorized dry run without any credential as not compared, and passes", async t => {
    const run = await previewRun(t, { answer: unauthorized, environment: { AIREG_TOKEN_ACME: "" } });
    assert.equal(run.error, undefined);
    assert.deepEqual(run.publishes[0]?.tokens, []);
    assert.match(run.body, /^<h3>⚠️ Not compared with the registry<\/h3>\n<p>No registry token reached this run/m);
    assert.match(run.output, /status=success\n/);
  });

  it("fails an unauthorized dry run that had the registry's token, and drops a token no registry reads", async t => {
    const run = await previewRun(t, { answer: refused("unauthorized", "Sign in to acme.", "Check the token."), environment: TOKENS });
    assert.match(run.error?.message ?? "", /Sign in to acme/);
    assert.deepEqual(run.publishes[0]?.tokens, ["AIREG_TOKEN_ACME"]);
    assert.match(run.body, /^<h3>❌ aireg can't publish this<\/h3>\n<p>Sign in to acme\.<\/p>$/m);
    assert.match(run.output, /status=failed/);
  });

  it("redacts a token aireg echoes in its reason", async t => {
    const run = await previewRun(t, { answer: refused("usage", "token synthetic-acme-token is not for team.", "Set `to`."), environment: TOKENS });
    assert.match(run.body, /<\/h3>\n<p>token \*\*\* is not for team\.<\/p>\n<p><b>To fix:<\/b> [^\n]*<br><sub>aireg suggests: Set <code>to<\/code>\.<\/sub><\/p>$/m);
    for (const report of [run.body, run.summary, run.output]) assert.doesNotMatch(report, /synthetic-acme-token/);
  });

  it("fails without running aireg when the manifest is not tracked", async t => {
    const run = await previewRun(t, { answer: () => assert.fail("nothing runs without a manifest"), manifest: null });
    assert.match(run.error?.message ?? "", /^add \.registry\/manifest\.yml/);
    assert.deepEqual(run.dispatched, []);
    assert.match(run.body, /^<h3>❌ aireg can't publish this<\/h3>\n<p>add \.registry\/manifest\.yml with exports and publish\.to to the repository/m);
    assert.equal(run.output, "comment-id=101\npublished=[]\nunchanged=[]\nskipped=[]\nconflict-count=0\nstatus=failed\n");
  });

  describe("withholds every token when the pull request redeclares a registry", () => {
    for (const [change, changed] of [
      ["repoints its source", "acme: { source: https://registry.example, adapter: acme }"],
      ["changes its adapter", "acme: { source: https://registry.example.com, adapter: well-known }"],
      ["changes its configuration", "acme: { source: https://registry.example.com, adapter: acme, namespace: other }"]
    ] as const) {
      it(`when it ${change}`, async t => {
        const run = await previewRun(t, { answer: unauthorized, environment: TOKENS, base: declare(ACME, TEAM), manifest: declare(changed, TEAM) });
        assert.equal(run.error, undefined);
        assert.deepEqual(tokensSeen(run), []);
        assert.match(run.body, /<h3>⚠️ Not compared with the registry<\/h3>\n<p>No token for <code>acme<\/code> and <code>team<\/code>, because this pull request changes <code>registries:<\/code>\.<\/p>\n<p>Once merged, the default branch publishes with these <code>registries:<\/code> and its token, so check them before merging\.<\/p>$/m);
        assert.match(run.body, /^<p>📝 <b>This pull request changes the manifest:<\/b> registries: changes <code>acme<\/code>\.<\/p>$/m);
        assert.match(run.output, /status=success/);
      });
    }
  });

  it("passes every token when the registries are declared as the base declares them", async t => {
    const run = await previewRun(t, { answer: dryRunOf([]), environment: TOKENS, manifest: declare(ACME, TEAM) });
    assert.deepEqual(tokensSeen(run), ["AIREG_TOKEN_ACME", "AIREG_TOKEN_TEAM"]);
    assert.doesNotMatch(run.body, /registries:|No token for/);
  });

  it("withholds every token when the pull request adds a registry, and warns on a passing preview", async t => {
    const run = await previewRun(t, { answer: dryRunOf([]), environment: TOKENS, base: declare(ACME), manifest: declare(ACME, TEAM) });
    assert.equal(run.error, undefined);
    assert.deepEqual(tokensSeen(run), []);
    assert.match(run.body, /^<p>🔒 No token for <code>acme<\/code> and <code>team<\/code>, because this pull request changes <code>registries:<\/code>\.<\/p>$/m);
  });

  it("withholds every token when the pull request removes a registry", async t => {
    const run = await previewRun(t, { answer: dryRunOf([]), environment: TOKENS, base: declare(ACME, TEAM), manifest: declare(ACME) });
    assert.deepEqual(tokensSeen(run), []);
    assert.match(run.body, /^<p>🔒 No token for <code>acme<\/code>, because this pull request changes <code>registries:<\/code>\.<\/p>$/m);
    assert.match(run.body, /^<p>📝 <b>This pull request changes the manifest:<\/b> registries: removes <code>team<\/code>\.<\/p>$/m);
  });

  it("passes no token when the pull request adds the manifest, and dry-runs only the head", async t => {
    const run = await previewRun(t, { answer: unauthorized, environment: TOKENS, base: null, manifest: declare(ACME, TEAM) });
    assert.deepEqual(tokensSeen(run), []);
    assert.deepEqual(run.publishes.map(call => call.at), ["head"]);
    assertMarkdownSnapshot(t, run.body);
  });

  describe("passes no token when the base cannot vouch for it", () => {
    const fetchFails: Git = (args, options) => args.includes("fetch") ? { status: 1, stdout: "" } : runGit(args, options);
    for (const [why, options, reason] of [
      ["the base commit cannot be fetched", {
        payload: () => pullRequestPayload({ baseSha: "a".repeat(40) }),
        checkout: (given: Parameters<Checkout>[0]) => checkoutBase({ ...given, git: fetchFails })
      }, "could not fetch the pull request's base commit"],
      ["the base manifest cannot be listed", { base: `${MANIFEST}# unlistable\n` }, "aireg could not list the registries the base commit's \\.registry/manifest\\.yml declares"],
      ["the pull request names no base commit", { payload: () => pullRequestPayload() }, "the pull request names no base commit"]
    ] as const) {
      it(`because ${why}`, async t => {
        const run = await previewRun(t, { answer: unauthorized, environment: TOKENS, ...options });
        assert.equal(run.error, undefined);
        assert.deepEqual(tokensSeen(run), []);
        assert.deepEqual(run.publishes.map(call => call.at), ["head"]);
        assert.match(run.body, new RegExp(`<h3>⚠️ Not compared with the registry</h3>\n<p>No token for <code>acme</code>, because the base commit could not be read \\(${reason}\\), so it is unknown whether this pull request changes <code>registries:</code>\\.</p>\n`));
      });
    }

    it("and a passing preview says conflicts were not checked", async t => {
      const run = await previewRun(t, { answer: dryRunOf([exported("review", "0.3.1", "0.3.2")]), base: `${MANIFEST}# unlistable\n` });
      assert.equal(run.error, undefined);
      assert.match(run.body, /^<p>ℹ️ Conflicts were not checked: the base commit could not be read \(aireg could not list/m);
    });
  });

  describe("passes no token when the pull request does not merge into the default branch", () => {
    const into = (fields: { baseRef?: string; defaultBranch?: string }) => (baseSha: string) => pullRequestPayload({ baseSha, ...fields });
    it("even though the base declares the registries as the pull request does", async t => {
      const run = await previewRun(t, { answer: dryRunOf([]), environment: TOKENS, manifest: declare(ACME, TEAM), payload: into({ baseRef: "release/next" }) });
      assert.equal(run.error, undefined);
      assert.deepEqual(tokensSeen(run), []);
      assert.deepEqual(run.publishes.map(call => call.at), ["head", "base"]);
      assert.match(run.body, /^<p>🔒 No token for <code>acme<\/code> and <code>team<\/code>, because this pull request merges into <code>release\/next<\/code>, not the default branch\.<\/p>$/m);
      assert.match(run.body, /^<h3>✅ Ready to merge<\/h3>\n<p>Merging into <code>release\/next<\/code> publishes nothing; only the default branch publishes\.<\/p>$/m);
    });
    it("or names no branch", async t => {
      const run = await previewRun(t, { answer: unauthorized, environment: TOKENS, manifest: declare(ACME, TEAM), payload: into({ baseRef: undefined }) });
      assert.equal(run.error, undefined);
      assert.deepEqual(tokensSeen(run), []);
      assert.match(run.body, /^<h3>⚠️ Not compared with the registry<\/h3>\n<p>No token for <code>acme<\/code> and <code>team<\/code>, because the branch this pull request merges into is unknown\.<\/p>$/m);
    });

    it("or the event names no default branch", async t => {
      const run = await previewRun(t, { answer: dryRunOf([]), environment: TOKENS, manifest: declare(ACME, TEAM), payload: into({ defaultBranch: undefined }) });
      assert.equal(run.error, undefined);
      assert.deepEqual(tokensSeen(run), []);
      assert.match(run.body, /^<p>🔒 No token for <code>acme<\/code> and <code>team<\/code>, because the repository's default branch is unknown\.<\/p>$/m);
      assert.match(run.body, /^<h3>✅ Ready to merge<\/h3>\n<p>Merging publishes only if this pull request merges into the default branch, which the event does not say\.<\/p>$/m);
    });
  });

  it("notes withheld tokens under a refusal", async t => {
    const run = await previewRun(t, { answer: rejected, environment: TOKENS, base: declare(ACME), manifest: declare(ACME, TEAM) });
    assert.match(run.error?.message ?? "", /its description is empty/);
    assert.match(run.body, /This check fails until then\.<br><sub>aireg suggests: Add a description\.<\/sub><\/p>\n<p>🔒 No token for <code>acme<\/code> and <code>team<\/code>, because this pull request changes <code>registries:<\/code>\.<\/p>$/m);
  });

  it("passes no token anywhere when the pull request repoints the only registry", async t => {
    const run = await previewRun(t, { answer: ANSWER, environment: TOKENS, manifest: MANIFEST.replace("https://registry.example.com", "https://registry.example"), base: MANIFEST });
    assert.deepEqual(run.publishes.map(call => [call.at, call.tokens]), [["head", []], ["base", []]]);
  });

  describe("conflicts", () => {
    const head = dryRunOf([
      exported("review", "0.3.1", "0.3.2"),
      exported("sql-style", "1.2.0", "1.2.1"),
      exported("lint", "2.0.0", "2.0.0"),
      exported("triage", null, "0.1.0", { kind: "agent" })
    ]);
    const base = dryRunOf([exported("review", "0.3.1", "0.3.2"), exported("sql-style", "1.2.0", "1.2.0"), exported("lint", "2.0.0", "2.0.1")]);

    it("fails the check after commenting while fail-on-conflict is on", async t => {
      const run = await previewRun(t, { answer: head, baseAnswer: base, environment: TOKENS });
      assert.equal(run.error?.message, "1 artifact this pull request changes was changed in the registry since its base; see the preview, or set fail-on-conflict to false");
      assertMarkdownSnapshot(t, run.body);
      assert.match(run.output, /conflict-count=1\nstatus=conflict\n/);
    });

    it("counts several conflicts in the failure", async t => {
      const both = dryRunOf([exported("review", "0.3.1", "0.3.2"), exported("lint", "2.0.0", "2.0.1")]);
      const run = await previewRun(t, { answer: both, baseAnswer: both, environment: TOKENS });
      assert.match(run.error?.message ?? "", /^2 artifacts this pull request changes were changed in the registry/);
      assert.match(run.output, /conflict-count=2\nstatus=conflict\n/);
    });

    it("passes with status conflict while fail-on-conflict is off", async t => {
      const run = await previewRun(t, { answer: head, baseAnswer: base, environment: { ...TOKENS, "INPUT_FAIL-ON-CONFLICT": "false" } });
      assert.equal(run.error, undefined);
      assert.match(run.body, /^<h3>❗ 1 conflict<\/h3>\n<p>The registry has a newer skill <code>review<\/code> than this branch\./m);
      assert.match(run.output, /conflict-count=1\nstatus=conflict\n/);
    });

    it("refuses a fail-on-conflict value other than true or false before running anything", async t => {
      const run = await previewRun(t, { answer: head, environment: { "INPUT_FAIL-ON-CONFLICT": "maybe" } });
      assert.equal(run.error?.message, "fail-on-conflict must be true or false");
      assert.deepEqual([run.dispatched, run.github, run.output], [[], [], ""]);
    });

    it("are not checked when the base has no manifest", async t => {
      const run = await previewRun(t, { answer: head, base: null, baseAnswer: () => assert.fail("no dry run without a base manifest") });
      assert.equal(run.error, undefined);
      assert.deepEqual(run.publishes.map(call => call.at), ["head"]);
      assert.match(run.body, /^<p>📝 This pull request adds <code>\.registry\/manifest\.yml<\/code>, so everything it declares is new\.<\/p>$/m);
      assert.match(run.output, /conflict-count=0\nstatus=success\n/);
    });

    for (const [why, baseAnswer, shown] of [
      ["refused, redacted", refused("usage", "the base's manifest uses synthetic-acme-token.", "Fix it."), "the base's manifest uses \\*\\*\\*\\."],
      ["unreadable", () => "not json", "aireg returned an unreadable publish result"],
      ["failed without an Error", () => {
        throw "synthetic failure";
      }, "the base commit's dry run failed"]
    ] as const) {
      it(`are reported as not checked when the base's dry run is ${why}`, async t => {
        const run = await previewRun(t, { answer: head, baseAnswer, environment: TOKENS });
        assert.equal(run.error, undefined);
        assert.match(run.body, /^<h3>✅ Ready to merge<\/h3>\n<p>Merging publishes /m);
        assert.match(run.body, new RegExp(`^<p>ℹ️ Conflicts were not checked: the base commit's dry run failed: ${shown}</p>$`, "m"));
        assert.doesNotMatch(run.body, /synthetic/);
        assert.match(run.output, /conflict-count=0\nstatus=success\n/);
      });
    }

    const digest = (hex: string) => ({ digest: `sha256:${hex.repeat(64)}` });
    const review = (hex: string) => dryRunOf([exported("review", "0.3.1", "0.3.2", digest(hex))]);

    it("warns that merging overwrites an artifact the pull request leaves as the base has it", async t => {
      const run = await previewRun(t, { answer: review("a"), baseAnswer: review("a"), environment: TOKENS });
      assert.equal(run.error, undefined);
      assert.match(run.output, /conflict-count=0\nstatus=success\n/);
      assert.match(run.body, /^<p>⚠️ Merging also republishes skill <code>review<\/code> over a newer registry version, though this pull request leaves it unchanged\. /m);
      assert.match(run.body, /^<tr><td><code>review<\/code> <sub>skill<\/sub><\/td><td>⚠️ Replaces newer<\/td><td><code>0\.3\.1<\/code> → <code>0\.3\.2<\/code><\/td><\/tr>$/m);
    });

    it("is a conflict when the pull request's digest differs from the base's", async t => {
      const run = await previewRun(t, { answer: review("b"), baseAnswer: review("a"), environment: TOKENS });
      assert.match(run.error?.message ?? "", /^1 artifact this pull request changes/);
      assert.match(run.output, /conflict-count=1\nstatus=conflict\n/);
      assert.doesNotMatch(run.body, /Replaces newer|leaves it unchanged/);
    });
  });

  describe("comments only on a same-repository pull request that allows it", () => {
    for (const [who, options] of [
      ["a fork", { head: "attacker/skills" }],
      ["a deleted fork", { head: null }],
      ["a fork with no name", { payload: (baseSha: string) => pullRequestPayload({ baseSha, headRepository: undefined }) }],
      ["a pull request with commenting off", { environment: { "INPUT_COMMENT-ON-PR": "false", "INPUT_GITHUB-TOKEN": "" } }]
    ] as const) {
      it(`writing only the job summary for ${who}`, async t => {
        const run = await previewRun(t, { answer: unauthorized, ...options });
        assert.equal(run.error, undefined);
        assert.deepEqual(run.github, []);
        assert.match(run.summary, /^<h3>⚠️ Not compared with the registry<\/h3>\n<p>/);
        assert.doesNotMatch(run.output, /comment-id=/);
      });
    }

    it("still failing a fork's refusal", async t => {
      const run = await previewRun(t, { answer: rejected, head: "attacker/skills" });
      assert.match(run.error?.message ?? "", /its description is empty/);
      assert.deepEqual(run.github, []);
      assert.match(run.summary, /^<h3>❌ aireg can't publish this<\/h3>\n<p>/);
    });

    for (const [why, token] of [["empty", ""], ["multi-line", "synthetic\ntoken"]] as const) {
      it(`refusing to run with an ${why} github-token`, async t => {
        const run = await previewRun(t, { answer: ANSWER, environment: { "INPUT_GITHUB-TOKEN": token } });
        assert.equal(run.error?.message, "github-token is required to comment on the pull request");
        assert.deepEqual([run.dispatched, run.github, run.summary], [[], [], ""]);
      });
    }
  });

  describe("coding-agent handoff", () => {
    const payload = (headRepository: string | null, headRef?: string) => (baseSha: string) =>
      pullRequestPayload({ baseSha, headRepository, ...(headRef === undefined ? {} : { headRef }) });
    const links = (report: string) => [...report.matchAll(/<a href="([^"]*)"><picture><source [^>]*><img alt="Fix in [^"]+"/g)].map(([, href]) => new URL((href ?? "").replaceAll("&amp;", "&")));

    it("hands a same-repository pull request's branch to a coding agent", async t => {
      const run = await previewRun(t, { answer: rejected, environment: TOKENS, payload: payload("acme/skills", "fix/review") });
      assert.match(run.error?.message ?? "", /its description is empty/);
      const [claude, ...others] = links(run.body);
      assert.equal(others.length, 1);
      assert.equal(claude?.searchParams.get("repo"), "acme/skills");
      assert.equal(claude?.searchParams.get("branch"), "fix/review");
      assert.match(claude?.searchParams.get("q") ?? "", /^Fix what aireg refused in https:\/\/github\.com\/acme\/skills\/pull\/8 \(branch fix\/review\):$/m);
      assert.equal(others[0]?.searchParams.get("prompt"), claude?.searchParams.get("q"));
      assert.match(run.body, /<summary>Prompt for another agent<\/summary>/);
    });

    for (const [who, head, ref] of [["a fork", "attacker/skills", "fix/review"], ["a deleted fork", null, "fix/review"], ["an event without a head branch", "acme/skills", undefined]] as const) {
      it(`hands nothing off for ${who}`, async t => {
        const run = await previewRun(t, { answer: rejected, environment: TOKENS, payload: payload(head, ref) });
        assert.match(run.error?.message ?? "", /its description is empty/);
        const report = head === "acme/skills" ? run.body : run.summary;
        assert.match(report, /aireg can't publish this/);
        assert.doesNotMatch(report, /<a href|<picture|Fix in|Prompt for another agent/);
      });
    }
  });

  describe("redaction", () => {
    const { artifacts, target, skipped } = echoedResult(true);
    const echoed = dryRunOf(artifacts, { target, skipped });

    it("removes credential echoes before Markdown escaping and from JSON outputs", async t => {
      const run = await previewRun(t, { answer: echoed, environment: ECHOED_ENVIRONMENT });
      assert.equal(run.error, undefined);
      for (const report of [run.body, run.summary, run.output]) assert.doesNotMatch(report, /synthetic/);
      assert.match(run.body, /config\.json/);
      assert.match(run.body, /publishes <b>1 artifact<\/b>/);
      assert.deepEqual(["published", "unchanged", "skipped"].map(name => (outputValue(run.output, name) as unknown[]).length), [1, 1, 1]);
    });

    it("never changes whether an export would publish, even when a token equals a version", async t => {
      const run = await previewRun(t, {
        answer: dryRunOf([exported("review", "1.234.567", "1.234.568")]),
        environment: { AIREG_TOKEN_ACME: "1.234.567", AIREG_TOKEN_TEAM: "1.234.568" }
      });
      assert.equal(run.error, undefined);
      assert.match(run.body, /publishes <b>1 artifact<\/b>/);
      assert.match(run.body, /^<tr><td><code>review<\/code> <sub>skill<\/sub><\/td><td>🔄 Update<\/td>/m);
      for (const report of [run.body, run.summary, run.output]) assert.doesNotMatch(report, /1\.234\.56[78]/);
      assert.deepEqual(outputValue(run.output, "published"), [{ registry: "acme", namespace: "engineering", kind: "skill", name: "review", version: "***" }]);
      assert.deepEqual(outputValue(run.output, "unchanged"), []);
    });
  });

  describe("fails the check when the preview itself fails", () => {
    const throwsString = async () => {
      throw "synthetic failure";
    };
    for (const [why, options, thrown, reason] of [
      ["the head's answer is unreadable", { answer: () => "not json" }, "aireg returned an unreadable publish result", "aireg returned an unreadable publish result"],
      ["installation throws something other than an Error", { answer: ANSWER, install: throwsString }, "synthetic failure", "the preview failed"]
    ] as const) {
      it(`when ${why}`, async t => {
        const run = await previewRun(t, options);
        assert.equal(run.error instanceof Error ? run.error.message : run.error, thrown);
        assert.match(run.body, new RegExp(`^<h3>❌ aireg can't publish this</h3>\n<p>${reason}</p>$`, "m"));
        assert.match(run.output, /\nstatus=failed\n$/);
        assert.doesNotMatch(run.output, /aireg-version/);
      });
    }
  });

  it("reports a base checkout that throws something other than an Error as unreadable", async t => {
    const run = await previewRun(t, { answer: ANSWER, checkout: async () => { throw "synthetic failure"; } });
    assert.equal(run.error, undefined);
    assert.deepEqual(run.publishes.map(call => call.at), ["head"]);
    assert.match(run.body, /^<p>ℹ️ Conflicts were not checked: the base commit could not be read \(the base commit could not be read\)\.<\/p>$/m);
  });
});

const SHA = "a".repeat(40);
const REPOSITORY = { owner: "acme", repo: "skills" };
const ENVIRONMENT = {
  HTTPS_PROXY: "http://proxy.example:3128",
  SSL_CERT_FILE: "/runner/ca.pem",
  AIREG_TOKEN_ACME: "synthetic-registry-token",
  LD_PRELOAD: "/hostile/inject.so"
};

interface GitCall {
  args: string[];
  env: Readonly<Record<string, string>>;
}

function fakeGit(top: string, { shallow = true, fetch = 0, fetchedCommit = true, added = 1, toplevel = 0 } = {}) {
  const calls: GitCall[] = [];
  let fetched = false;
  const run: Git = (args, options) => {
    calls.push({ args: [...args], env: options.env ?? {} });
    const answer = (status: number, stdout = ""): GitResult => ({ status, stdout });
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return answer(toplevel, `${top}\n`);
    if (args[0] === "rev-parse") return answer(0, `${shallow}\n`);
    if (args[0] === "cat-file") return answer(fetched && fetchedCommit ? 0 : 1);
    if (args.includes("fetch")) {
      fetched = fetch === 0;
      return answer(fetch);
    }
    if (args.includes("worktree") && args.includes("add")) return answer(added);
    return answer(0);
  };
  return { calls, git: run };
}

async function repository(t: TestContext, base: { files: Record<string, string>; links?: Record<string, string> }, head: Record<string, string>) {
  const root = await temporaryDirectory(t, "aireg-publish-repo-");
  await writeFiles(root, base.files);
  for (const [name, target] of Object.entries(base.links ?? {})) await symlink(target, path.join(root, name));
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  const sha = git(root, "rev-parse", "HEAD").trim();
  git(root, "rm", "-q", "-r", ".");
  await rm(path.join(root, "pkg"), { recursive: true, force: true });
  await writeFiles(root, head);
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", "head");
  return { root, sha };
}

const worktrees = (root: string) => git(root, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length;

describe("checkoutBase", () => {
  describe("fetching a missing base commit", () => {
    it("authenticates only through git's environment, scoped to the fixed GitHub origin", async t => {
      const directory = await temporaryDirectory(t);
      const stdout = captureStdout(t);
      const seam = fakeGit(directory);
      await assert.rejects(checkoutBase({ repository: REPOSITORY, cwd: directory, sha: SHA, environment: ENVIRONMENT, token: "synthetic-github-token", git: seam.git }),
        { message: "could not check out the pull request's base commit" });
      const fetch = seam.calls.find(call => call.args.includes("fetch"));
      assert.deepEqual(fetch?.args, [
        "-c", "protocol.version=2", "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--depth=1",
        "https://github.com/acme/skills", SHA
      ]);
      const header = `AUTHORIZATION: basic ${Buffer.from("x-access-token:synthetic-github-token").toString("base64")}`;
      assert.deepEqual(fetch?.env, {
        HTTPS_PROXY: "http://proxy.example:3128",
        SSL_CERT_FILE: "/runner/ca.pem",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: header
      });
      assert.doesNotMatch(JSON.stringify(seam.calls.map(call => call.args)), /synthetic/);
      assert.deepEqual(seam.calls.filter(call => call !== fetch).flatMap(call => Object.keys(call.env)), []);
      assert.deepEqual(stdout, [`::add-mask::${header}\n`]);
    });

    it("removes the worktree and its temporary directory when the checkout fails", async t => {
      const directory = await temporaryDirectory(t);
      captureStdout(t);
      const seam = fakeGit(directory);
      await assert.rejects(checkoutBase({ repository: REPOSITORY, cwd: directory, sha: SHA, environment: ENVIRONMENT, token: "synthetic-github-token", git: seam.git }));
      const added = seam.calls.find(call => call.args.includes("add"));
      const worktree = added?.args.at(-2) ?? "";
      assert.equal(path.basename(path.dirname(worktree)).startsWith("aireg-publish-base-"), true);
      assert.equal(existsSync(path.dirname(worktree)), false);
      assert.deepEqual(seam.calls.slice(-2).map(call => call.args.join(" ")), [`worktree remove --force ${worktree}`, "worktree prune"]);
    });

    it("fetches the full commit in a complete clone and sends no header without a token", async t => {
      const directory = await temporaryDirectory(t);
      const stdout = captureStdout(t);
      const seam = fakeGit(directory, { shallow: false });
      await assert.rejects(checkoutBase({ repository: REPOSITORY, cwd: directory, sha: SHA, environment: {}, token: "", git: seam.git }));
      const fetch = seam.calls.find(call => call.args.includes("fetch"));
      assert.equal(fetch?.args.includes("--depth=1"), false);
      assert.deepEqual(fetch?.env, {});
      assert.deepEqual(stdout, []);
    });

    for (const [why, options, sha, message] of [
      ["the pull request names no commit", {}, undefined, "the pull request names no base commit"],
      ["the base is not a commit SHA", {}, "main", "the pull request names no base commit"],
      ["the working directory is not in a repository", { toplevel: 128 }, SHA, "could not find the repository of the working directory"],
      ["the fetch fails", { fetch: 128 }, SHA, "could not fetch the pull request's base commit"],
      ["the fetch does not bring the commit", { fetchedCommit: false }, SHA, "could not fetch the pull request's base commit"]
    ] as const) {
      it(`refuses when ${why}`, async t => {
        const directory = await temporaryDirectory(t);
        captureStdout(t);
        const seam = fakeGit(directory, options);
        await assert.rejects(checkoutBase({ repository: REPOSITORY, cwd: directory, sha, environment: ENVIRONMENT, token: "synthetic-github-token", git: seam.git }), { message });
        assert.equal(seam.calls.some(call => call.args.includes("worktree")), false);
      });
    }

    it("refuses a working directory outside the repository it reports", async t => {
      const directory = await temporaryDirectory(t);
      const other = await temporaryDirectory(t);
      const seam = fakeGit(other);
      await assert.rejects(checkoutBase({ repository: REPOSITORY, cwd: directory, sha: SHA, environment: ENVIRONMENT, token: "", git: seam.git }),
        { message: "the working directory is outside its repository" });
    });
  });

  describe("with a real repository", () => {
    const head = { "pkg/.registry/manifest.yml": MANIFEST };

    it("checks out the working directory's counterpart, and remove() deletes it", async t => {
      const { root, sha } = await repository(t, { files: { "pkg/.registry/manifest.yml": MANIFEST } }, head);
      const base = await checkoutBase({ repository: REPOSITORY, cwd: path.join(root, "pkg"), sha, environment: ENVIRONMENT, token: "" });
      assert.equal(base.tracksManifest, true);
      assert.equal(path.basename(base.cwd), "pkg");
      assert.equal(path.basename(path.dirname(base.cwd)), "base");
      assert.equal(worktrees(root), 2);
      await base.remove();
      assert.equal(existsSync(path.dirname(path.dirname(base.cwd))), false);
      assert.equal(worktrees(root), 1);
    });

    for (const [why, files] of [
      ["lacks the working directory", { "other/README.md": "x\n" }],
      ["has a file where the working directory is", { pkg: "a file\n" }],
      ["has the directory without a manifest", { "pkg/README.md": "x\n" }]
    ] as const) {
      it(`reports no manifest when the base ${why}`, async t => {
        const { root, sha } = await repository(t, { files }, head);
        const base = await checkoutBase({ repository: REPOSITORY, cwd: path.join(root, "pkg"), sha, environment: ENVIRONMENT, token: "" });
        t.after(base.remove);
        assert.equal(base.tracksManifest, false);
      });
    }

    it("refuses a base whose working directory is a symbolic link, and removes the worktree", async t => {
      const { root, sha } = await repository(t, { files: { "real/.registry/manifest.yml": MANIFEST }, links: { pkg: "real" } }, head);
      await assert.rejects(checkoutBase({ repository: REPOSITORY, cwd: path.join(root, "pkg"), sha, environment: ENVIRONMENT, token: "" }),
        { message: "working-directory cannot contain symbolic links" });
      assert.equal(worktrees(root), 1);
    });

    it("checks out the repository root when the working directory is the root", async t => {
      const { root, sha } = await repository(t, { files: { ".registry/manifest.yml": MANIFEST } }, { ".registry/manifest.yml": MANIFEST });
      const base = await checkoutBase({ repository: REPOSITORY, cwd: root, sha, environment: ENVIRONMENT, token: "" });
      t.after(base.remove);
      assert.equal(base.tracksManifest, true);
      assert.equal(path.basename(base.cwd), "base");
    });
  });
});
