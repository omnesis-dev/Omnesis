// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
const request=vi.hoisted(()=>vi.fn());vi.mock("./cloud-relay-api.js",async original=>({...await original() as object,relayManagement:request}));
// @ts-expect-error portal JS
import { useRelayManagement } from "./use-relay-management.js";
let host:HTMLElement; let current: {status:unknown;error:string;busy:string;run:(op?:string,input?:unknown)=>Promise<void>};
function Probe(){current=useRelayManagement();return h("div",null,JSON.stringify(current.status));}
function pending(){let resolve!:(x:unknown)=>void, reject!:(x:unknown)=>void;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
beforeEach(()=>{vi.useFakeTimers();const dom=parseHTML("<html><body><main></main></body></html>");vi.stubGlobal("document",dom.document);vi.stubGlobal("window",dom.window);host=dom.document.querySelector("main") as unknown as HTMLElement;request.mockReset();});
afterEach(()=>{render(null,host);vi.useRealTimers();vi.unstubAllGlobals();});
async function mount(){await act(async()=>render(h(Probe,{}),host));}
test("polls visible status with single in-flight request and pauses hidden tabs",async()=>{
 const first=pending();request.mockReturnValueOnce(first.promise).mockResolvedValue({revision:2});await mount();
 expect(current.busy).toBe("refresh");await act(async()=>{await current.run();await vi.advanceTimersByTimeAsync(5000);});expect(request).toHaveBeenCalledTimes(1);
 await act(async()=>first.resolve({revision:1}));expect(current.status).toEqual({revision:1});
 Object.defineProperty(document,"visibilityState",{configurable:true,value:"hidden"});await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(request).toHaveBeenCalledTimes(1);
 Object.defineProperty(document,"visibilityState",{configurable:true,value:"visible"});await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(current.status).toEqual({revision:2});
});
test("mutation invalidates stale poll and blocks a second mutation until it finishes",async()=>{
 const old=pending(),mutation=pending();request.mockReturnValueOnce(old.promise).mockReturnValueOnce(mutation.promise);await mount();const oldSignal=request.mock.calls[0][2] as AbortSignal;
 let work!:Promise<void>;await act(async()=>{work=current.run("enable",{invitation:"fake"});await current.run("disable");});expect(oldSignal.aborted).toBe(true);expect(request).toHaveBeenCalledTimes(2);
 await act(async()=>old.resolve({revision:0}));expect(current.status).toBeNull();expect(current.busy).toBe("enable");
 await act(async()=>{mutation.resolve({revision:2});await work;});expect(current.status).toEqual({revision:2});expect(current.busy).toBe("");
});
test("errors are static, timeout aborts, and recovery clears the error",async()=>{
 request.mockRejectedValueOnce(new Error("private-secret"));await mount();expect(current.error).toContain("Couldn't load");expect(current.error).not.toContain("private-secret");
 const slow=pending();request.mockReturnValueOnce(slow.promise);let work!:Promise<void>;await act(async()=>{work=current.run("renew");});const signal=request.mock.calls[1][2] as AbortSignal;
 await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});expect(signal.aborted).toBe(true);
 await act(async()=>{slow.resolve({revision:3});await work;});expect(current.status).toBeNull();expect(current.error).toContain("Couldn't load");
 request.mockResolvedValue({revision:4});await act(async()=>current.run());expect(current.error).toBe("");expect(current.status).toEqual({revision:4});
});
test("unmount aborts and late success or rejection cannot mutate a replacement component",async()=>{
 const old=pending();request.mockReturnValueOnce(old.promise);await mount();const signal=request.mock.calls[0][2] as AbortSignal;
 const staleRun=current.run;await act(async()=>render(null,host));expect(signal.aborted).toBe(true);await act(async()=>staleRun("enable"));expect(request).toHaveBeenCalledTimes(1);await act(async()=>old.resolve({revision:99}));
 const failed=pending();request.mockReturnValueOnce(failed.promise);await mount();await act(async()=>render(null,host));await act(async()=>failed.reject(new Error("late")));
 expect(vi.getTimerCount()).toBe(0);
});

test("known backend refusal codes become actionable static guidance",async()=>{
 request.mockRejectedValueOnce(Object.assign(new Error("never display this"),{code:"ca-terms-required"}));await mount();expect(current.error).toContain("Accept the configured certificate authority");
});

test("Google linking navigates only after an authorized start and refuses substituted endpoints",async()=>{
 const assign=vi.fn();Object.defineProperty(window,"location",{configurable:true,value:{assign}});
 request.mockResolvedValueOnce({revision:1}).mockResolvedValueOnce({authorizeUrl:"https://accounts.google.com/o/oauth2/v2/auth?state=fictional"}).mockResolvedValueOnce({authorizeUrl:"https://attacker.example.test"});await mount();
 await act(async()=>current.run("google/link"));expect(assign).toHaveBeenCalledExactlyOnceWith("https://accounts.google.com/o/oauth2/v2/auth?state=fictional");expect(current.status).toEqual({revision:1});
 await act(async()=>current.run("google/link"));expect(assign).toHaveBeenCalledOnce();expect(current.error).toContain("Couldn't load or update");
});
