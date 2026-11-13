// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { h, render } from "preact";
import { parseHTML } from "linkedom";
import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error portal JS
import { DeviceConnectionPill } from "./device-connection-pill.js";
afterEach(()=>vi.unstubAllGlobals());
test("renders local, relay and reconnecting observations separately from permissions and trust",()=>{
 const dom=parseHTML("<html><main></main></html>");vi.stubGlobal("document",dom.document);const host=dom.document.querySelector("main")!;
 for(const [path,label] of [["local","Local"],["relay","Remote"],["reconnecting","Reconnecting"]]){render(h(DeviceConnectionPill,{path}),host);expect(host.textContent).toBe(label);expect(host.querySelector("span")?.getAttribute("title")).toContain("permissions and TLS verification are unchanged");}
 const invisible: Array<{path?:string;revoked?:boolean}>=[{},{path:"unknown-secret"},{path:"local",revoked:true}];
 for(const props of invisible){render(h(DeviceConnectionPill,props),host);expect(host.textContent).toBe("");}
 render(null,host);
});
