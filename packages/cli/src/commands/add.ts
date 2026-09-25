// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import {
  c,
  fetchDescriptors,
  fetchSourcesSnapshot,
  gatewayJson,
  pathInput,
  buildCliFx,
  iconFor,
  withSpinner,
  CliError,
  EXIT_CANCELLED,
  EXIT_USER_ERROR,
  EXIT_FAILURE,
} from "../utils.js";
import { runAuthFlowDetailed } from "../auth-flow.js";
import {
  fetchCredentialsStatus,
  isSameHostAsCollector,
  collectCredentialFields,
  runCredentialsWizard,
} from "../credentials-wizard.js";
import {
  fetchUnionDescriptors,
  isInteractive,
  pickDeviceForDescriptor,
  resolveDeviceFlag,
  type UnionDescriptor,
} from "../device-picker.js";
import {
  describeAccountChoice,
  describeAddChoice,
  joinModeSentence,
  renderAddChoice,
  type AccountChoice,
} from "./add-choice.js";
import {
  exclusiveRefusal,
  notCandidateRefusal,
  renderJoined,
  requestJoin,
  requestModeTransition,
} from "./join.js";
import {
  deviceLabel,
  loadSourcesAndDevices,
  sourceMode,
  type AdminDeviceEntry,
  type AdminSourceEntry,
  type TargetDevice,
} from "./members.js";
import type { ConfiguredSourcesSnapshot, SerializedDescriptor } from "../utils.js";
import type { MultiDeviceMode } from "@omnesis/types";

interface AddContext {
  deviceId: string;
  descriptors: SerializedDescriptor[];
  snapshot: ConfiguredSourcesSnapshot;
  /** Every source the gateway lists, on any device — what an add may already be. */
  sources: AdminSourceEntry[];
  /** Every paired device — names the hosts of those sources. */
  devices: AdminDeviceEntry[];
  /** Hostname reported by the collector — for same-host browser auto-open. */
  collectorHostname?: string;
}

/**
 * A dim "(experimental)" suffix for picker labels, or "" when the descriptor
 * isn't experimental. A descriptor only reaches the picker as experimental
 * when the operator opted in via OMNESIS_EXPERIMENTAL, so we surface it so the
 * user knows the source isn't battle-tested. Generic on the descriptor flag —
 * no per-source knowledge.
 */
export function experimentalLabelSuffix(experimental: unknown): string {
  return experimental === true ? ` ${c.dim}(experimental)${c.reset}` : "";
}

export function extraPositionalArg(
  sourceArg: unknown,
  positionals: readonly string[],
): string | undefined {
  return positionals[positionals[0] === sourceArg ? 1 : 0];
}

/**
 * Normalize a path only when the CLI and addressed collector share a host.
 * Remote collectors own their filesystem namespace, including `~` and
 * relative-path expansion; their descriptor validator is the authority.
 */
export function pathValueForCollector(
  value: string,
  collectorHostname: string | undefined,
  deps: Pick<AddFlowDeps, "resolve" | "join">,
): string {
  if (!isSameHostAsCollector(collectorHostname)) return value.trim();
  if (value === "~" || value.startsWith("~/")) {
    return deps.join(process.env.HOME ?? "", value.slice(1));
  }
  return deps.resolve(value);
}

export const addCommand = defineCommand({
  meta: {
    name: "add",
    description: "Add a data source (interactive)",
  },
  args: {
    source: {
      type: "positional",
      description: "source type (e.g. gmail, obsidian-notes); skips the picker",
      required: false,
    },
    device: {
      type: "string",
      description:
        "Target collector device (name or id) — required when multiple collectors host the source",
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "Join a source another device hosts without asking",
    },
  },
  async run(ctx) {
    const sourceArg = ctx.args.source;
    // Extra positional (e.g. `omnesis sources add obsidian-notes /path/to/vault`).
    const extraPositional = extraPositionalArg(sourceArg, ctx.args._ as string[]);
    const deviceFlag = typeof ctx.args.device === "string" ? ctx.args.device : undefined;
    const { resolve, join } = await import("node:path");
    const prompts = await import("@clack/prompts");
    const { parseSourceKey } = await import("@omnesis/core");
    const deps: AddFlowDeps = {
      prompts,
      resolve,
      join,
      parseSourceKey,
      joinConfirmation: joinConfirmationFor(ctx.args.yes === true, isInteractive()),
    };

    // Resolve the target collector device. When --device is supplied we
    // honor it directly; otherwise we fetch the union of descriptors
    // (across all online collectors) and pick a device per-descriptor
    // after the user selects a source.
    const explicitDevice = deviceFlag ? await resolveDeviceFlag(deviceFlag) : null;

    // Descriptor fetch shape depends on whether the user pinned a device:
    // - --device set: scope to that device (the per-device endpoint
    //   carries `collectorHostname`, used by the same-host browser
    //   auto-open path inside the auth flow).
    // - otherwise: pull the union of every online collector's descriptors,
    //   each annotated with the devices that advertise it.
    const [descSnapshot, sourcesSnapshot, unionDescriptors] = await withSpinner(
      "Loading available sources",
      async (spin) => {
        if (explicitDevice) {
          const descSnap = await fetchDescriptors(explicitDevice.id);
          spin.message("Loading configured sources");
          const srcSnap = await fetchSourcesSnapshot(descSnap.deviceId);
          return [descSnap, srcSnap, null] as const;
        }
        const union = await fetchUnionDescriptors();
        // Synthesize a single-device snapshot from the union for the
        // existing flow's expectations (descriptors + sources from one
        // device). The actual deviceId is decided per-source below.
        return [null, null, union] as const;
      },
    );
    // What the gateway already lists, on every device: the collector's own
    // snapshot only knows what it hosts, not what another host does.
    const listing = await loadListingForAdd();

    // If --device set, we have a single-collector view and can dive
    // straight into the existing flow.
    if (descSnapshot && sourcesSnapshot && explicitDevice) {
      const addCtx: AddContext = {
        deviceId: descSnapshot.deviceId,
        descriptors: descSnapshot.items,
        snapshot: sourcesSnapshot,
        ...listing,
        collectorHostname: descSnapshot.collectorHostname,
      };
      await runAddFlow(addCtx, sourceArg, extraPositional, deps);
      return;
    }

    // Multi-collector path: union descriptors → user picks source → we
    // resolve the device for that source → fetch per-device snapshot.
    if (!unionDescriptors) throw new CliError("internal: missing descriptors", EXIT_FAILURE);
    await runMultiCollectorAddFlow(unionDescriptors, listing, sourceArg, extraPositional, deps);
  },
});

