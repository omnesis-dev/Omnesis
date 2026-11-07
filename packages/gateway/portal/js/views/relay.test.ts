// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
const state=vi.hoisted(()=>({status:null as Record<string,any>|null,error:"",busy:"",run:vi.fn()}));
vi.mock("../lib/use-relay-management.js",()=>({useRelayManagement:()=>state}));
// @ts-expect-error portal JS
import { RelayView } from "./relay.js";
let host:HTMLElement;
function fixture(){return {enabled:false,configured:false,serviceConfigured:true,config:{termsAccepted:false,invitationRequired:false},google:{configured:false},enrollment:{state:"unconfigured"},tunnel:{state:"disabled"},certificate:{state:"unconfigured"},publicMcp:{ready:false},can:{configure:true,enable:true,disable:true,reconnect:true,renew:true}};}
beforeEach(()=>{const dom=parseHTML("<html><body><main></main></body></html>");vi.stubGlobal("document",dom.document);vi.stubGlobal("window",dom.window);host=dom.document.querySelector("main") as unknown as HTMLElement;state.status=fixture();state.error="";state.busy="";state.run.mockReset();});
afterEach(()=>{render(null,host);vi.unstubAllGlobals();});
async function show(){await act(async()=>render(h(RelayView,{}),host));}
function button(label:string){return [...host.querySelectorAll("button")].find(x=>x.textContent===label) as HTMLButtonElement;}
async function input(index:number,value:string){await act(async()=>{const element=host.querySelectorAll("input")[index] as HTMLInputElement;element.value=value;element.dispatchEvent(new window.Event("input",{bubbles:true}));});}
async function submit(index:number){await act(async()=>{host.querySelectorAll("form")[index].dispatchEvent(new window.Event("submit",{bubbles:true,cancelable:true}));});}
test("unconfigured setup generates identity on save and sends invitation only on explicit enable",async()=>{
 state.status!.config.invitationRequired=true;await show();expect(host.textContent).toContain("Generated when you save settings");expect(host.textContent).toContain("Not configured");
 await submit(0);expect(state.run).toHaveBeenLastCalledWith("configure",{termsAccepted:false});
 expect(host.textContent).not.toContain("Relay URL");expect(host.querySelector('input[placeholder="https://relay.example.com"]')).toBeNull();
 await input(3," fictional-one-use-invitation ");await submit(1);expect(state.run).toHaveBeenLastCalledWith("enable",{invitation:"fictional-one-use-invitation"});expect((host.querySelectorAll("input")[3] as HTMLInputElement).value).toBe("");
 await submit(1);expect(state.run).toHaveBeenLastCalledWith("enable",{});
});
test("populates public settings once, permits custom domain/CA and never overwrites an in-progress edit",async()=>{
 state.status={...fixture(),config:{relayUrl:"https://relay.example.test",publicOrigin:"https://public.example.test",acmeDirectoryUrl:"https://ca.example.test/directory",acmeTermsUrl:"https://ca.example.test/terms",termsAccepted:true,invitationRequired:true}};await show();
 expect((host.querySelectorAll("input")[3] as HTMLInputElement).hasAttribute("required")).toBe(true);expect(host.querySelector("a")?.getAttribute("href")).toBe("https://ca.example.test/terms");
 expect(host.textContent).not.toContain("https://relay.example.test");
 await input(0,"https://custom.example.test");await input(1,"https://issuer.example.test/directory");
 await act(async()=>{const check=host.querySelector('input[type="checkbox"]') as HTMLInputElement;check.checked=false;check.dispatchEvent(new window.Event("change",{bubbles:true}));});
 state.status={...state.status,revision:2};await show();await submit(0);expect(state.run).toHaveBeenLastCalledWith("configure",{publicOrigin:"https://custom.example.test",acmeDirectoryUrl:"https://issuer.example.test/directory",termsAccepted:false});
});
test("renders connected public identity, separate certificate state, actionable errors and controls",async()=>{
 state.status={...fixture(),identities:[{id:"cloud",names:["gateway.example.test"],state:"valid"},{id:"direct",names:["direct.example.test"],state:"valid",kind:"local-ca",expiresAt:"2028-05-01T00:00:00Z"}],enabled:true,gatewayId:"00000000-0000-4000-8000-000000000001",hostname:"gateway.example.test",publicOrigin:"https://gateway.example.test",google:{configured:true},enrollment:{state:"enrolled",error:"enrollment-refused"},tunnel:{state:"online",lastError:"tunnel-disconnected",lastConnectedAt:"2028-01-01T00:00:00Z"},certificate:{state:"expiring",expiresAt:"2028-01-02T00:00:00Z",lastRenewedAt:"2028-01-01T00:00:00Z",lastError:"certificate-renewal-failed"},publicMcp:{ready:true,url:"https://gateway.example.test/mcp"}};await show();
 expect(host.textContent).toContain("Not linked");expect(host.textContent).toContain("endpoint verified");expect(host.textContent).toContain("Certificate renewal failed");expect(host.textContent).toContain("https://gateway.example.test/mcp");
 for(const [label,op] of [["Reconnect","reconnect"],["Renew certificate","renew"],["Disable relay","disable"]]){await act(async()=>button(label).click());expect(state.run).toHaveBeenLastCalledWith(op);}
 await act(async()=>button("Refresh status").click());expect(state.run).toHaveBeenLastCalledWith();
 state.busy="renew";await show();expect([...host.querySelectorAll("button")].every(x=>x.disabled)).toBe(true);expect(host.textContent).toContain("Updating relay status");
 state.busy="";state.status.can={configure:false,enable:false,disable:false,reconnect:false,renew:false};await show();expect(button("Enable relay")).toBeUndefined();expect(button("Save settings").disabled).toBe(true);
});
test("loading and unavailable status provide retry without exposing exception details",async()=>{
 state.status=null;state.busy="refresh";await show();expect(host.textContent).toContain("Loading relay settings");
 state.busy="";state.error="Couldn't load relay settings.";await show();expect(host.querySelector('[role="alert"]')?.textContent).toBe(state.error);expect(host.textContent).toContain("Refresh status to retry");
 state.status=fixture();await show();expect(host.textContent).toContain("Hostname not assigned");
});

