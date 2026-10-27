import assert from "node:assert/strict";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { AiregOutputTooLarge, type Command, type Registry } from "../src/aireg.ts";
import { PUBLISH_FAILURE_MARKER } from "../src/constants.ts";
import type { GitHubRequestOptions } from "../src/github.ts";
import type { InstallOptions } from "../src/install.ts";
import { assertCurrentRerun, assertDefaultBranch, reportPublishFailure, runPublish } from "../src/publish.ts";
import { publisherEnvironment } from "../src/tokens.ts";
import { captureStdout, outputsOf, outputValue, temporaryDirectory } from "./helpers/action.ts";
import {
  ECHOED_ENVIRONMENT, echoedResult, exported, EXPORTS, manifestCheckout, PLANNER, publishAnswer, refusal,
  stepEnvironment
} from "./helpers/fixtures.ts";

const SHA = "c".repeat(40);
const PAYLOAD = { repository: { default_branch: "main" }, after: SHA };
const ANSWER = publishAnswer(EXPORTS, { skipped: [PLANNER] });
const DRY_ANSWER = publishAnswer(EXPORTS, { skipped: [PLANNER], dryRun: true });
const REGISTRIES: Registry[] = [{ registry: "acme", adapter: "acme", declaration: "{}" }, { registry: "team", declaration: "{}" }];
const entry = (name: string, version: string, kind = "skill") => ({ registry: "acme", namespace: "engineering", kind, name, version });

type Answer = string | (() => string);

interface Harness {
  t: TestContext;
  answer?: Answer;
  dryRun?: boolean;
  environment?: Record<string, string>;
  payload?: unknown;
  request?: (options: GitHubRequestOptions) => Promise<unknown>;
  manifest?: string | null;
}

async function publish({ t, answer = ANSWER, dryRun = false, environment = {}, payload = PAYLOAD, request, manifest }: Harness) {
  const stdout = captureStdout(t);
  const workspace = await manifestCheckout(t, manifest);
  const runtime = path.join(await temporaryDirectory(t), "runtime");
  const step = await stepEnvironment(t, {
    AIREG_TOKEN_ACME: "synthetic-acme-token", AIREG_TOKEN_TEAM: "synthetic-team-token", GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main", GITHUB_WORKSPACE: workspace, ...environment
  });
  const installs: InstallOptions[] = [];
  const commands: Command[] = [];
  const github: GitHubRequestOptions[] = [];
  const error = await runPublish({
    environment: step.environment,
    payload,
    dryRun,
    request: async options => {
      github.push(options);
      if (!request) throw new Error("this test expects no GitHub request");
      return request(options);
    },
    install: async options => {
      installs.push(options);
      await mkdir(runtime);
      return { binary: "/reviewed/aireg", directory: runtime, version: "0.2.0", registries: REGISTRIES };
    },
    execute: async command => {
      commands.push(command);
      return typeof answer === "function" ? answer() : answer;
    }
  }).then(() => undefined, (caught: unknown) => caught);
  const runtimeLeft = await stat(runtime).then(() => true, () => false);
  return {
    error, workspace, runtime, installs, commands, github, stdout, runtimeLeft, environment: step.environment,
    outputs: await outputsOf(step.output), summary: await outputsOf(step.summary)
  };
}

const tokensSeen = (command: Command | undefined) => Object.keys(command?.env ?? {}).filter(key => key.startsWith("AIREG_TOKEN_")).sort();

