import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import fsp, { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, it, type TestContext } from "node:test";
import type { Command } from "../src/aireg.ts";
import { CLI_RELEASE_KEYS, GIT_ENVIRONMENT, MAX_CLI_BYTES, SYSTEM_PATH } from "../src/constants.ts";
import {
  compareVersions, downloadCli, fetchRelease, type HttpsGet, installCli, type InstallOptions, type Release, resolveCliPlatform, verifyRelease
} from "../src/install.ts";
import { captureStdout, temporaryDirectory } from "./helpers/action.ts";
import { registryList } from "./helpers/fixtures.ts";

const RELEASE_FIXTURE = path.resolve(import.meta.dirname, "fixtures/aireg-release-manifest.json");

interface Signer {
  keyId: string;
  privateKey: KeyObject;
  keys: Record<string, string>;
}

function signer(keyId = "test-2026-v1"): Signer {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url").toString("base64");
  return { keyId, privateKey, keys: { [keyId]: raw } };
}

type ManifestFields = Record<string, unknown> & { artifacts?: unknown[] };

const ARTIFACTS = [{ name: "aireg-linux-amd64", sha256: "a".repeat(64), size: 10 }];

function manifest(fields: ManifestFields = {}, signers: Signer[] = [signer()], signed: ManifestFields = fields): Buffer {
  const body = { schema: "aireg-manifest.v1", channel: "stable", version: "0.2.0", minimum_version: null, published_at: "2026-10-20T00:00:00Z", artifacts: ARTIFACTS, ...fields };
  const covered = { schema: body.schema, channel: body.channel, version: body.version, minimum_version: body.minimum_version, published_at: body.published_at, artifacts: body.artifacts, ...signed };
  const payload = Buffer.from(JSON.stringify(covered));
  const signatures = signers.map(({ keyId, privateKey }) => ({ algorithm: "ed25519", key_id: keyId, value: sign(null, payload, privateKey).toString("base64") }));
  return Buffer.from(JSON.stringify({ ...body, signatures }));
}

describe("resolveCliPlatform", () => {
  for (const [platform, arch, target] of [
    ["linux", "x64", "linux-amd64"], ["linux", "arm64", "linux-arm64"], ["darwin", "x64", "darwin-amd64"], ["darwin", "arm64", "darwin-arm64"]
  ] as const) {
    it(`maps ${platform}/${arch} to ${target}`, () => assert.equal(resolveCliPlatform(platform, arch), target));
  }

  for (const [platform, arch, message] of [["win32", "x64", /Linux and macOS/], ["linux", "ia32", /amd64 and arm64/]] as const) {
    it(`refuses ${platform}/${arch}`, () => assert.throws(() => resolveCliPlatform(platform, arch), message));
  }
});

