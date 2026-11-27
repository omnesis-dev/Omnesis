// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { releasedTmpMountFacts } from "../../packages/collector/src/e2e/released-peer-fixture.js";
import {
  releasedCollector,
  releasedGateway,
  releasedDirection,
  releasedDirectionArgs,
  releasedContainerArguments,
  runReleasedPeerContainer,
  verifyReleasedCollectorImage,
} from "./test-released-peer-container.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});
function image(arch = "arm64", direction = "released-collector") {
  const pin = (direction === "released-gateway" ? releasedGateway : releasedCollector)[arch];
  return [
    {
      Id: pin.config,
      Os: "linux",
      Architecture: arch === "x64" ? "amd64" : "arm64",
      RepoDigests: [
        `ghcr.io/omnesis-dev/omnesis-${direction === "released-gateway" ? "gateway" : "collector"}@${pin.manifest}`,
      ],
      Config: {
        WorkingDir: "/app",
        User: "10001:10001",
        Cmd: [
          "node",
          direction === "released-gateway"
            ? "packages/gateway/dist/index.js"
            : "packages/collector/dist/main.js",
        ],
        Entrypoint:
          direction === "released-gateway" ? ["/app/scripts/seeded-state/entrypoint.sh"] : [],
        Labels: {
          "org.opencontainers.image.revision": releasedCollector.revision,
          "org.opencontainers.image.version": releasedCollector.version,
          "org.opencontainers.image.source": "https://github.com/omnesis-dev/Omnesis",
        },
      },
    },
  ];
}

