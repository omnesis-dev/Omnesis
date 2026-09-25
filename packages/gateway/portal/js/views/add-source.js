// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Add Source modal — ports the CLI `add` UX (packages/cli/src/commands/add.ts)
// to the browser. Drives the gateway's /admin/sources/* endpoints:
//
//   1. Pick a descriptor, each labelled with what the gateway already lists
//      of it: nothing (add), configured instances (set up another host), an
//      existing member to
//      configure, a stored source whose descriptor mode can be enabled, or a
//      source another device hosts — joined from a device of the operator's
//      choosing when the type allows several hosts, moved when it allows one
//   2. Fill any required params (validated via /validate-param)
//   3. For local sources with hasDiscover: auto-discover + multi-select accounts
//   4. For sources with hasAuthFlow: POST /admin/auth-flows, then consume SSE
//      events (/admin/auth-flows/:id/events) rendering URL / device code / QR
//      payload. Cancel posts to /admin/auth-flows/:id/cancel.
//   5. POST /add for every account the gateway does not list yet, POST
//      /members for every one it does that admits this device, then refresh
//      the parent and end on a step that states each add, join and refusal.
//      The modal stays open on that report — it is the only place a join is
//      explained in the joining device's terms
//
// Known limitations:
//   - Import-based sources (WhatsApp chat exports) require absolute server-side
//     file paths. Browsers sandbox file inputs and expose only blobs, so we
//     show a "use the CLI" message instead of trying to fake it.
//   - QR rendering: we pull `qrcode` from the locally vendored bundle at
//     /portal/vendor/qrcode.js (configured in the importmap; built by
//     packages/gateway/scripts/build-portal-vendor.mjs) and render to a
//     canvas. Used by the WhatsApp pairing flow.

import { html } from "htm/preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  addSource,
  discoverSourceAccounts,
  enableSourceMultiDeviceMode,
  getAdminSources,
  getCredentialsStatus,
  getSourceDescriptorsUnion,
  getSourcesSnapshot,
  joinSourceMember,
  listDevices,
  moveSourceToDevice,
  resumeSource,
  resolveSourceAccount,
  updateSourceMemberConfig,
  validateSourceParam,
} from "../api.js";
import { sourceIcon } from "../lib/format.js";
import { joinCandidates } from "../lib/join-candidates.js";
import { KindIcon } from "../lib/device-kind-icon.js";
import { AuthStep, useAuthFlow } from "../components/auth-flow.js";
import { ConfirmModal } from "../components/confirm-modal.js";
import { CopyIconButton } from "../components/copy-button.js";
import { CredentialsWizard } from "./credentials-wizard.js";

// Prefer the descriptor's own icon (freshest — pushed from collector over WS)
// over the sync_state cache, which lags behind code updates until a source
// syncs with the new metadata. Sources may advertise either a hosted `url`
// (hot-linked) or an `imageDataUri` they own (e.g. Lucide-derived); both
// can be passed straight to <img src=…>.
function descriptorIcon(d) {
  const src = d?.icon?.url ?? d?.icon?.imageDataUri;
  if (src) return html`<img class="source-icon" src=${src} alt=${d.id} />`;
  return sourceIcon(d.id);
}

/**
 * Whether the credentials wizard should open before starting an auth flow.
 *
 * `alreadyCollected` is the re-entrancy guard and is load-bearing: for a
 * `perAccount` spec the answer is otherwise always "yes", so the wizard's own
 * resume would reopen it, forever.
 */
export function shouldOpenCredentialsWizard(spec, entry, alreadyCollected) {
  if (alreadyCollected) return false;
  if (!spec) return false;
  // A provider-wide credential is asked for only when absent; a per-account one
  // belongs to the account being added, so an existing one says nothing.
  if (!spec.required && !spec.perAccount) return false;
  if (!entry) return false;
  if (!spec.perAccount && entry.configured) return false;
  return true;
}

/**
 * The display name of a device id. A device the gateway no longer pairs is
 * named as such rather than passing for an ordinary host: a revoked one keeps
 * its name with that state appended, and an id the device list does not know
 * at all — a forgotten device — is shortened, because a full ulid tells the
 * reader nothing.
 */
export function deviceName(devices, deviceId) {
  const device = (devices ?? []).find((d) => d.id === deviceId);
  if (!device) return `${String(deviceId ?? "").slice(0, 8)} (forgotten)`;
  return device.revokedAt ? `${device.name} (revoked)` : device.name;
}

/**
 * The operator-facing sentence behind a failed request: the gateway's own
 * `error` when it sent one (`api.js` parses it onto `serverMessage`), and the
 * request line only when it did not.
 */
function errorText(e) {
  return String(e?.serverMessage || e?.message || e);
}

/** Whether `deviceId` is the owner or a member of `source`. */
function isMemberOf(source, deviceId) {
  return source.deviceId === deviceId || (source.members ?? []).includes(deviceId);
}

/**
 * Project collected values onto the descriptor's host-local parameter contract.
 *
 * Keyed on `memberScopedParamNames`, the whole per-machine contract, rather
 * than on the form's parameter list — that list leaves advanced settings out,
 * and a value for one of those would otherwise be routed to the shared config
 * the host then refuses to store.
 */
export function memberConfigForDescriptor(descriptor, values) {
  const memberNames =
    descriptor?.memberScopedParamNames ??
    (descriptor?.params ?? []).filter((p) => p.scope === "member").map((p) => p.name);
  const params = {};
  for (const name of memberNames) {
    if (!Object.hasOwn(values ?? {}, name)) continue;
    params[name] = values[name];
  }
  return Object.keys(params).length > 0 ? { params } : undefined;
}

function memberParams(descriptor) {
  return (descriptor?.params ?? []).filter((param) => param.scope === "member");
}

function registeredSourceMembers(source, devices) {
  const memberIds = new Set([source.deviceId, ...(source.members ?? [])]);
  return (devices ?? []).filter(
    (device) =>
      memberIds.has(device.id) &&
      device.kind === "collector" &&
      device.revokedAt == null,
  );
}

function sourceMembers(source, devices) {
  return registeredSourceMembers(source, devices).filter((device) => device.online !== false);
}

/** A successful addressed edit, kept distinct from a newly joined member. */
export function memberUpdateOutcome(source, device) {
  return { kind: "updated", source, device };
}

/**
 * What joining means for a device, in the mode's own terms. The same
 * sentences the CLI prints before it asks.
 */
export function joinModeSentence(mode, name) {
  switch (mode) {
    case "handoff":
      return `Sync hands off to whichever machine is awake; ${name} needs its own sign-in.`;
    case "replicated":
      return `${name} syncs its own copy alongside the others.`;
    case "partitioned":
      return `${name} contributes its own stream.`;
    default:
      return `${name} would become a second host, which the type does not allow.`;
  }
}

/**
 * What a move does, as the confirmation names it. A move re-seats the source
 * on the target and unregisters it on the old host without touching either
 * side's documents or on-disk credentials — so the target has none of its own
 * yet and signs in for itself.
 */
export function moveSentence(source, fromName, toName) {
  return `${toName} takes over ${source.id}; ${fromName} stops syncing it. Indexed documents stay, but credentials do not travel — if the source needs a sign-in, sign in on ${toName} afterwards.`;
}

/**
 * Whether a listed source row is of the descriptor's type. The gateway stamps
 * every row it lists with its `type` — the same key the CLI matches on; the id
 * shape is the fallback for a row that reaches us without one, and it is the
 * addressing rule — a bare type covers every account of it — restated here
 * because the portal is served as plain modules with no build step and cannot
 * import `sourceIdAddresses` from a workspace package. Keep the two in step by
 * hand; the rule is small and its failure mode is a source that never appears.
 */
function rowIsOfType(row, descriptorId) {
  if (typeof row.type === "string") return row.type === descriptorId;
  return row.id === descriptorId || row.id.startsWith(`${descriptorId}:`);
}

