// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  composeImagesConfigSpec,
  imagesInUse,
  imagesToRemove,
  readPendingImages,
  removePreviousDockerImages,
  type CaptureRunner,
} from "./docker-images.js";
import { formatCommandSpec, type CommandSpec } from "./detect.js";

const REPO = "ghcr.io/example-org";

/** `docker compose config --no-interpolate`: which services the release tag controls. */
const RAW = JSON.stringify({
  services: {
    gateway: { image: `${REPO}/omnesis-gateway:\${OMNESIS_IMAGE_TAG}` },
    collector: { image: `${REPO}/omnesis-collector:\${OMNESIS_IMAGE_TAG:-latest}` },
    updater: { image: `${REPO}/omnesis-updater:\${OMNESIS_IMAGE_TAG}`, profiles: ["update"] },
    tailscale: { image: "tailscale/tailscale:stable" },
  },
});

/** The same project rendered at one release tag. */
function rendered(tag: string): string {
  return JSON.stringify({
    services: {
      gateway: { image: `${REPO}/omnesis-gateway:${tag}` },
      collector: { image: `${REPO}/omnesis-collector:${tag}` },
      updater: { image: `${REPO}/omnesis-updater:${tag}` },
      tailscale: { image: "tailscale/tailscale:stable" },
    },
  });
}

describe("imagesToRemove", () => {
  test("is the release images at the previous tag, and never a sidecar the tag does not control", () => {
    expect(
      imagesToRemove({
        raw: RAW,
        previousRendered: rendered("0.7.2"),
        currentRendered: rendered("0.7.3"),
        pending: [],
      }),
    ).toEqual([
      `${REPO}/omnesis-gateway:0.7.2`,
      `${REPO}/omnesis-collector:0.7.2`,
      `${REPO}/omnesis-updater:0.7.2`,
    ]);
  });

  test("leaves out every image the target still uses", () => {
    expect(
      imagesToRemove({
        raw: RAW,
        previousRendered: rendered("0.7.3"),
        currentRendered: rendered("0.7.3"),
        pending: [`${REPO}/omnesis-updater:0.7.3`],
      }),
    ).toEqual([]);
  });

  test("takes back what an earlier run kept, but only images of this project's repositories", () => {
    expect(
      imagesToRemove({
        raw: RAW,
        previousRendered: rendered("0.7.2"),
        currentRendered: rendered("0.7.3"),
        pending: [
          `${REPO}/omnesis-updater:0.7.1`,
          "tailscale/tailscale:v1.0.0",
          "registry.example.com/someone-else:1.0.0",
          `${REPO}/omnesis-gateway@sha256:${"a".repeat(64)}`,
          "--force",
        ],
      }),
    ).toEqual([
      `${REPO}/omnesis-gateway:0.7.2`,
      `${REPO}/omnesis-collector:0.7.2`,
      `${REPO}/omnesis-updater:0.7.2`,
      `${REPO}/omnesis-updater:0.7.1`,
    ]);
  });
});

describe("imagesInUse", () => {
  test("reads one image per container, ignoring blank lines", () => {
    expect(imagesInUse(`${REPO}/omnesis-updater:0.7.2\n\nsha256:abc\n`)).toEqual(
      new Set([`${REPO}/omnesis-updater:0.7.2`, "sha256:abc"]),
    );
  });
});

describe("composeImagesConfigSpec", () => {
  test("sets the tag for that one command, where compose prefers it over the env file", () => {
    const spec = composeImagesConfigSpec("/cfg/docker-compose.yml", "0.7.2");
    expect(formatCommandSpec(spec)).toBe(
      "docker compose -f /cfg/docker-compose.yml --profile update config --format json",
    );
    expect(spec.env).toEqual({ OMNESIS_IMAGE_TAG: "0.7.2" });
    const raw = composeImagesConfigSpec("/cfg/docker-compose.yml", null);
    expect(raw.args).toContain("--no-interpolate");
    expect(raw.env).toBeUndefined();
  });
});