// A real executable and persistent fake-daemon state exercise process/receipt control flow.
// They do NOT prove any Docker image, actual container, protocol or interoperability outcome.
async function fake(mode = "success", direction = "released-collector") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "omnesis-c6-docker-test-")));
  roots.push(directory);
  const state = join(directory, "state.json"),
    docker = join(directory, "docker.mjs");
  await writeFile(
    state,
    JSON.stringify({ mode, direction, image: image(process.arch, direction), calls: [] }),
    {
      mode: 0o600,
    },
  );
  await writeFile(
    docker,
    `#!${process.execPath}
import {readFileSync,writeFileSync,renameSync,mkdirSync,readdirSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const path=join(dirname(fileURLToPath(import.meta.url)),'state.json');
const state=JSON.parse(readFileSync(path,'utf8')),args=process.argv.slice(2),id='a'.repeat(64);
state.calls.push(args);
state.configObservations??=[];
const configFile=join(process.env.DOCKER_CONFIG,'config.json');
state.configObservations.push({directory:process.env.DOCKER_CONFIG,changed:existsSync(configFile)});
const save=()=>{writeFileSync(path+'.next',JSON.stringify(state),{mode:0o600});renameSync(path+'.next',path)};
let output='',code=0,hold=false;
if(args[0]==='info'){output='linux/'+(state.image[0].Architecture==='arm64'?'aarch64':'x86_64');if(state.mode==='wrong-daemon')output='linux/'+(state.image[0].Architecture==='arm64'?'x86_64':'aarch64')}
else if(args[0]==='pull'){if(state.mode==='private-stderr'){process.stderr.write('discarded prefix '+ 'x'.repeat(100000)+'fictional private stderr marker');code=1}}
else if(args[0]==='image'){output=JSON.stringify(state.image)}
else if(args[0]==='create'){
 const nonce=args[args.indexOf('--label')+1].split('=')[1];
 state.results=args.find(x=>x.startsWith('type=bind,source=')&&x.includes(',target=/results')).split(',')[1].slice('source='.length);
 state.resultInitialEntries=readdirSync(state.results);
 state.mounts=args.filter(x=>x.startsWith('type=bind,source='));
 if(state.mode==='control-boundary'){
   mkdirSync(join(state.results,'docker-config'));
   writeFileSync(join(state.results,'docker-config','config.json'),JSON.stringify({currentContext:'foreign-context'}));
 }
 state.container={Id:id,Name:'/omnesis-released-peer-'+nonce,Image:state.image[0].Id,Config:{Labels:{'dev.omnesis.test.released-peer':nonce}},State:{Status:'created',Running:false,StartedAt:'0001-01-01T00:00:00Z',ExitCode:0,OOMKilled:false}};
 if(state.image[0].Descriptor)state.container.ImageManifestDescriptor={...state.image[0].Descriptor,platform:{os:'linux',architecture:state.image[0].Architecture}};
 if(state.containerFault==='image-switch')state.container.Image=state.alternateImageId;
 if(state.containerFault==='descriptor-missing')delete state.container.ImageManifestDescriptor;
 if(state.containerFault==='descriptor-digest')state.container.ImageManifestDescriptor={...state.container.ImageManifestDescriptor,digest:'sha256:'+'e'.repeat(64)};
 if(state.containerFault==='descriptor-platform')state.container.ImageManifestDescriptor={...state.container.ImageManifestDescriptor,platform:{os:'windows',architecture:state.image[0].Architecture}};
 if(state.mode==='foreign'){state.container.Config.Labels['dev.omnesis.test.released-peer']='foreign'}
 if(state.mode==='ambiguous'){code=1}else{output=id}
}else if(args[0]==='container'){output=JSON.stringify([state.container])}
else if(args[0]==='start'){
 state.container.State={...state.container.State,StartedAt:'2020-01-01T00:00:00Z',Status:'exited',ExitCode:['cohort-failure','compound-failure'].includes(state.mode)?23:0};
 if(state.mode==='hold'||state.mode==='stop-failure'||state.mode==='compound-failure'){state.container.State.Status='running';state.container.State.Running=true;hold=state.mode==='hold';code=['stop-failure','compound-failure'].includes(state.mode)?1:0}
 if(state.mode==='success'||state.mode==='control-boundary'){
  writeFileSync(join(state.results,'runtime.json'),JSON.stringify({format:1,direction:state.direction,node:'v24.22.3',releasedVersion:'0.8.1',currentProductResolutionOwned:true,releasedProductResolutionOwned:true,currentPackagedNodeQualified:false}),{mode:0o600});
  writeFileSync(join(state.results,'cohort.json'),JSON.stringify({format:1,initialSyncSettled:true,independentDeviceIds:true,realPublishedCollector:true,realPublishedGateway:true,desktopProtectionUnavailable:true,independentDesktopGrants:true,pauseConsumedBeforeNewFile:true,currentProgressWhilePaused:true,releasedSiblingProgressWhileCurrentPaused:true,resumedFileIngested:true,stableDocumentIds:true,operatingSystems:1}),{mode:0o600});
  if(state.receiptFault==='missing-protection'){
    const file=join(state.results,'cohort.json'),receipt=JSON.parse(readFileSync(file,'utf8'));
    delete receipt.desktopProtectionUnavailable;writeFileSync(file,JSON.stringify(receipt),{mode:0o600});
  }
  if(state.receiptFault==='wrong-direction'){
    const file=join(state.results,'runtime.json'),receipt=JSON.parse(readFileSync(file,'utf8'));
    receipt.direction='released-collector';writeFileSync(file,JSON.stringify(receipt),{mode:0o600});
  }
 }
 if(state.containerFault==='late-descriptor')state.container.ImageManifestDescriptor={...state.container.ImageManifestDescriptor,digest:'sha256:'+'e'.repeat(64)};
}else if(args[0]==='stop'){
 if(state.mode==='stop-failure'||state.mode==='compound-failure'){code=1}else{state.container.State.Running=false;state.container.State.Status='exited'}
}else if(args[0]==='wait'){output=String(state.mode==='mismatched-exit'?17:state.container.State.ExitCode)}
else if(args[0]==='rm'){state.removed=true;output=id}
else{code=2}
save();if(output)process.stdout.write(output);if(hold)setInterval(()=>{},1000);else process.exitCode=code;
`,
    { mode: 0o700 },
  );
  await chmod(docker, 0o700);
  return { directory, state, docker, read: async () => JSON.parse(await readFile(state, "utf8")) };
}
function options(fake, signal) {
  return {
    root: resolve("."),
    modules: resolve("node_modules"),
    architecture: process.arch,
    docker: fake.docker,
    signal,
    env: {
      ...process.env,
      DOCKER_HOST: "",
      DOCKER_CONTEXT: "",
      DOCKER_TLS_VERIFY: "",
      DOCKER_CERT_PATH: "",
    },
  };
}
async function resultOf(work) {
  try {
    const value = await work;
    roots.push(value.evidenceDirectory);
    return { value };
  } catch (error) {
    if (error.evidenceDirectory) roots.push(error.evidenceDirectory);
    return { error };
  }
}
async function onStarted(fake) {
  let watcher, timer;
  try {
    await new Promise((done, reject) => {
      const check = async () => {
        try {
          if ((await fake.read()).calls.some((args) => args[0] === "start")) done();
        } catch (error) {
          reject(error);
        }
      };
      watcher = watch(fake.directory, (_event, name) => {
        if (String(name) === "state.json") void check();
      });
      timer = setTimeout(() => reject(Error("fixture start barrier missing")), 5000);
      void check();
    });
  } finally {
    watcher?.close();
    clearTimeout(timer);
  }
}

