// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { beforeEach, expect, test, vi, type Mock } from "vitest";
const mocks = vi.hoisted(() => ({
  client: {
    createAccount: vi.fn(),
    createOrder: vi.fn(),
    getAuthorizations: vi.fn(),
    getChallengeKeyAuthorization: vi.fn(),
    completeChallenge: vi.fn(),
    getOrder: vi.fn(),
    finalizeOrder: vi.fn(),
    getCertificate: vi.fn(),
    getAccountUrl: vi.fn(),
  },
  resolveTxt: vi.fn(),
  resolveCaa: vi.fn(),
  cancel: vi.fn(),
  intercept: undefined as ((request: { url: string }) => unknown) | undefined,
  sleep: vi.fn(),
}));
vi.mock("acme-client", () => ({
  Client: class {
    constructor() {
      return mocks.client;
    }
  },
  crypto: { createCsr: async () => [Buffer.from("private-local-only"), Buffer.from("public-csr")] },
  axios: {
    defaults: {},
    interceptors: {
      request: {
        use: (callback: (request: { url: string }) => unknown) => {
          mocks.intercept = callback;
        },
      },
    },
  },
}));
vi.mock("node:dns/promises", () => ({
  Resolver: class {
    resolveTxt = mocks.resolveTxt;
    resolveCaa = mocks.resolveCaa;
    cancel = mocks.cancel;
  },
}));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.sleep }));
import { issueAcmeCertificate } from "./acme-client.js";

const ACCOUNT = "https://ca.example.test/acct/1";
const hostname = "gateway.example.test",
  digest = "a".repeat(43);