describe("verifyRelease", () => {
  it("accepts aireg's real stable release with the pinned key", async () => {
    const release = verifyRelease(await readFile(RELEASE_FIXTURE));
    assert.equal(release.version, "0.1.7");
    assert.ok(release.artifacts.some(artifact => artifact.name === "aireg-linux-amd64"));
  });

  it("refuses the real release once any signed field changes", async () => {
    const real = JSON.parse(await readFile(RELEASE_FIXTURE, "utf8")) as Record<string, unknown>;
    assert.throws(() => verifyRelease(Buffer.from(JSON.stringify({ ...real, version: "0.1.8" })), CLI_RELEASE_KEYS), /invalid signature/);
  });

  describe("refuses a validly signed release older than the minimum version", () => {
    for (const version of ["0.1.6", "0.0.9", "0.1.7-rc.1"]) {
      it(version, () => {
        const key = signer();
        assert.throws(() => verifyRelease(manifest({ version }, [key]), key.keys, "0.1.7"), /older than 0\.1\.7, the oldest this action runs; refusing a possible rollback/);
      });
    }
  });

  it("accepts the minimum version and anything newer, comparing each part as a number", () => {
    const key = signer();
    for (const version of ["0.1.7", "0.1.10", "0.10.0", "1.0.0-rc.1"]) assert.equal(verifyRelease(manifest({ version }, [key]), key.keys, "0.1.7").version, version);
  });

  it("orders versions, putting a prerelease before its release", () => {
    assert.deepEqual([compareVersions("0.2.0", "0.10.0"), compareVersions("1.0.0", "1.0.0"), compareVersions("1.0.0-rc.1", "1.0.0"), compareVersions("1.0.0", "1.0.0-rc.1"),
      compareVersions("1.0.0-rc.1", "1.0.0-rc.2"), compareVersions("1.0.0-rc.2", "1.0.0-rc.1")], [-1, 0, -1, 1, -1, 1]);
  });

  it("returns the version and artifacts of a release a trusted key signed", () => {
    const key = signer();
    assert.deepEqual(verifyRelease(manifest({}, [key]), key.keys), { version: "0.2.0", artifacts: ARTIFACTS });
  });

  it("accepts a release signed by an untrusted key as long as a trusted key also signed it", () => {
    const trusted = signer("trusted");
    assert.equal(verifyRelease(manifest({}, [signer("other"), trusted]), trusted.keys).version, "0.2.0");
  });

  it("refuses a release no trusted key signed", () => {
    assert.throws(() => verifyRelease(manifest({}, [signer("other")]), signer("trusted").keys), /not signed by a key this action trusts/);
  });

  it("refuses a bad signature from a trusted key even next to a good one", () => {
    const trusted = signer("trusted");
    const forged = { ...signer("trusted"), keyId: "trusted" };
    assert.throws(() => verifyRelease(manifest({}, [forged, trusted]), trusted.keys), /invalid signature/);
  });

  it("refuses a release whose signed fields were changed after signing", () => {
    const key = signer();
    assert.throws(() => verifyRelease(manifest({ version: "9.9.9" }, [key], { version: "0.2.0" }), key.keys), /invalid signature/);
  });

  const malformed: [string, ManifestFields][] = [
    ["an unknown field", { extra: true }],
    ["another schema", { schema: "aireg-manifest.v2" }],
    ["another channel", { channel: "beta" }],
    ["an adapter release", { adapter: "acme" }],
    ["a version that is not exact", { version: "v1.2.3" }],
    ["no artifacts", { artifacts: [] }],
    ["an artifact with a bad digest", { artifacts: [{ ...ARTIFACTS[0], sha256: "abc" }] }],
    ["an artifact with no size", { artifacts: [{ ...ARTIFACTS[0], size: 0 }] }],
    ["an artifact over the size limit", { artifacts: [{ ...ARTIFACTS[0], size: MAX_CLI_BYTES + 1 }] }],
    ["an artifact named like a path", { artifacts: [{ ...ARTIFACTS[0], name: "../aireg" }] }]
  ];
  for (const [label, fields] of malformed) {
    it(`refuses a release with ${label}`, () => {
      const key = signer();
      assert.throws(() => verifyRelease(manifest(fields, [key]), key.keys), /malformed/);
    });
  }

  it("refuses a manifest that is not JSON or carries no signatures", () => {
    assert.throws(() => verifyRelease(Buffer.from("{"), {}), /not valid JSON/);
    assert.throws(() => verifyRelease(manifest({}, []), {}), /malformed/);
  });

  for (const [label, change] of [
    ["another algorithm", { algorithm: "rsa" }],
    ["a truncated signature", { value: Buffer.alloc(32).toString("base64") }]
  ] as const) {
    it(`refuses a trusted key's signature with ${label}`, () => {
      const key = signer();
      const raw = JSON.parse(manifest({}, [key]).toString()) as { signatures: Record<string, unknown>[] };
      raw.signatures = raw.signatures.map(signature => ({ ...signature, ...change }));
      assert.throws(() => verifyRelease(Buffer.from(JSON.stringify(raw)), key.keys), /invalid signature/);
    });
  }
});

class FakeRequest extends EventEmitter {
  destroyedWith: Error | undefined;

  destroy(error: Error): this {
    this.destroyedWith = error;
    this.emit("error", error);
    return this;
  }
}

function fakeResponse(t: TestContext, statusCode: number | undefined, body: Iterable<Buffer> = [], headers: Record<string, string> = {}) {
  const response = Object.assign(Readable.from(body), { statusCode, headers }) as unknown as IncomingMessage;
  const resume = t.mock.method(response, "resume");
  return { response, resume };
}

function fakeGet(response?: IncomingMessage) {
  const request = new FakeRequest();
  const calls: { url: string; options: unknown }[] = [];
  const get: HttpsGet = (url, options, callback) => {
    calls.push({ url, options });
    if (response) queueMicrotask(() => callback(response));
    return request;
  };
  return { get, calls, request };
}