export interface AddFlowDeps {
  prompts: typeof import("@clack/prompts");
  resolve: typeof import("node:path").resolve;
  join: typeof import("node:path").join;
  parseSourceKey: typeof import("@omnesis/core").parseSourceKey;
  /** How a join onto a source another device hosts is authorised. */
  joinConfirmation: JoinConfirmation;
}

/**
 * What authorises joining the target device to a source another device hosts.
 * A terminal is asked; `--yes` answers for it; a run with neither has nobody
 * to ask, and making a machine a member of another one's source unasked is
 * exactly what a provisioning script must not do by accident.
 */
export type JoinConfirmation = "ask" | "assume-yes" | "no-terminal";

export function joinConfirmationFor(yes: boolean, interactive: boolean): JoinConfirmation {
  if (yes) return "assume-yes";
  return interactive ? "ask" : "no-terminal";
}

/**
 * The refusal for a join nothing authorised. Names the flag that does, the
 * way every other non-interactive decision point in the CLI does.
 */
export function unconfirmedJoinRefusal(sourceId: string, deviceName: string): string {
  return (
    `${deviceName} was not joined to ${sourceId}: joining a source another device hosts needs a confirmation, and this run has no terminal to ask for one.\n` +
    `Re-run with --yes to authorise the join.`
  );
}

/** The gateway's source and device listings, as `loadSourcesAndDevices` returns them. */
export interface SourceListing {
  sources: AdminSourceEntry[];
  devices: AdminDeviceEntry[];
}

/**
 * The listings the add flow uses to recognize a source another device already
 * hosts. They are an improvement on the add, not a precondition for it: a
 * gateway that will not answer either one must not fail an add that would
 * have worked without them, so the flow carries on knowing nothing about the
 * other hosts — and the gateway still refuses a duplicate itself. What is
 * lost is said out loud, since a join silently becoming an add is the kind of
 * surprise this whole path exists to avoid.
 */
export async function loadListingForAdd(): Promise<SourceListing> {
  try {
    return await loadSourcesAndDevices();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `${c.yellow}Could not read the gateway's source and device listings: ${reason}${c.reset}\n` +
        `${c.dim}Continuing — a source another device already hosts will be offered as an add rather than a join.${c.reset}`,
    );
    return { sources: [], devices: [] };
  }
}

/**
 * Run the autocomplete multiselect that both add flows use to pick which
 * sources to set up. Extracted so the per-flow code only owns the choice-
 * building logic (provider grouping + already-configured annotations for
 * the single-device path; per-source device counts for the multi-collector
 * path).
 */
async function pickSourcesInteractively(
  choices: { value: string; label: string; hint?: string }[],
  prompts: typeof import("@clack/prompts"),
): Promise<string[]> {
  const selected = await prompts.autocompleteMultiselect({
    message: "Which sources would you like to add?",
    options: choices,
    required: true,
    placeholder: "type to filter...",
    filter: (search, option) => {
      const needle = search.toLowerCase();
      return (
        (option.label ?? "").toLowerCase().includes(needle) ||
        (option.hint ?? "").toLowerCase().includes(needle)
      );
    },
  });
  if (prompts.isCancel(selected)) {
    prompts.cancel("Cancelled.");
    throw new CliError("", EXIT_CANCELLED);
  }
  return selected as string[];
}

/**
 * Multi-collector add path: union descriptors → user picks a source (or
 * uses the positional arg) → device resolved from the descriptor's
 * `devices` list (auto-pick when only one host, picker otherwise) →
 * delegates to `runAddFlow` once a device is locked in.
 */