/**
 * The picker state of a descriptor, from the sources the gateway lists and
 * the paired devices:
 *
 *   - `add`: nothing of the type exists.
 *   - `accounts`: configured instances exist and another setup is possible.
 *     For a multi-account type that means adding another account. For a
 *     single-instance type it means an advertising host is still free; its
 *     discovery result decides whether to join an exact account or add a new
 *     one. `paused` counts how many configured rows are paused.
 *   - `paused`: every single-instance row of the type is paused. Adding one
 *     would collide with the row that is already there, so the tile resumes
 *     it instead.
 *   - `join`: a single-instance source another device hosts, whose type
 *     admits more hosts and which some device could join.
 *   - `enable`: a stored exclusive source whose descriptor now declares a
 *     multi-device mode; the operator must explicitly adopt that mode.
 *   - `exclusive`: a single-instance source whose type allows one host, while
 *     another paired collector could take it over (`moveTargets`).
 *   - `configure`: a source with member-local settings on an online collector.
 *   - `configured`: a single-instance source no device could join or take
 *     over — nothing to do.
 *
 * Paused rows count everywhere: a state that ignored them would offer an add
 * whose only possible outcomes are a refusal or a duplicate.
 */
export function describeTileState(d, registeredSources, devices) {
  const rows = (registeredSources ?? []).filter((s) => rowIsOfType(s, d.id));
  if (rows.length === 0) return { kind: "add" };
  const paused = rows.filter((s) => s.enabled === false);
  if (!d.singleInstance) return { kind: "accounts", count: rows.length, paused: paused.length };
  const pairedDevices = new Map((devices ?? []).map((device) => [device.id, device]));
  const setupDevices = (d.devices ?? []).filter((advertised) => {
    const device = pairedDevices.get(advertised.id);
    return (
      device?.kind === "collector" &&
      device.online !== false &&
      !device.revokedAt &&
      !rows.some((source) => isMemberOf(source, advertised.id))
    );
  });
  if (setupDevices.length > 0) {
    return {
      kind: "accounts",
      count: rows.length,
      paused: paused.length,
      singleInstance: true,
      devices: setupDevices,
    };
  }
  if (paused.length === rows.length) {
    return {
      kind: "paused",
      source: paused[0],
      hostName: deviceName(devices, paused[0].deviceId),
    };
  }
  const live = rows.filter((s) => s.enabled !== false);
  for (const source of live) {
    const candidates = joinCandidates(source, devices);
    if (candidates.length > 0) {
      const members = memberParams(d).length > 0 ? sourceMembers(source, devices) : [];
      return {
        kind: "join",
        source,
        hostName: deviceName(devices, source.deviceId),
        candidates: candidates.map((c) => ({
          id: c.id,
          name: c.name,
          kind: c.kind,
          online: c.online === true,
        })),
        ...(members.length > 0 ? { members } : {}),
      };
    }
  }
  const hostName = deviceName(devices, live[0].deviceId);
  const exclusive = live.every((r) => (r.multiDeviceMode ?? "exclusive") === "exclusive");
  const desiredMode = d.multiDeviceMode ?? "exclusive";
  if (exclusive && desiredMode !== "exclusive") {
    return { kind: "enable", source: live[0], hostName, desiredMode };
  }
  if (exclusive && moveTargets(live[0], devices).length > 0) {
    return { kind: "exclusive", source: live[0], hostName };
  }
  if (memberParams(d).length > 0) {
    const members = sourceMembers(live[0], devices);
    if (members.length > 0) {
      return {
        kind: "configure",
        source: live[0],
        hostName,
        members,
        memberCount: registeredSourceMembers(live[0], devices).length,
      };
    }
  }
  return { kind: "configured", hostName };
}

/**
 * The state line under a tile's name. The verb leads, so a long host name
 * clipped at the end of the line never hides what picking the tile does.
 */
export function tileStateLabel(state) {
  switch (state.kind) {
    case "add":
      return "add";
    case "accounts":
      if (state.singleInstance) {
        return `${state.count} configured · set up on another device`;
      }
      return state.paused
        ? `${state.count} configured · ${state.paused} paused`
        : `${state.count} configured`;
    case "paused":
      return `resume · paused on ${state.hostName}`;
    case "join":
      return `join · configured on ${state.hostName}`;
    case "exclusive":
      return `move… · exclusive, lives on ${state.hostName}`;
    case "enable":
      return `enable ${state.desiredMode} mode`;
    case "configure":
      return `configured on ${state.memberCount} device${state.memberCount === 1 ? "" : "s"}`;
    default:
      return `configured on ${state.hostName}`;
  }
}

/** The collectors the normal discovery flow may target for this picker state. */
export function devicesForAddState(descriptor, state) {
  if (state?.kind === "accounts" && Array.isArray(state.devices)) return state.devices;
  return Array.isArray(descriptor?.devices) ? descriptor.devices : [];
}

/**
 * Split the account ids an add resolved into the ones the gateway already
 * lists as a source of this type (returned as their rows) and the ones the
 * add would create.
 */
export function splitConfiguredAccounts(descriptorId, accountIds, registeredSources) {
  const fresh = [];
  const configured = [];
  for (const accountId of accountIds) {
    const row = (registeredSources ?? []).find((s) => s.id === `${descriptorId}:${accountId}`);
    if (row) configured.push(row);
    else fresh.push(accountId);
  }
  return { fresh, configured };
}

/** Ask the selected collector to resolve a local source's account identity. */
export async function localAccountId(descriptor, deviceId, params, resolveAccount = resolveSourceAccount) {
  if (!descriptor.hasResolveAccountId) return "local";
  const result = await resolveAccount({ deviceId, descriptorId: descriptor.id, params });
  if (!result?.accountId) throw new Error("The collector did not resolve an account ID.");
  return result.accountId;
}

/**
 * The collectors a source could move to: paired, available now, not the
 * current host, and able to host the type. A missing `online` field remains
 * eligible for compatibility with older gateways. A source a phone or the
 * browser extension pushes stays with its device, and a phone never hosts a
 * collector's source, so only collectors are offered.
 */
export function moveTargets(source, devices) {
  if (source.pushBased) return [];
  return (devices ?? []).filter((d) => {
    if (d.kind !== "collector" || d.online === false || d.revokedAt || d.id === source.deviceId) {
      return false;
    }
    const hostable = d.capabilities?.hostableSourceTypes;
    return !Array.isArray(hostable) || hostable.includes(source.type);
  });
}

/**
 * What an account the gateway already lists means for the device an add is
 * targeting — the CLI's `describeAccountChoice` (commands/add-choice.ts) in
 * the browser's terms:
 *
 *   - `member`: the device already hosts it (`paused` when the row is paused).
 *   - `exclusive`: another device hosts it and the type allows one host.
 *   - `join`: another device hosts it and the type admits this one too.
 */
export function describeAccountChoice(source, deviceId, devices) {
  if (isMemberOf(source, deviceId)) return { kind: "member", paused: source.enabled === false };
  const hostName = deviceName(devices, source.deviceId);
  if (source.enabled === false) return { kind: "paused", hostName };
  if ((source.multiDeviceMode ?? "exclusive") === "exclusive") {
    return { kind: "exclusive", hostName };
  }
  return { kind: "join", hostName, mode: source.multiDeviceMode };
}

/**
 * Why an account was left as it is, and what the operator can do about it.
 * Each refusal names the source it belongs to, so a selection that was only
 * partly carried out reads as a list rather than as one blanket failure.
 */
export function accountRefusal(choice, deviceLabel) {
  if (choice.kind === "member") {
    return choice.paused
      ? `Already configured on ${deviceLabel}, but paused — resume it from the Sources page.`
      : `Already configured on ${deviceLabel}. Change its device settings through an explicit update.`;
  }
  if (choice.kind === "paused") {
    return `Paused on ${choice.hostName} — resume it from the Sources page before adding it to ${deviceLabel}.`;
  }
  return `Hosted by ${choice.hostName}, and its type allows one host at a time. Move it from the Sources page to put it on ${deviceLabel}.`;
}