describe("fetchRelease", () => {
  for (const status of [301, 302, 307]) {
    it(`refuses an HTTP ${status} redirect without following it`, async t => {
      const { response, resume } = fakeResponse(t, status, [], { location: "https://elsewhere.example/aireg" });
      const { get, calls } = fakeGet(response);
      await assert.rejects(fetchRelease("/channels/stable/manifest.json", 1024, get), /redirected; refusing an unapproved source/);
      assert.equal(resume.mock.callCount(), 1);
      assert.equal(calls.length, 1);
    });
  }

  for (const [status, message] of [[404, /failed with HTTP 404/], [500, /failed with HTTP 500/], [undefined, /failed with HTTP 0/]] as const) {
    it(`refuses an HTTP ${status} answer`, async t => {
      const { response, resume } = fakeResponse(t, status);
      await assert.rejects(fetchRelease("/x", 1024, fakeGet(response).get), message);
      assert.equal(resume.mock.callCount(), 1);
    });
  }

  it("refuses a declared length over the limit before reading the body", async t => {
    const { response, resume } = fakeResponse(t, 200, [], { "content-length": "1025" });
    await assert.rejects(fetchRelease("/x", 1024, fakeGet(response).get), /exceeds the size limit/);
    assert.equal(resume.mock.callCount(), 1);
  });

  it("stops a streamed body over the limit when no length is declared", async t => {
    const { response } = fakeResponse(t, 200, [Buffer.alloc(600), Buffer.alloc(600)]);
    await assert.rejects(fetchRelease("/x", 1024, fakeGet(response).get), /exceeds the size limit/);
  });

  it("requests the fixed origin with a timeout and returns the body", async t => {
    const { response } = fakeResponse(t, 200, [Buffer.from("{}")], { "content-length": "2" });
    const { get, calls } = fakeGet(response);
    assert.equal((await fetchRelease("/channels/stable/manifest.json", 1024, get)).toString(), "{}");
    assert.deepEqual(calls, [{ url: "https://aireg.sh/channels/stable/manifest.json", options: { timeout: 60_000, headers: { "User-Agent": "ai-registry-action" } } }]);
  });

  it("destroys a request that times out", async () => {
    const { get, request } = fakeGet();
    const fetching = fetchRelease("/x", 1024, get);
    request.emit("timeout");
    await assert.rejects(fetching, /aireg download timed out/);
    assert.match(request.destroyedWith?.message ?? "", /timed out/);
  });

  it("rejects on a request error", async () => {
    const { get, request } = fakeGet();
    const fetching = fetchRelease("/x", 1024, get);
    request.emit("error", new Error("connection reset"));
    await assert.rejects(fetching, /connection reset/);
  });

  for (const pathname of ["//elsewhere.example/aireg", "https://elsewhere.example/aireg", "/x?redirect=1", "/x#y"]) {
    it(`refuses ${pathname} before making any request`, () => {
      const { get, calls } = fakeGet();
      assert.throws(() => fetchRelease(pathname, 1024, get), /not approved/);
      assert.deepEqual(calls, []);
    });
  }
});

describe("downloadCli", () => {
  const body = Buffer.from("#!/bin/sh\n");
  const release = (artifact: Partial<Release["artifacts"][number]> = {}): Release => ({
    version: "0.2.0",
    artifacts: [{ name: "aireg-linux-amd64", sha256: createHash("sha256").update(body).digest("hex"), size: body.length, ...artifact }]
  });

  it("downloads the platform's artifact of that release, held to its signed size", async t => {
    const { response } = fakeResponse(t, 200, [body]);
    const { get, calls } = fakeGet(response);
    assert.deepEqual(await downloadCli(release(), "linux-amd64", get), body);
    assert.equal(calls[0]?.url, "https://aireg.sh/artifacts/v0.2.0/aireg-linux-amd64");
  });

  it("refuses a platform the release has no build for", async () => {
    await assert.rejects(downloadCli(release(), "darwin-arm64", fakeGet().get), /aireg 0\.2\.0 has no build for darwin-arm64/);
  });

  for (const [label, artifact, served] of [
    ["a body shorter than its signed size", {}, Buffer.from("#!/bin/")],
    ["a body that does not match its signed digest", { sha256: "b".repeat(64) }, body]
  ] as const) {
    it(`refuses ${label}`, async t => {
      const { response } = fakeResponse(t, 200, [served]);
      await assert.rejects(downloadCli(release(artifact), "linux-amd64", fakeGet(response).get), /does not match its signed release manifest/);
    });
  }

  it("refuses a body longer than its signed size", async t => {
    const { response } = fakeResponse(t, 200, [Buffer.concat([body, body])]);
    await assert.rejects(downloadCli(release(), "linux-amd64", fakeGet(response).get), /exceeds the size limit/);
  });
});

interface FakeInstall {
  commands: Command[];
  directory: () => string;
  options: Omit<InstallOptions, "environment" | "cwd">;
}

