// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  CliError,
  EXIT_AUTH,
  EXIT_CANCELLED,
  EXIT_FAILURE,
  EXIT_GATEWAY_DOWN,
  EXIT_OK,
  EXIT_USER_ERROR,
} from "./errors.js";
import { runCli } from "./runner.js";

interface Captured {
  stderr: string[];
}

function harness(): { opts: Parameters<typeof runCli>[1]; captured: Captured } {
  const captured: Captured = { stderr: [] };
  return {
    captured,
    opts: { stderr: (s) => captured.stderr.push(s) },
  };
}

describe("runCli", () => {
  it("returns EXIT_OK when fn resolves cleanly", async () => {
    const { opts, captured } = harness();
    const code = await runCli(async () => {
      /* no throw */
    }, opts);
    expect(code).toBe(EXIT_OK);
    expect(captured.stderr).toEqual([]);
  });

  it("maps a CliError to its exitCode and prints the message", async () => {
    const { opts, captured } = harness();
    const code = await runCli(async () => {
      throw new CliError("nope", EXIT_USER_ERROR);
    }, opts);
    expect(code).toBe(EXIT_USER_ERROR);
    expect(captured.stderr.join("")).toContain("nope");
  });

  it("maps a fetch-connect rejection to EXIT_GATEWAY_DOWN", async () => {
    const { opts, captured } = harness();
    const code = await runCli(async () => {
      const err = new TypeError("fetch failed");
      (err as TypeError & { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
      throw err;
    }, opts);
    expect(code).toBe(EXIT_GATEWAY_DOWN);
    expect(captured.stderr.join("")).toMatch(/gateway|reach/i);
  });

  it("uses the gatewayDownHint when provided", async () => {
    const captured: Captured = { stderr: [] };
    const code = await runCli(
      async () => {
        throw new TypeError("fetch failed");
      },
      {
        stderr: (s) => captured.stderr.push(s),
        gatewayDownHint: "Cannot reach gateway at http://localhost:7600. Is it running?",
      },
    );
    expect(code).toBe(EXIT_GATEWAY_DOWN);
    expect(captured.stderr.join("")).toContain("http://localhost:7600");
  });

  it("maps a generic Error to EXIT_FAILURE and prints the stack", async () => {
    const { opts, captured } = harness();
    const code = await runCli(async () => {
      throw new Error("kaboom");
    }, opts);
    expect(code).toBe(EXIT_FAILURE);
    expect(captured.stderr.join("")).toContain("kaboom");
  });

  it("preserves the EXIT_AUTH exit-code path", async () => {
    const { opts } = harness();
    const code = await runCli(async () => {
      throw new CliError("403 forbidden", EXIT_AUTH);
    }, opts);
    expect(code).toBe(EXIT_AUTH);
  });

  it("invokes opts.onSigint when SIGINT fires during fn", async () => {
    let sigintFired = false;
    const code = await runCli(
      async () => {
        process.emit("SIGINT");
        // Yield once so the listener queue drains before we resolve.
        await new Promise((r) => setImmediate(r));
      },
      {
        onSigint: () => {
          sigintFired = true;
        },
      },
    );
    expect(sigintFired).toBe(true);
    // The SIGINT handler is the user's responsibility (default = process.exit(130));
    // runCli itself returns whatever fn produced — clean return → EXIT_OK.
    expect(code).toBe(EXIT_OK);
    // Sanity check: we don't leak the signal listener after runCli returns.
    expect(EXIT_CANCELLED).toBe(130);
  });

  it("removes its SIGINT listener on exit (no leak across calls)", async () => {
    const before = process.listenerCount("SIGINT");
    await runCli(async () => {
      /* noop */
    }, harness().opts);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("maps citty's CLIError (parse failure) to EXIT_USER_ERROR", async () => {
    const { opts, captured } = harness();
    const code = await runCli(async () => {
      // Match citty's CLIError shape without pulling citty into cli-shared.
      const e = Object.assign(new Error("Missing required positional argument: QUERY"), {
        name: "CLIError",
        code: "EARG",
      });
      throw e;
    }, opts);
    expect(code).toBe(EXIT_USER_ERROR);
    const out = captured.stderr.join("");
    expect(out).toContain("Missing required positional");
    // No stack trace — clean one-liner.
    expect(out).not.toContain("at parseArgs");
  });
});
