// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { afterEach, expect, test, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("../api.js", () => ({ apiFetch: request }));
// @ts-expect-error portal JS
import { relayManagement, relayError, relayTime, relayCertificateKind, relayHttpsUrl, googleAuthorizationUrl } from "./cloud-relay-api.js";
afterEach(() => vi.clearAllMocks());
test("uses authenticated same-origin status and mutation calls with cancellation", async () => {
 const status={ enabled:false }; request.mockResolvedValue({ok:true,json:async()=>status}); const signal=new AbortController().signal;
 expect(await relayManagement("",undefined,signal)).toEqual(status);
 expect(request).toHaveBeenLastCalledWith("/admin/cloud-relay",{cache:"no-store",signal});
 await relayManagement("enable",{invitation:"fictional-invitation"},signal);
 expect(request).toHaveBeenLastCalledWith("/admin/cloud-relay/enable",{cache:"no-store",signal,method:"POST",body:'{"invitation":"fictional-invitation"}'});
});
test("never displays server bodies, unknown codes, paths or credentials", async () => {
 request.mockResolvedValue({ok:false,text:()=>"private-key-secret"});
 await expect(relayManagement("disable",{})).rejects.toThrow("Couldn't update relay settings");
 expect(relayError()).toBe(""); expect(relayError("unknown-secret-path")).toBe("An operation failed. Check settings and retry.");expect(relayError("__proto__")).toBe("An operation failed. Check settings and retry.");
 for(const code of ["relay-service-mismatch","relay-service-unavailable","configuration-invalid","relay-unreachable","invitation-required","enrollment-refused","tunnel-disconnected","certificate-setup-failed","certificate-renewal-failed","public-endpoint-unreachable"]) expect(relayError(code)).not.toContain("An operation failed");
});
test("renders absent or invalid timestamps safely and valid expiry in local time",()=>{
 expect(relayTime()).toBe("Not yet recorded");expect(relayTime("invalid")).toBe("Not yet recorded");
 expect(relayTime("2028-01-01T00:00:00Z")).toBe(new Date("2028-01-01T00:00:00Z").toLocaleString());
});

test("only known typed refusal codes cross the API error boundary",async()=>{
 request.mockResolvedValueOnce({ok:false,json:async()=>({code:"ca-terms-required",error:"secret"})});
 await expect(relayManagement("enable",{})).rejects.toMatchObject({code:"ca-terms-required"});
 for(const body of [null,{code:"secret"}]){request.mockResolvedValueOnce({ok:false,json:async()=>body});await expect(relayManagement("enable",{})).rejects.not.toHaveProperty("code");}
});
test("certificate types are readable and unknown external values use a fixed fallback",()=>{
 for(const kind of ["self-signed","public-ca","local-ca","external","unconfigured"])expect(relayCertificateKind(kind)).not.toBe("Existing certificate");expect(relayCertificateKind("unknown")).toBe("Existing certificate");
});

test("public terms links allow HTTPS without credentials and refuse invalid or executable URLs",()=>{
 expect(relayHttpsUrl("https://ca.example.test/terms")).toBe("https://ca.example.test/terms");
 for(const value of [undefined,42,"https://"+"x".repeat(2050),"invalid","http://ca.example.test/terms","javascript:alert(1)","https://user@ca.example.test/terms","https://:password@ca.example.test/terms"])expect(relayHttpsUrl(value)).toBeNull();
});

test("Google account linking can navigate only the fixed Google authorization endpoint",()=>{
 expect(googleAuthorizationUrl("https://accounts.google.com/o/oauth2/v2/auth?state=fictional")).toBe("https://accounts.google.com/o/oauth2/v2/auth?state=fictional");
 for(const value of [undefined,"https://attacker.example.test/o/oauth2/v2/auth","https://accounts.google.com/other","http://accounts.google.com/o/oauth2/v2/auth"])expect(()=>googleAuthorizationUrl(value)).toThrow("Google authorization is unavailable");
});

test("a conflicting SNI hostname gets clear guidance without exposing certificate paths", () => {
  expect(relayError("hostname-conflict")).toBe("Choose a different public gateway hostname. This name is already covered by the direct/default certificate.");
});

// @ts-expect-error portal JS
import { relayRecoveryLabel, relayMonitorLabel } from "./cloud-relay-api.js";
test("recovery and CT presentation refuses unknown or prototype-derived states",()=>{
 expect(relayRecoveryLabel("present")).toBe("Stored locally");expect(relayMonitorLabel("observing")).toBe("Recent provider observations completed");for(const value of ["__proto__",undefined,"private-path"]){expect(relayRecoveryLabel(value)).toBe("Unavailable");expect(relayMonitorLabel(value)).toBe("Monitoring status unavailable");}
 for(const code of ["ct-configuration-invalid","ct-provider-unavailable","ct-provider-refused","ct-provider-invalid","ct-scan-incomplete","ct-journal-invalid","ct-journal-write-failed"])expect(relayError(code)).not.toContain("An operation failed");
});
