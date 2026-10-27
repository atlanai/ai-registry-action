import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { PreviewOptions } from "../src/preview.ts";
import type { PublishOptions } from "../src/publish.ts";
import { run } from "../src/run.ts";
import { actionDefaults, temporaryDirectory } from "./helpers/action.ts";

const PAYLOAD = { repository: { default_branch: "main" }, pull_request: { number: 8 } };

async function route(t: TestContext, event: string | undefined, publish: string, extra: Record<string, string> = {}) {
  const directory = await temporaryDirectory(t);
  const eventPath = path.join(directory, "event.json");
  await writeFile(eventPath, JSON.stringify(PAYLOAD));
  const environment = {
    ...actionDefaults(), INPUT_PUBLISH: publish, GITHUB_EVENT_PATH: eventPath, ...(event === undefined ? {} : { GITHUB_EVENT_NAME: event }), ...extra
  };
  const ran: { flow: string; options: PreviewOptions | PublishOptions }[] = [];
  const outcome = await run(environment, {
    preview: async options => void ran.push({ flow: "preview", options }),
    publish: async options => void ran.push({ flow: "publish", options })
  }).then(() => undefined, (error: unknown) => error);
  return { ran, outcome, environment };
}

describe("run", () => {
  for (const publish of ["true", "false"]) {
    it(`refuses pull_request_target before anything runs (publish: ${publish})`, async t => {
      const { ran, outcome } = await route(t, "pull_request_target", publish);
      assert.deepEqual(ran, []);
      assert.match(String(outcome), /^Error: ai-registry Action refuses pull_request_target, which would run pull-request code with base-repository secrets; run it on pull_request$/);
    });
  }

  for (const server of ["https://github.acme.internal", "https://acme.ghe.com", "http://github.com", "https://github.com.evil", ""]) {
    it(`refuses the GitHub host ${JSON.stringify(server)} before anything runs`, async t => {
      const { ran, outcome } = await route(t, "push", "true", { GITHUB_SERVER_URL: server });
      assert.deepEqual(ran, []);
      assert.match(String(outcome), /^Error: ai-registry Action supports repositories on github\.com only, not GitHub Enterprise Server or GHE\.com$/);
    });
  }

  for (const server of ["https://github.com", "https://github.com/"]) {
    it(`runs on github.com named as ${server}`, async t => {
      const { ran, outcome } = await route(t, "push", "true", { GITHUB_SERVER_URL: server });
      assert.equal(outcome, undefined);
      assert.deepEqual(ran.map(call => call.flow), ["publish"]);
    });
  }

  for (const [event, message] of [
    ["workflow_run", /not workflow_run$/],
    [undefined, /not an unknown event$/]
  ] as const) {
    it(`refuses ${event ?? "a missing event"}`, async t => {
      const { ran, outcome } = await route(t, event, "false");
      assert.deepEqual(ran, []);
      assert.match(String(outcome), message);
    });
  }

  for (const value of ["", "yes", "True", "Auto", "1"]) {
    it(`takes publish only as auto, true or false, not ${JSON.stringify(value)}`, async t => {
      const { ran, outcome } = await route(t, "push", value);
      assert.deepEqual(ran, []);
      assert.match(String(outcome), /^Error: publish must be auto, true or false$/);
    });
  }

  for (const [event, flow, does] of [
    ["push", { flow: "publish", dryRun: false }, "publishes"],
    ["workflow_dispatch", { flow: "publish", dryRun: false }, "publishes"],
    ["pull_request", { flow: "preview" }, "previews"],
    ["schedule", { flow: "publish", dryRun: true }, "dry-runs"]
  ] as const) {
    it(`with publish: auto, ${does} ${event}`, async t => {
      const { ran, outcome } = await route(t, event, "auto");
      assert.equal(outcome, undefined);
      assert.deepEqual(ran.map(call => ({ flow: call.flow, ...("dryRun" in call.options ? { dryRun: call.options.dryRun } : {}) })), [flow]);
    });
  }

  for (const [event, message] of [
    ["pull_request", /^Error: a pull request never publishes; remove publish: true from this step/],
    ["schedule", /^Error: a scheduled run never publishes; remove publish: true from this step/]
  ] as const) {
    it(`refuses publish: true on ${event}`, async t => {
      const { ran, outcome } = await route(t, event, "true");
      assert.deepEqual(ran, []);
      assert.match(String(outcome), message);
    });
  }

  it("previews a pull request with its event payload", async t => {
    const { ran, outcome, environment } = await route(t, "pull_request", "false");
    assert.equal(outcome, undefined);
    assert.deepEqual(ran, [{ flow: "preview", options: { environment, payload: PAYLOAD } }]);
  });

  for (const event of ["push", "workflow_dispatch", "schedule"]) {
    it(`dry-runs ${event} with publish off and its event payload, which decides whether tokens pass`, async t => {
      const { ran, outcome, environment } = await route(t, event, "false");
      assert.equal(outcome, undefined);
      assert.deepEqual(ran, [{ flow: "publish", options: { environment, payload: PAYLOAD, dryRun: true } }]);
    });
  }

  for (const event of ["push", "workflow_dispatch"]) {
    it(`publishes ${event} with its event payload`, async t => {
      const { ran, outcome, environment } = await route(t, event, "true");
      assert.equal(outcome, undefined);
      assert.deepEqual(ran, [{ flow: "publish", options: { environment, payload: PAYLOAD, dryRun: false } }]);
    });
  }
});