export async function runMultiCollectorAddFlow(
  union: UnionDescriptor[],
  listing: SourceListing,
  sourceArg: string | undefined,
  extraPositional: string | undefined,
  deps: AddFlowDeps,
): Promise<void> {
  // If the user named a source, find it in the union. The positional accepts
  // either a sourceType (descriptor id, e.g. `gmail`) or a providerType
  // (e.g. `google`) — same precedence as the single-device flow's
  // `descriptorsByProvider` lookup. Provider matches with multiple sources
  // get a follow-up picker.
  if (sourceArg) {
    let desc = union.find((d) => d.id === sourceArg);
    if (!desc) {
      const providerMatches = union.filter((d) => {
        const provider = d.provider as { id?: string } | undefined;
        return provider?.id === sourceArg;
      });
      if (providerMatches.length === 1) {
        desc = providerMatches[0];
      } else if (providerMatches.length > 1) {
        const selected = await deps.prompts.select({
          message: `Which ${sourceArg} source would you like to add?`,
          options: providerMatches.map((d) => ({
            value: d.id,
            label: `${typeof d.name === "string" ? d.name : d.id}${experimentalLabelSuffix(d.experimental)}`,
            hint: typeof d.description === "string" ? d.description : "",
          })),
        });
        if (deps.prompts.isCancel(selected)) {
          deps.prompts.cancel("Cancelled.");
          throw new CliError("", EXIT_CANCELLED);
        }
        desc = union.find((d) => d.id === selected);
      }
    }
    if (!desc) {
      const known = union.map((d) => d.id).join(", ");
      const providers = Array.from(
        new Set(
          union.flatMap((d) => {
            const p = d.provider as { id?: string } | undefined;
            return p?.id ? [p.id] : [];
          }),
        ),
      ).join(", ");
      throw new CliError(
        `${c.red}Unknown source: ${sourceArg}${c.reset}\nSources: ${known}\nProviders: ${providers}`,
        EXIT_USER_ERROR,
      );
    }
    const device = await pickDeviceForDescriptor(desc);
    const [perDevice, snapshot] = await withSpinner("Loading source details", async () => {
      const d = await fetchDescriptors(device.id);
      const s = await fetchSourcesSnapshot(d.deviceId);
      return [d, s] as const;
    });
    const addCtx: AddContext = {
      deviceId: perDevice.deviceId,
      descriptors: perDevice.items,
      snapshot,
      ...listing,
      collectorHostname: perDevice.collectorHostname,
    };
    await runAddFlow(addCtx, desc.id, extraPositional, deps);
    return;
  }

  // Interactive picker: source first (deduped via the union), then per
  // selected source resolve a device. A descriptor one collector advertises
  // is described for that collector; one several advertise is described for
  // no device in particular, and the device pick settles the rest.
  const choices: { value: string; label: string; hint?: string }[] = [];
  for (const d of union) {
    const name = typeof d.name === "string" ? d.name : d.id;
    const description = typeof d.description === "string" ? d.description : "";
    const onN = d.devices.length > 1 ? ` ${c.dim}(on ${d.devices.length} devices)${c.reset}` : "";
    const exp = experimentalLabelSuffix(d.experimental);
    const singleInstance = d.singleInstance === true;
    const onlyDevice = d.devices.length === 1 ? d.devices[0]!.id : null;
    const choice = describeAddChoice(
      { id: d.id, singleInstance },
      listing.sources,
      onlyDevice,
      listing.devices,
    );
    if (choice.kind === "member") continue;
    const { suffix, hint } = renderAddChoice(choice, {
      description,
      another: d.hasAuthFlow === true ? "add another account" : "add another",
    });
    choices.push({ value: d.id, label: `${name}${exp}${onN}${suffix}`, hint });
  }
  if (union.length === 0) {
    console.log(`${c.green}No collectors are online.${c.reset}`);
    return;
  }
  if (choices.length === 0) {
    console.log(`${c.green}All available sources are already configured!${c.reset}`);
    return;
  }
  const selectedIds = await pickSourcesInteractively(choices, deps.prompts);
  for (let i = 0; i < selectedIds.length; i++) {
    const id = selectedIds[i];
    const desc = union.find((d) => d.id === id);
    if (!desc) continue;
    if (selectedIds.length > 1) {
      const label = typeof desc.name === "string" ? desc.name : desc.id;
      console.log(`\n${c.bold}[${i + 1}/${selectedIds.length}] Setting up ${label}...${c.reset}`);
    }
    const device = await pickDeviceForDescriptor(desc);
    const [perDevice, snapshot] = await withSpinner("Loading source details", async () => {
      const d = await fetchDescriptors(device.id);
      const s = await fetchSourcesSnapshot(d.deviceId);
      return [d, s] as const;
    });
    const addCtx: AddContext = {
      deviceId: perDevice.deviceId,
      descriptors: perDevice.items,
      snapshot,
      ...listing,
      collectorHostname: perDevice.collectorHostname,
    };
    await runAddFlow(addCtx, id, undefined, deps);
  }
}

/**
 * Single-device add flow: optional source multiselect, per-source parameter
 * prompts, auth flow (or local-only / push-based shortcut), then the POST to
 * /admin/sources/add. Both the `--device` and
 * multi-collector entry points funnel here once a device is resolved.
 */
async function runAddFlow(
  addCtx: AddContext,
  sourceArg: string | undefined,
  extraPositional: string | undefined,
  deps: AddFlowDeps,
): Promise<void> {
  const { prompts, resolve, join, parseSourceKey } = deps;

  const findDescriptor = (id: string): SerializedDescriptor | undefined =>
    addCtx.descriptors.find((d) => d.id === id);
  const descriptorsByProvider = (): Map<string, SerializedDescriptor[]> => {
    const map = new Map<string, SerializedDescriptor[]>();
    for (const d of addCtx.descriptors) {
      const existing = map.get(d.provider.id) ?? [];
      existing.push(d);
      map.set(d.provider.id, existing);
    }
    return map;
  };

  // No argument — show interactive multi-select source picker
  if (!sourceArg) {
    prompts.intro(`${c.bold}Add data sources${c.reset}`);

    // Show currently configured sources
    const configured = addCtx.snapshot.configured;
    const configuredKeys = Object.keys(configured).filter((k) => configured[k].enabled);

    const fx = await buildCliFx();

    if (configuredKeys.length > 0) {
      console.log(`\n  ${c.dim}Currently configured:${c.reset}`);
      for (const key of configuredKeys) {
        const { sourceType, accountId } = parseSourceKey(key);
        const desc = addCtx.descriptors.find((d) => d.id === sourceType);
        const name = desc?.name ?? sourceType;
        const acct = String(accountId) !== "local" ? ` (${accountId})` : "";
        const icon = iconFor(sourceType, fx);
        const iconPrefix = icon ? `${icon} ` : "";
        console.log(`    ${c.green}✓${c.reset} ${iconPrefix}${c.dim}${name}${acct}${c.reset}`);
      }
      console.log();
    }

    // Build multiselect choices — group by provider.
    //
    // Deliberately NOT prefixing icons here. Tried it; @clack/prompts
    // re-renders option labels on every keystroke (for the filter
    // input) and doesn't handle embedded OSC 1337 escape bytes —
    // outside tmux the base64 image payload leaks onto the screen as
    // plain text across multiple rows. Icons still show in the
    // "Currently configured" list above (plain console.log, safe).
    const byProvider = descriptorsByProvider();
    const choices: { value: string; label: string; hint?: string }[] = [];

    for (const [, descs] of byProvider) {
      for (const d of descs) {
        const choice = describeAddChoice(d, addCtx.sources, addCtx.deviceId, addCtx.devices);
        // A single-instance source this device already hosts leaves nothing
        // to add or join.
        if (choice.kind === "member") continue;
        const { suffix, hint } = renderAddChoice(choice, {
          description: d.description,
          another: d.hasAuthFlow ? "add another account" : "add another",
        });
        const label = `${d.name}${experimentalLabelSuffix(d.experimental)}${suffix}`;
        choices.push({ value: d.id, label, hint });
      }
    }

    if (choices.length === 0) {
      console.log(`${c.green}All available sources are already configured!${c.reset}`);
      return;
    }

    const selectedIds = await pickSourcesInteractively(choices, prompts);
    for (let i = 0; i < selectedIds.length; i++) {
      const desc = findDescriptor(selectedIds[i]);
      if (selectedIds.length > 1) {
        console.log(
          `\n${c.bold}[${i + 1}/${selectedIds.length}] Setting up ${desc?.name ?? selectedIds[i]}...${c.reset}`,
        );
      }
      await addSingleSource(selectedIds[i], addCtx, {
        prompts,
        resolve,
        join,
        findDescriptor,
        descriptorsByProvider,
        extraPositional: undefined,
        joinConfirmation: deps.joinConfirmation,
      });
    }

    return;
  }

  // Direct argument: add single source
  await addSingleSource(sourceArg, addCtx, {
    prompts,
    resolve,
    join,
    findDescriptor,
    descriptorsByProvider,
    extraPositional,
    joinConfirmation: deps.joinConfirmation,
  });
}