/**
 * AddSourceModal — pass `onClose` to dismiss, `onAdded(sourceIds)` for every
 * outcome that changed gateway state (an add, a join, a move, a resume), with
 * the ids it touched.
 *
 * `onAdded` refreshes the parent; it does not close the modal. The modal ends
 * on its own `done` step, which is the only place the operator is told what a
 * join or a move means for the device that gained the source — closing on the
 * same commit would render that report unreachable.
 */
export function AddSourceModal({ onClose, onAdded }) {
  const [step, setStep] = useState("picker"); // picker | devicePick | join | configure | enable | exclusive | paused | params | discover | auth | adding | done | notice | error
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [deviceId, setDeviceIdState] = useState(null);
  const deviceIdRef = useRef(null);
  const setDeviceId = (id) => { deviceIdRef.current = id; setDeviceIdState(id); };
  // Display name of the selected collector, surfaced in the OAuth host hint.
  const [collectorName, setCollectorName] = useState(null);
  const [descriptors, setDescriptors] = useState([]);
  /**
   * Multi-collector aware: when more than one collector advertises the
   * picked descriptor, hold the candidates here so the devicePick step
   * can offer them. Empty when the picked descriptor is hosted by a
   * single device.
   */
  const [pendingDevices, setPendingDevices] = useState([]);
  const [snapshot, setSnapshot] = useState({ configured: {} });

  // Gateway-side registered sources — fetched once at init (no device
  // dependency). Used for picker badges so the user sees which sources
  // are already configured before selecting a device.
  const [registeredSources, setRegisteredSources] = useState([]);
  // Every paired device — names the host of a configured source, and lists
  // the candidates a join or a move may pick from.
  const [devices, setDevices] = useState([]);
  /**
   * A configured source the picker is acting on instead of adding: the join
   * step's candidates, or the exclusive step's host and move targets.
   */
  const [tileState, setTileState] = useState(null);
  const [memberAction, setMemberAction] = useState(null);
  /** The collector a move is about to go to, while its confirmation is open. */
  const [moveTarget, setMoveTarget] = useState(null);
  /**
   * Set while a membership request (join / move / resume) is out. The button
   * that started it is gone from the DOM by the time the request returns, but
   * a second click landing in the same tick would otherwise send it twice.
   */
  const inFlightRef = useRef(false);

  // Selected descriptor + collected state
  const [descriptor, setDescriptor] = useState(null);
  const [params, setParams] = useState({});
  const [paramErrors, setParamErrors] = useState({});
  const [discoveredAccounts, setDiscoveredAccounts] = useState(null); // array or null
  const [selectedAccounts, setSelectedAccounts] = useState([]);
  const [filter, setFilter] = useState("");
  const [finalResult, setFinalResult] = useState(null); // { sourceIds }
  const [flowError, setFlowError] = useState(null);
  /** Neutral end-state message (e.g. nothing left to add) — not a failure. */
  const [flowNotice, setFlowNotice] = useState(null);

  /**
   * Pending credentials wizard — set when a required-credentials provider
   * (Google, Strava) has no creds configured. Holds the entry passed to
   * <CredentialsWizard /> plus the descriptor + params we'll resume with
   * once the wizard closes successfully.
   */
  const [credsWizard, setCredsWizard] = useState(null);

  // Ref-tracked context so the auth-flow callbacks see the latest descriptor
  // + params without us having to recreate the hook on every state change.
  const flowContextRef = useRef({ descriptor: null, params: {} });

  // Snapshot ref — keeps the latest per-device snapshot accessible in async
  // callbacks without waiting for React state to settle. Updated alongside
  // the `snapshot` state setter in `applyDeviceSelection`.
  const snapshotRef = useRef({ configured: {} });

  const { authState, start: startAuthRun, cancel: cancelAuthRun, reset: resetAuthState } =
    useAuthFlow({
      deviceId,
      onAccount: (accountId) => {
        const ctx = flowContextRef.current;
        if (!ctx.descriptor) return;
        // `advanceToAdd` re-sets selectedAccounts internally, so no separate
        // setter call is needed here. Defer so React state settles before we
        // advance the step.
        setTimeout(() => advanceToAdd(ctx.descriptor, [accountId], ctx.params), 0);
      },
      onError: () => {
        // AuthStep already renders the error from authState.
      },
      onMissingCredentials: ({ fileKey }) => {
        // Async fetch creds entry, then open the wizard.
        (async () => {
          try {
            const status = await getCredentialsStatus(deviceIdRef.current);
            const entry = (status.items || []).find((e) => e.fileKey === fileKey);
            const ctx = flowContextRef.current;
            if (entry && ctx.descriptor) {
              setCredsWizard({
                entry,
                descriptor: ctx.descriptor,
                collectedParams: ctx.params,
                perAccount: !!ctx.descriptor.credentials?.perAccount,
              });
            }
          } catch {
            /* fall through — show generic error state */
          }
        })();
      },
    });

  useEffect(() => {
    (async () => {
      try {
        // Pull the union of descriptors across every online collector
        // and the gateway's registered sources in parallel. Descriptors
        // carry `devices: [{id, name}]` so the picker knows when a
        // source needs a device-selection step. Registered sources are
        // gateway-side (no device dependency) and power the picker badges
        // that show how many accounts are already configured.
        const [union, adminSrc, deviceList] = await Promise.all([
          getSourceDescriptorsUnion(),
          getAdminSources().catch(() => ({ items: [] })),
          listDevices().catch(() => ({ items: [] })),
        ]);
        setDescriptors(union.items || []);
        setRegisteredSources(adminSrc.items || []);
        setDevices(deviceList.items || []);
        setLoading(false);
      } catch (e) {
        setLoadError(String(e.message || e));
        setLoading(false);
      }
    })();
  }, []);

  /**
   * Once a device is resolved (auto-picked when one collector advertises
   * the descriptor; selected by the user in the devicePick step otherwise),
   * fetch the per-device snapshot so the rest of the flow has accurate
   * "currently configured" state, then advance to the params step (or
   * skip it when the descriptor has none).
   *
   * On snapshot fetch failure the modal falls back to the device picker
   * so the user can pick a different collector — without this, a single
   * transient failure would strand them on the error screen.
   */
  async function applyDeviceSelection(d, picked) {
    try {
      const snap = await getSourcesSnapshot(picked.id);
      setDeviceId(picked.id);
      setCollectorName(picked.name || null);
      const resolved = { configured: snap.configured || {} };
      snapshotRef.current = resolved;
      setSnapshot(resolved);
    } catch (e) {
      setFlowError(`Couldn't load sources from ${picked.name}: ${errorText(e)}`);
      setStep(pendingDevices.length > 1 ? "devicePick" : "picker");
      return;
    }
    if (d.params && d.params.length > 0) {
      setStep("params");
    } else {
      advanceFromParams(d, {});
    }
  }

  // Escape key closes the modal.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") handleClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function handleClose() {
    // If mid-auth, cancel the flow on the gateway side.
    cancelAuthRun();
    onClose?.();
  }

  // Annotate the descriptor list with what the gateway already lists of it,
  // on any device (`describeTileState`). Gateway-side data rather than the
  // per-device snapshot, which only exists once a descriptor + device is
  // selected.
  //
  // A single-instance source nothing can be done about stays in the grid,
  // marked `configured` and rendered inert. Keeping it keeps the catalogue
  // stable and shows the source is set up; making it inert keeps the user out
  // of a flow whose only possible outcome is "nothing left to add".
  const visibleDescriptors = useMemo(() => {
    return descriptors
      .map((d) => {
        const state = describeTileState(d, registeredSources, devices);
        return { d, state, configured: state.kind === "configured" };
      })
      // Push-based sources (e.g. the browser extension) aren't user-added —
      // they self-register when their paired device first pushes — so hide
      // them from the picker. Their descriptor still flows through the feed so
      // the sources list / doc view / iOS can render their icon.
      .filter(({ d }) => !d.pushBased)
      .filter(({ d }) => {
        if (!filter.trim()) return true;
        const q = filter.toLowerCase();
        return (
          d.name.toLowerCase().includes(q) ||
          d.id.toLowerCase().includes(q) ||
          (d.description || "").toLowerCase().includes(q) ||
          d.provider.name.toLowerCase().includes(q)
        );
      });
  }, [descriptors, registeredSources, devices, filter]);

  // Group by provider for the picker
  const byProvider = useMemo(() => {
    const map = new Map();
    for (const v of visibleDescriptors) {
      const list = map.get(v.d.provider.id) ?? { name: v.d.provider.name, items: [] };
      list.items.push(v);
      map.set(v.d.provider.id, list);
    }
    return map;
  }, [visibleDescriptors]);

  // --- Picker step ---
  function selectDescriptor(d, state) {
    setDescriptor(d);
    setParams({});
    setParamErrors({});
    setDiscoveredAccounts(null);
    setSelectedAccounts([]);
    resetAuthState();
    setFlowError(null);
    setFlowNotice(null);
    setPendingDevices([]);
    setTileState(state ?? null);
    setMoveTarget(null);
    setMemberAction(null);

    // A source another device already hosts is joined or moved, not added.
    if (state?.kind === "join") {
      setStep("join");
      return;
    }
    if (state?.kind === "exclusive") {
      setStep("exclusive");
      return;
    }
    if (state?.kind === "enable") {
      setStep("enable");
      return;
    }
    if (state?.kind === "configure") {
      setStep("configure");
      return;
    }
    if (state?.kind === "paused") {
      setStep("paused");
      return;
    }
    startAddOn(d, devicesForAddState(d, state));
  }

  /**
   * Multi-collector dispatch: when only one device advertises the
   * descriptor we silently pick it; when several do, the user picks via
   * the devicePick step. The union endpoint always populates `devices`
   * (empty when no collector hosts it, which shouldn't reach the picker
   * because the row is filtered out).
   */
  function startAddOn(d, devs) {
    if (devs.length === 0) {
      setLoadError(`No online collector hosts "${d.id}".`);
      setStep("error");
      return;
    }
    if (devs.length === 1) {
      applyDeviceSelection(d, devs[0]);
      return;
    }
    setPendingDevices(devs);
    setStep("devicePick");
  }

  function pickDeviceAndContinue(picked) {
    if (!descriptor) return;
    applyDeviceSelection(descriptor, picked);
  }

  // --- Member config: atomic join, or an addressed edit for an existing member ---
  async function applyMemberAction(action, collectedParams) {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setStep("adding");
    try {
      const memberConfig = memberConfigForDescriptor(descriptor, collectedParams);
      if (action.kind === "join") {
        const { members } = await joinSourceMember(
          action.source.id,
          action.device.id,
          memberConfig,
        );
        setFinalResult({
          sourceIds: [],
          joined: [
            { source: action.source, device: action.device, members: (members ?? []).length },
          ],
        });
      } else {
        await updateSourceMemberConfig(action.source.id, action.device.id, memberConfig ?? {});
        setFinalResult({
          sourceIds: [],
          updated: [memberUpdateOutcome(action.source, action.device)],
        });
      }
      setStep("done");
      onAdded?.([action.source.id]);
    } catch (e) {
      setFlowError(errorText(e));
      setStep("error");
    } finally {
      inFlightRef.current = false;
    }
  }

  function beginMemberAction(kind, source, device) {
    const action = { kind, source, device };
    setDeviceId(device.id);
    setCollectorName(device.name || null);
    setMemberAction(action);
    setParams({});
    setParamErrors({});
    if (memberParams(descriptor).length > 0) setStep("params");
    else void applyMemberAction(action, {});
  }

  function joinFrom(source, device) {
    beginMemberAction("join", source, device);
  }

  async function enableDesiredMode(source, desiredMode, continuation) {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setStep("adding");
    try {
      await enableSourceMultiDeviceMode(source.id, desiredMode);
      if (continuation?.device) {
        const transitioned = { ...source, multiDeviceMode: desiredMode };
        let members;
        try {
          ({ members } = await joinSourceMember(
            source.id,
            continuation.device.id,
            continuation.memberConfig,
          ));
        } catch (e) {
          setFinalResult({
            sourceIds: [],
            joined: [],
            updated: [],
            refused: [
              {
                sourceId: source.id,
                reason: `${desiredMode} mode was enabled, but ${continuation.device.name} could not join: ${errorText(e)}`,
              },
            ],
          });
          onAdded?.([source.id]);
          setStep("done");
          return;
        }
        setFinalResult({
          sourceIds: [],
          joined: [
            {
              source: transitioned,
              device: continuation.device,
              members: (members ?? []).length,
            },
          ],
          updated: [],
          refused: [],
        });
        onAdded?.([source.id]);
        setStep("done");
        return;
      }
      const refreshed = await getAdminSources();
      const items = refreshed.items || [];
      setRegisteredSources(items);
      const next = describeTileState(descriptor, items, devices);
      setTileState(next);
      if (["join", "configure"].includes(next.kind)) setStep(next.kind);
      else {
        setFlowNotice(`${source.id} now uses ${desiredMode} mode.`);
        setStep("notice");
      }
      onAdded?.([source.id]);
    } catch (e) {
      setFlowError(errorText(e));
      setStep("error");
    } finally {
      inFlightRef.current = false;
    }
  }

  // --- Exclusive step: a one-host source, moved to a chosen collector ---
  async function moveTo(source, device) {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setMoveTarget(null);
    setStep("adding");
    try {
      await moveSourceToDevice(source.id, device.id);
      setFinalResult({
        sourceIds: [],
        moved: { source, device, fromName: deviceName(devices, source.deviceId) },
      });
      setStep("done");
      onAdded?.([source.id]);
    } catch (e) {
      setFlowError(errorText(e));
      setStep("error");
    } finally {
      inFlightRef.current = false;
    }
  }

  // --- Paused step: a configured source that is paused, resumed in place ---
  async function resumePaused(source) {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setStep("adding");
    try {
      await resumeSource(source.id);
      setFinalResult({
        sourceIds: [],
        resumed: { source, hostName: deviceName(devices, source.deviceId) },
      });
      setStep("done");
      onAdded?.([source.id]);
    } catch (e) {
      setFlowError(errorText(e));
      setStep("error");
    } finally {
      inFlightRef.current = false;
    }
  }

  // --- Params step ---
  async function validateAndContinue() {
    if (!descriptor) return;
    const errors = {};
    const paramsToValidate = memberAction ? memberParams(descriptor) : descriptor.params || [];
    // Required check first
    for (const p of paramsToValidate) {
      const v = (params[p.name] || "").trim();
      if (p.required && !v) errors[p.name] = `${p.label} is required`;
    }
    // Server-side validation for non-empty values
    if (Object.keys(errors).length === 0) {
      for (const p of paramsToValidate) {
        const v = params[p.name];
        if (!shouldValidateParam(p, v)) continue;
        try {
          const r = await validateSourceParam({
            deviceId,
            descriptorId: descriptor.id,
            paramName: p.name,
            value: v,
          });
          if (!r.valid) errors[p.name] = r.error || "Invalid value";
        } catch (e) {
          errors[p.name] = errorText(e);
        }
      }
    }
    setParamErrors(errors);
    if (Object.keys(errors).length > 0) return;
    if (memberAction) {
      await applyMemberAction(memberAction, params);
      return;
    }
    advanceFromParams(descriptor, params);
  }

  // After params (or if no params), decide the next step: discover / auth / add
  function advanceFromParams(d, collectedParams) {
    // Auth-required sources: run discover first if available, else jump to auth.
    if (d.hasAuthFlow) {
      if (d.hasDiscover) {
        runDiscover(d);
      } else {
        startAuth(d, collectedParams);
      }
      return;
    }
    // Local sources
    if (d.authType === "local") {
      if (d.hasDiscover) {
        runDiscover(d);
      } else {
        setStep("adding");
        void localAccountId(d, deviceIdRef.current, collectedParams)
          .then((accountId) => advanceToAdd(d, [accountId], collectedParams))
          .catch((e) => {
            setFlowError(errorText(e));
            setStep("error");
          });
      }
      return;
    }
    setSelectedAccounts(["local"]);
    advanceToAdd(d, ["local"], collectedParams);
  }

  // --- Discover step ---
  async function runDiscover(d) {
    setStep("discover");
    setDiscoveredAccounts(null);
    try {
      const result = await discoverSourceAccounts(d.id, deviceIdRef.current);
      const accounts = result.accounts || [];
      // Read from ref — React state may not have settled yet when
      // runDiscover is called synchronously after setSnapshot.
      const configured = snapshotRef.current.configured || {};
      const alreadyAdded = new Set(
        accounts.filter((a) => configured[`${d.id}:${a}`]?.enabled),
      );
      const newAccounts = accounts.filter((a) => !alreadyAdded.has(a));
      setDiscoveredAccounts({ all: accounts, alreadyAdded: [...alreadyAdded], newAccounts });
      if (d.hasAuthFlow && newAccounts.length === 0) {
        // No pre-discovered account — fall through to auth flow.
        startAuth(d, params);
      } else if (!d.hasAuthFlow && newAccounts.length === 0) {
        // Local source with nothing to pick. "Nothing left to add" is a
        // normal outcome, not a failure — only a source that isn't present on
        // the host at all is an error the user can act on.
        if (accounts.length === 0) {
          setFlowError(
            `${d.name} not found on this system. Make sure Full Disk Access is granted if this is an Apple source.`,
          );
          setStep("error");
        } else {
          setFlowNotice(
            accounts.length === 1
              ? `${d.name} (${accounts[0]}) is already configured.`
              : `All ${accounts.length} ${d.name} accounts are already configured.`,
          );
          setStep("notice");
        }
      } else if (newAccounts.length === 1) {
        setSelectedAccounts(newAccounts);
      } else {
        // Default-select all new accounts
        setSelectedAccounts(newAccounts);
      }
    } catch (e) {
      // Discover failed; if the source has an auth flow, fall through to it.
      if (d.hasAuthFlow) {
        startAuth(d, params);
      } else {
        setFlowError(String(e.message || e));
        setStep("error");
      }
    }
  }

  function confirmDiscoveredAccounts() {
    if (!descriptor) return;
    if (selectedAccounts.length === 0) return;
    advanceToAdd(descriptor, selectedAccounts, params);
  }

  /**
   * Pre-flight credentials check before starting an auth flow. Two shapes:
   *
   *   - A provider-wide credential (an OAuth client id/secret) is collected
   *     once and saved, so the wizard only opens when none is configured.
   *   - A `perAccount` credential IS the account being added, so the wizard
   *     opens every time and its fields are handed to the auth flow rather
   *     than saved. Skipping it because one is already on disk is what made a
   *     second account impossible.
   *
   * Same shape as the CLI's pre-auth pass in commands/add.ts.
   */
  async function maybeRunCredsWizard(d, collectedParams) {
    const spec = d.credentials;
    if (!spec) return false;
    try {
      const status = await getCredentialsStatus(deviceIdRef.current);
      const entry = (status.items || []).find((e) => e.fileKey === spec.fileKey);
      if (!shouldOpenCredentialsWizard(spec, entry, false)) return false;
      setCredsWizard({ entry, descriptor: d, collectedParams, perAccount: !!spec.perAccount });
      return true;
    } catch {
      // If the credentials lookup fails, fall through to the auth flow —
      // the auth subprocess will surface the missing-creds error and the
      // SSE handler below routes us back to the wizard.
      return false;
    }
  }

  // --- Auth step (OAuth / QR / device code) ---
  // `credentialFields` present means the wizard just collected them, so the
  // pre-flight is skipped. Without that guard an always-collect gate would
  // reopen the wizard on every resume and never terminate.
  async function startAuth(d, collectedParams, credentialFields) {
    if (!credentialFields && (await maybeRunCredsWizard(d, collectedParams))) return;
    flowContextRef.current = { descriptor: d, params: collectedParams || {} };
    setStep("auth");
    await startAuthRun({
      sourceType: d.id,
      params: collectedParams,
      deviceId: deviceIdRef.current,
      credentials: credentialFields,
    });
  }

  async function cancelAuth() {
    await cancelAuthRun();
    setStep("picker");
  }

  // --- Add ---
  function advanceToAdd(d, accounts, collectedParams) {
    setSelectedAccounts(accounts);
    registerSource(d, accounts, collectedParams);
  }

  /**
   * Register the resolved accounts on the chosen device. Every account the
   * gateway does not list yet is added; each one it does is joined from the
   * device when its type admits a second host.
   *
   * A selection is carried out as far as it goes: an account that cannot be
   * settled — its type allows one host, the device already has it, the
   * gateway refused the join — is collected and reported next to the ones
   * that landed, rather than abandoning the rest of the selection (and any
   * join already committed) at the first refusal.
   */
  async function registerSource(d, accounts, collectedParams) {
    setStep("adding");
    const device = { id: deviceId, name: deviceName(devices, deviceId) };
    const { fresh, configured } = splitConfiguredAccounts(d.id, accounts, registeredSources);
    const joined = [];
    const refused = [];
    for (const source of configured) {
      const choice = describeAccountChoice(source, deviceId, devices);
      const memberConfig = memberConfigForDescriptor(d, collectedParams);
      const desiredMode = d.multiDeviceMode ?? "exclusive";
      if (
        choice.kind === "exclusive" &&
        d.singleInstance === true &&
        desiredMode !== "exclusive" &&
        fresh.length === 0 &&
        configured.length === 1
      ) {
        setTileState({
          kind: "enable",
          source,
          hostName: choice.hostName,
          desiredMode,
          continuation: { device, memberConfig },
        });
        setStep("enable");
        return;
      }
      if (choice.kind !== "join") {
        refused.push({ sourceId: source.id, reason: accountRefusal(choice, device.name) });
        continue;
      }
      try {
        const { members } = await joinSourceMember(source.id, deviceId, memberConfig);
        joined.push({ source, device, members: (members ?? []).length });
      } catch (e) {
        refused.push({ sourceId: source.id, reason: errorText(e) });
      }
    }
    let sourceIds = [];
    if (fresh.length > 0) {
      try {
        const result = await addSource({
          deviceId,
          descriptorId: d.id,
          accountIds: fresh,
          params:
            collectedParams && Object.keys(collectedParams).length ? collectedParams : undefined,
        });
        sourceIds = result.sourceIds || [];
      } catch (e) {
        const reason = errorText(e);
        for (const accountId of fresh) refused.push({ sourceId: `${d.id}:${accountId}`, reason });
      }
    }
    // Refresh unconditionally: a partly-carried-out selection leaves the
    // Sources page stale in exactly the case a caller is tempted to skip.
    onAdded?.([
      ...sourceIds,
      ...joined.map((j) => j.source.id),
    ]);
    if (sourceIds.length === 0 && joined.length === 0 && refused.length === 0) {
      setFlowNotice(`${d.name} is already configured on ${device.name}.`);
      setStep("notice");
      return;
    }
    setFinalResult({ sourceIds, joined, refused });
    setStep("done");
  }

  // --- Render ---
  // One entry per value of `step`. A lookup keeps each branch readable as the
  // list grows, and makes an unhandled step obvious rather than silently
  // falling through to null.
  const stepViews = {
    picker: () => html`<${Picker}
      byProvider=${byProvider}
      filter=${filter}
      onFilter=${setFilter}
      registeredSources=${registeredSources}
      onPick=${selectDescriptor}
      hasDescriptors=${descriptors.length > 0}
    />`,
    devicePick: () => html`<${DevicePickStep}
      descriptor=${descriptor}
      devices=${pendingDevices}
      onPick=${pickDeviceAndContinue}
      onBack=${() => setStep("picker")}
    />`,
    join: () => html`<${JoinStep}
      descriptor=${descriptor}
      state=${tileState}
      onJoin=${(device) => joinFrom(tileState.source, device)}
      onConfigure=${(device) => beginMemberAction("edit", tileState.source, device)}
      onBack=${() => setStep("picker")}
    />`,
    configure: () => html`<${MemberConfigureStep}
      descriptor=${descriptor}
      state=${tileState}
      onConfigure=${(device) => beginMemberAction("edit", tileState.source, device)}
      onBack=${() => setStep("picker")}
    />`,
    enable: () => html`<${EnableModeStep}
      descriptor=${descriptor}
      state=${tileState}
      onEnable=${() =>
        enableDesiredMode(tileState.source, tileState.desiredMode, tileState.continuation)}
      onBack=${() => setStep("picker")}
    />`,
    exclusive: () => html`<${ExclusiveStep}
      descriptor=${descriptor}
      state=${tileState}
      targets=${moveTargets(tileState.source, devices)}
      onMove=${(device) => setMoveTarget(device)}
      onBack=${() => setStep("picker")}
    />`,
    paused: () => html`<${PausedStep}
      descriptor=${descriptor}
      state=${tileState}
      onResume=${() => resumePaused(tileState.source)}
      onBack=${() => setStep("picker")}
    />`,
    params: () => html`<${ParamsForm}
      descriptor=${
        memberAction ? { ...descriptor, params: memberParams(descriptor) } : descriptor
      }
      params=${params}
      errors=${paramErrors}
      onChange=${setParams}
      onBack=${() => setStep(memberAction ? tileState?.kind ?? "picker" : "picker")}
      onContinue=${validateAndContinue}
    />`,
    discover: () => html`<${DiscoverStep}
      descriptor=${descriptor}
      discovered=${discoveredAccounts}
      selected=${selectedAccounts}
      onToggle=${(a, on) => setSelectedAccounts((sel) => (on ? [...sel, a] : sel.filter((x) => x !== a)))}
      onBack=${() => setStep(descriptor?.params?.length ? "params" : "picker")}
      onContinue=${confirmDiscoveredAccounts}
      onAddAnother=${descriptor?.hasAuthFlow ? () => startAuth(descriptor, params) : null}
    />`,
    auth: () => html`<${AuthStep}
      descriptor=${descriptor}
      state=${authState}
      collectorName=${collectorName}
      onCancel=${cancelAuth}
    />`,
    adding: () => html`<div class="add-source-loading">Registering source…</div>`,
    done: () => html`<${DoneStep}
      descriptor=${descriptor}
      result=${finalResult}
      onClose=${handleClose}
    />`,
    notice: () => html`<${NoticeStep}
      message=${flowNotice}
      onBack=${() => setStep("picker")}
      onClose=${handleClose}
    />`,
    error: () => html`<${ErrorStep}
      message=${flowError}
      onBack=${() => setStep("picker")}
      onClose=${handleClose}
    />`,
  };
  const renderStep = () => (stepViews[step] ?? stepViews.error)();

  return html`
    <div class="add-source-backdrop" onClick=${handleClose}>
      <div class="add-source-modal" onClick=${(e) => e.stopPropagation()}>
        <div class="add-source-header">
          <div>
            <h3>Add a source</h3>
            ${descriptor && html`<div class="add-source-breadcrumb">
              ${descriptor.provider.name} · ${descriptor.name}
              ${descriptor.experimental && html`<span class="add-source-experimental">Experimental</span>`}
            </div>`}
          </div>
          <button class="btn-tiny" onClick=${handleClose}>close</button>
        </div>

        <div class="add-source-body">
          ${loading
            ? html`<div class="add-source-loading">Loading descriptors…</div>`
            : loadError
              ? html`<div class="sources-banner-v2 error">${loadError}</div>`
              : renderStep()}
        </div>
      </div>
      ${moveTarget && tileState?.source && html`<${ConfirmModal}
        open
        title=${`Move ${tileState.source.id} to ${moveTarget.name}?`}
        body=${moveSentence(tileState.source, tileState.hostName, moveTarget.name)}
        confirmLabel="Move"
        onConfirm=${() => moveTo(tileState.source, moveTarget)}
        onCancel=${() => setMoveTarget(null)}
      />`}
      ${credsWizard && html`<${CredentialsWizard}
        entry=${credsWizard.entry}
        deviceId=${deviceId}
        collectOnly=${credsWizard.perAccount}
        onClose=${(updated, fields) => {
          const pending = credsWizard;
          setCredsWizard(null);
          if (updated && pending) {
            // Resume the auth flow. For a per-account credential the fields
            // ride along rather than having been saved, and passing them also
            // stops the pre-flight reopening the wizard.
            startAuth(pending.descriptor, pending.collectedParams, fields);
          }
        }}
      />`}
    </div>
  `;
}

