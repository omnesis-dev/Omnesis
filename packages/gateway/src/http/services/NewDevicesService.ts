// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The one answer for new devices (Settings → Connectivity): what happens when a device asks to
 * join without a pairing code, by signing in with the linked Omnesis account or from the owner's
 * tailnet through the gateway's own Tailscale device. Each of those keeps its own policy; this
 * sets both together, so one owner action is one request and asks for one step-up.
 *
 * "code" is offered only while no account is linked, since an account always lets a device ask by
 * signing in; it turns joining through Tailscale off. The Tailscale device's policy is local and
 * is written first, so it can be put back exactly when the account's then fails: one answer
 * never leaves the two ways split.
 */

import { CloudRelayManagementFailure } from "@omnesis/cloud-relay";
import { HttpError } from "../errors.js";
import type { CloudRelayManagement, CloudRelayManagementStatus } from "@omnesis/cloud-relay";
import type { TailscaleJoinPolicy } from "@omnesis/core";
import type { TailscaleEmbedService } from "../../tailscale-embed/service.js";

type NewDevicesPolicy = "ask" | "automatic" | "code";

interface NewDevicesAnswer {
  /** The account's status, as GET /admin/cloud-relay reads it, when its policy was set. */
  relay?: CloudRelayManagementStatus;
  /** The Tailscale device's state, as GET /admin/tailscale reads it, when its policy was set. */
  tailscale?: ReturnType<TailscaleEmbedService["state"]>;
}

/** The Tailscale device's own word for an answer: a pairing code only turns its joining off. */
const tailscaleJoinPolicy = (policy: NewDevicesPolicy): TailscaleJoinPolicy =>
  policy === "code" ? "off" : policy;

const UNCHANGED = "Couldn't change that. Nothing changed. Try again.";

export class NewDevicesService {
  constructor(
    private readonly ways: { relay?: CloudRelayManagement; tailscale?: TailscaleEmbedService },
  ) {}

  async answer(policy: NewDevicesPolicy): Promise<NewDevicesAnswer> {
    const { relay, tailscale } = this.ways;
    const linked = Boolean(relay?.setEnrollmentPolicy && relay.accountPairingIdentity?.());
    const tailscaleOn = tailscale?.state().enabled === true;
    if (!linked && !tailscaleOn)
      throw new HttpError(
        409,
        "NO_WAY_TO_ASK",
        "No new device can ask to join yet: link an Omnesis account or turn on this gateway's own Tailscale device.",
      );
    if (linked && policy === "code")
      throw new HttpError(
        409,
        "ACCOUNT_LETS_DEVICES_ASK",
        "A device can always ask to join by signing in with your Omnesis account. Choose Ask me first instead.",
      );
    const before = tailscaleOn ? tailscale!.joinPolicy() : undefined;
    try {
      if (tailscaleOn) await tailscale!.updateSettings({ joinPolicy: tailscaleJoinPolicy(policy) });
    } catch {
      throw new HttpError(503, "NEW_DEVICES_UNAVAILABLE", UNCHANGED);
    }
    let account: CloudRelayManagementStatus | undefined;
    try {
      if (linked) account = await relay!.setEnrollmentPolicy!(policy as "ask" | "automatic");
    } catch (error) {
      if (before !== undefined && before !== tailscaleJoinPolicy(policy))
        await tailscale!.updateSettings({ joinPolicy: before }).catch(() => undefined);
      if (error instanceof CloudRelayManagementFailure)
        throw new HttpError(error.status, error.code, UNCHANGED);
      throw new HttpError(503, "NEW_DEVICES_UNAVAILABLE", UNCHANGED);
    }
    return {
      ...(account ? { relay: account } : {}),
      ...(tailscaleOn ? { tailscale: tailscale!.state() } : {}),
    };
  }
}
