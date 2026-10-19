// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let root: string;
let bin: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "demo-encode-test-"));
  bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "scripts"));
  copyFileSync(resolve("scripts/demos-to-video.sh"), join(root, "scripts/demos-to-video.sh"));
  // Record argument arrays, not shell strings: this distinguishes a seek or
  // duration limit from text inside a filter and checks paths exactly.
  const stub = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DEMO_TEST_LOG, JSON.stringify({ name, args }) + "\\n");
if (name === "ffprobe") process.stdout.write((args.includes("-count_frames") ? (process.env.DEMO_TEST_FRAME_COUNT || "471") : (process.env.DEMO_TEST_DURATION || "13.800000")) + "\\n");
else if (!(name === "ffmpeg" && args.includes("-frames:v") && process.env.DEMO_TEST_EMPTY_POSTER === "1")) { const out = name === "cwebp" ? args[args.indexOf("-o") + 1] : args.at(-1); fs.writeFileSync(out, "encoded fixture"); }
`;
  for (const tool of ["ffprobe", "ffmpeg", "cwebp"]) {
    writeFileSync(join(bin, tool), stub, { mode: 0o755 });
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Invocation = { name: string; args: string[] };
function run(
  args: string[],
  source: string,
  duration = "13.800000",
  frameCount = "471",
): Invocation[] {
  const master = join(root, source);
  mkdirSync(dirname(master), { recursive: true });
  writeFileSync(master, "native master fixture");
  execFileSync("bash", [join(root, "scripts/demos-to-video.sh"), ...args], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DEMO_TEST_LOG: join(root, "calls.jsonl"),
      DEMO_TEST_DURATION: duration,
      DEMO_TEST_FRAME_COUNT: frameCount,
    },
  });
  return readFileSync(join(root, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("landing demo encoding", () => {
  it("selects the final decoded frame even when duration extends beyond it", () => {
    const calls = run(["birthday_gifts"], "demos/birthday_gifts.mp4");
    const poster = calls.filter((call) => call.name === "ffmpeg")[1].args;
    expect(poster).not.toContain("-ss");
    expect(poster[poster.indexOf("-vf") + 1]).toContain("select=eq(n\\,470)");
  });

  it("selects the first frame for a single-frame master", () => {
    const calls = run(["birthday_gifts"], "demos/birthday_gifts.mp4", "0.100000", "1");
    const poster = calls.filter((call) => call.name === "ffmpeg")[1].args;
    expect(poster[poster.indexOf("-vf") + 1]).toContain("select=eq(n\\,0)");
  });

  it.each(["N/A", "0", "-1", "471junk"])("rejects invalid decoded frame count %s", (count) => {
    expect(() => run(["birthday_gifts"], "demos/birthday_gifts.mp4", "13.8", count)).toThrow();
    const calls = readFileSync(join(root, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.name === "ffmpeg")).toHaveLength(1);
  });

  it.each(["N/A", "0", "-1", "13.8junk"])("rejects invalid master duration %s", (duration) => {
    expect(() => run(["swim_progress"], "demos/swim_progress.mp4", duration)).toThrow();
    const calls = readFileSync(join(root, "calls.jsonl"), "utf8");
    expect(calls).not.toContain('"name":"ffmpeg"');
  });

  it("rejects a successful encoder that emits no poster instead of reusing a stale image", () => {
    const previous = process.env.DEMO_TEST_EMPTY_POSTER;
    process.env.DEMO_TEST_EMPTY_POSTER = "1";
    const stale = join(root, "website/demos/birthday_gifts.png");
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, "stale poster");
    try {
      expect(() => run(["birthday_gifts"], "demos/birthday_gifts.mp4")).toThrow();
      expect(() => readFileSync(stale)).toThrow();
    } finally {
      if (previous === undefined) delete process.env.DEMO_TEST_EMPTY_POSTER;
      else process.env.DEMO_TEST_EMPTY_POSTER = previous;
    }
  });

  it("rejects a missing requested master instead of leaving stale carousel assets", () => {
    expect(() =>
      execFileSync("bash", [join(root, "scripts/demos-to-video.sh"), "swim_progress"], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DEMO_TEST_LOG: join(root, "calls.jsonl"),
        },
        stdio: "pipe",
      }),
    ).toThrow();
  });

  it.each([
    { args: [], subtree: "", width: "560", rotated: false },
    { args: ["--light"], subtree: "light/", width: "560", rotated: false },
    { args: ["--variant", "ipad"], subtree: "ipad/", width: "1500", rotated: true },
    {
      args: ["--variant", "ipad", "--light"],
      subtree: "light/ipad/",
      width: "1500",
      rotated: true,
    },
  ])(
    "encodes complete $subtree masters and matching poster assets",
    ({ args, subtree, width, rotated }) => {
      const scenario = "swim_progress";
      const source = `demos/${subtree}${scenario}.mp4`;
      const destination = `website/demos/${subtree}${scenario}`;
      const calls = run([...args, scenario], source);
      const encodes = calls.filter((call) => call.name === "ffmpeg");
      expect(encodes).toHaveLength(2);
      const video = encodes[0].args;
      expect(video[video.indexOf("-i") + 1]).toBe(source);
      expect(video.at(-1)).toBe(`${destination}.mp4`);
      // Preserve the opening question and complete answer, including the long
      // swim scenario. Timing acceleration belongs in replay, not encoding.
      for (const flag of ["-ss", "-t", "-to"]) expect(video).not.toContain(flag);
      const filter = video[video.indexOf("-vf") + 1];
      expect(filter).toContain(`scale=${width}:-2`);
      expect(filter).toContain("tpad=stop_mode=clone:stop_duration=1.333333");
      expect(filter.includes("transpose=2")).toBe(rotated);
      expect(filter).not.toMatch(/setpts|trim=/);
      const poster = encodes[1].args;
      expect(poster).not.toContain("-ss");
      expect(poster[poster.indexOf("-vf") + 1]).toContain("select=eq(n\\,470)");
      expect(poster.at(-1)).toBe(`${destination}.png`);
      expect(calls.find((call) => call.name === "cwebp")?.args).toEqual([
        "-quiet",
        "-q",
        "80",
        `${destination}.png`,
        "-o",
        `${destination}.webp`,
      ]);
    },
  );
});