// ---- Sub-components ----

// A copyable command block: the text in a <pre>, with the shared copy-icon
// button in the corner. Only the block layout is local here; the button
// (clipboard call + copied state + icons) is the shared `CopyIconButton`.
function CopyBlock({ text }) {
  return html`
    <div class="copy-block">
      <pre class="copy-block-code">${text}</pre>
      <${CopyIconButton} text=${text} class="copy-block-btn" />
    </div>
  `;
}

function NoCollectorHint() {
  const gwUrl = window.location.origin;
  const cmd = `export OMNESIS_GATEWAY_URL=${gwUrl}\n# Find your token in ~/.config/omnesis/token on the gateway host\nexport OMNESIS_TOKEN=YOUR_TOKEN\nnpm run collector`;

  return html`
    <div class="add-source-empty no-collector-hint">
      <strong>No collector connected</strong>
      <p>Sources are advertised by a running collector. Start one and it will pair with this gateway automatically.</p>
      <div class="no-collector-section">
        <span class="no-collector-label">Run from the Omnesis project directory</span>
        <${CopyBlock} text=${cmd} />
      </div>
    </div>
  `;
}

function SourceTile({ item, onPick }) {
  const { d, state, configured } = item;
  const title = configured
    ? `${d.name} is already set up on ${state.hostName} — it supports one account.`
    : state.kind === "join"
      ? `${d.name} is configured on ${state.hostName}; another device can join it.`
      : state.kind === "configure"
        ? `${d.name} has separate settings on each collector; pick it to edit one.`
      : state.kind === "exclusive"
        ? `${d.name} lives on ${state.hostName}; its type allows one host at a time.`
        : state.kind === "paused"
          ? `${d.name} is configured on ${state.hostName} and paused; picking it resumes it.`
          : d.description;
  return html`
    <button
      class=${`add-source-tile is-${state.kind}`}
      key=${d.id}
      aria-disabled=${configured ? "true" : undefined}
      onClick=${() => { if (!configured) onPick(d, state); }}
      title=${title}
    >
      <span class="add-source-tile-icon">${descriptorIcon(d)}</span>
      <span class="add-source-tile-name">${d.name}</span>
      <span class="add-source-tile-state">${tileStateLabel(state)}</span>
      ${configured && html`<span class="add-source-tile-check" aria-label="already configured">✓</span>`}
    </button>
  `;
}

