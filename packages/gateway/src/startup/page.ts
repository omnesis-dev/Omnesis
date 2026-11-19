// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";

const STYLES = String.raw`
:root{color-scheme:light dark;--bg:#f5f7fb;--surface:#fff;--ink:#182333;--muted:#5d6c7f;--line:#dde4ed;--accent:#1f6feb;--accent-soft:#eaf2ff;--good:#187452;--bad:#a13c35;--shadow:0 24px 90px #15294a0c}
*{box-sizing:border-box}
body{margin:0;height:100vh;height:100dvh;overflow:hidden;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;padding:clamp(12px,3vh,32px) 22px}
main{width:min(100%,640px);max-height:100%;min-height:0;display:flex;flex-direction:column;gap:20px}
header{flex:none;text-align:center}
.brand{display:flex;align-items:center;justify-content:center;margin:0 0 18px;font-size:28px;font-weight:700;line-height:1;letter-spacing:-.02em}
.brand-mark{width:.83em;height:.83em;margin-right:.026em;flex:none;fill:currentColor}
.wordmark{font:inherit}
h1{font-size:clamp(24px,4.5vw,30px);line-height:1.18;letter-spacing:-.035em;margin:0 0 8px}
header p{margin:0 auto;color:var(--muted);font-size:14px}
.card{min-height:0;display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);overflow:hidden}
.status-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 20px;border-bottom:1px solid var(--line)}
.status-head strong{font-size:12px;font-weight:650}
.clock{color:var(--muted);font:12px ui-monospace,SFMono-Regular,monospace;white-space:nowrap}
ol{min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:var(--muted) transparent;list-style:none;margin:0;padding:3px 20px}
ol:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
li{display:grid;grid-template-columns:20px minmax(0,1fr) auto;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);line-height:1.4}
li:last-child{border-bottom:0}
.step-symbol{width:19px;height:19px;border:1.5px solid var(--line);border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:700;line-height:1;color:var(--muted)}
.step-label{font-size:14px;font-weight:550}
.step-detail{display:block;margin-top:3px;color:var(--muted);font-size:12px}
.step-status{display:inline-flex;align-items:baseline;justify-content:flex-end;gap:7px;white-space:nowrap;font-size:11px;color:var(--muted);text-align:right}
.step-status small{font:inherit;color:var(--muted)}
.step-status,.clock{font-variant-numeric:tabular-nums}
li[data-state=running] .step-symbol{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
li[data-state=running] .step-symbol:before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;animation:pulse 1.8s ease-in-out infinite}
li[data-state=running] .step-label,li[data-state=running] .step-status{color:var(--accent)}
li[data-state=succeeded] .step-symbol{border-color:var(--good);color:var(--good)}
li[data-state=failed] .step-symbol{border-color:var(--bad);color:var(--bad)}
li[data-state=failed] .step-status{color:var(--bad)}
li[data-state=skipped],li[data-state=blocked]{opacity:.7}
.summary{flex:none;margin:0;padding:12px 20px;background:var(--accent-soft);border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
[hidden]{display:none!important}
noscript p{text-align:center;color:var(--muted);font-size:13px;margin:0}
@keyframes pulse{50%{opacity:.35}}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--surface:#151b23;--ink:#e6edf3;--muted:#96a4b5;--line:#2b3543;--accent:#58a6ff;--accent-soft:#17283d;--good:#6fc9a0;--bad:#f48b83;--shadow:0 24px 90px #0003}}
@media(prefers-reduced-motion:reduce){li[data-state=running] .step-symbol:before{animation:none}}
@media(max-width:480px){body{padding:16px 14px}main{gap:16px}.brand{font-size:26px;margin-bottom:14px}.status-head{padding:12px 16px}ol{padding:3px 16px}li{gap:8px;grid-template-columns:19px minmax(0,1fr) auto;padding:8px 0}.step-label{font-size:13px}.step-status{font-size:10px;gap:6px}.summary{padding:10px 16px}.card{border-radius:14px}}
@media(max-height:500px){body{padding:12px 14px}main{gap:12px}.brand{margin-bottom:10px;font-size:24px}h1{font-size:24px}.status-head{padding-top:10px;padding-bottom:10px}}
@media(max-height:320px){body{padding:8px 12px}main{gap:8px}.brand{font-size:20px;margin-bottom:8px}h1{font-size:20px;margin:0}header p{display:none}.status-head{padding:8px 12px}}
`;