const challenge = {
  type: "dns-01",
  token: "public-token",
  url: "https://ca.example.test/challenge",
};
const authorization = {
  identifier: { type: "dns", value: hostname },
  status: "pending",
  challenges: [challenge],
};
let presenter: {
  create: Mock<(value: string, signal: AbortSignal) => Promise<{ id: string }>>;
  remove: Mock<(id: string, signal: AbortSignal) => Promise<void>>;
};
const options = () => ({
  directoryUrl: "https://ca.example.test/directory",
  hostname,
  accountKey: "local-account-private-key",
  tlsKey: "local-TLS-private-key",
  presenter,
  signal: new AbortController().signal,
});
beforeEach(() => {
  for (const method of Object.values(mocks.client)) method.mockReset();
  mocks.resolveTxt.mockReset().mockResolvedValue([[digest]]);
  mocks.cancel.mockClear();
  mocks.sleep.mockReset().mockResolvedValue(undefined);
  mocks.client.createAccount.mockResolvedValue({});
  mocks.client.getAccountUrl.mockReturnValue(ACCOUNT);
  mocks.resolveCaa.mockReset().mockResolvedValue([]);
  mocks.client.createOrder.mockResolvedValue({
    url: "https://ca.example.test/order",
    status: "pending",
  });
  mocks.client.getAuthorizations
    .mockResolvedValueOnce([authorization])
    .mockResolvedValue([{ ...authorization, status: "valid" }]);
  mocks.client.getChallengeKeyAuthorization.mockResolvedValue(digest);
  mocks.client.completeChallenge.mockResolvedValue({});
  mocks.client.getOrder
    .mockResolvedValueOnce({ status: "ready" })
    .mockResolvedValue({ status: "valid" });
  mocks.client.finalizeOrder.mockResolvedValue({ status: "processing" });
  mocks.client.getCertificate.mockResolvedValue("public-certificate");
  presenter = {
    create: vi.fn<(value: string, signal: AbortSignal) => Promise<{ id: string }>>(async () => ({
      id: "lease-id",
    })),
    remove: vi.fn<(id: string, signal: AbortSignal) => Promise<void>>(async () => {}),
  };
});
test("only the configured hostname/order is issued; DNS proof is cleaned before certificate download", async () => {
  expect(await issueAcmeCertificate(options())).toBe("public-certificate");
  expect(mocks.client.createOrder).toHaveBeenCalledWith({
    identifiers: [{ type: "dns", value: hostname }],
  });
  expect(mocks.resolveTxt).toHaveBeenCalledWith(`_acme-challenge.${hostname}`);
  expect(presenter.create).toHaveBeenCalledWith(digest, expect.any(AbortSignal));
  expect(presenter.remove).toHaveBeenCalledWith("lease-id", expect.any(AbortSignal));
  expect(mocks.client.finalizeOrder.mock.invocationCallOrder[0]).toBeGreaterThan(
    presenter.remove.mock.invocationCallOrder[0],
  );
});
test("already authorized accounts/orders skip new DNS publication and finalization", async () => {
  mocks.client.getAuthorizations
    .mockReset()
    .mockResolvedValue([{ ...authorization, status: "valid" }]);
  mocks.client.getOrder.mockReset().mockResolvedValue({ status: "valid" });
  await issueAcmeCertificate(options());
  expect(presenter.create).not.toHaveBeenCalled();
  expect(mocks.client.finalizeOrder).not.toHaveBeenCalled();
});
test("malicious authorization identifiers, wildcards and absent DNS challenges are rejected before DNS writes", async () => {
  for (const values of [
    [],
    [authorization, authorization],
    [{ ...authorization, identifier: { type: "ip", value: hostname } }],
    [{ ...authorization, identifier: { type: "dns", value: "victim.example.test" } }],
    [{ ...authorization, wildcard: true }],
    [{ ...authorization, challenges: [] }],
  ]) {
    mocks.client.getAuthorizations.mockReset().mockResolvedValue(values);
    await expect(issueAcmeCertificate(options())).rejects.toThrow();
  }
  expect(presenter.create).not.toHaveBeenCalled();
  await expect(
    issueAcmeCertificate({
      ...options(),
      directoryUrl: "https://user:secret@ca.example.test/directory",
    }),
  ).rejects.toThrow("directory");
  await expect(
    issueAcmeCertificate({
      ...options(),
      directoryUrl: "https://ca.example.test/directory#fragment",
    }),
  ).rejects.toThrow("directory");
  await expect(
    issueAcmeCertificate({ ...options(), hostname: "*.example.test" }),
  ).rejects.toThrow();
});
test("DNS propagation retries errors and mismatches, caps polling and always cleans a published record", async () => {
  mocks.resolveTxt
    .mockRejectedValueOnce(new Error("temporary DNS error"))
    .mockResolvedValueOnce([["other"]])
    .mockResolvedValue([[digest]]);
  await issueAcmeCertificate(options());
  expect(mocks.sleep).toHaveBeenCalledTimes(2);
  mocks.resolveTxt.mockResolvedValue([["other"]]);
  mocks.client.getAuthorizations.mockReset().mockResolvedValue([authorization]);
  await expect(issueAcmeCertificate(options())).rejects.toThrow("propagation limit");
  expect(presenter.remove).toHaveBeenCalledTimes(2);
});
test("CA rejection and status polling limits clean the lease; cancellation also cancels in-progress DNS", async () => {
  mocks.client.getAuthorizations
    .mockReset()
    .mockResolvedValueOnce([authorization])
    .mockResolvedValue([{ ...authorization, status: "invalid" }]);
  await expect(issueAcmeCertificate(options())).rejects.toThrow("order failed");
  expect(presenter.remove).toHaveBeenCalledOnce();
  mocks.client.getAuthorizations.mockReset().mockResolvedValue([authorization]);
  await expect(issueAcmeCertificate(options())).rejects.toThrow("polling limit");
  expect(mocks.sleep).toHaveBeenCalledTimes(60);
  const abort = new AbortController();
  mocks.client.getAuthorizations.mockReset().mockResolvedValue([authorization]);
  mocks.resolveTxt.mockImplementationOnce(async () => {
    abort.abort(new Error("cancelled"));
    throw new Error("cancelled DNS");
  });
  await expect(issueAcmeCertificate({ ...options(), signal: abort.signal })).rejects.toThrow(
    "cancelled",
  );
  expect(mocks.cancel).toHaveBeenCalledOnce();
});
test("order failures and malformed certificate responses are bounded after authorization", async () => {
  mocks.client.getAuthorizations
    .mockReset()
    .mockResolvedValue([{ ...authorization, status: "valid" }]);
  for (const status of ["invalid", undefined]) {
    mocks.client.getOrder.mockReset().mockResolvedValue({ status });
    await expect(issueAcmeCertificate(options())).rejects.toThrow("order failed");
  }
  mocks.client.getOrder.mockReset().mockResolvedValue({ status: "valid" });
  for (const reply of [undefined, "x".repeat(65537)]) {
    mocks.client.getCertificate.mockResolvedValue(reply);
    await expect(issueAcmeCertificate(options())).rejects.toThrow("certificate response");
  }
});
test("CA transport policy rejects out-of-scope recipients and binds network cancellation/body/redirect limits", async () => {
  const interceptor = mocks.intercept!;
  expect(() => interceptor({ url: "https://ca.example.test/directory" })).toThrow("issuance scope");
  for (const url of [
    "https://other.example.test/order",
    "https://user:secret@ca.example.test/order",
    "https://ca.example.test/order#fragment",
  ]) {
    mocks.client.createAccount.mockImplementationOnce(async () => interceptor({ url }));
    await expect(issueAcmeCertificate(options())).rejects.toThrow("different recipient");
  }
  mocks.client.createAccount.mockImplementationOnce(async () => {
    expect(interceptor({ url: "https://ca.example.test/account" })).toMatchObject({
      timeout: 15000,
      maxRedirects: 0,
      maxBodyLength: 65536,
      maxContentLength: 65536,
      signal: expect.any(AbortSignal),
    });
  });
  await issueAcmeCertificate(options());
  const abort = new AbortController();
  abort.abort(new Error("stopped"));
  mocks.client.createAccount.mockImplementationOnce(async () =>
    interceptor({ url: "https://ca.example.test/account" }),
  );
  await expect(issueAcmeCertificate({ ...options(), signal: abort.signal })).rejects.toThrow(
    "stopped",
  );
});