test("shows the separate default certificate even when identity details have not loaded",async()=>{
 state.status={...fixture(),directCertificate:{state:"expiring",expiresAt:"2028-05-01T00:00:00Z"}};await show();
 expect(host.textContent).toContain("Direct/default certificate");expect(host.textContent).toContain("Existing direct gateway identity");expect(host.textContent).toContain("managed independently");
});

test("enrolled gateways do not ask for another invitation and distinguish failed renewal from an unusable certificate",async()=>{
 state.status={...fixture(),enabled:true,enrollment:{state:"enrolled"},config:{invitationRequired:true,termsAccepted:true},tunnel:{state:"online"},certificate:{state:"valid",lastError:"certificate-renewal-failed",expiresAt:"2028-05-01T00:00:00Z"}};await show();
 expect(host.textContent).toContain("Connected");expect(host.textContent).toContain("current certificate remains valid");expect(host.querySelector('input[type="password"]')).toBeNull();expect(host.textContent).not.toContain("Save settings to create a stable gateway identity");
 state.status={...state.status,enabled:false,certificate:{state:"failed"}};await show();expect(host.textContent).toContain("already enrolled");expect(host.textContent).not.toContain("current certificate remains valid");
});

test("optional Google controls link and unlink only when the real backend supports those operations",async()=>{
 Object.defineProperty(window,"location",{configurable:true,value:{origin:"https://gateway.example.test"}});
 state.status={...fixture(),identities:[{id:"direct",names:["direct.example.test"],state:"valid",kind:"external",label:"Provided Tailscale certificate"}],google:{configured:true,canLink:true,linkOrigin:"https://gateway.example.test",lastError:"google-link-failed"}};await show();
 expect(host.textContent).toContain("Provided Tailscale certificate");expect(host.textContent).toContain("Google account linking failed");
 expect(button("Link Google account").querySelector("img")?.getAttribute("src")).toBe("/portal/img/google-sign-in-mark.png");
 await act(async()=>button("Link Google account").click());expect(state.run).toHaveBeenLastCalledWith("google/link");
 state.busy="google/link";await show();expect(button("Link Google account").disabled).toBe(true);
 state.busy="";state.status={...state.status,google:{configured:true,linked:true,canUnlink:true}};await show();expect(host.textContent).toContain("association is saved on this gateway");expect(host.textContent).toContain("linking Google again may be needed");expect(host.textContent).toContain("Existing paired devices continue working");
 await act(async()=>button("Unlink Google account").click());expect(state.run).toHaveBeenLastCalledWith("google/unlink");
 state.busy="google/unlink";await show();expect(button("Unlink Google account").disabled).toBe(true);
});
test("Google starts at the configured callback origin so direct-origin portal cookies are not lost",async()=>{
 Object.defineProperty(window,"location",{configurable:true,value:{origin:"https://direct.example.test"}});
 state.status={...fixture(),google:{configured:true,canLink:true,linkOrigin:"https://cloud.example.test"}};await show();expect(host.querySelector("a")?.getAttribute("href")).toBe("https://cloud.example.test/portal/settings/relay");expect(host.textContent).not.toContain("Link Google account");expect(state.run).not.toHaveBeenCalled();
});