const SCRIPT = String.raw`
(() => {
  "use strict";
  const ENDPOINT = "/.well-known/omnesis-startup";
  const POLL_MS = 750;
  const TIMEOUT_MS = 4000;
  const states = new Set(["pending", "running", "succeeded", "skipped", "failed", "blocked"]);
  const bootStates = new Set(["starting", "ready", "failed", "stopping"]);
  const descriptions = {
    pending: "Waiting", running: "In progress", succeeded: "Done",
    skipped: "Not needed", failed: "Failed", blocked: "Blocked"
  };
  const list = document.getElementById("startup-steps");
  const title = document.getElementById("startup-title");
  const subtitle = document.getElementById("startup-subtitle");
  const summary = document.getElementById("startup-summary");
  const phase = document.getElementById("startup-phase");
  const clock = document.getElementById("startup-clock");
  let snapshot = null;
  let stopped = false;
  let handedOff = false;
  let lifecycle = 0;
  let pollTimer;
  let request;

  function finite(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
  function count(value) { return Number.isSafeInteger(value) && value >= 0; }
  function valid(value) {
    if (!value || typeof value !== "object" || typeof value.bootId !== "string" ||
        !value.bootId || value.bootId.length > 128 || !count(value.sequence) ||
        !finite(value.startedAt) || !bootStates.has(value.state) ||
        !Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > 64) return false;
    const ids = new Set();
    for (const step of value.steps) {
      if (!step || typeof step !== "object" || typeof step.id !== "string" ||
          !step.id || step.id.length > 128 || ids.has(step.id) ||
          typeof step.label !== "string" || !step.label || step.label.length > 160 ||
          typeof step.optional !== "boolean" || !Array.isArray(step.dependsOn) ||
          !step.dependsOn.every(id => typeof id === "string" && id.length > 0 && id.length <= 128) ||
          !states.has(step.state) || (step.startedAt !== undefined && !finite(step.startedAt)) ||
          (step.finishedAt !== undefined && (!finite(step.finishedAt) ||
            (step.startedAt === undefined ? !["skipped", "blocked"].includes(step.state) :
              step.finishedAt < step.startedAt)))) return false;
      ids.add(step.id);
      if (step.progress !== undefined) {
        const p = step.progress;
        if (!p || !count(p.current) || !count(p.total) || !count(p.completed) ||
            p.current > p.total || p.completed > p.current) return false;
      }
    }
    if (value.steps.some(step => step.dependsOn.some(id => !ids.has(id)))) return false;
    if (value.state === "ready" && value.steps.some(step => !step.optional && step.state !== "succeeded")) return false;
    return true;
  }

  function duration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return seconds + "s";
    return Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
  }

  function updateText(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }

  function render() {
    const scrollTop = list.scrollTop;
    list.replaceChildren();
    let next = false;
    for (const step of snapshot.steps) {
      const row = document.createElement("li");
      row.dataset.state = step.state;
      const symbol = document.createElement("span");
      symbol.className = "step-symbol";
      symbol.setAttribute("aria-hidden", "true");
      symbol.textContent = step.state === "succeeded" ? "✓" :
        step.state === "failed" ? "!" : step.state === "skipped" || step.state === "blocked" ? "−" : "";
      const label = document.createElement("span");
      label.className = "step-label";
      label.textContent = step.label;
      if (step.progress && step.progress.total > 0 && step.state === "running") {
        const detail = document.createElement("span");
        detail.className = "step-detail";
        detail.textContent = step.progress.completed + " of " + step.progress.total + " migrations committed";
        if (step.progress.current > step.progress.completed) {
          detail.textContent += " · applying migration " + step.progress.current;
        }
        label.append(detail);
      }
      const status = document.createElement("span");
      status.className = "step-status";
      status.textContent = descriptions[step.state];
      if (step.state === "pending" && !next && snapshot.state === "starting") {
        status.textContent = "Up next";
        next = true;
      }
      if (step.startedAt !== undefined) {
        const elapsed = document.createElement("small");
        elapsed.textContent = duration((step.finishedAt === undefined ? Date.now() : step.finishedAt) - step.startedAt);
        status.append(elapsed);
      }
      row.append(symbol, label, status);
      list.append(row);
    }
    list.scrollTop = scrollTop;
    clock.textContent = duration(Date.now() - snapshot.startedAt) + " elapsed";
    summary.hidden = false;
    if (snapshot.state === "failed") {
      title.textContent = "Your gateway could not start";
      subtitle.textContent = "Check the gateway’s service logs for details.";
      updateText(phase, "Startup needs attention");
      updateText(summary, "This page will reconnect if the gateway restarts.");
    } else if (snapshot.state === "stopping") {
      title.textContent = "Your gateway is stopping";
      subtitle.textContent = "Closing services safely.";
      updateText(phase, "Stopping services");
      updateText(summary, "Waiting for the gateway to return.");
    } else if (snapshot.state === "ready") {
      updateText(phase, "Ready");
      updateText(summary, "Opening your page…");
    } else {
      title.textContent = "Your gateway is starting up";
      subtitle.textContent = "Your page will open automatically when ready.";
      const running = snapshot.steps.filter(step => step.state === "running");
      const completed = snapshot.steps.filter(step => step.state === "succeeded" || step.state === "skipped").length;
      updateText(phase, completed + " of " + snapshot.steps.length + " steps complete");
      summary.hidden = running.length < 2;
      updateText(summary, running.length > 1 ? running.length + " steps are running in parallel." : "");
    }
  }

  async function poll() {
    if (stopped || handedOff) return;
    const generation = lifecycle;
    request = new AbortController();
    const timeout = setTimeout(() => request.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(ENDPOINT, {
        cache: "no-store", credentials: "same-origin", redirect: "error", signal: request.signal
      });
      if (!response.ok) throw new Error("Progress unavailable");
      const value = await response.json();
      if (!valid(value)) throw new Error("Progress unavailable");
      if (stopped || generation !== lifecycle) return;
      if (snapshot && snapshot.bootId === value.bootId && value.sequence < snapshot.sequence) return;
      snapshot = value;
      render();
      if (snapshot.state === "ready") {
        handedOff = true;
        // Reload leaves the path, query string and fragment intact, including one-time login links.
        window.location.reload();
      }
    } catch {
      if (!stopped && generation === lifecycle) {
        updateText(phase, "Reconnecting to your gateway");
        summary.hidden = false;
        updateText(summary, snapshot ? "Showing the last confirmed startup state. Waiting for a fresh update…" :
          "Waiting for the gateway’s startup progress. This page will reconnect automatically.");
      }
    } finally {
      clearTimeout(timeout);
      request = undefined;
      if (!stopped && !handedOff) pollTimer = setTimeout(poll, POLL_MS);
    }
  }

  window.addEventListener("pagehide", () => {
    stopped = true;
    lifecycle++;
    clearTimeout(pollTimer);
    if (request) request.abort();
  });
  window.addEventListener("pageshow", () => {
    if (!stopped) return;
    stopped = false;
    handedOff = false;
    // A cancelled request may still be settling after a back/forward-cache
    // restore. Its finally block resumes polling without overlapping it.
    if (!request) void poll();
  });
  void poll();
})();
`;

