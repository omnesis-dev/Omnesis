// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { afterEach, expect, test, vi } from "vitest";
import { authorizeGoogleDesktop, openGoogleBrowser } from "./google-desktop.js";
import { localIdentityProvider } from "./identity.js";
import * as identities from "./identity.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
const key = randomBytes(32);
const identity = localIdentityProvider(key, "127.0.0.1");
const nonce = "fictional-desktop-nonce-32bytes";
const token = () =>
  new SignJWT({ nonce })
    .setIssuer("omnesis-local-test")
    .setSubject("fictional-owner")
    .setAudience("omnesis-cloud-relay")
    .setIssuedAt()
    .setExpirationTime("1h")
    .setProtectedHeader({ alg: "HS256" })
    .sign(key);
const tokens = async () =>
  Response.json({
    id_token: await token(),
    refresh_token: "fictional-refresh",
    token_type: "Bearer",
  });
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  spawn.mockReset();
  Object.defineProperty(process, "platform", platformDescriptor);
});

test("system browser uses platform launchers without a shell", async () => {
  for (const platform of ["darwin", "win32", "linux"] as const) {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    const child = new EventEmitter();
    spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });
    const url = "https://accounts.google.com/o/oauth2/v2/auth?state=fictional";
    await openGoogleBrowser(url);
    expect(spawn).toHaveBeenLastCalledWith(
      platform === "darwin" ? "open" : platform === "win32" ? "rundll32" : "xdg-open",
      platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url],
      { stdio: "ignore" },
    );
  }
  await expect(openGoogleBrowser("https://untrusted.example.test")).rejects.toThrow("destination");
});

test("browser spawn failures and nonzero exits are reported without credentials", async () => {
  for (const event of ["exit", "error"]) {
    const child = new EventEmitter();
    spawn.mockImplementation(() => {
      queueMicrotask(() =>
        child.emit(event, event === "exit" ? 1 : new Error("Unavailable browser")),
      );
      return child;
    });
    await expect(openGoogleBrowser("https://accounts.google.com")).rejects.toThrow();
  }
});

test("isolated loopback callback exchanges exactly one matching browser authorization", async () => {
  let redirect = "";
  const transport = vi.fn<typeof fetch>(tokens);
  const result = await authorizeGoogleDesktop({
    clientId: "fictional-desktop",
    nonce,
    identity,
    offline: true,
    fetch: transport,
    openBrowser: async (url) => {
      const auth = new URL(url);
      redirect = auth.searchParams.get("redirect_uri")!;
      expect(new URL(redirect).hostname).toBe("127.0.0.1");
      expect(auth.searchParams.get("access_type")).toBe("offline");
      for (const request of [
        { url: redirect },
        { url: `${redirect}?state=wrong` },
        {
          url: `${redirect}?state=${auth.searchParams.get("state")!.replace(/^./, (value) => (value === "A" ? "B" : "A"))}`,
        },
        {
          url:
            redirect.replace("/google/callback", "/other") +
            `?state=${auth.searchParams.get("state")}`,
        },
        { url: `${redirect}?state=${auth.searchParams.get("state")}`, method: "POST" },
        { url: `${redirect}?state=${auth.searchParams.get("state")}&state=duplicate` },
      ])
        expect((await fetch(request.url, request)).status).toBe(404);
      const wrongHost = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          `${redirect}?state=${auth.searchParams.get("state")}`,
          { headers: { Host: "untrusted.example.test" } },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(wrongHost).toBe(404);
      const malformed = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(redirect, { path: "/\\[" }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        });
        req.on("error", reject);
        req.end();
      });
      expect(malformed).toBe(400);
      const response = await fetch(
        `${redirect}?code=fictional-code&state=${auth.searchParams.get("state")}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(await response.text()).not.toContain("fictional-code");
      expect(
        (await fetch(`${redirect}?code=replay&state=${auth.searchParams.get("state")}`)).status,
      ).toBe(404);
    },
  });
  expect(result.identity.subject).toBe("fictional-owner");
  expect(result.refreshToken).toBe("fictional-refresh");
  expect(transport).toHaveBeenCalledTimes(1);
  await expect(fetch(redirect)).rejects.toThrow();
});

test.each(["darwin", "win32", "linux"] as const)(
  "%s default Google verifier, browser launcher and token transport compose without a relay",
  async (platform) => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    vi.spyOn(identities, "googleIdentityProvider").mockReturnValue(identity);
    const direct = globalThis.fetch;
    const transport = vi.fn<typeof fetch>(tokens);
    vi.stubGlobal("fetch", transport);
    spawn.mockImplementation((_command, args: string[]) => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      const expected =
        platform === "darwin" ? "open" : platform === "win32" ? "rundll32" : "xdg-open";
      expect(_command).toBe(expected);
      if (platform === "win32") expect(args[0]).toBe("url.dll,FileProtocolHandler");
      expect(args).toHaveLength(platform === "win32" ? 2 : 1);
      const auth = new URL(args.at(-1)!);
      void direct(
        `${auth.searchParams.get("redirect_uri")}?code=fictional&state=${auth.searchParams.get("state")}`,
      );
      return child;
    });
    expect(
      (await authorizeGoogleDesktop({ clientId: "fixture-client", nonce })).identity.subject,
    ).toBe("fictional-owner");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![0]).toBe("https://oauth2.googleapis.com/token");
  },
);

test("an abandoned sign-in times out and closes its listener", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let redirect = "";
  await expect(
    authorizeGoogleDesktop({
      clientId: "client",
      nonce,
      identity,
      openBrowser: async (url) => {
        redirect = new URL(url).searchParams.get("redirect_uri")!;
        await vi.advanceTimersByTimeAsync(300_000);
      },
    }),
  ).rejects.toThrow("timed out");
  vi.useRealTimers();
  await expect(fetch(redirect)).rejects.toThrow();
});

test("cancelled or abandoned browser authorization always closes its loopback listener", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Cancelled"));
  await expect(
    authorizeGoogleDesktop({ clientId: "client", nonce, signal: controller.signal }),
  ).rejects.toThrow("Cancelled");
  let redirect = "";
  for (const reason of ["cancel", "browser-error", "google-denied"]) {
    const abort = new AbortController();
    await expect(
      authorizeGoogleDesktop({
        clientId: "client",
        nonce,
        identity,
        signal: abort.signal,
        openBrowser: async (url) => {
          const auth = new URL(url);
          redirect = auth.searchParams.get("redirect_uri")!;
          if (reason === "cancel") abort.abort(new Error("Cancelled"));
          else if (reason === "browser-error") throw new Error("Browser unavailable");
          else
            await fetch(`${redirect}?error=access_denied&state=${auth.searchParams.get("state")}`);
        },
      }),
    ).rejects.toThrow();
    await expect(fetch(redirect)).rejects.toThrow();
  }
});