interface AddDeps {
  prompts: typeof import("@clack/prompts");
  resolve: typeof import("node:path").resolve;
  join: typeof import("node:path").join;
  findDescriptor: (id: string) => SerializedDescriptor | undefined;
  descriptorsByProvider: () => Map<string, SerializedDescriptor[]>;
  /** CLI-supplied extra positional (e.g. vault path); only honored for single-param sources. */
  extraPositional: string | undefined;
  /** See `AddFlowDeps.joinConfirmation`. */
  joinConfirmation: JoinConfirmation;
}

/**
 * The device an add targets, as the gateway lists it. A device the listing
 * lacks is named by its id and nothing more: its kind and its presence are
 * unknown, and the refusals that read them say less rather than something
 * untrue.
 */
function targetDevice(ctx: AddContext): TargetDevice {
  return ctx.devices.find((d) => d.id === ctx.deviceId) ?? { id: ctx.deviceId, name: ctx.deviceId };
}

/**
 * Join the target device to a source another device hosts: say what the
 * source's mode makes of a second member, ask, then send the join and print
 * the outcome the way `sources join` does. `--yes` answers the question; a
 * run with no terminal to ask has nothing authorising the join and refuses
 * it. A "no" leaves the source alone without being a refusal.
 */
async function joinFromDevice(
  source: AdminSourceEntry,
  ctx: AddContext,
  deps: Pick<AddDeps, "prompts" | "joinConfirmation">,
  memberConfig?: Record<string, unknown>,
): Promise<SettleOutcome> {
  const device = targetDevice(ctx);
  const hostName = deviceLabel(ctx.devices, source.deviceId);
  console.log(
    `\n${c.bold}${source.id}${c.reset} is configured on ${hostName} ${c.dim}(${sourceMode(source)})${c.reset}.`,
  );
  console.log(`${c.dim}${joinModeSentence(sourceMode(source))}${c.reset}`);
  if (deps.joinConfirmation === "no-terminal") {
    return refusal(source.id, unconfirmedJoinRefusal(source.id, device.name));
  }
  if (deps.joinConfirmation === "ask") {
    const answer = await deps.prompts.confirm({ message: "Join from this device?" });
    if (deps.prompts.isCancel(answer)) {
      deps.prompts.cancel("Cancelled.");
      throw new CliError("", EXIT_CANCELLED);
    }
    if (!answer) {
      console.log(`${c.dim}Left as is.${c.reset}`);
      return { kind: "declined", sourceId: source.id };
    }
  }
  let members: string[];
  try {
    members = await withSpinner(`Joining ${device.name} to ${source.id}`, () =>
      requestJoin(source, device, ctx.devices, memberConfig),
    );
  } catch (err) {
    // A refusal the gateway made is this account's outcome, and the rest of
    // the add carries on. Anything else — an unreachable gateway, a server
    // fault — is not a decision about this account and ends the run.
    if (err instanceof CliError && err.exitCode === EXIT_USER_ERROR) {
      return { kind: "refused", sourceId: source.id, reason: err.message };
    }
    throw err;
  }
  for (const line of renderJoined(source, device, members.length)) console.log(line);
  return { kind: "joined", source, members: members.length };
}

/** How one account the gateway already lists was settled. */
type SettleOutcome =
  | { kind: "member"; sourceId: string }
  | { kind: "joined"; source: AdminSourceEntry; members: number }
  | { kind: "declined"; sourceId: string }
  | { kind: "refused"; sourceId: string; reason: string };

/** A refusal outcome, with its sentence rendered the way it will be printed. */
function refusal(sourceId: string, reason: string): SettleOutcome {
  return { kind: "refused", sourceId, reason: `${c.red}${reason}${c.reset}` };
}

/**
 * What settling the already-listed accounts of an add came to. A refusal is
 * collected here rather than thrown, so the accounts after it — and every
 * account the gateway does not list yet — still get their turn; the exit code
 * is then decided once, from the run as a whole.
 */
interface SettleReport {
  joined: AdminSourceEntry[];
  refused: { sourceId: string; reason: string }[];
  /** Accounts the target device already hosts. */
  members: string[];
  /** Joins the operator turned down. */
  declined: string[];
}

function emptySettleReport(): SettleReport {
  return { joined: [], refused: [], members: [], declined: [] };
}

/** Whether anything at all happened to the accounts the gateway already listed. */
function settledAnything(report: SettleReport): boolean {
  return report.joined.length + report.refused.length + report.declined.length > 0;
}

/**
 * Settle an account the gateway already lists as a source: nothing to do
 * when the target device hosts it, a join when its type admits the device,
 * a refusal — before any auth flow — when the type allows one host or the
 * device is not among the candidates.
 */