// The mark is the portal's existing favicon geometry, embedded so boot needs no assets.
const LOGO =
  '<svg class="brand-mark" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="138.09 138.09 723.80 722.85"><path d="M771.96,264.13L760.06,251.07L747.53,238.61L734.41,226.77L720.72,215.60L706.50,205.11L691.78,195.34L676.60,186.29L661.00,178.01L645.00,170.49L628.66,163.78L612.01,157.87L595.09,152.78L577.93,148.54L560.59,145.14L543.11,142.59L525.52,140.91L507.87,140.09L490.20,140.13L472.55,141.05L454.97,142.83L437.50,145.47L420.18,148.96L403.05,153.30L386.16,158.47L369.54,164.47L353.23,171.28L337.28,178.87L321.72,187.25L306.59,196.37L291.92,206.23L277.76,216.79L264.13,228.04L251.07,239.94L238.61,252.47L226.77,265.59L215.60,279.28L205.11,293.50L195.34,308.22L186.29,323.40L178.01,339.00L170.49,355.00L163.78,371.34L157.87,387.99L152.78,404.91L148.54,422.07L145.14,439.41L142.59,456.89L140.91,474.48L140.09,492.13L140.13,509.80L141.05,527.45L142.83,545.03L145.47,562.50L148.96,579.82L153.30,596.95L158.47,613.84L164.47,630.46L171.28,646.77L178.87,662.72L187.25,678.28L196.37,693.41L206.23,708.08L216.79,722.24L228.04,735.87L239.94,748.93L252.47,761.39L265.59,773.23L279.28,784.40L293.50,794.89L308.22,804.66L332.03,818.40L452.41,733.14L437.15,729.52L420.43,724.27L404.15,717.81L388.39,710.17L373.23,701.39L363.50,694.92L349.53,684.35L336.38,672.79L328.09,664.55L316.46,651.46L305.81,637.54L296.22,622.89L287.73,607.56L280.39,591.66L274.25,575.25L269.32,558.44L265.65,541.31L263.24,523.96L262.12,506.48L262.29,488.96L263.12,477.31L265.43,459.95L269.01,442.80L273.84,425.96L279.90,409.52L284.61,398.83L292.63,383.26L301.78,368.32L308.48,358.76L319.39,345.05L331.28,332.18L344.08,320.23L357.73,309.24L372.15,299.30L387.26,290.43L402.98,282.71L419.23,276.16L435.92,270.83L452.95,266.73L470.24,263.90L487.69,262.35L505.20,262.09L522.69,263.12L540.05,265.43L557.20,269.01L574.04,273.84L595.85,282.19L611.61,289.83L626.77,298.61L641.24,308.48L654.95,319.39L667.82,331.28L679.77,344.08L690.76,357.73L700.70,372.15L712.27,392.44L719.61,408.34L725.75,424.75L730.68,441.56L734.35,458.69L736.76,476.04L737.88,493.52L737.71,511.04L735.73,532.47L856.10,447.21L852.89,428.82L846.70,403.05L838.63,377.81L828.72,353.23L817.04,329.45L803.63,306.59L788.58,284.77L771.96,264.13ZM369.73,818.59L366.93,821.95L365.73,826.41L366.56,830.95L369.07,834.53L372.33,836.59L385.03,841.04L389.17,841.06L392.78,839.61L602.51,691.05L606.16,686.82L608.01,681.82L607.97,676.24L605.93,671.04L601.85,666.71L596.42,664.26L590.47,664.08L584.91,666.19L369.73,818.59ZM855.94,511.56L858.45,508.72L859.83,504.93L859.89,491.52L859.38,488.46L857.38,484.87L854.15,482.32L850.18,481.22L846.10,481.72L843.34,483.12L628.60,635.25L624.95,639.47L623.06,644.73L623.19,650.31L625.19,655.25L629.26,659.59L634.69,662.03L640.64,662.21L646.21,660.10L855.94,511.56ZM435.14,836.54L432.22,840.38L431.34,845.12L432.54,849.53L435.71,853.16L439.67,854.89L454.58,857.09L458.10,856.79L461.32,855.34L848.26,581.26L850.40,578.98L851.78,576.17L854.72,561.36L854.67,557.29L853.06,553.55L850.16,550.70L846.38,549.17L842.31,549.19L838.56,550.76L435.14,836.54ZM520.46,840.36L517.44,844.44L516.72,849.71L518.68,854.66L522.81,858.01L527.04,858.94L536.12,858.18L548.50,856.68L552.42,855.07L817.78,667.10L820.62,663.67L829.63,644.61L830.10,639.81L828.36,635.31L825.46,632.45L821.68,630.92L817.61,630.95L813.85,632.52L520.46,840.36Z" fill-rule="evenodd"/></svg>';