function Picker({ byProvider, filter, onFilter, registeredSources, onPick, hasDescriptors }) {
  const configuredCount = (registeredSources || []).filter((s) => s.enabled !== false).length;
  // Flat sorted list — every source fits in one compact grid so the
  // whole catalog is visible without scrolling / category hunt.
  const flat = [];
  for (const [, group] of byProvider.entries()) {
    for (const item of group.items) flat.push(item);
  }
  flat.sort((a, b) => a.d.name.localeCompare(b.d.name));

  // Experimental sources are pulled into their own section below the stable
  // catalogue, so the "Experimental" flag lives in a section heading rather
  // than a per-card badge. The section only renders when at least one
  // experimental source is present (which already implies the gateway is in
  // experimental mode, since the collector hides them otherwise).
  const stable = flat.filter(({ d }) => !d.experimental);
  const experimental = flat.filter(({ d }) => d.experimental);

  const noCollector = !hasDescriptors;

  return html`
    <div class="add-source-picker">
      ${noCollector
        ? html`<${NoCollectorHint} />`
        : html`
      <input
        class="add-source-filter"
        type="text"
        placeholder="Filter sources…"
        value=${filter}
        onInput=${(e) => onFilter(e.target.value)}
        autofocus
      />
      ${flat.length === 0
        ? html`<div class="add-source-empty">No sources match "${filter}".</div>`
        : html`
          ${stable.length > 0 && html`
            <div class="add-source-grid">
              ${stable.map((item) => html`<${SourceTile} key=${item.d.id} item=${item} onPick=${onPick} />`)}
            </div>
          `}
          ${experimental.length > 0 && html`
            <div class="add-source-section-heading">Experimental</div>
            <div class="add-source-grid">
              ${experimental.map((item) => html`<${SourceTile} key=${item.d.id} item=${item} onPick=${onPick} />`)}
            </div>
          `}
        `}
      ${configuredCount > 0 && html`
        <div class="add-source-footer-hint">${configuredCount} source${configuredCount === 1 ? "" : "s"} already configured.</div>
      `}
      `}
    </div>
  `;
}