async function settleConfiguredAccount(
  source: AdminSourceEntry,
  ctx: AddContext,
  deps: Pick<AddDeps, "prompts" | "joinConfirmation">,
  memberConfig?: Record<string, unknown>,
  desiredMode?: MultiDeviceMode,
): Promise<SettleOutcome> {
  const device = targetDevice(ctx);
  let effectiveSource = source;
  if (
    sourceMode(source) === "exclusive" &&
    desiredMode !== undefined &&
    desiredMode !== "exclusive"
  ) {
    if (deps.joinConfirmation === "no-terminal") {
      return refusal(
        source.id,
        `Enabling ${desiredMode} mode for ${source.id} requires confirmation. Re-run with --yes.`,
      );
    }
    if (deps.joinConfirmation === "ask") {
      const answer = await deps.prompts.confirm({
        message: `Enable ${desiredMode} mode for ${source.id}?`,
      });
      if (deps.prompts.isCancel(answer)) {
        deps.prompts.cancel("Cancelled.");
        throw new CliError("", EXIT_CANCELLED);
      }
      if (!answer) return { kind: "declined", sourceId: source.id };
    }
    try {
      const transitioned = await requestModeTransition(source.id, desiredMode);
      // The ordinary source PATCH response does not carry the admin listing's
      // computed candidates. Absence delegates the subsequent join decision
      // to the gateway, which remains authoritative.
      effectiveSource = {
        ...source,
        ...transitioned,
        multiDeviceMode: desiredMode,
        joinCandidates: undefined,
      };
      console.log(`${c.green}Enabled ${desiredMode} mode for ${source.id}.${c.reset}`);
    } catch (err) {
      if (err instanceof CliError && err.exitCode === EXIT_USER_ERROR) {
        return { kind: "refused", sourceId: source.id, reason: err.message };
      }
      throw err;
    }
  }
  const choice: AccountChoice = describeAccountChoice(effectiveSource, ctx.deviceId, ctx.devices);
  if (choice.kind !== "member" && effectiveSource.enabled === false) {
    return refusal(
      source.id,
      `${source.id} is paused on ${deviceLabel(ctx.devices, source.deviceId)}; resume it before adding it to ${device.name}.`,
    );
  }
  switch (choice.kind) {
    case "member":
      if (memberConfig) {
        return refusal(
          source.id,
          `${source.id} is already configured on ${device.name}. Change its member settings explicitly with PATCH /admin/sources/<source-id>/members/<device-id>.`,
        );
      }
      if (!source.enabled) {
        // Adding it again is not the way back: the row is here and hosted,
        // only its sync is stopped — which is what a phone opting out of a
        // source it alone hosts leaves behind. Name the command that undoes
        // exactly that, or the operator is told nothing changed and why.
        console.log(
          `${c.yellow}${source.id} is already configured on ${device.name}, but its sync is paused.${c.reset}`,
        );
        console.log(`${c.dim}To start it again: omnesis sources resume ${source.id}${c.reset}`);
        return { kind: "member", sourceId: source.id };
      }
      console.log(`${c.yellow}${source.id} is already configured on ${device.name}.${c.reset}`);
      return { kind: "member", sourceId: source.id };
    case "exclusive":
      return refusal(source.id, exclusiveRefusal(source.id, choice.hostName, device));
    case "join":
      if (!choice.candidate) {
        const names = (source.joinCandidates ?? []).map((id) => deviceLabel(ctx.devices, id));
        return refusal(source.id, notCandidateRefusal(source, device, names));
      }
      return joinFromDevice(effectiveSource, ctx, deps, memberConfig);
  }
}

/**
 * Settle every account the gateway already lists, one after another, into
 * `report`. Each is decided on its own terms: an account that cannot be
 * settled does not stop the ones behind it.
 */
async function settleConfiguredAccounts(
  configured: readonly AdminSourceEntry[],
  ctx: AddContext,
  deps: Pick<AddDeps, "prompts" | "joinConfirmation">,
  report: SettleReport,
  memberConfig?: Record<string, unknown>,
  desiredMode?: MultiDeviceMode,
): Promise<void> {
  for (const source of configured) {
    const outcome = await settleConfiguredAccount(source, ctx, deps, memberConfig, desiredMode);
    switch (outcome.kind) {
      case "joined":
        report.joined.push(outcome.source);
        break;
      case "refused":
        report.refused.push({ sourceId: outcome.sourceId, reason: outcome.reason });
        break;
      case "declined":
        report.declined.push(outcome.sourceId);
        break;
      case "member":
        report.members.push(outcome.sourceId);
        break;
    }
  }
}

/**
 * Project collected values onto the descriptor's host-local parameter contract.
 *
 * Keyed on `memberScopedParamNames`, the whole per-machine contract, rather
 * than on the form's parameter list — that list leaves advanced settings out,
 * and a value for one of those would otherwise be routed to the shared config
 * the host then refuses to store.
 */
export function memberConfigForDescriptor(
  descriptor: Pick<SerializedDescriptor, "params" | "memberScopedParamNames">,
  params: Readonly<Record<string, string>>,
): Record<string, unknown> | undefined {
  const memberNames = new Set(
    descriptor.memberScopedParamNames ??
      (descriptor.params ?? [])
        .filter((param) => param.scope === "member")
        .map((param) => param.name),
  );
  const local: Record<string, string> = {};
  for (const name of memberNames) {
    if (!Object.hasOwn(params, name)) continue;
    local[name] = params[name];
  }
  return Object.keys(local).length > 0 ? { params: local } : undefined;
}

/**
 * State what the add could not carry out, and let the run as a whole decide
 * the exit code. A refusal next to an add or a join is a note printed beside
 * them and the run succeeds; a run where every account was refused is the
 * failure the exit code reports, the refusals being its message.
 */
function reportSettled(report: SettleReport, added: number): void {
  if (report.refused.length === 0) return;
  const text = report.refused.map(({ reason }) => reason).join("\n\n");
  if (added === 0 && report.joined.length === 0) {
    throw new CliError(text, EXIT_USER_ERROR);
  }
  console.error(`\n${text}`);
}

/**
 * Split account ids into the ones the gateway lists as a source of this
 * type already (returned as their rows) and the ones an add would create.
 */