test("a failed public endpoint probe is separate from a still-valid public certificate",async()=>{
 state.status={...fixture(),certificate:{state:"valid",expiresAt:"2028-05-01T00:00:00Z"},publicMcp:{ready:false,lastError:"public-endpoint-unreachable"}};await show();expect(host.textContent).toContain("The public endpoint could not be verified");expect(host.textContent).not.toContain("Certificate renewal failed");
});

test("missing installation service disables setup and never renders service URLs from status",async()=>{
 state.status={...fixture(),serviceConfigured:false,config:{relayUrl:"https://private-operator.example.test",termsAccepted:false,invitationRequired:false}};await show();
 expect(host.textContent).toContain("Ask the installation administrator");expect(button("Save settings").disabled).toBe(true);expect(host.textContent).not.toContain("https://private-operator.example.test");
 state.status.serviceError="relay-service-mismatch";await show();expect(host.textContent).toContain("installation service configuration does not match");
 delete state.status.serviceConfigured;await show();expect(button("Save settings").disabled).toBe(true);
});

test("recovery receipt visibility describes only the local artifact and never claims authority or revocation verification",async()=>{
 for(const [receipt,label] of [["missing","Not stored"],["present","Stored locally"],["expired","Expired"],["invalid","Invalid local artifact"],["unknown","Unavailable"]]){
  state.status={...fixture(),recovery:{receipt,...(receipt==="present"?{expiresAt:"2028-01-01T00:00:00Z"}:{})}};await show();expect(host.textContent).toContain(label);expect(host.textContent).toContain("does not verify the authority signature");expect(host.textContent).toContain("current revocation policy");
 }
});
test("optional CT monitoring distinguishes disabled, pending, completed, incident and incomplete states without false reassurance",async()=>{
 for(const [value,label] of [["disabled","Off"],["pending","Waiting for a local gateway key"],["observing","Recent provider observations completed"],["incident","Unexpected certificate key observed"],["stale","Observations are incomplete or stale"],["unavailable","Monitoring unavailable"],["unknown-secret-status","Monitoring status unavailable"]]){
  state.status={...fixture(),certificateMonitor:{enabled:value!=="disabled",state:value,incidents:[]}};await show();expect(host.textContent).toContain(label);expect(host.textContent).toContain("does not prove that every certificate is safe");expect(host.textContent).toContain("never changes encryption trust");expect(host.textContent).not.toContain("unknown-secret-status");
 }
 state.status={...fixture(),certificateMonitor:{state:"unavailable",lastError:"ct-provider-unavailable"}};await show();expect(host.querySelector('[role="alert"]')?.textContent).toContain("provider could not be reached");
});
test("unexpected CT key evidence remains visible during provider outage with public issuer, serial, validity and full digest",async()=>{
 const fingerprint="f".repeat(64);state.status={...fixture(),certificateMonitor:{enabled:true,state:"unavailable",lastCompletedAt:"2028-01-01T00:00:00Z",lastError:"ct-journal-write-failed",incidents:[{hostname:"gateway.example.test",spkiFingerprint:fingerprint,certificateFingerprint:"e".repeat(64),issuer:"Fictional test issuer",serial:"ABCD",validFrom:"2028-01-01T00:00:00Z",validTo:"2028-02-01T00:00:00Z",observedAt:"2028-01-02T00:00:00Z",providerEntryId:"fixture-entry-1"}]}};await show();expect(host.textContent).toContain(fingerprint);expect(host.textContent).toContain("e".repeat(64));expect(host.textContent).toContain("Fictional test issuer");expect(host.textContent).toContain("ABCD");expect(host.textContent).toContain("fixture-entry-1");expect(host.textContent).toContain("could not be saved locally");expect(host.textContent).not.toContain("api.certspotter.com");
});

