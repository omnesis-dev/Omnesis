// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What `omnesis sources add` can do with a descriptor, given the sources the
 * gateway already lists. The add picker labels every descriptor with this
 * state. Account discovery then decides whether the target device adds a new
 * instance or joins an exact account that another host already contributes.
 */

import { c } from "../utils.js";
import {
  deviceLabel,
  sourceMode,
  type AdminDeviceEntry,
  type AdminSourceEntry,
} from "./members.js";
import type { MultiDeviceMode } from "@omnesis/types";

/** The fields of a descriptor the add choice depends on. */
export interface AddChoiceDescriptor {
  id: string;
  singleInstance?: boolean;
}

/**
 * One configured account, seen from a device. `candidate` is whether the
 * gateway's listing admits the device as a new member; a listing without
 * candidates leaves the decision to the gateway, as `sources join` does.
 */
export type AccountChoice =
  | { kind: "member" }
  | { kind: "join"; hostName: string; mode: MultiDeviceMode; candidate: boolean }
  | { kind: "exclusive"; hostName: string };

/**
 * A descriptor's state in the add picker. `singleInstance` limits each host
 * to one instance, not the whole gateway, so a source another host owns
 * remains unresolved until the target collector discovers its account.
 * `accounts` says how many instances exist and where; discovery later decides
 * whether the target joins an exact account or adds a fresh one.
 */
export type AddChoice =
  | { kind: "add" }
  | { kind: "member"; source: AdminSourceEntry }
  | {
      kind: "accounts";
      here: number;
      elsewhere: number;
      hostNames: string[];
      singleInstance: boolean;
    };

function isMember(source: AdminSourceEntry, deviceId: string | null): boolean {
  if (deviceId === null) return false;
  return source.deviceId === deviceId || source.members.includes(deviceId);
}

/**
 * The state of one configured source for `deviceId`. A null device — the add
 * picker before a collector is chosen — is never a member and always a
 * candidate: the device pick that follows settles both.
 */
export function describeAccountChoice(
  source: AdminSourceEntry,
  deviceId: string | null,
  devices: readonly AdminDeviceEntry[],
): AccountChoice {
  if (isMember(source, deviceId)) return { kind: "member" };
  const hostName = deviceLabel(devices, source.deviceId);
  const mode = sourceMode(source);
  if (mode === "exclusive") return { kind: "exclusive", hostName };
  const candidate =
    deviceId === null || !source.joinCandidates || source.joinCandidates.includes(deviceId);
  return { kind: "join", hostName, mode, candidate };
}

/**
 * The state of a descriptor for `deviceId`, from every listed source of its
 * type. A single-instance type is complete only when the target device
 * already hosts one of its rows. Every row elsewhere stays an aggregate
 * setup choice because the target's account is not known until discovery.
 */
export function describeAddChoice(
  descriptor: AddChoiceDescriptor,
  rows: readonly AdminSourceEntry[],
  deviceId: string | null,
  devices: readonly AdminDeviceEntry[],
): AddChoice {
  const sources = rows.filter((s) => s.type === descriptor.id);
  if (sources.length === 0) return { kind: "add" };
  if (descriptor.singleInstance) {
    const member = sources.find((source) => isMember(source, deviceId));
    if (member) return { kind: "member", source: member };
  }
  const elsewhere = sources.filter((s) => !isMember(s, deviceId));
  const hostNames = [...new Set(elsewhere.map((s) => deviceLabel(devices, s.deviceId)))];
  return {
    kind: "accounts",
    here: sources.length - elsewhere.length,
    elsewhere: elsewhere.length,
    hostNames,
    singleInstance: descriptor.singleInstance === true,
  };
}

/**
 * What joining means for the device, in the mode's own terms. `subject` is
 * how the device is named — "this device" from the CLI, its display name from
 * a client that acts on another device's behalf.
 */
export function joinModeSentence(mode: MultiDeviceMode, subject = "this device"): string {
  const capitalized = subject.charAt(0).toUpperCase() + subject.slice(1);
  switch (mode) {
    case "handoff":
      return `Sync hands off to whichever machine is awake; ${subject} needs its own sign-in.`;
    case "replicated":
      return `${capitalized} syncs its own copy alongside the others.`;
    case "partitioned":
      return `${capitalized} contributes its own stream.`;
    // "exclusive" — the mode that admits no second host, and what a listing
    // that does not name a mode is read as.
    default:
      return `${capitalized} would become a second host, which the type does not allow.`;
  }
}

/** What `renderAddChoice` needs besides the state. */
export interface RenderAddChoiceOptions {
  /** The descriptor's description — the hint of a plain add. */
  description: string;
  /** The hint of a type that already has accounts: "add another account" for a signed-in type, "add another" otherwise. */
  another: string;
}

/**
 * The picker line for a descriptor: a dim state after the name, and the hint
 * shown on the highlighted row.
 */
export function renderAddChoice(
  choice: AddChoice,
  { description, another }: RenderAddChoiceOptions,
): { suffix: string; hint: string } {
  const dim = (text: string): string => ` ${c.dim}${text}${c.reset}`;
  switch (choice.kind) {
    case "add":
      return { suffix: "", hint: description };
    case "member":
      return { suffix: dim("· already a member"), hint: "configured on this device" };
    case "accounts": {
      const where =
        choice.elsewhere > 0
          ? `${choice.here > 0 ? `${choice.here} configured, ` : ""}${choice.elsewhere} on ${choice.hostNames.join(", ")}`
          : `${choice.here} configured`;
      return {
        suffix: ` (${where})`,
        hint: choice.singleInstance
          ? "set up this device's account, or join an existing one"
          : choice.elsewhere > 0
            ? `${another}, or join one`
            : another,
      };
    }
  }
}
