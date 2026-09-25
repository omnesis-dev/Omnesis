// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, type AddressInfo } from "node:net";
import { fetchPeerCert } from "@omnesis/core";
import { describe, expect, it } from "vitest";
import {
  CliError,
  EXIT_AUTH,
  EXIT_CANCELLED,
  EXIT_CODES,
  EXIT_FAILURE,
  EXIT_GATEWAY_DOWN,
  EXIT_GATEWAY_ERROR,
  EXIT_PARTIAL,
  EXIT_USER_ERROR,
  isCittyParseError,
  isFetchConnectionError,
} from "./errors.js";

describe("EXIT_CODES", () => {
  it("exposes the well-known exit codes", () => {
    expect(EXIT_CODES.EXIT_OK).toBe(0);
    expect(EXIT_FAILURE).toBe(1);
    expect(EXIT_USER_ERROR).toBe(2);
    expect(EXIT_GATEWAY_DOWN).toBe(64);
    expect(EXIT_GATEWAY_ERROR).toBe(65);
    expect(EXIT_PARTIAL).toBe(66);
    expect(EXIT_AUTH).toBe(77);
    expect(EXIT_CANCELLED).toBe(130);
  });
});

describe("CliError", () => {
  it("defaults to EXIT_FAILURE", () => {
    const err = new CliError("boom");
    expect(err.exitCode).toBe(EXIT_FAILURE);
    expect(err.name).toBe("CliError");
    expect(err.message).toBe("boom");
  });

  it("carries the requested exitCode", () => {
    const err = new CliError("auth fail", EXIT_AUTH);
    expect(err.exitCode).toBe(EXIT_AUTH);
  });

  it("is an Error subclass (instanceof)", () => {
    const err = new CliError("x");
    expect(err instanceof Error).toBe(true);
    expect(err instanceof CliError).toBe(true);
  });
});

describe("isFetchConnectionError", () => {
  it("recognises a fetch connect rejection by message", () => {
    const err = new TypeError("fetch failed");
    expect(isFetchConnectionError(err)).toBe(true);
  });

  it("recognises a fetch connect rejection by cause.code", () => {
    const err = new TypeError("fetch failed");
    (err as TypeError & { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
    expect(isFetchConnectionError(err)).toBe(true);
  });

  it("rejects unrelated TypeErrors", () => {
    const err = new TypeError("not iterable");
    expect(isFetchConnectionError(err)).toBe(false);
  });

  // Renamed: some non-TypeError errors ARE connection failures now, so the old
  // blanket name would have been a lie.
  it("rejects non-TypeError errors that carry no connection code", () => {
    expect(isFetchConnectionError(new Error("connect"))).toBe(false);
    expect(isFetchConnectionError(new Error("could not connect the widget"))).toBe(false);
    expect(isFetchConnectionError("connect")).toBe(false);
    expect(isFetchConnectionError(null)).toBe(false);
  });

  it("recognises a socket reset mid-handshake (plain Error with a code)", () => {
    const err = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(isFetchConnectionError(err)).toBe(true);
  });

  it("recognises undici's TLS-disconnect phrasing with no code at all", () => {
    const err = new Error(
      "Client network socket disconnected before secure TLS connection was established",
    );
    expect(isFetchConnectionError(err)).toBe(true);
  });

  it("recognises a connection that never completes as unreachable, not as a bad code", () => {
    // What a dropped SYN produces: a DROP-target firewall or a cloud security
    // group never refuses, so the dial times out instead. Undici's own connect
    // timeout, and a route that does not exist, belong with it.
    for (const code of ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "ENETUNREACH"]) {
      expect(isFetchConnectionError(Object.assign(new Error("dial"), { code }))).toBe(true);
      expect(
        isFetchConnectionError(
          new TypeError("fetch failed", { cause: Object.assign(new Error("dial"), { code }) }),
        ),
      ).toBe(true);
    }
  });

  it("recognises the join's certificate probe timing out against a silent port", async () => {
    // The pinned join's first network touch is `fetchPeerCert`'s raw TLS dial.
    // Its timeout used to reject with a bare Error and no code, which fell past
    // this guard: a stack trace, then the installer's "mint a fresh code" for a
    // join that never reached the gateway. A listener that accepts and never
    // speaks is what the collector sees through a relay whose upstream is
    // dropped.
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      const err = await fetchPeerCert("127.0.0.1", port, 100).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ code: "ETIMEDOUT" });
      expect(isFetchConnectionError(err)).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe("isCittyParseError", () => {
  it("recognises citty's argv-shape error by name + code", () => {
    // Citty's CLIError has name="CLIError" and a string code (EARG, etc.)
    const cittyErr = Object.assign(new Error("Missing required positional"), {
      name: "CLIError",
      code: "EARG",
    });
    expect(isCittyParseError(cittyErr)).toBe(true);
  });

  it("rejects our own CliError class (different shape)", () => {
    const ours = new CliError("nope", EXIT_USER_ERROR);
    expect(isCittyParseError(ours)).toBe(false);
  });

  it("rejects plain Error / non-objects", () => {
    expect(isCittyParseError(new Error("plain"))).toBe(false);
    expect(isCittyParseError("string")).toBe(false);
    expect(isCittyParseError(null)).toBe(false);
    expect(isCittyParseError(undefined)).toBe(false);
  });
});