/**
 * Multi-collector device picker — shown after the user selects a source
 * that's advertised by more than one online collector. Auto-skipped when
 * exactly one collector hosts the source.
 */
function DevicePickStep({ descriptor, devices, onPick, onBack }) {
  return html`
    <div class="add-source-form">
      <p class="add-source-step-hint">
        Multiple collectors host <strong>${descriptor.name}</strong>. Pick one:
      </p>
      <${DeviceList} devices=${devices.map((d) => ({ ...d, kind: "collector" }))} onPick=${onPick} />
      <div class="add-source-actions">
        <button class="btn-tiny" onClick=${onBack}>back</button>
      </div>
    </div>
  `;
}

/**
 * A short list of devices to pick one from — the member picker's rows, with
 * an optional selection. `hint` is drawn on the right of a row.
 */
function DeviceList({ devices, selectedId, onPick }) {
  return html`
    <div class="member-picker-list" role="radiogroup">
      ${devices.map((d) => html`
        <button
          type="button"
          role="radio"
          aria-checked=${d.id === selectedId}
          class=${`member-picker-item${d.id === selectedId ? " selected" : ""}`}
          key=${d.id}
          onClick=${() => onPick(d)}
        >
          <${KindIcon} kind=${d.kind} size=${14} class="member-picker-item-icon" />
          <span class="member-picker-item-name">${d.name}</span>
          ${d.hint && html`<span class="member-picker-item-hint">${d.hint}</span>`}
        </button>
      `)}
    </div>
  `;
}