function platformDescriptor(arch, direction, withPlatform = false) {
  const pin = (direction === "released-gateway" ? releasedGateway : releasedCollector)[arch];
  return {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: pin.manifest,
    size: pin.manifestSize,
    ...(withPlatform
      ? { platform: { os: "linux", architecture: arch === "arm64" ? "arm64" : "amd64" } }
      : {}),
  };
}
function inspectedBackend(arch, direction, backend) {
  const value = image(arch, direction);
  if (backend === "containerd") {
    value[0].Id = platformDescriptor(arch, direction).digest;
    value[0].Descriptor = platformDescriptor(arch, direction);
  }
  return value;
}
async function backendFixture(direction, backend, containerFault) {
  const fixture = await fake("success", direction);
  const state = await fixture.read();
  state.image = inspectedBackend(process.arch, direction, backend);
  state.containerFault = containerFault;
  const pin = (direction === "released-gateway" ? releasedGateway : releasedCollector)[
    process.arch
  ];
  state.alternateImageId = backend === "containerd" ? pin.config : pin.manifest;
  await writeFile(fixture.state, JSON.stringify(state), { mode: 0o600 });
  return fixture;
}

const backendCases = ["released-collector", "released-gateway"].flatMap((direction) =>
  ["arm64", "x64"].flatMap((arch) =>
    ["classic", "containerd"].map((backend) => [direction, arch, backend]),
  ),
);
describe("exact released identity across Docker image stores", () => {
  it.each(backendCases)("keeps native pins for %s/%s/%s", (direction, arch, backend) => {
    const value = inspectedBackend(arch, direction, backend);
    const verified = verifyReleasedCollectorImage(value, arch, direction);
    const pin = (direction === "released-gateway" ? releasedGateway : releasedCollector)[arch];
    expect(verified.config).toBe(pin.config);
    expect(verified.manifest).toBe(pin.manifest);
    expect(verified.localImageId).toBe(backend === "classic" ? pin.config : pin.manifest);
    expect(verified.localImageKind).toBe(backend === "classic" ? "config" : "manifest");
    // A classic daemon may supply the same correct optional manifest descriptor.
    value[0].Descriptor = platformDescriptor(arch, direction, true);
    expect(verifyReleasedCollectorImage(value, arch, direction).localImageId).toBe(
      verified.localImageId,
    );
    if (arch === "arm64") {
      value[0].Descriptor.platform.variant = "v8";
      expect(verifyReleasedCollectorImage(value, arch, direction).localImageId).toBe(
        verified.localImageId,
      );
    }
  });

  it.each(backendCases)(
    "rejects every contradictory descriptor for %s/%s/%s",
    (direction, arch, backend) => {
      const mutations = [
        (descriptor) => {
          descriptor.digest = "sha256:" + "f".repeat(64);
        },
        (descriptor) => {
          descriptor.size += 1;
        },
        (descriptor) => {
          descriptor.mediaType = "application/vnd.oci.image.index.v1+json";
        },
        (descriptor) => {
          descriptor.mediaType = "application/vnd.docker.distribution.manifest.v2+json";
        },
        (descriptor) => {
          descriptor.platform.os = "windows";
        },
        (descriptor) => {
          descriptor.platform.architecture = arch === "arm64" ? "amd64" : "arm64";
        },
        (descriptor) => {
          descriptor.platform.variant = "unreviewed-variant";
        },
      ];
      for (const mutate of mutations) {
        const value = inspectedBackend(arch, direction, backend);
        value[0].Descriptor = platformDescriptor(arch, direction, true);
        mutate(value[0].Descriptor);
        expect(() => verifyReleasedCollectorImage(value, arch, direction)).toThrow(
          "descriptor[contradictory]",
        );
      }
      for (const descriptor of ["private arbitrary value", [], 42]) {
        const value = inspectedBackend(arch, direction, backend);
        value[0].Descriptor = descriptor;
        expect(() => verifyReleasedCollectorImage(value, arch, direction)).toThrow();
      }
    },
  );

  it.each(backendCases)("preserves metadata refusals for %s/%s/%s", (direction, arch, backend) => {
    for (const mutate of [
      (value) => {
        value[0].RepoDigests = ["mutable:0.8.1"];
      },
      (value) => {
        value[0].Os = "windows";
      },
      (value) => {
        value[0].Architecture = arch === "arm64" ? "amd64" : "arm64";
      },
      (value) => {
        value[0].Config.WorkingDir = "/foreign";
      },
      (value) => {
        value[0].Config.User = "0:0";
      },
      (value) => {
        value[0].Config.Cmd = ["installer"];
      },
      (value) => {
        value[0].Config.Entrypoint = ["foreign-entrypoint"];
      },
      (value) => {
        value[0].Config.Labels["org.opencontainers.image.revision"] = "foreign";
      },
      (value) => {
        value[0].Config.Labels["org.opencontainers.image.version"] = "9.9.9";
      },
      (value) => {
        value[0].Config.Labels["org.opencontainers.image.source"] = "https://example.org/foreign";
      },
    ]) {
      const value = inspectedBackend(arch, direction, backend);
      mutate(value);
      expect(() => verifyReleasedCollectorImage(value, arch, direction)).toThrow(
        "Released image identity or metadata differs",
      );
    }
  });

  it("refuses missing manifest proof and index IDs without dumping unknown fields", () => {
    for (const direction of ["released-collector", "released-gateway"])
      for (const arch of ["arm64", "x64"]) {
        const pin = direction === "released-gateway" ? releasedGateway : releasedCollector;
        for (const descriptor of [undefined, null]) {
          const value = inspectedBackend(arch, direction, "containerd");
          value[0].Descriptor = descriptor;
          expect(() => verifyReleasedCollectorImage(value, arch, direction)).toThrow(
            "identity=false",
          );
        }
        const value = inspectedBackend(arch, direction, "containerd");
        value[0].Id = pin.index;
        expect(() => verifyReleasedCollectorImage(value, arch, direction)).toThrow(
          "identity[index]",
        );
        value[0].Id = "invented-private-unknown-id";
        value[0].Config.Env = ["INVENTED_SECRET=never-print-this-value"];
        let failure;
        try {
          verifyReleasedCollectorImage(value, arch, direction);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect(failure.message).toContain("identity[other]");
        expect(failure.message.length).toBeLessThan(400);
        expect(failure.message).not.toMatch(/invented-private|INVENTED_SECRET|never-print/);
      }
  });
});

describe.skipIf(process.platform !== "linux")(
  "verified image identity through real fake-Docker ownership",
  () => {
    it.each(
      ["released-collector", "released-gateway"].flatMap((direction) =>
        ["classic", "containerd"].map((backend) => [direction, backend]),
      ),
    )("retires only the exact verified image for %s/%s", async (direction, backend) => {
      const fixture = await backendFixture(direction, backend);
      const result = await resultOf(runReleasedPeerContainer({ ...options(fixture), direction }));
      expect(result.error).toBeUndefined();
      const state = await fixture.read();
      expect(state.removed).toBe(true);
      expect(state.calls.filter((args) => args[0] === "start")).toHaveLength(1);
      expect(state.calls.filter((args) => args[0] === "rm")).toEqual([["rm", "a".repeat(64)]]);
      expect(
        JSON.parse(await readFile(join(result.value.evidenceDirectory, "runner.json"), "utf8")),
      ).toMatchObject({
        retired: true,
        passed: true,
        localImageKind: backend === "classic" ? "config" : "manifest",
      });
    });

    it.each([
      ["classic", "image-switch"],
      ["containerd", "image-switch"],
      ["containerd", "descriptor-missing"],
      ["containerd", "descriptor-digest"],
      ["containerd", "descriptor-platform"],
      ["classic", "descriptor-digest"],
    ])("retains unconfirmed creation without cleanup for %s/%s", async (backend, fault) => {
      const fixture = await backendFixture("released-collector", backend, fault);
      const result = await resultOf(runReleasedPeerContainer(options(fixture)));
      expect(result.error).toBeInstanceOf(Error);
      const state = await fixture.read();
      expect(state.calls.some((args) => ["start", "stop", "wait", "rm"].includes(args[0]))).toBe(
        false,
      );
      expect(state.removed).toBeUndefined();
      expect(
        JSON.parse(await readFile(join(result.error.evidenceDirectory, "runner.json"), "utf8")),
      ).toMatchObject({
        verified: false,
        retired: false,
        passed: false,
      });
    });

    it("does not stop or remove an initially verified container after its manifest descriptor contradicts at cleanup", async () => {
      const fixture = await backendFixture("released-gateway", "containerd", "late-descriptor");
      const result = await resultOf(
        runReleasedPeerContainer({ ...options(fixture), direction: "released-gateway" }),
      );
      expect(result.error?.cleanupFailure).toBe("container-retirement");
      const state = await fixture.read();
      expect(state.calls.filter((args) => args[0] === "start")).toHaveLength(1);
      expect(state.calls.some((args) => ["stop", "wait", "rm"].includes(args[0]))).toBe(false);
      expect(state.removed).toBeUndefined();
      expect(
        JSON.parse(await readFile(join(result.error.evidenceDirectory, "runner.json"), "utf8")),
      ).toMatchObject({
        verified: true,
        retired: false,
        passed: false,
      });
    });
  },
);

describe("immutable released image policy", () => {
  it("accepts both native immutable platform/config pairs, refusing emulation and wrong metadata", () => {
    for (const arch of ["arm64", "x64"])
      expect(verifyReleasedCollectorImage(image(arch), arch).config).toBe(
        releasedCollector[arch].config,
      );
    expect(() => verifyReleasedCollectorImage(image(), "ppc64")).toThrow();
    for (const arch of ["arm64", "x64"]) {
      const absent = image(arch);
      delete absent[0].Config.Entrypoint;
      expect(verifyReleasedCollectorImage(absent, arch).config).toBe(
        releasedCollector[arch].config,
      );
      for (const entrypoint of [null, []]) {
        const empty = image(arch);
        empty[0].Config.Entrypoint = entrypoint;
        expect(verifyReleasedCollectorImage(empty, arch).config).toBe(
          releasedCollector[arch].config,
        );
      }
      for (const entrypoint of ["node", ["node"], {}, false, 1, undefined]) {
        const invalid = image(arch);
        invalid[0].Config.Entrypoint = entrypoint;
        expect(() => verifyReleasedCollectorImage(invalid, arch)).toThrow();
      }
    }

    for (const mutate of [
      (value) => {
        value[0].Id = "sha256:" + "0".repeat(64);
      },
      (value) => {
        value[0].Architecture = "amd64";
      },
      (value) => {
        value[0].RepoDigests = ["mutable:0.8.1"];
      },
      (value) => {
        value[0].Config.Cmd = ["node", "current.js"];
      },
      (value) => {
        value[0].Config.Entrypoint = ["installer"];
      },
      (value) => {
        value[0].Config.Labels["org.opencontainers.image.revision"] = "0".repeat(40);
      },
    ]) {
      const value = image();
      mutate(value);
      expect(() => verifyReleasedCollectorImage(value, "arm64")).toThrow();
    }
  });
  // The mount argument builder uses the POSIX host paths required by this Linux-only runner.
  it.skipIf(process.platform === "win32")(
    "isolates the real /app closure, copied current source, private state and direct Node test entry",
    () => {
      const args = releasedContainerArguments({
        architecture: "arm64",
        root: "/fixture/current",
        modules: "/fixture/deps/node_modules",
        marker: "/fixture/control/container.json",
        files: "/fixture/control/source-files",
        result: "/fixture/control/child-results",
        control: "/fixture/control",
        nonce: "fixture-nonce",
        uid: 1234,
        gid: 1234,
      });
      expect(args.slice(args.indexOf("--network"), args.indexOf("--network") + 2)).toEqual([
        "--network",
        "none",
      ]);
      expect(args).toContain("/tmp:rw,nosuid,nodev,exec,size=2g,mode=1777");
      expect(args).toContain("--read-only");
      expect(args).not.toContain("--privileged");
      expect(args).not.toContain("--publish");
      expect(
        args.filter(
          (arg) =>
            arg.includes("target=/app") ||
            arg.includes("docker.sock") ||
            arg.includes("NODE_TLS_REJECT_UNAUTHORIZED") ||
            arg.includes("NODE_PATH="),
        ),
      ).toEqual([]);
      expect(args).toContain("type=bind,source=/fixture/current,target=/input,readonly");
      expect(
        args.filter((arg) => arg.startsWith("type=bind,") && !arg.endsWith(",readonly")),
      ).toEqual(["type=bind,source=/fixture/control/child-results,target=/results"]);
      expect(args.at(-1)).toContain("exec node node_modules/vitest/vitest.mjs run");
      expect(args.at(-1)).not.toContain("npm run");
      expect(args).toContain("OMNESIS_RUNTIME_MODE=test");
      expect(args).toContain("OMNESIS_TELEMETRY=off");
      const isolated = {
        architecture: "arm64",
        root: "/fixture/current",
        modules: "/fixture/deps/node_modules",
        control: "/fixture/control",
        result: "/fixture/control/child-results",
        marker: "/fixture/control/container.json",
        files: "/fixture/control/source-files",
        nonce: "fixture-nonce",
        uid: 1234,
        gid: 1234,
      };
      for (const unsafe of [
        { result: isolated.control },
        { root: "/fixture" },
        { modules: "/fixture/control/node_modules" },
        { marker: "/fixture/foreign-marker" },
        { files: "/fixture/foreign-source-list" },
        { control: "/fixture/control/../control" },
      ])
        expect(() => releasedContainerArguments({ ...isolated, ...unsafe })).toThrow();

      for (const modules of [
        "/",
        "/fixture/current",
        "/app/node_modules",
        "/input/node_modules",
        "/tmp/omnesis-c6/current/node_modules",
        "/results/node_modules",
      ])
        expect(() =>
          releasedContainerArguments({
            architecture: "arm64",
            root: "/fixture/current",
            modules,
            marker: "/fixture/control/container.json",
            files: "/fixture/control/source-files",
            result: "/fixture/control/child-results",
            control: "/fixture/control",
            nonce: "fixture-nonce",
            uid: 1234,
            gid: 1234,
          }),
        ).toThrow();
    },
  );
});

describe.skipIf(process.platform !== "linux")("owned real fake-Docker control flow", () => {
  it("refuses a nonnative Docker daemon before pulling or creating anything", async () => {
    const fixture = await fake("wrong-daemon"),
      result = await resultOf(runReleasedPeerContainer(options(fixture)));
    expect(result.error).toBeInstanceOf(Error);
    expect((await fixture.read()).calls).toEqual([
      ["info", "--format", "{{.OSType}}/{{.Architecture}}"],
    ]);
  });

  it("retains invented secret stderr only in a capped private tail, not errors or JSON receipts", async () => {
    const fixture = await fake("private-stderr"),
      result = await resultOf(runReleasedPeerContainer(options(fixture)));
    const directory = result.error.evidenceDirectory;
    const metadataText = await readFile(join(directory, "phase-evidence.json"), "utf8");
    const phase = JSON.parse(metadataText).phases.find((value) => value.stage === "pull");
    const log = await readFile(join(directory, phase.leaf));
    expect(log.length).toBe(65536);
    expect(log.toString("utf8")).toContain("fictional private stderr marker");
    expect(log.toString("utf8")).not.toContain("discarded prefix");
    expect(phase).toMatchObject({ capturedBytes: 65536, truncated: true, rootClosed: true });
    expect(phase.stderrBytes).toBeGreaterThan(65536);
    expect((await stat(join(directory, phase.leaf))).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const publicText of [
      String(result.error),
      JSON.stringify(result.error),
      metadataText,
      await readFile(join(directory, "runner.json"), "utf8"),
    ])
      expect(publicText).not.toContain("fictional private stderr marker");
  });

  it("rejects remote Docker configuration before invoking the executable", async () => {
    const fixture = await fake();
    const result = await resultOf(
      runReleasedPeerContainer({
        ...options(fixture),
        env: { ...process.env, DOCKER_HOST: "tcp://remote.example.invalid:1234" },
      }),
    );
    expect(result.error).toBeInstanceOf(Error);
    expect((await fixture.read()).calls).toEqual([]);
  });

  it("waits and verifies exact exit before deleting the known created container", async () => {
    const fixture = await fake(),
      result = await resultOf(runReleasedPeerContainer(options(fixture)));
    expect(result.error).toBeUndefined();
    const state = await fixture.read();
    expect(state.calls.map((args) => args[0])).toEqual([
      "info",
      "pull",
      "image",
      "create",
      "container",
      "start",
      "container",
      "wait",
      "container",
      "rm",
    ]);
    expect(state.calls.at(-1)).toEqual(["rm", "a".repeat(64)]);
    expect(
      JSON.parse(await readFile(join(result.value.evidenceDirectory, "runner.json"), "utf8")),
    ).toMatchObject({ retired: true, passed: true });
  });
  it("preserves a failed cohort verdict while still retiring its exact container", async () => {
    const fixture = await fake("cohort-failure"),
      result = await resultOf(runReleasedPeerContainer(options(fixture)));
    expect(result.error).toBeInstanceOf(Error);
    expect((await fixture.read()).removed).toBe(true);
    expect(
      JSON.parse(await readFile(join(result.error.evidenceDirectory, "runner.json"), "utf8")),
    ).toMatchObject({ retired: true, passed: false });
  });

  it("does not treat a zero container exit without real cohort receipts as a positive run", async () => {
    const fixture = await fake("missing-evidence"),
      result = await resultOf(runReleasedPeerContainer(options(fixture)));
    expect(result.error).toBeInstanceOf(Error);
    expect((await fixture.read()).removed).toBe(true);
    expect(
      JSON.parse(await readFile(join(result.error.evidenceDirectory, "runner.json"), "utf8")),
    ).toMatchObject({ passed: false, retired: true });
  });
  it("never looks up or kills by name when creation acknowledgement is ambiguous", async () => {
    const fixture = await fake("ambiguous"),
      result = await resultOf(runReleasedPeerContainer(options(fixture)));
    expect(result.error.cleanupFailure).toBe("container-create");
    expect((await fixture.read()).calls.map((args) => args[0])).toEqual([
      "info",
      "pull",
      "image",
      "create",
    ]);
    expect(
      JSON.parse(await readFile(join(result.error.evidenceDirectory, "runner.json"), "utf8")),
    ).toMatchObject({ createAttempted: true, verified: false, retired: false });
  });
  it("refuses foreign ownership rather than stopping the returned but unverified ID", async () => {
    const fixture = await fake("foreign"),
      result = await resultOf(runReleasedPeerContainer(options(fixture)));
    expect(result.error.cleanupFailure).toBe("container-create");
    expect(
      (await fixture.read()).calls.some((args) => ["start", "stop", "rm"].includes(args[0])),
    ).toBe(false);
  });
  it("retains a known container and its evidence when stop is unconfirmed", async () => {
    const fixture = await fake("stop-failure"),
      result = await resultOf(runReleasedPeerContainer(options(fixture)));
    expect(result.error.cleanupFailure).toBe("container-retirement");
    const state = await fixture.read();
    expect(state.removed).not.toBe(true);
    expect(state.calls.at(-1)).toEqual(["stop", "--time", "10", "a".repeat(64)]);
  });
  it("refuses mismatched exit receipts without deleting the container", async () => {
    const fixture = await fake("mismatched-exit"),
      result = await resultOf(runReleasedPeerContainer(options(fixture)));
    expect(result.error.cleanupFailure).toBe("container-retirement");
    expect((await fixture.read()).removed).not.toBe(true);
  });
  it("joins the cancelled attach client and then stops/waits/verifies the exact daemon-owned container", async () => {
    const fixture = await fake("hold"),
      controller = new AbortController();
    const pending = resultOf(runReleasedPeerContainer(options(fixture, controller.signal)));
    await onStarted(fixture);
    controller.abort();
    const result = await pending,
      state = await fixture.read();
    expect(result.error).toBeInstanceOf(Error);
    expect(state.removed).toBe(true);
    expect(state.calls.slice(-5).map((args) => args[0])).toEqual([
      "container",
      "stop",
      "wait",
      "container",
      "rm",
    ]);
    expect(
      JSON.parse(await readFile(join(result.error.evidenceDirectory, "runner.json"), "utf8")),
    ).toMatchObject({ passed: false, retired: true });
  });
  it("keeps Docker control state outside every writable child result alias", async () => {
    const fixture = await fake("control-boundary"),
      result = await resultOf(runReleasedPeerContainer(options(fixture)));
    expect(result.error).toBeUndefined();
    const state = await fixture.read();
    const control = result.value.evidenceDirectory;
    expect(state.results).toBe(join(control, "child-results"));
    expect(state.resultInitialEntries).toEqual([]);
    expect(state.mounts.filter((mount) => !mount.endsWith(",readonly"))).toEqual([
      `type=bind,source=${state.results},target=/results`,
    ]);
    expect(state.mounts).not.toContain(`type=bind,source=${control},target=/results`);
    expect(
      state.configObservations.every(
        (value) => value.directory === join(control, "docker-config") && value.changed === false,
      ),
    ).toBe(true);
    expect(
      JSON.parse(await readFile(join(state.results, "docker-config", "config.json"), "utf8")),
    ).toEqual({ currentContext: "foreign-context" });
    expect(JSON.parse(await readFile(join(control, "runner.json"), "utf8"))).toMatchObject({
      passed: true,
      retired: true,
    });
  });

  it("retains both operation and retirement failures without deleting an unconfirmed container", async () => {
    const fixture = await fake("compound-failure"),
      result = await resultOf(runReleasedPeerContainer(options(fixture)));
    expect(result.error).toBeInstanceOf(AggregateError);
    expect(result.error.cleanupFailure).toBe("container-retirement");
    expect(result.error.errors).toHaveLength(2);
    expect(result.error.cause).toBe(result.error.errors[0]);
    expect(result.error.errors.every((error) => error instanceof Error)).toBe(true);
    expect(result.error.errors[0]).not.toBe(result.error.errors[1]);
    const state = await fixture.read();
    expect(state.removed).not.toBe(true);
    expect(state.calls.at(-1)).toEqual(["stop", "--time", "10", "a".repeat(64)]);
    expect(
      JSON.parse(await readFile(join(result.error.evidenceDirectory, "runner.json"), "utf8")),
    ).toMatchObject({ passed: false, retired: false });
  });
});

describe("own-namespace finite mount observation", () => {
  const row = (flags = "rw,nosuid,nodev", mount = "/tmp", fs = "tmpfs") =>
    `42 1 0:7 / ${mount} ${flags} - ${fs} tmpfs rw`;
  const unknown = {
    state: "unknown",
    filesystem: "unknown",
    noexec: null,
    nosuid: null,
    nodev: null,
    readOnly: null,
  };
  it("projects only unique exact tmp flags without namespace paths or identities", () => {
    expect(releasedTmpMountFacts(row())).toEqual({
      state: "observed",
      filesystem: "tmpfs",
      noexec: false,
      nosuid: true,
      nodev: true,
      readOnly: false,
    });
    expect(releasedTmpMountFacts(row("ro,nosuid,nodev,noexec"))).toEqual({
      state: "observed",
      filesystem: "tmpfs",
      noexec: true,
      nosuid: true,
      nodev: true,
      readOnly: true,
    });
    expect(releasedTmpMountFacts(row("rw", "/tmp", "ext4"))).toEqual({
      state: "observed",
      filesystem: "other",
      noexec: false,
      nosuid: false,
      nodev: false,
      readOnly: false,
    });
    const projected = JSON.stringify(
      releasedTmpMountFacts(row() + "\n" + row("rw", "/invented-private-mount")),
    );
    expect(projected).not.toContain("invented-private-mount");
    expect(projected).not.toContain("0:7");
  });
  it("refuses absent ambiguous oversized and malformed observations as unknown", () => {
    for (const text of [
      "",
      row("rw", "/tmp/other"),
      row() + "\n" + row(),
      "x".repeat(65537),
      "malformed",
      row() + "\nmalformed",
      row("rw,ro"),
      row("rw,exec,noexec"),
      row("rw,nosuid,nosuid"),
      row() + "\0",
    ])
      expect(releasedTmpMountFacts(text)).toEqual(unknown);
  });
});

describe("reverse immutable gateway cohort", () => {
  it("accepts only the closed explicit direction command without arbitrary test or Docker arguments", () => {
    expect(releasedDirectionArgs([])).toBe("released-collector");
    for (const value of ["released-collector", "released-gateway"])
      expect(releasedDirectionArgs([`--direction=${value}`])).toBe(value);
    for (const args of [
      ["--direction="],
      ["--direction=unknown"],
      ["--direction", "released-gateway"],
      ["--privileged"],
      ["--direction=released-gateway", "extra"],
    ])
      expect(() => releasedDirectionArgs(args)).toThrow();
  });

  it("pins each native gateway including its real seeded-state entrypoint without accepting collector identity", () => {
    for (const arch of ["arm64", "x64"]) {
      expect(
        verifyReleasedCollectorImage(image(arch, "released-gateway"), arch, "released-gateway")
          .config,
      ).toBe(releasedGateway[arch].config);
      expect(() => verifyReleasedCollectorImage(image(arch), arch, "released-gateway")).toThrow();
      for (const entrypoint of [
        undefined,
        null,
        [],
        ["node"],
        "/app/scripts/seeded-state/entrypoint.sh",
      ]) {
        const candidate = image(arch, "released-gateway");
        candidate[0].Config.Entrypoint = entrypoint;
        expect(() => verifyReleasedCollectorImage(candidate, arch, "released-gateway")).toThrow();
      }
      const wrongCommand = image(arch, "released-gateway");
      wrongCommand[0].Config.Cmd = ["node", "packages/collector/dist/main.js"];
      expect(() => verifyReleasedCollectorImage(wrongCommand, arch, "released-gateway")).toThrow();
    }
    for (const invalid of ["", "gateway", "released-gateway-extra", null])
      expect(() => releasedDirection(invalid)).toThrow();
  });

  describe.skipIf(process.platform !== "linux")("reverse fake-Docker lifecycle", () => {
    it("runs reverse preparation through the same exact-container lifecycle and direction-specific receipts", async () => {
      const fixture = await fake("success", "released-gateway");
      const result = await resultOf(
        runReleasedPeerContainer({ ...options(fixture), direction: "released-gateway" }),
      );
      expect(result.error).toBeUndefined();
      const state = await fixture.read();
      const create = state.calls.find((args) => args[0] === "create");
      expect(create).toContain(
        "ghcr.io/omnesis-dev/omnesis-gateway@" + releasedGateway[process.arch].manifest,
      );
      expect(create.at(-1)).toContain("released-gateway-current-collector.e2e.test.ts");
      expect(create.at(-1)).not.toContain("scripts/run-e2e");
      expect(create).not.toContain("--entrypoint");
      expect(create).toContain("OMNESIS_E2E_RELEASED_DIRECTION=released-gateway");
      expect(state.calls.filter((args) => args[0] === "pull")).toHaveLength(1);
      expect(state.removed).toBe(true);
      const receipt = JSON.parse(
        await readFile(join(result.value.evidenceDirectory, "runner.json"), "utf8"),
      );
      expect(receipt).toMatchObject({
        direction: "released-gateway",
        index: releasedGateway.index,
        retired: true,
        passed: true,
      });
    });
    it.each(["missing-protection", "wrong-direction"])(
      "rejects incomplete reverse evidence %s while retaining physical cleanup",
      async (receiptFault) => {
        const fixture = await fake("success", "released-gateway");
        const state = await fixture.read();
        await writeFile(fixture.state, JSON.stringify({ ...state, receiptFault }));
        const result = await resultOf(
          runReleasedPeerContainer({ ...options(fixture), direction: "released-gateway" }),
        );
        expect(result.error).toBeDefined();
        expect(result.error.message).toBe("Released cohort evidence incomplete");
        expect((await fixture.read()).removed).toBe(true);
      },
    );
  });
});