const RELEASE: Release = { version: "9.8.7", artifacts: [] };

function fakeInstall(answer: (command: Command) => string, binary = Buffer.from("")): FakeInstall {
  const commands: Command[] = [];
  let directory = "";
  return {
    commands,
    directory: () => directory,
    options: {
      release: async () => RELEASE,
      download: async () => binary,
      execute: async command => {
        directory = path.dirname(command.binary);
        commands.push(command);
        return answer(command);
      }
    }
  };
}

const answers = ({ head = registryList([]), base = head }: { head?: string; base?: string } = {}) =>
  ({ args, cwd }: Command): string => args[0] === "registry" ? (cwd === "/base" ? base : head) : "";

const exists = (file: string) => stat(file).then(() => true, () => false);

describe("installCli", () => {
  it("writes the verified binary to the runtime directory, owner-only, and reports its version", async t => {
    const fake = fakeInstall(answers(), Buffer.from("#!/bin/sh\n"));
    const installed = await installCli({ environment: {}, cwd: "/checkout", ...fake.options });
    t.after(() => rm(installed.directory, { recursive: true, force: true }));
    assert.equal(installed.version, "9.8.7");
    assert.equal(installed.binary, path.join(installed.directory, "aireg"));
    assert.equal(path.basename(installed.directory).startsWith("aireg-publish-"), true);
    assert.equal(await readFile(installed.binary, "utf8"), "#!/bin/sh\n");
    assert.equal((await stat(installed.binary)).mode & 0o777, 0o700);
  });

  it("downloads this runner's build of the release it verified", async t => {
    const seen: [Release, string][] = [];
    const fake = fakeInstall(answers());
    const installed = await installCli({
      environment: {}, cwd: "/checkout", ...fake.options,
      download: async (release, target) => {
        seen.push([release, target]);
        return Buffer.from("");
      }
    });
    t.after(() => rm(installed.directory, { recursive: true, force: true }));
    assert.deepEqual(seen, [[RELEASE, resolveCliPlatform(process.platform, process.arch)]]);
  });

  it("lists the registries and installs only non-built-in adapters, with no credential in any environment", async t => {
    const hostile = {
      HOME: "/caller/home",
      PATH: "/hostile/bin",
      AIREG_HOME: "/caller/aireg",
      OTHER_TOKEN: "synthetic-other-token",
      AIREG_TOKEN_ACME: "synthetic-caller-token",
      ACTIONS_RUNTIME_TOKEN: "synthetic-runner-token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-oidc-token",
      "INPUT_GITHUB-TOKEN": "synthetic-github-token",
      UNEXPECTED_SECRET: "synthetic-future-secret"
    };
    const fake = fakeInstall(answers({
      head: registryList([
        { registry: "acme", address: "https://registry.example.com", config: {}, adapter: "acme" },
        { registry: "mirror", address: "https://mirror.example", config: {}, adapter: "acme" },
        { registry: "team", address: "https://github.com/acme/registry", config: {}, adapter: "git" },
        { registry: "files", address: "./registry", config: {} }
      ])
    }));
    const installed = await installCli({ environment: hostile, cwd: "/checkout", ...fake.options });
    t.after(() => rm(installed.directory, { recursive: true, force: true }));
    const { binary, directory } = installed;
    const owned = {
      HOME: directory, AIREG_HOME: path.join(directory, ".aireg"), AIREG_USER_SCOPE: path.join(directory, "registry"),
      AIREG_DISABLE_UPDATE_CHECK: "1", PATH: SYSTEM_PATH
    };
    assert.equal(installed.base, undefined);
    assert.deepEqual(installed.registries.map(({ declaration: _declaration, ...entry }) => entry), [
      { registry: "acme", adapter: "acme" }, { registry: "mirror", adapter: "acme" }, { registry: "team", adapter: "git" }, { registry: "files" }
    ]);
    assert.deepEqual(fake.commands, [
      { binary, args: ["registry", "list", "--json"], cwd: "/checkout", env: { ...owned, ...GIT_ENVIRONMENT } },
      { binary, args: ["adapter", "install", "acme", "--yes", "--json"], cwd: directory, env: owned }
    ]);
  });

  it("lists the base after the head and installs the adapters of both once each", async t => {
    const fake = fakeInstall(answers({
      head: registryList([{ registry: "acme", adapter: "acme" }, { registry: "team", adapter: "custom" }]),
      base: registryList([{ registry: "acme", adapter: "old-acme" }, { registry: "team", adapter: "custom" }])
    }));
    const installed = await installCli({ environment: { AIREG_TOKEN_ACME: "synthetic-caller-token" }, cwd: "/checkout", baseCwd: "/base", ...fake.options });
    t.after(() => rm(installed.directory, { recursive: true, force: true }));
    assert.deepEqual(fake.commands.map(command => [command.args.join(" "), command.cwd]), [
      ["registry list --json", "/checkout"], ["registry list --json", "/base"],
      ["adapter install acme --yes --json", installed.directory], ["adapter install custom --yes --json", installed.directory],
      ["adapter install old-acme --yes --json", installed.directory]
    ]);
    assert.equal(fake.commands.some(command => Object.keys(command.env).some(key => key.includes("TOKEN"))), false);
    assert.deepEqual(installed.base && "registries" in installed.base ? installed.base.registries.map(entry => entry.adapter) : [], ["old-acme", "custom"]);
  });

  it("reports an unlistable base as a base error and still installs the head's adapters", async t => {
    const fake = fakeInstall(answers({ head: registryList([{ registry: "team", adapter: "custom" }]), base: "not json" }));
    const installed = await installCli({ environment: {}, cwd: "/checkout", baseCwd: "/base", ...fake.options });
    t.after(() => rm(installed.directory, { recursive: true, force: true }));
    assert.deepEqual(installed.base, { error: "aireg could not list the registries the base commit's .registry/manifest.yml declares" });
    assert.deepEqual(fake.commands.at(-1)?.args, ["adapter", "install", "custom", "--yes", "--json"]);
  });

  for (const [label, listing] of [
    ["an adapter path", registryList([{ registry: "acme", adapter: "../acme" }])],
    ["an option-like registry name", registryList([{ registry: "--to", adapter: "acme" }])],
    ["user scope", JSON.stringify({ ok: true, data: { scope: "user", registries: [] } })],
    ["no JSON", "not json"]
  ] as const) {
    it(`refuses a head listing with ${label} before installing any adapter, and removes the runtime directory`, async () => {
      const fake = fakeInstall(answers({ head: listing }));
      await assert.rejects(installCli({ environment: {}, cwd: "/checkout", ...fake.options }), /aireg could not list the registries \.registry\/manifest\.yml declares/);
      assert.equal(fake.commands.some(command => command.args[0] === "adapter"), false);
      assert.equal(await exists(fake.directory()), false);
    });
  }

  for (const [label, failure] of [
    ["the release cannot be verified", { release: async () => { throw new Error("aireg's release manifest has an invalid signature"); } }],
    ["the download does not match", { download: async () => { throw new Error("aireg download does not match its signed release manifest"); } }]
  ] as const) {
    it(`runs nothing and removes the runtime directory when ${label}`, async t => {
      const created: string[] = [];
      const mkdtemp = fsp.mkdtemp.bind(fsp);
      t.mock.method(fsp, "mkdtemp", async (prefix: string) => {
        const made = await mkdtemp(prefix);
        created.push(made);
        return made;
      });
      const fake = fakeInstall(answers());
      await assert.rejects(installCli({ environment: {}, cwd: "/checkout", ...fake.options, ...failure }), /signature|does not match/);
      assert.deepEqual(fake.commands, []);
      assert.equal(created.length, 1);
      assert.equal(await exists(created[0] ?? ""), false);
    });
  }

  it("runs the binary directly with fixed arguments, ignoring a caller PATH with a hostile sh", async t => {
    const home = await temporaryDirectory(t);
    const hostile = path.join(home, "hostile-bin");
    const marker = path.join(home, "hostile-sh-ran");
    const observed = path.join(home, "adapter-arguments");
    await mkdir(hostile);
    await writeFile(path.join(hostile, "sh"), `#!/bin/sh\nprintf invoked > '${marker}'\nexit 99\n`);
    await chmod(path.join(hostile, "sh"), 0o700);
    const written = captureStdout(t);
    const script = [
      "#!/bin/sh",
      "set -eu",
      `if [ "$1" = registry ]; then echo '${registryList([{ registry: "team", adapter: "example" }])}'; exit 0; fi`,
      `printf '%s' "$*" > '${observed}'`,
      ""
    ].join("\n");
    const installed = await installCli({ environment: { HOME: home, PATH: hostile }, cwd: home, release: async () => RELEASE, download: async () => Buffer.from(script) });
    t.after(() => rm(installed.directory, { recursive: true, force: true }));
    assert.equal(await readFile(observed, "utf8"), "adapter install example --yes --json");
    assert.equal(await exists(marker), false);
    assert.equal(written.filter(line => line.startsWith("::stop-commands::")).length, 2);
  });
});