/**
 * Join a configured source from a device of the operator's choosing. The
 * mode's sentence names the chosen device, so the operator reads what the
 * join means for it before confirming.
 */
function JoinStep({ descriptor, state, onJoin, onConfigure, onBack }) {
  const [picked, setPicked] = useState(state.candidates.length === 1 ? state.candidates[0] : null);
  const mode = state.source.multiDeviceMode;
  return html`
    <div class="add-source-form">
      <p class="add-source-step-hint">
        <strong>${descriptor.name}</strong> (<code>${state.source.id}</code>) is configured on${" "}
        <strong>${state.hostName}</strong>, ${mode}. Pick the device to join from:
      </p>
      <${DeviceList}
        devices=${state.candidates.map((c) => ({ ...c, hint: c.online ? null : "offline" }))}
        selectedId=${picked?.id}
        onPick=${setPicked}
      />
      ${picked && html`<p class="add-source-step-hint">${joinModeSentence(mode, picked.name)}</p>`}
      ${(state.members ?? []).length > 0 && html`
        <p class="add-source-step-hint">Or update an existing member's device settings:</p>
        <div class="add-source-actions">
          ${state.members.map((member) => html`
            <button class="btn-tiny" key=${member.id} onClick=${() => onConfigure(member)}>
              Configure ${member.name}
            </button>
          `)}
        </div>
      `}
      <div class="add-source-actions">
        <button class="btn-tiny" onClick=${onBack}>back</button>
        <button class="btn-primary" disabled=${!picked} onClick=${() => picked && onJoin(picked)}>
          Join from ${picked ? picked.name : "…"}
        </button>
      </div>
    </div>
  `;
}

/** Pick an existing member whose host-local parameters should be replaced. */
function MemberConfigureStep({ descriptor, state, onConfigure, onBack }) {
  const [picked, setPicked] = useState(state.members.length === 1 ? state.members[0] : null);
  return html`
    <div class="add-source-form">
      <p class="add-source-step-hint">
        <strong>${descriptor.name}</strong> keeps these settings separately on each collector. Pick
        the collector to configure:
      </p>
      <${DeviceList}
        devices=${state.members}
        selectedId=${picked?.id}
        onPick=${setPicked}
      />
      <div class="add-source-actions">
        <button class="btn-tiny" onClick=${onBack}>back</button>
        <button
          class="btn-primary"
          disabled=${!picked}
          onClick=${() => picked && onConfigure(picked)}
        >Configure ${picked ? picked.name : "…"}</button>
      </div>
    </div>
  `;
}

/** Explicitly adopt a descriptor's multi-device mode for already stored data. */
function EnableModeStep({ descriptor, state, onEnable, onBack }) {
  return html`
    <div class="add-source-form">
      <p class="add-source-step-hint">
        <strong>${descriptor.name}</strong> was stored before ${state.desiredMode} mode was
        enabled. Omnesis will adopt its existing history before another collector can join.
      </p>
      <div class="add-source-actions">
        <button class="btn-tiny" onClick=${onBack}>back</button>
        <button class="btn-primary" onClick=${onEnable}>
          Enable ${state.desiredMode} mode
        </button>
      </div>
    </div>
  `;
}

/**
 * The refusal for a source whose type allows one host, with the way out: a
 * move to another collector, confirmed separately since the current host
 * stops syncing it. The step is only reached when there is a collector to
 * move to — a single-instance source has one account id, so "add it on
 * another collector instead" would resolve to this very source again.
 */
function ExclusiveStep({ descriptor, state, targets, onMove, onBack }) {
  const [picked, setPicked] = useState(targets.length === 1 ? targets[0] : null);
  return html`
    <div class="add-source-form">
      <div class="sources-banner-v2 info">
        <strong>${descriptor.name}</strong> (<code>${state.source.id}</code>) lives on${" "}
        <strong>${state.hostName}</strong>, and its type allows one host at a time.
      </div>
      ${targets.length > 0
        ? html`
          <p class="add-source-step-hint">Move it to another collector — ${state.hostName} stops syncing it:</p>
          <${DeviceList}
            devices=${targets.map((t) => ({ id: t.id, name: t.name, kind: "collector", hint: t.online === false ? "offline" : null }))}
            selectedId=${picked?.id}
            onPick=${setPicked}
          />
        `
        : html`<p class="add-source-step-hint">No other collector is paired, so there is nowhere to move it.</p>`}
      <div class="add-source-actions">
        <button class="btn-tiny" onClick=${onBack}>back</button>
        ${targets.length > 0 && html`
          <button class="btn-primary" disabled=${!picked} onClick=${() => picked && onMove(picked)}>
            Move to ${picked ? picked.name : "…"}…
          </button>
        `}
      </div>
    </div>
  `;
}