export function splitConfiguredAccounts(
  descriptorId: string,
  accountIds: readonly string[],
  sources: readonly AdminSourceEntry[],
): { fresh: string[]; configured: AdminSourceEntry[] } {
  const fresh: string[] = [];
  const configured: AdminSourceEntry[] = [];
  for (const accountId of accountIds) {
    const row = sources.find(
      (s) => s.type === descriptorId && s.id === `${descriptorId}:${accountId}`,
    );
    if (row) configured.push(row);
    else fresh.push(accountId);
  }
  return { fresh, configured };
}

/** Validate a source param via the gateway, returning the error message or null. */
async function validateParam(
  ctx: AddContext,
  descriptorId: string,
  paramName: string,
  value: string,
): Promise<string | null> {
  const result = await gatewayJson<{ valid: boolean; error?: string }>(
    `/admin/sources/validate-param`,
    {
      method: "POST",
      body: JSON.stringify({
        deviceId: ctx.deviceId,
        descriptorId,
        paramName,
        value,
      }),
    },
  );
  return result.valid ? null : (result.error ?? "Invalid value");
}

/** Discover existing accounts for a source type via the gateway. */
async function discoverAccounts(ctx: AddContext, descriptorId: string): Promise<string[]> {
  const result = await withSpinner(`Discovering ${descriptorId} accounts`, () =>
    gatewayJson<{ accounts: string[] }>(`/admin/sources/discover`, {
      method: "POST",
      body: JSON.stringify({ descriptorId, deviceId: ctx.deviceId }),
    }),
  );
  return result.accounts;
}

/**
 * Recover from an auth flow that reported missing credentials, and say whether
 * a retry is worth attempting.
 *
 * A `perAccount` provider gets its fields re-collected and threaded into the
 * retry. That also covers the version-skew case: the `auth.begin` payload is
 * non-strict, so a collector older than this change silently drops the
 * credentials it does not know about, and the flow would otherwise report
 * missing credentials forever. Re-collecting once and, failing that, falling
 * back to the provider-wide save gives both a new and an old collector a path
 * that terminates.
 */
async function recoverFromMissingCredentials(
  ctx: AddContext,
  missing: { fileKey: string; providerName: string },
  flowOptions: { acceptsAuthCode?: boolean; credentials?: Record<string, string> },
): Promise<boolean> {
  console.log(
    `\n${c.yellow}${missing.providerName} needs credentials before we can authenticate.${c.reset}`,
  );
  const status = await fetchCredentialsStatus(ctx.deviceId);
  const entry = status.items.find((e) => e.fileKey === missing.fileKey);
  if (!entry) {
    console.error(`${c.red}Credentials spec not found for ${missing.fileKey}.${c.reset}`);
    return false;
  }
  const sameHost = isSameHostAsCollector(status.hostname);

  if (entry.spec.perAccount) {
    // Already carrying fields the collector ignored. That means it predates the
    // per-account channel, and the only place it would accept them is the
    // provider-wide file this change exists to stop using — where a failed add
    // would then leave the key behind. Refuse and name the fix.
    if (flowOptions.credentials) {
      console.error(
        `${c.red}This collector is too old to accept per-account credentials for ` +
          `${missing.providerName}. Update the collector and try again.${c.reset}`,
      );
      return false;
    }
    const fields = await collectCredentialFields(entry, { sameHost, perAccount: true });
    if (!fields) {
      console.error(`${c.red}Aborting — credentials not provided.${c.reset}`);
      return false;
    }
    flowOptions.credentials = fields;
    return true;
  }

  const ok = await runCredentialsWizard(entry, { deviceId: ctx.deviceId, sameHost });
  if (!ok) {
    // Known bug: #2705 — declining the wizard still exits 0.
    console.error(`${c.red}Aborting — credentials not set up.${c.reset}`);
    return false;
  }
  return true;
}