describe("removePreviousDockerImages", () => {
  let dir: string;
  let pendingFile: string;
  let lines: string[];
  const composeFile = "/cfg/docker-compose.yml";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-image-cleanup-"));
    pendingFile = join(dir, "update-image-cleanup.json");
    lines = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * A Docker host: what compose renders, which containers exist, which
   * images are present, and which removals fail. Records every command.
   */
  function host(opts: {
    present?: readonly string[];
    containers?: readonly string[];
    failRemoval?: readonly string[];
    configFails?: boolean;
  }): { run: CaptureRunner; calls: CommandSpec[]; removed: string[] } {
    const calls: CommandSpec[] = [];
    const removed: string[] = [];
    const present = new Set(opts.present ?? []);
    const run: CaptureRunner = (spec) => {
      calls.push(spec);
      const args = spec.args;
      if (args.includes("config")) {
        if (opts.configFails) return Promise.resolve({ code: 1, stdout: "" });
        const tag = spec.env?.OMNESIS_IMAGE_TAG;
        return Promise.resolve({ code: 0, stdout: tag ? rendered(tag) : RAW });
      }
      if (args[0] === "ps") {
        return Promise.resolve({ code: 0, stdout: (opts.containers ?? []).join("\n") });
      }
      const reference = args.at(-1)!;
      if (args[1] === "inspect") {
        return Promise.resolve({ code: present.has(reference) ? 0 : 1, stdout: "sha256:1\n" });
      }
      if (args[1] === "rm") {
        if (opts.failRemoval?.includes(reference)) return Promise.resolve({ code: 1, stdout: "" });
        removed.push(reference);
        return Promise.resolve({ code: 0, stdout: `Untagged: ${reference}\n` });
      }
      throw new Error(`unexpected command ${formatCommandSpec(spec)}`);
    };
    return { run, calls, removed };
  }

  const remove = (run: CaptureRunner) =>
    removePreviousDockerImages(
      { composeFile, previous: "0.7.2", target: "0.7.3", pendingFile },
      { run, log: (line) => lines.push(line) },
    );

  test("removes the previous release's images one by one, never forced, and says which", async () => {
    const docker = host({
      present: [
        `${REPO}/omnesis-gateway:0.7.2`,
        `${REPO}/omnesis-collector:0.7.2`,
        `${REPO}/omnesis-updater:0.7.2`,
      ],
    });
    await remove(docker.run);
    expect(docker.removed).toEqual([
      `${REPO}/omnesis-gateway:0.7.2`,
      `${REPO}/omnesis-collector:0.7.2`,
      `${REPO}/omnesis-updater:0.7.2`,
    ]);
    const removals = docker.calls.filter((spec) => spec.args[1] === "rm");
    expect(removals.every((spec) => spec.args.length === 3)).toBe(true);
    expect(docker.calls.some((spec) => spec.args.includes("tailscale/tailscale:stable"))).toBe(
      false,
    );
    expect(lines.join("\n")).toContain(
      "Removed the images this update replaced: omnesis-gateway:0.7.2, omnesis-collector:0.7.2, omnesis-updater:0.7.2.",
    );
    expect(existsSync(pendingFile)).toBe(false);
  });

  test("an image a container still uses is kept and recorded, and the next run removes it", async () => {
    const updater = `${REPO}/omnesis-updater:0.7.2`;
    const first = host({
      present: [`${REPO}/omnesis-gateway:0.7.2`, updater],
      containers: [updater, `${REPO}/omnesis-gateway:0.7.3`],
    });
    await remove(first.run);
    expect(first.removed).toEqual([`${REPO}/omnesis-gateway:0.7.2`]);
    expect(readPendingImages(pendingFile)).toEqual([updater]);
    expect(lines.join("\n")).toContain(
      "Kept omnesis-updater:0.7.2 for now: a container still uses it.",
    );

    // The next update moves 0.7.3 → 0.7.4; the updater from two releases back
    // is free by then.
    lines = [];
    const second = host({ present: [updater] });
    await removePreviousDockerImages(
      { composeFile, previous: "0.7.3", target: "0.7.4", pendingFile },
      { run: second.run, log: (line) => lines.push(line) },
    );
    expect(second.removed).toEqual([updater]);
    expect(existsSync(pendingFile)).toBe(false);
  });

  test("an image already gone is nothing to report", async () => {
    const docker = host({ present: [] });
    await remove(docker.run);
    expect(docker.removed).toEqual([]);
    expect(lines).toEqual([]);
  });

  test("a removal Docker refuses is a warning naming the command, and the rest still go", async () => {
    const gateway = `${REPO}/omnesis-gateway:0.7.2`;
    const docker = host({
      present: [gateway, `${REPO}/omnesis-collector:0.7.2`],
      failRemoval: [gateway],
    });
    await expect(remove(docker.run)).resolves.toBeUndefined();
    expect(docker.removed).toEqual([`${REPO}/omnesis-collector:0.7.2`]);
    expect(lines.join("\n")).toContain(`Could not remove omnesis-gateway:0.7.2`);
    expect(lines.join("\n")).toContain(`docker image rm ${gateway}`);
  });

  test("a project whose images cannot be read removes nothing and says so", async () => {
    const docker = host({ configFails: true, present: [`${REPO}/omnesis-gateway:0.7.2`] });
    await expect(remove(docker.run)).resolves.toBeUndefined();
    expect(docker.removed).toEqual([]);
    expect(lines.join("\n")).toContain("so none were removed");
  });

  test("a runner that throws is a warning, never a failure", async () => {
    await expect(
      remove(() => Promise.reject(new Error("spawn docker ENOENT"))),
    ).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("spawn docker ENOENT");
  });

  test("an unreadable record of kept images reads as none", () => {
    writeFileSync(pendingFile, "{not json", "utf8");
    expect(readPendingImages(pendingFile)).toEqual([]);
    writeFileSync(pendingFile, JSON.stringify({ images: [1, `${REPO}/x:1`] }), "utf8");
    expect(readPendingImages(pendingFile)).toEqual([`${REPO}/x:1`]);
    expect(readFileSync(pendingFile, "utf8")).toContain("images");
  });
});