/**
 * A configured source that is paused. Adding it again would collide with the
 * row that already exists, so the way out is to resume that row — named with
 * the host it lives on, since that is where syncing starts again.
 */
function PausedStep({ descriptor, state, onResume, onBack }) {
  const [busy, setBusy] = useState(false);
  return html`
    <div class="add-source-form">
      <div class="sources-banner-v2 info">
        <strong>${descriptor.name}</strong> (<code>${state.source.id}</code>) is configured on${" "}
        <strong>${state.hostName}</strong>, and paused.
      </div>
      <p class="add-source-step-hint">
        Resume it and ${state.hostName} starts syncing it again on the next cycle.
      </p>
      <div class="add-source-actions">
        <button class="btn-tiny" onClick=${onBack}>back</button>
        <button
          class="btn-primary"
          disabled=${busy}
          onClick=${() => { setBusy(true); onResume(); }}
        >Resume</button>
      </div>
    </div>
  `;
}

/**
 * The line under an input.
 *
 * A source's own help text when it has one, because only the source can say
 * what its setting means or what leaving it blank will do. Failing that, a
 * path gets a generic note: this form is the one place an operator learns that
 * a home-relative path is accepted at all.
 */
export function paramHint(p) {
  if (p.help) return p.help;
  if (p.type === "path") return "An absolute path, or one starting with ~ for your home directory.";
  return null;
}

export function ParamsForm({ descriptor, params, errors, onChange, onBack, onContinue }) {
  return html`
    <div class="add-source-form">
      <p class="add-source-step-hint">${descriptor.description}</p>
      ${descriptor.params.map((p) => html`
        <div class="form-group" key=${p.name}>
          <label>${p.label}${p.required ? html`<span class="add-source-req"> *</span>` : null}</label>
          ${p.type === "select" && p.options
            ? html`<select
                value=${params[p.name] || ""}
                onChange=${(e) => onChange({ ...params, [p.name]: e.target.value })}
              >
                <option value="">—</option>
                ${p.options.map((o) => html`<option value=${o.value} key=${o.value}>${o.label}</option>`)}
              </select>`
            : html`<input
                type=${p.type === "secret" ? "password" : "text"}
                placeholder=${p.placeholder || ""}
                value=${params[p.name] || ""}
                onInput=${(e) => onChange({ ...params, [p.name]: e.target.value })}
              />`}
          ${paramHint(p) && html`<span class="form-hint">${paramHint(p)}</span>`}
          ${errors[p.name] && html`<span class="add-source-field-error">${errors[p.name]}</span>`}
        </div>
      `)}
      <div class="add-source-actions">
        <button class="btn-tiny" onClick=${onBack}>back</button>
        <button class="btn-primary" onClick=${onContinue}>Continue</button>
      </div>
    </div>
  `;
}

function DiscoverStep({ descriptor, discovered, selected, onToggle, onBack, onContinue, onAddAnother }) {
  if (!discovered) {
    return html`<div class="add-source-loading">Discovering ${descriptor.name} accounts…</div>`;
  }
  const { newAccounts, alreadyAdded } = discovered;
  return html`
    <div class="add-source-form">
      <p class="add-source-step-hint">
        ${newAccounts.length === 0
          ? `No new ${descriptor.name} accounts found.`
          : newAccounts.length === 1
            ? `Found 1 account.`
            : `Found ${newAccounts.length} accounts. Pick the ones to add.`}
      </p>
      ${alreadyAdded.length > 0 && html`
        <div class="add-source-alreadyadded">
          Already configured: ${alreadyAdded.join(", ")}
        </div>
      `}
      <div class="add-source-account-list">
        ${newAccounts.map((a) => html`
          <label class="add-source-account" key=${a}>
            <input
              type="checkbox"
              checked=${selected.includes(a)}
              onChange=${(e) => onToggle(a, e.target.checked)}
            />
            <span>${a}</span>
          </label>
        `)}
      </div>
      ${onAddAnother && html`
        <button class="add-source-add-another" onClick=${onAddAnother}>
          + Connect a different ${descriptor.name} account
        </button>
      `}
      <div class="add-source-actions">
        <button class="btn-tiny" onClick=${onBack}>back</button>
        <button class="btn-primary" onClick=${onContinue} disabled=${selected.length === 0}>Continue</button>
      </div>
    </div>
  `;
}

/**
 * What the modal carried out, and what it could not. A selection is settled
 * account by account, so an add, a join and a refusal can all belong to the
 * same outcome — each is stated rather than the first one standing for all.
 */
function DoneStep({ descriptor, result, onClose }) {
  const added = result?.sourceIds || [];
  const joined = result?.joined || [];
  const moved = result?.moved || null;
  const resumed = result?.resumed || null;
  const updated = result?.updated || [];
  const refused = result?.refused || [];
  return html`
    <div class="add-source-form">
      ${added.length > 0 && html`
        <div class="sources-banner-v2 info add-source-done">
          <strong>${descriptor.name} added.</strong>
          ${" "}Sync will run on the next cycle.
        </div>
        <ul class="add-source-result-list">
          ${added.map((id) => html`<li key=${id}><code>${id}</code></li>`)}
        </ul>
      `}
      ${joined.map(({ source, device, members }) => html`
        <div class="sources-banner-v2 info add-source-done" key=${source.id}>
          <strong>${device.name} joined <code>${source.id}</code></strong>
          ${members > 0 ? ` (${members} members). ` : ". "}
          ${joinModeSentence(source.multiDeviceMode, device.name)}
          ${!source.pushBased && ` If it needs a sign-in, reauth it from the Sources page.`}
        </div>
      `)}
      ${updated.map((entry) => html`
        <div class="sources-banner-v2 info add-source-done" key=${entry.source.id}>
          <strong>Updated <code>${entry.source.id}</code> on ${entry.device.name}.</strong>
          ${" "}Its next sync uses that collector's local settings.
        </div>
      `)}
      ${moved && html`
        <div class="sources-banner-v2 info add-source-done">
          <strong>Moved <code>${moved.source.id}</code> to ${moved.device.name}.</strong>
          ${" "}${moved.fromName} stops syncing it. Credentials do not travel with a move — if it needs a sign-in, sign ${moved.device.name} in from the Sources page.
        </div>
      `}
      ${resumed && html`
        <div class="sources-banner-v2 info add-source-done">
          <strong>Resumed <code>${resumed.source.id}</code>.</strong>
          ${" "}${resumed.hostName} syncs it again on the next cycle.
        </div>
      `}
      ${refused.map(({ sourceId, reason }) => html`
        <div class="sources-banner-v2 error add-source-done" key=${sourceId}>
          <strong>Left <code>${sourceId}</code> alone.</strong> ${" "}${reason}
        </div>
      `)}
      <div class="add-source-actions">
        <button class="btn-primary" onClick=${onClose}>Done</button>
      </div>
    </div>
  `;
}

function NoticeStep({ message, onBack, onClose }) {
  return html`
    <div class="add-source-form">
      <div class="sources-banner-v2 info">${message}</div>
      <div class="add-source-actions">
        <button class="btn-tiny" onClick=${onBack}>back</button>
        <button class="btn-primary" onClick=${onClose}>Done</button>
      </div>
    </div>
  `;
}

function ErrorStep({ message, onBack, onClose }) {
  return html`
    <div class="add-source-form">
      <div class="sources-banner-v2 error">${message || "Something went wrong."}</div>
      <div class="add-source-actions">
        <button class="btn-tiny" onClick=${onBack}>back</button>
        <button class="btn-tiny" onClick=${onClose}>close</button>
      </div>
    </div>
  `;
}

// ---- helpers ----

export function shouldValidateParam(param, value) {
  return !!value || !!param?.validateWhenEmpty;
}