describe("runPublish", () => {
  it("publishes the manifest's exports from the working directory with each registry's own token", async t => {
    const run = await publish({ t });
    assert.equal(run.error, undefined);
    assert.deepEqual(run.installs.map(options => options.cwd), [run.workspace]);
    assert.equal(run.commands.length, 1);
    const [command] = run.commands;
    assert.deepEqual({ ...command, env: undefined }, { binary: "/reviewed/aireg", args: ["publish", "--yes", "--json"], cwd: run.workspace, env: undefined });
    assert.deepEqual(command?.env, publisherEnvironment(run.environment, { AIREG_TOKEN_ACME: "synthetic-acme-token", AIREG_TOKEN_TEAM: "synthetic-team-token" }, run.runtime));
    assert.equal(run.outputs, [
      `published=${JSON.stringify([entry("review", "0.3.2"), entry("triage", "0.1.0", "agent")])}`,
      `unchanged=${JSON.stringify([entry("sql-style", "1.2.0")])}`,
      `skipped=${JSON.stringify([PLANNER])}`,
      "status=success",
      "aireg-version=0.2.0",
      ""
    ].join("\n"));
    assert.match(run.summary, /^<h3>✅ Published 2 artifacts to <code>acme\/engineering<\/code><\/h3>\n<p>1 new · 1 update<\/p>\n/);
    assert.ok(run.stdout.includes("::notice title=ai-registry Action::published 2, unchanged 1, skipped 1\n"));
    assert.ok(run.stdout.includes("::add-mask::synthetic-acme-token\n"));
    assert.equal(run.runtimeLeft, false);
  });

  for (const [name, answer] of [
    ["an artifact it cannot read", () => publishAnswer([exported("review", "0.3.1", "0.3.2"), { ...exported("sql-style", null, "0.1.0"), name: "sql\u202estyle" }])],
    ["an answer marked as a dry run", () => publishAnswer([exported("review", "0.3.1", "0.3.2")], { dryRun: true })],
    ["no JSON", () => "published, but no JSON"],
    ["output over the size limit", () => { throw new AiregOutputTooLarge(); }]
  ] as const) {
    it(`reports a completed publish with ${name} as successful but incomplete`, async t => {
      const run = await publish({ t, answer });
      assert.equal(run.error, undefined);
      assert.match(run.outputs, /\nstatus=success\naireg-version=0\.2\.0\n$/);
      assert.match(run.summary, /part of its answer could not be read, so this list may be incomplete/);
      assert.equal(run.runtimeLeft, false);
    });
  }

  it("keeps the readable artifacts of an incomplete answer in its outputs", async t => {
    const run = await publish({ t, answer: publishAnswer([exported("review", "0.3.1", "0.3.2"), { ...exported("sql-style", null, "0.1.0"), name: "sql\u202estyle" }]) });
    assert.deepEqual(outputValue(run.outputs, "published"), [entry("review", "0.3.2")]);
  });

  for (const [name, answer, heading] of [
    ["a target and only skipped exports", publishAnswer([], { skipped: [{ name: "planner", kind: "agent", reason: "not taken" }], target: { registry: "team", namespace: "platform" } }), "<h3>✅ Nothing to publish to <code>team/platform</code></h3>"],
    ["no exports and no target", publishAnswer([], { target: null }), "<h3>✅ Nothing to publish</h3>"]
  ] as const) {
    it(`summarizes a publish with ${name}`, async t => {
      const run = await publish({ t, answer });
      assert.equal(run.error, undefined);
      assert.equal(run.summary.split("\n")[0], heading);
    });
  }

  it("fails on aireg's refusal with empty export outputs and the CLI version", async t => {
    const run = await publish({ t, environment: { GITHUB_EVENT_NAME: "workflow_dispatch" }, answer: () => { throw refusal("rejected", "its description is empty.", "Add a description."); } });
    assert.match(String(run.error), /its description is empty/);
    assert.equal(run.outputs, "published=[]\nunchanged=[]\nskipped=[]\nstatus=failed\naireg-version=0.2.0\n");
    assert.deepEqual(run.github, []);
    assert.equal(run.runtimeLeft, false);
  });

  it("fails before installing without a tracked manifest", async t => {
    const run = await publish({ t, manifest: null, environment: { GITHUB_EVENT_NAME: "workflow_dispatch" } });
    assert.match(String(run.error), /^Error: add \.registry\/manifest\.yml/);
    assert.deepEqual(run.installs, []);
    assert.equal(run.outputs, "published=[]\nunchanged=[]\nskipped=[]\nstatus=failed\n");
  });

  it("fails and removes the runtime directory when aireg fails without a reason", async t => {
    const run = await publish({ t, environment: { GITHUB_EVENT_NAME: "workflow_dispatch" }, answer: () => { throw new Error("aireg publish exited with status 9"); } });
    assert.match(String(run.error), /status 9/);
    assert.match(run.outputs, /status=failed\n$/);
    assert.equal(run.runtimeLeft, false);
  });

  it("redacts registry tokens echoed into its outputs and summary without changing what published", async t => {
    const { artifacts, target, skipped } = echoedResult(false);
    const run = await publish({ t, environment: ECHOED_ENVIRONMENT, answer: publishAnswer(artifacts, { target, skipped }) });
    assert.equal(run.error, undefined);
    for (const report of [run.outputs, run.summary]) assert.doesNotMatch(report, /synthetic/);
    assert.match(run.summary, /config\.json/);
    assert.deepEqual(["published", "unchanged", "skipped"].map(name => (outputValue(run.outputs, name) as unknown[]).length), [1, 1, 1]);
  });

  describe("with publish off", () => {
    for (const [event, tokens] of [["push", []], ["workflow_dispatch", []], ["schedule", ["AIREG_TOKEN_ACME", "AIREG_TOKEN_TEAM"]]] as const) {
      it(`dry-runs ${event} on another branch and rerun, writing nothing and passing tokens only to a schedule`, async t => {
        const run = await publish({
          t, dryRun: true, answer: DRY_ANSWER,
          environment: { GITHUB_EVENT_NAME: event, GITHUB_REF: "refs/heads/feature", GITHUB_RUN_ATTEMPT: "2", "INPUT_GITHUB-TOKEN": "synthetic-github-token" }
        });
        assert.equal(run.error, undefined);
        assert.deepEqual(run.commands.map(command => [command.args, tokensSeen(command)]), [
          [["publish", "--yes", "--json", "--dry-run"], tokens]
        ]);
        assert.equal(run.stdout.join("").includes("::notice title=ai-registry Action::registry tokens are passed only on the default branch, so this dry run ran without them\n"), tokens.length === 0);
        assert.deepEqual(run.github, []);
        assert.equal(run.outputs, [
          `published=${JSON.stringify([entry("review", "0.3.2"), entry("triage", "0.1.0", "agent")])}`,
          `unchanged=${JSON.stringify([entry("sql-style", "1.2.0")])}`,
          `skipped=${JSON.stringify([PLANNER])}`,
          "status=success",
          "aireg-version=0.2.0",
          ""
        ].join("\n"));
        assert.ok(run.stdout.includes("::notice title=ai-registry Action::would publish 2, unchanged 1, skipped 1 (dry run)\n"));
      });
    }

    it("passes registry tokens to a dry run on the default branch", async t => {
      const run = await publish({ t, dryRun: true, answer: DRY_ANSWER, environment: { GITHUB_EVENT_NAME: "workflow_dispatch" } });
      assert.equal(run.error, undefined);
      assert.deepEqual(run.commands.map(tokensSeen), [["AIREG_TOKEN_ACME", "AIREG_TOKEN_TEAM"]]);
      assert.doesNotMatch(run.stdout.join(""), /registry tokens are passed only/);
    });

    it("passes no registry token to a dry run whose event names no default branch", async t => {
      const run = await publish({ t, dryRun: true, answer: DRY_ANSWER, payload: null });
      assert.equal(run.error, undefined);
      assert.deepEqual(run.commands.map(tokensSeen), [[]]);
    });

    it("explains, instead of aireg's sign-in advice, why a dry run off the default branch was refused", async t => {
      const run = await publish({
        t, dryRun: true, environment: { GITHUB_REF: "refs/heads/feature" },
        answer: () => { throw refusal("unauthorized", "auth.json has no session for acme", "Sign in with the desktop app."); }
      });
      assert.match(String(run.error), /^Error: this dry run is not on the default branch, so it ran without registry tokens, and the registry needs one; preview the branch in a pull request, or dry-run the default branch$/);
      assert.match(run.outputs, /status=failed/);
    });

    it("keeps aireg's refusal for a dry run on the default branch", async t => {
      const run = await publish({ t, dryRun: true, answer: () => { throw refusal("unauthorized", "Sign in to acme.", "Set AIREG_TOKEN_ACME."); } });
      assert.match(String(run.error), /Sign in to acme\./);
    });

    it("summarizes what would publish", async t => {
      const run = await publish({ t, dryRun: true, answer: DRY_ANSWER });
      assert.match(run.summary, /^<h3>Dry run · would publish 2 artifacts to <code>acme\/engineering<\/code><\/h3>\n<p>1 new · 1 update<\/p>\n<p>Nothing was written to the registry, because <code>publish<\/code> is off\.<\/p>\n/);
    });

    for (const [name, answer, message] of [
      ["aireg's refusal", () => { throw refusal("rejected", "skill review: its description is empty.", "Add a description."); }, /its description is empty/],
      ["an answer that is not a dry run", () => ANSWER, /unreadable publish result/],
      ["output over the size limit", () => { throw new AiregOutputTooLarge(); }, /exceeds the size limit/]
    ] as const) {
      it(`fails on ${name}, since a dry run must be read in full`, async t => {
        const run = await publish({ t, dryRun: true, answer, environment: { GITHUB_REPOSITORY: "acme/skills", "INPUT_GITHUB-TOKEN": "gh" } });
        assert.match(String(run.error), message);
        assert.match(run.outputs, /^published=\[\]\nunchanged=\[\]\nskipped=\[\]\nstatus=failed\n/);
        assert.deepEqual(run.github, []);
        assert.equal(run.runtimeLeft, false);
      });
    }
  });
});