test("linked accounts show one account action and keep discovery repair in advanced settings", async () => {
  state.status = { ...fixture(), enabled: true, enrollment: { state: "enrolled" }, google: { configured: true, linked: true, canLink: true, canUnlink: true } };
  await show();
  expect(host.textContent).toContain("Google account linked");
  expect(button("Link Google account")).toBeUndefined();
  expect(button("Unlink Google account")).toBeDefined();
  const repair = button("Refresh Google discovery");
  expect(repair.closest("details")?.hasAttribute("open")).toBe(false);
  await act(async () => repair.click());
  expect(state.run).toHaveBeenLastCalledWith("google/link");
  expect(host.querySelector(".relay-card")).toBeNull();
  expect(host.querySelector(".relay-cards")).toBeNull();
});

test("copying an MCP address reports success and gives a manual fallback when the clipboard refuses", async () => {
  state.status = { ...fixture(), publicMcp: { ready: true, url: "https://gateway.example.test/mcp" } };
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  await show(); await act(async () => button("Copy MCP address").click());
  expect(writeText).toHaveBeenCalledExactlyOnceWith("https://gateway.example.test/mcp");
  expect(host.textContent).toContain("Copied");
  writeText.mockRejectedValueOnce(new Error("fixture clipboard refusal"));
  await act(async () => button("Copy MCP address").click());
  expect(host.textContent).toContain("Select and copy the address above.");
  expect(host.textContent).not.toContain("fixture clipboard refusal");
});

test("connection problems remain visible when technical details are collapsed", async () => {
  state.status = { ...fixture(), enabled: true, enrollment: { state: "enrolled" }, tunnel: { state: "disconnected", lastError: "tunnel-disconnected" } };
  await show();
  const alert = host.querySelector('[role="alert"]');
  expect(alert?.closest("details")).toBeNull();
  expect(alert?.textContent).toContain("relay connection was interrupted");
});


test("an offline enabled gateway never claims that remote access is available", async () => {
  state.status = { ...fixture(), enabled: true, tunnel: { state: "offline" } };
  await show(); expect(host.textContent).toContain("Waiting for an encrypted connection");
  expect(host.textContent).not.toContain("Your gateway is available through an encrypted connection");
  state.status.tunnel.state = "online"; await show();
  expect(host.textContent).toContain("Your gateway is available through an encrypted connection");
});

test("disabled enrolled gateways can reconnect in the main row while new installations open setup", async () => {
  state.status = { ...fixture(), enrollment: { state: "enrolled" } };
  await show(); await act(async () => button("Enable relay").click());
  expect(state.run).toHaveBeenLastCalledWith("enable", {});
  state.status = fixture(); await show();
  const details = host.querySelector(".relay-setup") as HTMLDetailsElement;
  details.open = false; const summary = details.querySelector("summary")!;
  Object.defineProperty(summary, "focus", { value: vi.fn() });
  await act(async () => button("Set up remote access").click());
  expect(details.open).toBe(true); expect(summary.focus).toHaveBeenCalledOnce();
});
