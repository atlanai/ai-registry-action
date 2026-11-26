import assert from "node:assert/strict";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  AiregOutputTooLarge, AiregRefusal, type Command, declaredRegistries, dryRunResult, failureReason, publishedResult,
  runAireg, runAiregPublish
} from "../src/aireg.ts";
import { MAX_PUBLISHED_ARTIFACTS, MAX_REASON_CHARS, MAX_REGISTRIES, SYSTEM_PATH } from "../src/constants.ts";
import { publisherEnvironment } from "../src/tokens.ts";
import { captureStdout, silenceStderr, temporaryDirectory } from "./helpers/action.ts";
import { exported, PLANNER, publishAnswer, registryList, TARGET } from "./helpers/fixtures.ts";

const ENV = { PATH: SYSTEM_PATH };

async function fakeAireg(t: TestContext, script: (directory: string) => string): Promise<{ directory: string; binary: string }> {
  const directory = await temporaryDirectory(t);
  const binary = path.join(directory, "aireg");
  await writeFile(binary, script(directory));
  await chmod(binary, 0o755);
  return { directory, binary };
}

const run = (binary: string, cwd: string, args: string[] = ["publish", "--json"]) => runAireg({ binary, args, cwd, env: ENV });

describe("runAireg", () => {
  it("returns captured stdout with workflow commands suspended around the run", async t => {
    const written = captureStdout(t);
    const { directory, binary } = await fakeAireg(t, () => "#!/bin/sh\necho '::warning::from a pull request'\n");
    assert.equal(await run(binary, directory), "::warning::from a pull request\n");
    const resume = /^::stop-commands::([0-9a-f-]{36})\n$/.exec(written[0] ?? "")?.[1];
    assert.ok(resume, "the first write suspends workflow commands");
    assert.deepEqual(written, [`::stop-commands::${resume}\n`, `::${resume}::\n`]);
  });

  it("resumes workflow commands after a failed run", async t => {
    const written = captureStdout(t);
    silenceStderr(t);
    const { directory, binary } = await fakeAireg(t, () => "#!/bin/sh\nexit 5\n");
    await assert.rejects(run(binary, directory), { message: "aireg publish exited with status 5" });
    const resume = /^::stop-commands::(.+)\n$/.exec(written[0] ?? "")?.[1];
    assert.equal(written.at(-1), `::${resume}::\n`);
  });

  it("redacts a token before shortening the reason, so a cut cannot leave part of it", async t => {
    captureStdout(t);
    const token = "synthetic-registry-token";
    const message = `${"a".repeat(MAX_REASON_CHARS - 10)} ${token}`;
    const { directory, binary } = await fakeAireg(t, () => `#!/bin/sh\necho '${JSON.stringify({ ok: false, error: { message } })}'\nexit 1\n`);
    await assert.rejects(runAireg({ binary, args: ["publish", "--json"], cwd: directory, env: { ...ENV, AIREG_TOKEN_ACME: token } }), (error: unknown) => {
      assert.ok(error instanceof AiregRefusal);
      assert.equal(error.reason.message, `${"a".repeat(MAX_REASON_CHARS - 10)} ***`);
      assert.doesNotMatch(error.message, /synthetic/);
      return true;
    });
  });

  it("redacts a token aireg's JSON answer escapes, before shortening the reason", async t => {
    captureStdout(t);
    const token = 'synthetic"registry\\token';
    const message = `${"a".repeat(MAX_REASON_CHARS - 10)} ${token}`;
    const { directory, binary } = await fakeAireg(t, () => `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ ok: false, error: { message } })}'\nexit 1\n`);
    await assert.rejects(runAireg({ binary, args: ["publish", "--json"], cwd: directory, env: { ...ENV, AIREG_TOKEN_ACME: token } }), (error: unknown) => {
      assert.ok(error instanceof AiregRefusal);
      assert.equal(error.reason.message, `${"a".repeat(MAX_REASON_CHARS - 10)} ***`);
      return true;
    });
  });

  it("reports a signal that killed aireg", async t => {
    captureStdout(t);
    const { directory, binary } = await fakeAireg(t, () => "#!/bin/sh\nkill -TERM $$\n");
    await assert.rejects(run(binary, directory), (error: Error) => {
      assert.equal(error.message, "aireg publish was killed by SIGTERM");
      assert.equal(error instanceof AiregRefusal, false);
      return true;
    });
  });

  it("prints aireg's stderr on stdout between the suspension markers", async t => {
    const log = captureStdout(t, /^(?:::|error: |hint: )/);
    const { directory, binary } = await fakeAireg(t, () => "#!/bin/sh\necho 'error: not an artifact' >&2\necho 'hint: Name a skill folder.' >&2\nexit 2\n");
    await assert.rejects(run(binary, directory), (error: unknown) => {
      assert.equal((error as Error).message, "aireg publish exited with status 2");
      assert.equal(error instanceof AiregRefusal, false);
      return true;
    });
    const printed = log.join("");
    const resume = /^::stop-commands::([0-9a-f-]{36})\n/.exec(printed)?.[1];
    assert.ok(resume, "the first line suspends workflow commands");
    assert.ok(printed.endsWith(`::${resume}::\n`), "commands resume only after everything aireg printed");
    assert.match(printed, /not an artifact/);
  });

  it("refuses with the error in aireg's JSON answer, keeping its code", async t => {
    captureStdout(t);
    const { directory, binary } = await fakeAireg(t, at => {
      const error = { code: "unauthorized", message: `Sign in to acme to publish ${at}/skills/a.`, hint: "Set AIREG_TOKEN_ACME." };
      return `#!/bin/sh\necho 'publishing'\necho '${JSON.stringify({ ok: false, error })}'\nexit 4\n`;
    });
    await assert.rejects(run(binary, directory), {
      name: "AiregRefusal",
      message: "aireg publish exited with status 4: Sign in to acme to publish skills/a. Hint: Set AIREG_TOKEN_ACME.",
      reason: { code: "unauthorized", message: "Sign in to acme to publish skills/a.", hint: "Set AIREG_TOKEN_ACME." }
    });
  });

  it("fails without a reason when aireg says nothing it can read", async t => {
    captureStdout(t);
    silenceStderr(t);
    const { directory, binary } = await fakeAireg(t, () => "#!/bin/sh\necho 'something broke' >&2\necho 'not json'\nexit 3\n");
    await assert.rejects(run(binary, directory, ["registry", "list"]), (error: Error) => {
      assert.equal(error.message, "aireg registry exited with status 3");
      assert.equal(error instanceof AiregRefusal, false);
      return true;
    });
  });

  for (const [status, expected] of [[0, "too large"], [3, "status"]] as const) {
    it(`drains output past its bound instead of stopping aireg, so exit ${status} still decides`, async t => {
      captureStdout(t);
      const { directory, binary } = await fakeAireg(t, at =>
        `#!${process.execPath}\nprocess.stdout.write("x".repeat(2 * 1024 * 1024), () => { require("node:fs").writeFileSync(${JSON.stringify(path.join(at, "finished"))}, ""); process.exit(${status}); });\n`);
      await assert.rejects(run(binary, directory), (error: Error) => {
        if (expected === "too large") assert.ok(error instanceof AiregOutputTooLarge);
        else assert.equal(error.message, "aireg publish exited with status 3");
        return true;
      });
      await stat(path.join(directory, "finished"));
    });
  }

  it("rejects when the binary cannot start", async t => {
    captureStdout(t);
    const directory = await temporaryDirectory(t);
    await assert.rejects(run(path.join(directory, "missing"), directory), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  });

  it("gives the subprocess exactly the given environment and its arguments without a shell", async t => {
    captureStdout(t);
    const { directory, binary } = await fakeAireg(t, at =>
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(path.join(at, "observed.json"))}, JSON.stringify({ env: process.env, args: process.argv.slice(2) }));\n`);
    const observed = path.join(directory, "observed.json");
    const env = { PATH: SYSTEM_PATH, HOME: directory, AIREG_TOKEN_ACME: "synthetic-token" };
    const args = ["publish", "$(touch injected)", "; touch injected", "`touch injected`"];
    // Coverage runs inject NODE_V8_COVERAGE into the env object itself, so compare against a copy.
    await runAireg({ binary, args, cwd: directory, env: { ...env } });
    const seen = JSON.parse(await readFile(observed, "utf8")) as { env: Record<string, string>; args: string[] };
    delete seen.env.__CF_USER_TEXT_ENCODING;
    delete seen.env.NODE_V8_COVERAGE;
    assert.deepEqual(seen, { env, args });
    await assert.rejects(stat(path.join(directory, "injected")), { code: "ENOENT" });
  });
});

describe("runAiregPublish", () => {
  for (const dryRun of [false, true]) {
    it(`runs aireg publish${dryRun ? " --dry-run" : ""} with the publisher environment and exactly the given tokens`, async () => {
      const commands: Command[] = [];
      const environment = { LANG: "C", AIREG_TOKEN_OTHER: "synthetic-other", "INPUT_GITHUB-TOKEN": "synthetic-github" };
      const tokens = { AIREG_TOKEN_ACME: "synthetic-acme" };
      const answer = await runAiregPublish({
        binary: "/runtime/aireg", runtimeDirectory: "/runtime", cwd: "/checkout", environment, tokens, dryRun,
        execute: async command => {
          commands.push(command);
          return "answer";
        }
      });
      assert.equal(answer, "answer");
      assert.deepEqual(commands, [{
        binary: "/runtime/aireg",
        args: ["publish", "--yes", "--json", ...(dryRun ? ["--dry-run"] : [])],
        cwd: "/checkout",
        env: publisherEnvironment(environment, tokens, "/runtime")
      }]);
      assert.equal(commands[0]?.env.AIREG_TOKEN_OTHER, undefined);
    });
  }
});

const UNREADABLE_LIST = /aireg could not list the registries \.registry\/manifest\.yml declares/;
const UNREADABLE_RESULT = /unreadable publish result/;

describe("declaredRegistries", () => {
  it("keeps each registry's name and adapter with a declaration that ignores key order", () => {
    const [acme, team] = declaredRegistries(registryList([
      { registry: "acme", address: "https://registry.example.com", adapter: "acme", config: { b: 1, a: [2, { d: null, c: "x" }] } },
      { registry: "team", address: "./registry" }
    ]));
    assert.deepEqual({ ...acme, declaration: undefined }, { registry: "acme", adapter: "acme", declaration: undefined });
    assert.deepEqual(team, { registry: "team", declaration: '{"address":"./registry","registry":"team"}' });
    const [reordered] = declaredRegistries(registryList([
      { config: { a: [2, { c: "x", d: null }], b: 1 }, adapter: "acme", address: "https://registry.example.com", registry: "acme" }
    ]));
    assert.equal(reordered?.declaration, acme?.declaration);
  });

  it("reads aireg's answer from its last non-empty line", () => {
    assert.deepEqual(declaredRegistries(`listing\n${registryList([{ registry: "acme" }])}\n\n`).map(entry => entry.registry), ["acme"]);
  });

  const refused: [string, string][] = [
    ["an adapter id that is a path", registryList([{ registry: "acme", adapter: "../acme" }])],
    ["a non-string adapter", registryList([{ registry: "acme", adapter: 7 }])],
    ["a registry name that is an option", registryList([{ registry: "--to", adapter: "acme" }])],
    ["a missing registry name", registryList([{ adapter: "acme" }])],
    ["an entry that is not an object", registryList(["acme"])],
    ["user scope", JSON.stringify({ ok: true, data: { scope: "user", registries: [] } })],
    ["a registry list that is not an array", JSON.stringify({ ok: true, data: { scope: "project", registries: {} } })],
    ["more registries than the bound", registryList(Array.from({ length: MAX_REGISTRIES + 1 }, (_, at) => ({ registry: `r${at}` })))],
    ["an error answer", JSON.stringify({ ok: false, data: { scope: "project", registries: [] } })],
    ["an answer without data", JSON.stringify({ ok: true })],
    ["output that is not JSON", "not json"],
    ["a JSON array", "[]"]
  ];
  for (const [name, raw] of refused) {
    it(`refuses ${name}`, () => assert.throws(() => declaredRegistries(raw), UNREADABLE_LIST));
  }

  it("accepts exactly the registry bound", () => {
    assert.equal(declaredRegistries(registryList(Array.from({ length: MAX_REGISTRIES }, (_, at) => ({ registry: `r${at}` })))).length, MAX_REGISTRIES);
  });
});

describe("dryRunResult", () => {
  const read = (extra: Record<string, unknown>) => dryRunResult(publishAnswer([exported("review", "0.3.1", "0.3.2", extra as never)], { dryRun: true })).artifacts[0];
  const files = { added: ["examples/new.md"], changed: ["SKILL.md"], removed: ["rules/old.md"] };
  const edges = { added: ["engineering/skill/lint@1.1.0"], removed: ["engineering/skill/lint@1.0.0"] };

  it("reads exports, skips and the target", () => {
    const result = dryRunResult(publishAnswer([exported("review", "0.3.1", "0.3.2", { dependsOn: [{ to: "engineering/skill/lint@1.0.0" }] })], { dryRun: true, skipped: [PLANNER] }));
    assert.deepEqual(result, {
      dryRun: true, target: TARGET, artifacts: [exported("review", "0.3.1", "0.3.2", { dependsOn: [{ to: "engineering/skill/lint@1.0.0" }] })], skipped: [PLANNER]
    });
  });

  it("keeps changed files, dependency changes and a digest", () => {
    assert.deepEqual(read({ filesChanged: files, dependsOnChanged: edges }), exported("review", "0.3.1", "0.3.2", { filesChanged: files, dependsOnChanged: edges }));
    const digest = `sha256:${"a".repeat(64)}`;
    assert.equal(read({ digest })?.digest, digest);
    assert.deepEqual(read({ filesChanged: { changed: ["SKILL.md"] } })?.filesChanged, { added: [], changed: ["SKILL.md"], removed: [] });
    assert.deepEqual(read({ filesChanged: { added: ["x".repeat(1024)] } })?.filesChanged?.added, ["x".repeat(1024)]);
  });

  it("keeps a withheld newest version, flattening and capping its reason", () => {
    assert.deepEqual(read({ withheld: { version: "0.3.1", status: "pending_review" } })?.withheld, { version: "0.3.1", status: "pending_review" });
    assert.deepEqual(read({ withheld: { version: "0.3.1", status: "blocked", reason: ` leaks\n‮tokens ${"x".repeat(600)}` } })?.withheld,
      { version: "0.3.1", status: "blocked", reason: `leaks tokens ${"x".repeat(487)}` });
  });

  it("drops change lists that are present but empty", () => {
    assert.deepEqual(read({ filesChanged: { added: [], changed: [], removed: [] }, dependsOnChanged: { added: [], removed: [] } }), exported("review", "0.3.1", "0.3.2"));
  });

  it("strips fields aireg adds that the action does not read", () => {
    assert.deepEqual(read({ dependsOn: [{ to: "engineering/skill/lint@1.0.0", pinned: true }], extra: "ignored" } as Record<string, unknown>),
      exported("review", "0.3.1", "0.3.2", { dependsOn: [{ to: "engineering/skill/lint@1.0.0" }] }));
  });

  it("returns no target when the dry run names none", () => {
    assert.deepEqual(dryRunResult(publishAnswer([], { dryRun: true, target: null })), { dryRun: true, artifacts: [], skipped: [] });
    assert.deepEqual(dryRunResult(JSON.stringify({ ok: true, data: { dryRun: true, artifacts: [] } })), { dryRun: true, artifacts: [], skipped: [] });
  });

  const malformed: Record<string, unknown>[] = [
    { filesChanged: null }, { filesChanged: ["SKILL.md"] }, { filesChanged: "SKILL.md" }, { filesChanged: { changed: "SKILL.md" } },
    { filesChanged: { changed: null } }, { filesChanged: { removed: [7] } }, { filesChanged: { removed: [""] } },
    { filesChanged: { removed: ["rules/\u001b[2Jold.md"] } }, { filesChanged: { removed: ["rules/\u202eold.md"] } },
    { filesChanged: { added: ["x".repeat(1025)] } },
    { filesChanged: { added: Array.from({ length: 1001 }, (_, at) => `f${at}.md`) } },
    { digest: "sha256:abc" }, { digest: `SHA256:${"a".repeat(64)}` }, { digest: 7 },
    { dependsOnChanged: [] }, { dependsOnChanged: { added: [{ to: "engineering/skill/lint@1.1.0" }] } },
    { dependsOnChanged: { removed: ["engineering/skill/lint@1.0.0\n"] } },
    { dependsOnChanged: { added: Array.from({ length: 101 }, (_, at) => `engineering/skill/s${at}@1.0.0`) } },
    { dependsOn: "engineering/skill/lint@1.0.0" }, { dependsOn: ["engineering/skill/lint@1.0.0"] }, { dependsOn: [{ to: "" }] },
    { dependsOn: Array.from({ length: 101 }, (_, at) => ({ to: `engineering/skill/s${at}@1.0.0` })) },
    { name: "review\u202e" }, { name: "x".repeat(201) }, { kind: 7 }, { registry: "" }, { namespace: undefined }, { version: null },
    { from: 7 }, { from: "" }, { published: "yes" },
    { withheld: "blocked" }, { withheld: null }, { withheld: { status: "blocked" } }, { withheld: { version: "0.3.1", status: "" } },
    { withheld: { version: "0.3.1", status: "blocked‮" } }, { withheld: { version: "0.3.1", status: "blocked", reason: 7 } }
  ];
  for (const extra of malformed) {
    it(`refuses an export with ${JSON.stringify(extra).slice(0, 80)}`, () => assert.throws(() => read(extra), UNREADABLE_RESULT));
  }

  const unreadable: [string, string][] = [
    ["a completed publish", publishAnswer([], { dryRun: false })],
    ["an error answer", JSON.stringify({ ok: false, data: { dryRun: true, artifacts: [] } })],
    ["a target that is a string", publishAnswer([], { dryRun: true, target: "acme" })],
    ["a target without a namespace", publishAnswer([], { dryRun: true, target: { registry: "acme" } })],
    ["artifacts that are not a list", JSON.stringify({ ok: true, data: { dryRun: true, artifacts: {} } })],
    ["an export that is not an object", publishAnswer(["review"], { dryRun: true })],
    ["skips that are not a list", JSON.stringify({ ok: true, data: { dryRun: true, artifacts: [], skipped: {} } })],
    ["a skip without a reason", publishAnswer([], { dryRun: true, skipped: [{ name: "planner", kind: "agent" }] as never })],
    ["a skip with a bad path", publishAnswer([], { dryRun: true, skipped: [{ ...PLANNER, path: "" }] })],
    ["more exports than the bound", publishAnswer(Array.from({ length: MAX_PUBLISHED_ARTIFACTS + 1 }, (_, at) => exported(`s${at}`, "1.0.0", "1.0.0")), { dryRun: true })],
    ["more skips than the bound", publishAnswer([], { dryRun: true, skipped: Array.from({ length: MAX_PUBLISHED_ARTIFACTS + 1 }, () => PLANNER) })],
    ["output that is not JSON", "published"]
  ];
  for (const [name, raw] of unreadable) {
    it(`refuses ${name}`, () => assert.throws(() => dryRunResult(raw), UNREADABLE_RESULT));
  }

  it("flattens control characters in a skip reason and caps its length", () => {
    const [skipped] = dryRunResult(publishAnswer([], { dryRun: true, skipped: [{ name: "planner", kind: "agent", reason: ` not\n\u202etaken ${"x".repeat(600)}` }] })).skipped;
    assert.equal(skipped?.reason.length, 500);
    assert.match(skipped?.reason ?? "", /^not taken x+$/);
  });
});

describe("publishedResult", () => {
  it("reads a complete publish", () => {
    const answer = publishAnswer([exported("review", "0.3.1", "0.3.2")], { skipped: [PLANNER] });
    assert.deepEqual(publishedResult(answer), { dryRun: false, target: TARGET, artifacts: [exported("review", "0.3.1", "0.3.2")], skipped: [PLANNER] });
  });

  it("keeps an export whose change details are malformed, without them, and marks the answer unread", () => {
    const published = publishedResult(publishAnswer([exported("review", "0.3.1", "0.3.2", {
      filesChanged: { removed: [7] } as never, digest: "sha256:bad", dependsOnChanged: { added: ["engineering/skill/lint@1.1.0"], removed: [] }
    })]));
    assert.deepEqual(published.artifacts, [exported("review", "0.3.1", "0.3.2")]);
    assert.equal(published.unread, true);
  });

  it("keeps valid change details", () => {
    const files = { added: ["examples/new.md"], changed: ["SKILL.md"], removed: [] };
    assert.deepEqual(publishedResult(publishAnswer([exported("review", "0.3.1", "0.3.2", { filesChanged: files })])).artifacts[0]?.filesChanged, files);
  });

  const unread: [string, string, number][] = [
    ["an export it cannot read", publishAnswer([exported("review", "0.3.1", "0.3.2"), { ...exported("sql-style", null, "0.1.0"), name: "sql\u202estyle" }]), 1],
    ["an export that is not an object", publishAnswer(["review", exported("review", "0.3.1", "0.3.2")]), 1],
    ["a dry-run answer", publishAnswer([exported("review", "0.3.1", "0.3.2")], { dryRun: true }), 1],
    ["output that is not JSON", "published, but no JSON", 0],
    ["no output", "", 0],
    ["a malformed target", publishAnswer([], { target: "acme" }), 0],
    ["skips that are not a list", JSON.stringify({ ok: true, data: { dryRun: false, artifacts: [], skipped: {} } }), 0],
    ["more exports than the bound", publishAnswer(Array.from({ length: MAX_PUBLISHED_ARTIFACTS + 1 }, (_, at) => exported(`s${at}`, "1.0.0", "1.0.1"))), MAX_PUBLISHED_ARTIFACTS]
  ];
  for (const [name, raw, kept] of unread) {
    it(`marks ${name} unread and keeps what it can read`, () => {
      const result = publishedResult(raw);
      assert.equal(result.unread, true);
      assert.equal(result.artifacts.length, kept);
      assert.equal(result.dryRun, false);
    });
  }

  it("drops a skip it cannot read", () => {
    const result = publishedResult(publishAnswer([], { skipped: [PLANNER, { name: "", kind: "agent", reason: "x" }] }));
    assert.deepEqual(result.skipped, [PLANNER]);
    assert.equal(result.unread, true);
  });

  it("reads an answer without a target or skips as complete", () => {
    assert.deepEqual(publishedResult(JSON.stringify({ ok: true, data: { dryRun: false, artifacts: [] } })), { dryRun: false, artifacts: [], skipped: [] });
  });
});

describe("failureReason", () => {
  const cwd = "/work/repo";
  const errorAnswer = (error: unknown) => `publishing\n${JSON.stringify({ ok: false, error })}\n`;

  it("reads aireg's JSON error with its code and hint, relative to the working directory", () => {
    assert.deepEqual(failureReason(errorAnswer({ code: "unauthorized", message: `Sign in to publish ${cwd}/skills/a.`, hint: `Check ${cwd}/x.` }), cwd),
      { code: "unauthorized", message: "Sign in to publish skills/a.", hint: "Check x." });
  });

  const answers: [string, unknown, unknown][] = [
    ["drops a code that is not an identifier", { code: "Not Allowed", message: "refused" }, { message: "refused" }],
    ["drops a blank hint", { code: "rejected", message: "refused", hint: "  " }, { code: "rejected", message: "refused" }],
    ["flattens control characters", { message: "line one\n\u001b[2Jline\u202etwo" }, { message: "line one [2Jline two" }],
    ["caps the message length", { message: "x".repeat(1200), hint: "y".repeat(1200) }, { message: "x".repeat(1000), hint: "y".repeat(1000) }]
  ];
  for (const [name, error, expected] of answers) {
    it(name, () => assert.deepEqual(failureReason(errorAnswer(error), cwd), expected));
  }

  const none: [string, string][] = [
    ["output that is not JSON", "error: something\n"],
    ["a successful JSON answer", JSON.stringify({ ok: true, data: {} })],
    ["a JSON error without a message", JSON.stringify({ ok: false, error: { code: "x" } })]
  ];
  for (const [name, stdout] of none) {
    it(`finds no reason in ${name}`, () => assert.equal(failureReason(stdout, cwd), undefined));
  }
});