describe("assertDefaultBranch", () => {
  for (const [name, ref, payload] of [
    ["another branch", "refs/heads/feature", PAYLOAD],
    ["a tag of the default branch's name", "refs/tags/main", PAYLOAD],
    ["a payload without a default branch", "refs/heads/main", {}],
    ["no payload", "refs/heads/main", undefined]
  ] as const) {
    it(`refuses ${name}`, () => {
      assert.throws(() => assertDefaultBranch({ GITHUB_REF: ref }, payload), /^Error: ai-registry Action publishes only from the repository's default branch$/);
    });
  }

  it("stops a real publish before installing", async t => {
    const run = await publish({ t, environment: { GITHUB_REF: "refs/heads/feature" } });
    assert.match(String(run.error), /only from the repository's default branch/);
    assert.deepEqual(run.installs, []);
    assert.equal(run.outputs, "");
  });
});

describe("assertCurrentRerun", () => {
  const RERUN = { GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: "d".repeat(40), GITHUB_REPOSITORY: "acme/skills", "INPUT_GITHUB-TOKEN": "gh" };
  const tipAt = (tip: unknown) => async ({ requestPath }: GitHubRequestOptions) => {
    assert.equal(requestPath, "/repos/acme/skills/git/ref/heads/main");
    return { object: { sha: tip } };
  };

  it("lets a first attempt through without asking GitHub", async () => {
    await assertCurrentRerun({ ...RERUN, GITHUB_RUN_ATTEMPT: "1" }, PAYLOAD, async () => assert.fail("no request"));
  });

  it("lets a rerun through while its commit is still the default branch's tip", async () => {
    await assertCurrentRerun(RERUN, PAYLOAD, tipAt("D".repeat(40)));
  });

  it("encodes each segment of a default branch name with slashes", async () => {
    const paths: string[] = [];
    await assertCurrentRerun(RERUN, { repository: { default_branch: "release/v 1" } }, async ({ requestPath }) => {
      paths.push(requestPath);
      return { object: { sha: "d".repeat(40) } };
    });
    assert.deepEqual(paths, ["/repos/acme/skills/git/ref/heads/release/v%201"]);
  });

  it("refuses a rerun after the default branch moved on", async () => {
    await assert.rejects(assertCurrentRerun(RERUN, PAYLOAD, tipAt("e".repeat(40))),
      /^Error: this rerun is for ddddddd, but main has moved on to eeeeeee, so publishing it would put older artifacts over newer ones; run ai-registry Action manually from the default branch instead$/);
  });

  for (const [name, environment, request] of [
    ["GitHub fails", RERUN, async () => { throw new Error("offline"); }],
    ["the answer has no commit", RERUN, async () => ({ object: { sha: "main" } })],
    ["there is no token", { ...RERUN, "INPUT_GITHUB-TOKEN": "" }, async () => assert.fail("no request")],
    ["the repository is malformed", { ...RERUN, GITHUB_REPOSITORY: "acme/skills/extra" }, async () => assert.fail("no request")]
  ] as const) {
    it(`refuses a rerun it cannot confirm because ${name}`, async () => {
      await assert.rejects(assertCurrentRerun(environment, PAYLOAD, request),
        /^Error: this rerun could not confirm the default branch's latest commit, so it did not publish; run ai-registry Action manually/);
    });
  }

  it("stops a stale rerun before installing", async t => {
    const run = await publish({ t, environment: RERUN, request: tipAt("e".repeat(40)) });
    assert.match(String(run.error), /has moved on/);
    assert.deepEqual(run.installs, []);
  });
});

describe("reportPublishFailure", () => {
  const FAILED = { GITHUB_REPOSITORY: "acme/skills", GITHUB_RUN_ID: "42", "INPUT_GITHUB-TOKEN": "gh" };
  const pulls = [
    { number: 3, merged_at: null, base: { ref: "main" } },
    { number: 9, merged_at: "2026-09-29T09:55:32Z", base: { ref: "main" } },
    { number: 11, merged_at: "2026-09-29T09:55:32Z", base: { ref: "release" } }
  ];
  const github = (answer: unknown) => {
    const requests: GitHubRequestOptions[] = [];
    const request = async (options: GitHubRequestOptions) => {
      requests.push(options);
      if (options.requestPath === `/repos/acme/skills/commits/${SHA}/pulls`) return answer;
      if (options.requestPath === "/user") return { login: "github-actions[bot]", type: "Bot" };
      if (options.method === "GET") return [];
      return { id: 5 };
    };
    return { requests, request };
  };

  it("comments the refusal on the one pull request merged into the default branch", async t => {
    const run = await publish({
      t, environment: FAILED, request: github(pulls).request,
      answer: () => { throw refusal("rejected", "The registry refused review: its description is empty.", "Add a description."); }
    });
    assert.match(String(run.error), /its description is empty/);
    const post = run.github.find(options => options.method === "POST");
    assert.equal(post?.requestPath, "/repos/acme/skills/issues/9/comments");
    const body = String(post?.body?.body);
    assert.ok(body.startsWith(`${PUBLISH_FAILURE_MARKER}\n`));
    assert.match(body, /\n<h3>❌ Publishing <code>ccccccc<\/code> failed<\/h3>\n<p>The registry refused review: its description is empty\.<\/p>\n<p><b>To fix:<\/b> [^\n]*<br><sub>aireg suggests: Add a description\.<\/sub><\/p>$/);
    assert.doesNotMatch(body, /exited with status/);
  });

  it("comments a failure that happened before aireg ran", async t => {
    const run = await publish({ t, environment: FAILED, manifest: null, request: github(pulls).request });
    assert.match(String(run.error), /add \.registry\/manifest\.yml/);
    assert.equal(run.github.filter(options => options.method === "POST").length, 1);
  });

  for (const [name, event, dryRun] of [["workflow_dispatch", "workflow_dispatch", false], ["a dry run", "push", true]] as const) {
    it(`does not comment on ${name}`, async t => {
      const run = await publish({ t, dryRun, environment: { ...FAILED, GITHUB_EVENT_NAME: event }, request: github(pulls).request, answer: () => { throw refusal("rejected", "no", "fix"); } });
      assert.match(String(run.error), /no/);
      assert.deepEqual(run.github, []);
    });
  }

  for (const [name, environment, payload] of [
    ["no token", { ...FAILED, "INPUT_GITHUB-TOKEN": "" }, PAYLOAD],
    ["no pushed commit", FAILED, { repository: { default_branch: "main" } }],
    ["a malformed repository", { ...FAILED, GITHUB_REPOSITORY: "acme" }, PAYLOAD]
  ] as const) {
    it(`asks GitHub nothing with ${name}`, async t => {
      captureStdout(t);
      const { requests, request } = github(pulls);
      await reportPublishFailure(environment, payload, new Error("refused"), request);
      assert.deepEqual(requests, []);
    });
  }

  for (const [name, answer] of [
    ["no merged pull request", [pulls[0]]],
    ["several merged pull requests", [pulls[1], { ...pulls[1], number: 10 }]],
    ["an answer that is not a list", { message: "not a list" }]
  ] as const) {
    it(`leaves the failed run as the report with ${name}`, async t => {
      const stdout = captureStdout(t);
      const { requests, request } = github(answer);
      await reportPublishFailure(FAILED, PAYLOAD, new Error("refused"), request);
      assert.deepEqual(requests.map(options => options.method), ["GET"]);
      assert.ok(stdout.includes("::notice title=ai-registry Action::no single merged pull request introduced this commit, so the failed run is the report\n"));
    });
  }

  it("warns rather than fails when the comment cannot be written", async t => {
    const stdout = captureStdout(t);
    await reportPublishFailure(FAILED, PAYLOAD, new Error("refused"), async () => { throw new Error("offline"); });
    assert.ok(stdout.includes("::warning title=ai-registry Action::the failed publish could not be reported on its pull request\n"));
    assert.ok(stdout.includes("::add-mask::gh\n"));
  });
});