/** A standalone page: no portal module, database, remote font or icon dependency. */
export function renderStartupPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><title>Starting up · Omnesis</title><style>${STYLES}</style></head>
<body><main><header><div class="brand" role="img" aria-label="Omnesis">${LOGO}<span class="wordmark" aria-hidden="true">MNESIS</span></div><h1 id="startup-title">Your gateway is starting up</h1><p id="startup-subtitle">Your page will open automatically when ready.</p></header>
<section class="card" aria-label="Gateway startup progress"><div class="status-head"><strong id="startup-phase" aria-live="polite" aria-atomic="true">Startup progress</strong><span class="clock" id="startup-clock"></span></div><ol id="startup-steps" aria-label="Startup steps" tabindex="0"></ol><p id="startup-summary" class="summary" role="status">Connecting to your gateway…</p></section>
<noscript><p>Enable JavaScript to see live startup progress, then refresh to open your page.</p></noscript></main><script>${SCRIPT}</script></body></html>`;
}

/** Exact hashes permit the embedded script/style without allowing arbitrary inline code. */
export function startupPageCsp(): string {
  const hash = (value: string): string => createHash("sha256").update(value).digest("base64");
  return [
    "default-src 'none'",
    `script-src 'sha256-${hash(SCRIPT)}'`,
    `style-src 'sha256-${hash(STYLES)}'`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}
