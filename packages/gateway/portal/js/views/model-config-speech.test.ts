// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer from vitest.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelConfigModal } from "./model-config.js";

vi.mock("../api.js", () => ({getRecentModels:vi.fn(() => Promise.resolve({entries:[]})),getModelCredentialsStatus:vi.fn()}));
let host;
let oldDocument;
let oldWindow;
beforeEach(() => {
  oldDocument=globalThis.document;oldWindow=globalThis.window;
  const parsed=parseHTML("<html><body><main id='root'></main></body></html>");
  Object.assign(globalThis,{document:parsed.document,window:parsed.window});host=document.querySelector("#root");
});
afterEach(() => {
  render(null,host);
  if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
  if(oldWindow===undefined)delete globalThis.window;else globalThis.window=oldWindow;
});
const overview=(backends) => ({capabilities:[{role:"speech-to-speech",title:"Speech to speech"}],catalog:[],presets:[{id:"openai",name:"OpenAI",defaultUrl:"https://api.openai.com"}],inference:{assignments:{},backends}});
const modal=(data,props={}) => h(ModelConfigModal,{role:"speech-to-speech",capTitle:"Speech to speech",overview:data,onClose:()=>{},...props});
const click=(text) => [...host.querySelectorAll("button")].find((button)=>(button.querySelector(".backend-opt-title")?.textContent ?? button.textContent).trim()===text).click();

it.each(["probing","reachable"])("selects only the supported Live model even without a probed model catalog (%s)",async(status)=>{
  const pick=vi.fn();
  await act(async()=>render(modal(overview({cloud:{type:"http",status,modelRoles:{"gpt-live-1":["speech-to-speech"],"gpt-chat":["agent"]}}}),{onPickHttp:pick}),host));
  await act(async()=>click("cloud"));
  expect(host.textContent).toContain("gpt-live-1");expect(host.textContent).not.toContain("gpt-chat");
  expect(host.querySelector(".picker-custom-input")).toBeNull();
  await act(async()=>click("Use"));
  expect(pick).toHaveBeenCalledWith("cloud","gpt-live-1");
});
it("offers safe OpenAI setup without overwriting a non-OpenAI backend named openai",async()=>{
  await act(async()=>render(modal(overview({openai:{type:"http",status:"ok",modelRoles:{"chat-fixture":["agent"]}}})),host));
  await act(async()=>click("OpenAI"));
  const fields=[...host.querySelectorAll("input")];
  expect(fields.some((field)=>field.value==="openai-2")).toBe(true);
  expect(fields.some((field)=>field.value==="https://api.openai.com")).toBe(true);
});