test("F3: a certificate order is refused when the name's CAA accounturi is not the gateway's own account", async () => {
  // Whoever rewrote the name's CAA record bound issuance to an ACME account of their own.
  mocks.resolveCaa.mockResolvedValue([
    { critical: 0, issue: "letsencrypt.org; accounturi=https://ca.example.test/acct/666" },
  ]);
  await expect(issueAcmeCertificate(options())).rejects.toThrow("another ACME account");
  expect(mocks.client.createOrder).not.toHaveBeenCalled();
  expect(presenter.create).not.toHaveBeenCalled();
});

test("the account-bound CAA step runs with the account URL before the order, and its own record lets it through", async () => {
  const beforeOrder = vi.fn(async () => {
    mocks.resolveCaa.mockResolvedValue([
      { critical: 0, issue: `letsencrypt.org; validationmethods=dns-01; accounturi=${ACCOUNT}` },
    ]);
  });
  expect(await issueAcmeCertificate({ ...options(), beforeOrder })).toBe("public-certificate");
  expect(beforeOrder).toHaveBeenCalledWith(ACCOUNT, expect.any(AbortSignal));
  expect(beforeOrder.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.client.createOrder.mock.invocationCallOrder[0]!,
  );
  // A name DNS couldn't answer for, or one with no account binding, goes ahead: the CA decides.
  mocks.client.getAuthorizations.mockResolvedValue([{ ...authorization, status: "valid" }]);
  mocks.client.getOrder.mockResolvedValue({ status: "valid" });
  for (const answer of [
    Promise.reject(Object.assign(new Error("SERVFAIL"), { code: "ESERVFAIL" })),
    Promise.resolve([{ critical: 0, issue: "letsencrypt.org" }]),
  ]) {
    answer.catch(() => {});
    mocks.resolveCaa.mockReturnValueOnce(answer);
    expect(await issueAcmeCertificate(options())).toBe("public-certificate");
  }
});
