// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Removing the images a container update moved away from.
 *
 * Every release pulls a new image for each service the recorded tag controls,
 * a gigabyte or so each, and the previous release's stay in the local store:
 * the rollback needs them, until the update is known to have worked. Once it
 * is, they are removed — exactly this compose project's release images at the
 * previous tag, read from the project's own configuration, and never one the
 * target still uses, one of a sidecar the tag does not control, or one
 * anything else on the host refers to by another name.
 *
 * An image a container still uses is kept: Docker refuses to remove it, and
 * the update that runs this is itself one — the updater that started it runs
 * from the previous release's updater image until this one exits. Such images
 * are recorded beside the compose project, and the next update removes them
 * once nothing uses them.
 *
 * Nothing here fails an update. It runs after the new release is serving, and
 * whatever it could not remove it says, with the command that does.
 */

import { readFileSync, rmSync } from "node:fs";
import { atomicWriteFileSync } from "@omnesis/core";
import { c } from "../utils.js";
import { dockerComposeSpec, formatCommandSpec, IMAGE_TAG_KEY, type CommandSpec } from "./detect.js";
import { dockerReleaseImages } from "./docker-registry.js";

/** Images a previous cleanup kept because a container used them, beside the compose project. */
export const IMAGE_CLEANUP_FILE = "update-image-cleanup.json";

/** Runs one command with its stdout captured and its stderr on the terminal. */
export type CaptureRunner = (spec: CommandSpec) => Promise<{ code: number; stdout: string }>;

/** An image reference with a tag and no digest, as this project's compose renders one. */
const TAGGED_REFERENCE = /^[a-z0-9][a-z0-9._/:-]*:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * The project's configuration as compose resolves it, with every service of
 * the update profile. `tag` sets the release tag for this one command — the
 * environment wins over the `.env` file in compose — and null leaves the
 * configuration uninterpolated, which is how the release images are told from
 * the sidecars.
 */
export function composeImagesConfigSpec(composeFile: string, tag: string | null): CommandSpec {
  return {
    ...dockerComposeSpec(composeFile, [
      "--profile",
      "update",
      "config",
      ...(tag === null ? ["--no-interpolate"] : []),
      "--format",
      "json",
    ]),
    ...(tag === null ? {} : { env: { [IMAGE_TAG_KEY]: tag } }),
  };
}

/** The repository half of a tagged reference. */
function repositoryOf(reference: string): string {
  return reference.replace(/:[^/:]+$/u, "");
}

/** The short name a line shows: the image's last path segment and its tag. */
function shortName(reference: string): string {
  return reference.slice(reference.lastIndexOf("/") + 1);
}

/**
 * Which images to remove: the project's release images at the previous tag,
 * and those an earlier cleanup kept, minus every image the target uses. A
 * kept image is only taken back when it is still one of this project's
 * release repositories, so an edited record cannot name anything else.
 */
export function imagesToRemove(input: {
  raw: string;
  previousRendered: string;
  currentRendered: string;
  pending: readonly string[];
}): string[] {
  const current = new Set(dockerReleaseImages(input.raw, input.currentRendered));
  const repositories = new Set([...current].map(repositoryOf));
  const previous = dockerReleaseImages(input.raw, input.previousRendered);
  const kept = input.pending.filter((reference) => repositories.has(repositoryOf(reference)));
  // Only a plain tagged reference reaches `docker image rm`: never a digest,
  // and never anything a command line could read as an option.
  return [...new Set([...previous, ...kept])].filter(
    (reference) => TAGGED_REFERENCE.test(reference) && !current.has(reference),
  );
}

/** The images every container on the host was created from, as `docker ps` names them. */
export function imagesInUse(psOutput: string): Set<string> {
  return new Set(
    psOutput
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

/** What an earlier cleanup kept; anything unreadable reads as nothing. */
export function readPendingImages(path: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { images?: unknown };
    return Array.isArray(parsed.images)
      ? parsed.images.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function writePendingImages(path: string, images: readonly string[]): void {
  if (images.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  atomicWriteFileSync(path, `${JSON.stringify({ version: 1, images }, null, 2)}\n`, {
    mode: 0o600,
  });
}

/**
 * Remove the previous release's images of one compose project once its
 * containers run `target`. Reports what it did through `log` and never
 * throws.
 */
export async function removePreviousDockerImages(
  opts: { composeFile: string; previous: string; target: string; pendingFile: string },
  deps: { run: CaptureRunner; log(line: string): void },
): Promise<void> {
  const { log } = deps;
  const capture = async (spec: CommandSpec): Promise<string> => {
    const result = await deps.run(spec);
    if (result.code !== 0) {
      throw new Error(`\`${formatCommandSpec(spec)}\` failed (exit ${result.code})`);
    }
    return result.stdout;
  };

  let candidates: string[];
  let inUse: Set<string>;
  try {
    const pending = readPendingImages(opts.pendingFile);
    candidates = imagesToRemove({
      raw: await capture(composeImagesConfigSpec(opts.composeFile, null)),
      previousRendered: await capture(composeImagesConfigSpec(opts.composeFile, opts.previous)),
      currentRendered: await capture(composeImagesConfigSpec(opts.composeFile, opts.target)),
      pending,
    });
    inUse = imagesInUse(
      candidates.length === 0
        ? ""
        : await capture({ command: "docker", args: ["ps", "--all", "--format", "{{.Image}}"] }),
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log(
      `${c.yellow}! Could not tell which ${opts.previous} images this installation no longer ` +
        `uses, so none were removed: ${detail}.${c.reset}`,
    );
    return;
  }

  const removed: string[] = [];
  const kept: string[] = [];
  const failed: string[] = [];
  for (const reference of candidates) {
    if (inUse.has(reference)) {
      kept.push(reference);
      continue;
    }
    try {
      // Absent already: removed by hand, or never pulled on this host.
      const present = await deps.run({
        command: "docker",
        args: ["image", "inspect", "--format", "{{.Id}}", reference],
      });
      if (present.code !== 0) continue;
      // Never forced: an image something still holds is Docker's to keep.
      const result = await deps.run({ command: "docker", args: ["image", "rm", reference] });
      (result.code === 0 ? removed : failed).push(reference);
    } catch {
      failed.push(reference);
    }
  }

  try {
    writePendingImages(opts.pendingFile, kept);
  } catch {
    // The next update finds the previous release's images again; only an
    // older image kept here would be left for the operator.
  }

  if (removed.length > 0) {
    log(
      `${c.green}✔${c.reset} Removed the images this update replaced: ` +
        `${removed.map(shortName).join(", ")}.`,
    );
  }
  if (kept.length > 0) {
    log(
      `${c.dim}Kept ${kept.map(shortName).join(", ")} for now: a container still uses ` +
        `${kept.length === 1 ? "it" : "them"}. The next update removes ` +
        `${kept.length === 1 ? "it" : "them"} once nothing does.${c.reset}`,
    );
  }
  if (failed.length > 0) {
    log(
      `${c.yellow}! Could not remove ${failed.map(shortName).join(", ")}. This installation no ` +
        `longer uses ${failed.length === 1 ? "it" : "them"}; remove ` +
        `${failed.length === 1 ? "it" : "them"} with ${c.bold}docker image rm ` +
        `${failed.join(" ")}${c.reset}${c.yellow}.${c.reset}`,
    );
  }
}