async function addSingleSource(sourceArg: string, ctx: AddContext, deps: AddDeps): Promise<void> {
  const {
    prompts,
    resolve,
    join,
    findDescriptor,
    descriptorsByProvider,
    extraPositional,
    joinConfirmation,
  } = deps;
  // One report for the whole add: the accounts the gateway already lists are
  // settled wherever they turn up (discovery, a path, a sign-in), and what
  // they came to is stated once, next to what the add itself achieved.
  const settled = emptySettleReport();

  let descriptor = findDescriptor(sourceArg);
  if (!descriptor) {
    const byProvider = descriptorsByProvider();
    const providerDescs = byProvider.get(sourceArg);

    if (providerDescs && providerDescs.length === 1) {
      descriptor = providerDescs[0];
    } else if (providerDescs && providerDescs.length > 1) {
      const selected = await prompts.select({
        message: `Which ${providerDescs[0].provider.name} source would you like to add?`,
        options: providerDescs.map((d) => ({
          value: d.id,
          label: `${d.name}${experimentalLabelSuffix(d.experimental)}`,
          hint: d.description,
        })),
      });
      if (prompts.isCancel(selected)) {
        prompts.cancel("Cancelled.");
        throw new CliError("", EXIT_CANCELLED);
      }
      descriptor = findDescriptor(selected as string);
    }
  }

  if (!descriptor) {
    const names = ctx.descriptors.map((d) => d.id);
    const providerNames = [...new Set(ctx.descriptors.map((d) => d.provider.id))];
    throw new CliError(
      `${c.red}Unknown source: ${sourceArg}${c.reset}\n\n` +
        `Available sources: ${names.join(", ")}\n` +
        `Or by provider: ${providerNames.join(", ")}`,
      EXIT_USER_ERROR,
    );
  }

  // Collect params
  const params: Record<string, string> = {};
  const settle = (configured: readonly AdminSourceEntry[]): Promise<void> =>
    settleConfiguredAccounts(
      configured,
      ctx,
      { prompts, joinConfirmation },
      settled,
      memberConfigForDescriptor(descriptor!, params),
      descriptor!.multiDeviceMode,
    );
  const collectorIsLocal = isSameHostAsCollector(ctx.collectorHostname);

  // A prompt is one line, so the source's own explanation of the setting has
  // to ride along with the label. For an optional field that sentence is
  // usually the only place the operator is told what leaving it blank does.
  const promptMessage = (p: { label: string; help?: string }) =>
    p.help ? `${p.label} — ${p.help}` : p.label;

  if (descriptor.params) {
    for (const param of descriptor.params) {
      // CLI-arg form: `omnesis sources add obsidian-notes /path/to/vault`
      const cliValue = extraPositional;
      if (cliValue && descriptor.params.length === 1) {
        let value = cliValue;
        if (param.type === "path") {
          value = pathValueForCollector(value, ctx.collectorHostname, { resolve, join });
        }
        const err = await validateParam(ctx, descriptor.id, param.name, value);
        if (err) {
          console.error(`${c.red}${err}${c.reset}`);
          return;
        }
        params[param.name] = value;
        continue;
      }

      if (param.type === "path") {
        const value = await pathInput({
          message: promptMessage(param),
          placeholder: param.placeholder,
          resolvePath: collectorIsLocal,
          // An optional path is answerable by pressing Enter: the source has
          // said blank means something, and the host is about to say whether
          // what it means is true on this machine.
          allowEmpty: !param.required,
          validate: (resolved) => {
            if (param.required && !resolved) return `${param.label} is required`;
            return undefined;
          },
        });
        if (typeof value === "symbol") {
          prompts.cancel("Cancelled.");
          throw new CliError("", EXIT_CANCELLED);
        }
        const err = await validateParam(ctx, descriptor.id, param.name, value);
        if (err) {
          console.error(`${c.red}${err}${c.reset}`);
          return;
        }
        params[param.name] = value;
      } else {
        // A secret is not echoed. The same field can now reach a source's
        // settings, not only an auth challenge, so the masking has to be here
        // as well as there.
        const ask = param.type === "secret" ? prompts.password : prompts.text;
        const value = await ask({
          message: promptMessage(param),
          placeholder: param.placeholder,
          validate: (val) => {
            const v = val ?? "";
            if (param.required && !v) return `${param.label} is required`;
            return undefined;
          },
        });
        if (prompts.isCancel(value)) {
          prompts.cancel("Cancelled.");
          throw new CliError("", EXIT_CANCELLED);
        }
        const err = await validateParam(ctx, descriptor.id, param.name, value as string);
        if (err) {
          console.error(`${c.red}${err}${c.reset}`);
          return;
        }
        params[param.name] = value as string;
      }
    }
  }

  // Resolve account IDs (auth flow / local discover / "local")
  let accountIds: string[] | undefined;

  // Pre-flight credentials. Two shapes:
  //
  //   - A provider-wide credential (an OAuth client id/secret) is collected
  //     once and saved, so it is only asked for when absent.
  //   - A `perAccount` credential IS the account being added, so it is
  //     collected every time and handed to the auth flow rather than saved.
  //     Skipping it when one is already on disk is what made a second account
  //     impossible: the flow just re-validated the first account's key.
  let pastedCredentials: Record<string, string> | undefined;
  if (descriptor.hasAuthFlow && descriptor.credentials) {
    const spec = descriptor.credentials;
    const status = await fetchCredentialsStatus(ctx.deviceId);
    const entry = status.items.find((e) => e.fileKey === spec.fileKey);
    const sameHost = isSameHostAsCollector(status.hostname);
    if (entry && spec.perAccount) {
      console.log(
        `\n${c.yellow}${descriptor.provider.name} needs the credentials for the account you're connecting.${c.reset}`,
      );
      const fields = await collectCredentialFields(entry, { sameHost, perAccount: true });
      if (!fields) {
        console.error(
          `${c.red}Aborting — ${descriptor.provider.name} credentials not provided.${c.reset}`,
        );
        return;
      }
      pastedCredentials = fields;
    } else if (entry && spec.required && !entry.configured) {
      console.log(
        `\n${c.yellow}${descriptor.provider.name} needs OAuth credentials before we can add this source.${c.reset}`,
      );
      const ok = await runCredentialsWizard(entry, { deviceId: ctx.deviceId, sameHost });
      if (!ok) {
        console.error(
          `${c.red}Aborting — ${descriptor.provider.name} credentials not set up.${c.reset}`,
        );
        return;
      }
    }
  }

  if (descriptor.hasAuthFlow) {
    // With a credential in hand, the probe is what resolves identity — taking
    // the discover shortcut here would register a stored account and quietly
    // discard what the user just pasted.
    if (descriptor.hasDiscover && !pastedCredentials) {
      let discovered: string[] | null = null;
      try {
        discovered = await discoverAccounts(ctx, descriptor.id);
      } catch {
        // Discovery failed — fall through to auth flow
      }
      if (discovered) {
        // An account the gateway already lists is settled here — joined,
        // refused or left alone — and never sent through auth again. Only
        // when every listed account is already this device's does the flow
        // go on to sign in a new one.
        const { fresh, configured } = splitConfiguredAccounts(
          descriptor.id,
          discovered,
          ctx.sources,
        );
        await settle(configured);
        if (fresh.length === 1) {
          console.log(`\n${c.dim}Found existing credentials for ${fresh[0]}${c.reset}`);
          accountIds = fresh;
        } else if (fresh.length > 1) {
          const selected = await prompts.multiselect({
            message: `Found ${fresh.length} accounts. Which would you like to add?`,
            options: fresh.map((a) => ({ value: a, label: a })),
            initialValues: fresh,
            required: true,
          });
          if (prompts.isCancel(selected)) {
            prompts.cancel("Cancelled.");
            throw new CliError("", EXIT_CANCELLED);
          }
          accountIds = selected as string[];
        } else if (settledAnything(settled)) {
          // Discovery turned up nothing the gateway does not already list, and
          // at least one listed account was joined, declined or refused. That
          // is what the operator asked about; signing a brand-new account in
          // on top of it is not, so the run ends on the report.
          reportSettled(settled, 0);
          return;
        } else if (configured.length > 0) {
          console.log(
            `${c.dim}Existing accounts already configured, proceeding to add a new one...${c.reset}`,
          );
        }
      }
    }

    if (!accountIds) {
      if (descriptor.authType === "oauth") {
        console.log(`\n${c.bold}${descriptor.provider.name} Account Setup${c.reset}\n`);
        // The actual instructions (URL/code/QR) arrive over the SSE channel
        // from the collector — render them below as they come in.
      } else if (descriptor.authType === "qr") {
        console.log(`\n${c.bold}${descriptor.provider.name} Pairing${c.reset}\n`);
        console.log("A QR code will appear below. Scan it with your phone.\n");
      } else if (descriptor.authType === "api-key") {
        console.log(`\n${c.bold}${descriptor.provider.name} API Key Setup${c.reset}\n`);
        // The key was collected above; the provider probes with it, resolves
        // which account it belongs to, and stores it under that account.
      }
      // No `link-widget` branch: a hosted client-rendered widget (Plaid Link,
      // …) has no terminal-renderable step, so those sources are added from the
      // portal / iOS, which render the `widget` auth event. See #926.

      // Try the auth flow. If the auth subprocess refuses for missing creds
      // (e.g. they were cleared between the pre-flight wizard and now, or
      // the user skipped the pre-flight pass), surface the wizard and retry.
      const flowOptions = {
        acceptsAuthCode: descriptor.acceptsAuthCode,
        credentials: pastedCredentials,
      };
      let outcome = await runAuthFlowDetailed(ctx, descriptor.id, params, flowOptions);
      if (outcome.missingCredentials) {
        const recovered = await recoverFromMissingCredentials(
          ctx,
          outcome.missingCredentials,
          flowOptions,
        );
        if (!recovered) return;
        outcome = await runAuthFlowDetailed(ctx, descriptor.id, params, flowOptions);
      }
      if (!outcome.accountId && flowOptions.credentials) {
        // Keep what the user typed. A credential a platform shows once at
        // creation cannot be re-read, so sending them back for a fresh one is
        // not a recovery.
        console.log(
          `\n${c.dim}The credentials you entered were not saved — nothing is stored until the account is verified. ` +
            `Run the command again to retry.${c.reset}`,
        );
      }
      if (!outcome.accountId) return;
      accountIds = [outcome.accountId];
    }
  } else if (descriptor.authType === "local") {
    if (descriptor.hasResolveAccountId) {
      const resolved = await gatewayJson<{ accountId: string }>("/admin/sources/resolve-account", {
        method: "POST",
        body: JSON.stringify({
          deviceId: ctx.deviceId,
          descriptorId: descriptor.id,
          params,
        }),
      });
      accountIds = [resolved.accountId];
    } else if (descriptor.hasDiscover) {
      const accounts = await discoverAccounts(ctx, descriptor.id);
      if (accounts.length === 0) {
        throw new CliError(
          `${c.red}${descriptor.name} not found on this system.${c.reset}\n` +
            `${c.dim}Make sure Full Disk Access is enabled for your terminal.${c.reset}`,
          EXIT_FAILURE,
        );
      }
      // The accounts the gateway already lists are settled — joined, refused
      // or left alone — and only the rest are offered as an add.
      const { fresh, configured } = splitConfiguredAccounts(descriptor.id, accounts, ctx.sources);
      await settle(configured);
      if (fresh.length === 0) {
        reportSettled(settled, 0);
        return;
      }
      const selected = await prompts.multiselect({
        message:
          fresh.length === 1
            ? `Found 1 account. Add it?`
            : `Found ${fresh.length} accounts. Which would you like to add?`,
        options: fresh.map((a) => ({ value: a, label: a })),
        initialValues: fresh.length === 1 ? fresh : [],
        required: true,
      });
      if (prompts.isCancel(selected)) {
        prompts.cancel("Cancelled.");
        throw new CliError("", EXIT_CANCELLED);
      }
      accountIds = selected as string[];
    } else {
      accountIds = ["local"];
    }
  } else {
    accountIds = ["local"];
  }

  if (!accountIds || accountIds.length === 0) {
    console.error(`${c.red}No accounts to add.${c.reset}`);
    return;
  }

  // An account resolved by a sign-in or a path may already be a source on
  // another device: that one is joined or refused rather than added twice.
  const { fresh, configured } = splitConfiguredAccounts(descriptor.id, accountIds, ctx.sources);
  await settle(configured);
  if (fresh.length === 0) {
    reportSettled(settled, 0);
    return;
  }

  // Send the add to the gateway, which dispatches `source.add` to the collector.
  let result: { sourceIds?: string[] };
  try {
    result = await withSpinner(`Registering ${descriptor.name}`, () =>
      gatewayJson<{ sourceIds: string[] }>(`/admin/sources/add`, {
        method: "POST",
        body: JSON.stringify({
          deviceId: ctx.deviceId,
          descriptorId: descriptor.id,
          accountIds: fresh,
          params: Object.keys(params).length > 0 ? params : undefined,
        }),
      }),
    );
  } catch (err) {
    console.error(
      `${c.red}Failed to add source: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
    );
    reportSettled(settled, 0);
    return;
  }

  console.log(`\n${c.green}${descriptor.name} added successfully!${c.reset}`);
  for (const sourceId of result.sourceIds ?? []) {
    console.log(`${c.dim}Source: ${sourceId}${c.reset}`);
  }
  console.log(`${c.dim}Sync started automatically.${c.reset}`);

  // Sources that can import older history from a local artifact (e.g. a phone
  // backup) advertise it via the generic `historyImport` descriptor capability.
  // Point the user at the one-time import so they don't assume live sync is all
  // there is. Wording comes from the source's own descriptor — no per-source
  // knowledge here. See #588.
  if (descriptor.historyImport) {
    const hi = descriptor.historyImport;
    console.log(`\n${c.cyan}💡 ${hi.label}${c.reset} — ${c.dim}${hi.description}${c.reset}`);
    for (const sourceId of result.sourceIds ?? []) {
      console.log(`${c.dim}   Run: ${c.reset}omnesis sources import-history ${sourceId}`);
    }
  }

  reportSettled(settled, result.sourceIds?.length ?? fresh.length);
}
