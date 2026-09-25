// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The translation between a watch firing and the notification tail.
 *
 * The tail owns devices, APNs and dead tokens. What this has to get right is
 * small and easy to get wrong — that the firing is identifiable afterwards,
 * that a re-send replaces a banner rather than stacking a second one, that an
 * install with nothing to send to is an ordinary state rather than a failure,
 * and that a conversation the agent opened about the firing changes both what
 * the banner says and where a tap lands.
 *
 * All fixture data is invented.
 */

import { describe, expect, it } from "vitest";

import {
  omnesisNotifyDelivery,
  type WatchFiringThreadRequest,
  type WatchPushRunner,
} from "./delivery.js";
import { WatchFiringThreadNoAgentError } from "./firing-thread.js";
import { WATCH_THREAD_DEGRADES, type WatchNotification } from "./engine-host.js";
import type { NotifyRunOptions, NotifyRunResult } from "./notify-runner.js";

/** A runner that records what it was asked to send. */
function recordingRunner(
  delivered: number,
  attempted = delivered,
): {
  runner: WatchPushRunner;
  sent: NotifyRunOptions[];
} {
  const sent: NotifyRunOptions[] = [];
  const runner: WatchPushRunner = {
    run: (input) => {
      sent.push(input);
      return Promise.resolve({
        status: "ok",
        attempted,
        delivered,
      } as unknown as NotifyRunResult);
    },
  };
  return { runner, sent };
}

const FIRING = {
  watchId: "w-1",
  watchName: "an-order-shipped",
  firingKey: "w-1:41",
  firingId: "w-1:41:notify:k9:0",
  title: "Omnesis: an-order-shipped",
  body: "doc_id: d-1",
  authoredCopy: {},
  condition: "tell me when an order I was told about ships",
  firedAt: "2026-05-04T09:15:00.000Z",
  documentIds: ["d-1"],
  payload: {},
} satisfies WatchNotification;

describe("a watch firing on its way to a device", () => {
  it("carries the watch's own identity, so the push traces back to a row", async () => {
    const { runner, sent } = recordingRunner(1);
    await omnesisNotifyDelivery(() => runner).send(FIRING);

    expect(sent[0]?.watchId, "the push named something other than the watch").toBe("w-1");
    expect(sent[0]?.watchName).toBe("an-order-shipped");
    expect(sent[0]?.firingKey).toBe("w-1:41");
    // The envelope is a contract with the phone: its router refuses a
    // watch-firing push that names no firing, so a tap would open the app and
    // go nowhere.
    // No conversation, because no thread was opened. The tap reaches the
    // firing's line of the ledger, which is all there is to show.
    expect(sent[0]?.conversationId).toBeUndefined();
  });

  it("collapses on the firing, so a re-send replaces the banner", async () => {
    // A firing is unique by construction, so this is a guard against a retry
    // rather than a coalescer — but without it a retry stacks a second banner
    // for something that happened once.
    const { runner, sent } = recordingRunner(1);
    await omnesisNotifyDelivery(() => runner).send(FIRING);
    expect(sent[0]?.collapseId).toBe("w-1:41");
  });

  it("passes the copy through rather than templating over it", async () => {
    // The host writes what a firing says, because it is the half that has the
    // payload. A second rendering here would be a second thing to keep in step.
    const { runner, sent } = recordingRunner(1);
    await omnesisNotifyDelivery(() => runner).send(FIRING);
    expect(sent[0]?.title).toBe(FIRING.title);
    expect(sent[0]?.body).toBe(FIRING.body);
  });

  it("reports what was delivered, not what was attempted", async () => {
    // An install with a stale device token attempts and delivers nothing. The
    // caller counts what reached someone, so the two must not be conflated.
    const { runner } = recordingRunner(0, 3);
    // Reports what it tried as well as what landed: a push nobody accepted and
    // a push nobody was there for are different facts, and the ledger records
    // both.
    expect(await omnesisNotifyDelivery(() => runner).send(FIRING)).toMatchObject({
      delivered: 0,
      attempted: 3,
    });
  });

  it("sends nothing, and does not throw, when no transport is wired", async () => {
    // An operator can turn delivery on before APNs is configured. That is worth
    // a log line, not an exception that would pause the watch.
    expect(await omnesisNotifyDelivery(() => null).send(FIRING)).toMatchObject({
      delivered: 0,
      attempted: 0,
      error: "no push transport is configured",
    });
  });

  it("asks for the runner each time, so a reconfigured client is picked up", async () => {
    // The runner is rebuilt when the operator changes the APNs configuration.
    // A captured one would go on talking to a client that has been replaced.
    const first = recordingRunner(1);
    const second = recordingRunner(1);
    let current: WatchPushRunner = first.runner;
    const port = omnesisNotifyDelivery(() => current);

    await port.send(FIRING);
    current = second.runner;
    await port.send(FIRING);

    expect(first.sent, "the port held on to the first runner").toHaveLength(1);
    expect(second.sent).toHaveLength(1);
  });

  it("quotes the agent's opening message and lands the tap on the thread", async () => {
    // The operator-visible difference between this and the plain push: the
    // banner says what happened rather than announcing that something did.
    const { runner, sent } = recordingRunner(1);
    const asked: WatchFiringThreadRequest[] = [];
    const port = omnesisNotifyDelivery(
      () => runner,
      async (request) => {
        asked.push(request);
        return { conversationId: "s_thread_1", openingMessage: "Your speakers shipped today." };
      },
    );

    await port.send(FIRING);

    expect(sent[0]?.body).toBe("Your speakers shipped today.");
    // What a tap opens: the thread whose opening sentence this banner quotes.
    expect(sent[0]?.conversationId).toBe("s_thread_1");
    // The agent is briefed from the firing itself: what was asked, when it came
    // true, and which documents made it so.
    expect(asked).toEqual([
      {
        watchId: "w-1",
        firingId: "w-1:41:notify:k9:0",
        watchName: "an-order-shipped",
        condition: "tell me when an order I was told about ships",
        firedAt: Date.parse("2026-05-04T09:15:00.000Z"),
        evidenceDocumentIds: ["d-1"],
      },
    ]);
  });

  it("still notifies when the conversation cannot be opened", async () => {
    // A firing is never lost to a thread that failed to write. The operator
    // asked to be told when their watch came true, and being told plainly
    // beats not being told at all.
    const { runner, sent } = recordingRunner(1);
    const port = omnesisNotifyDelivery(
      () => runner,
      () => Promise.reject(new Error("no agent is configured on this gateway")),
    );

    expect(await port.send(FIRING)).toMatchObject({ delivered: 1 });
    expect(sent[0]?.body).toBe(FIRING.body);
    // The envelope is a contract with the phone: its router refuses a
    // watch-firing push that names no firing, so a tap would open the app and
    // go nowhere.
    // No conversation, because no thread was opened. The tap reaches the
    // firing's line of the ledger, which is all there is to show.
    expect(sent[0]?.conversationId).toBeUndefined();
  });

  it("gives two firings of one tick two conversations", async () => {
    // A broadcast arm re-judges every live cell at the tick's own sequence
    // number, so two firings over different evidence share a `seq` — and the
    // deep-link key with it. Keying the thread on that would reuse the first
    // firing's conversation for the second, and tell the operator about an
    // event that is not the one the banner announces.
    const { runner } = recordingRunner(1);
    const asked: string[] = [];
    const port = omnesisNotifyDelivery(
      () => runner,
      async (request) => {
        asked.push(request.firingId);
        return { conversationId: `s_${asked.length}`, openingMessage: "Something happened." };
      },
    );

    await port.send({ ...FIRING, firingId: "w-1:41:notify:ka:0", documentIds: ["d-1"] });
    await port.send({ ...FIRING, firingId: "w-1:41:notify:kb:0", documentIds: ["d-2"] });

    expect(new Set(asked).size, "two firings were asked about as if they were one").toBe(2);
  });

  it("keeps copy the author wrote, even when the agent wrote about the firing", async () => {
    // `delivery.title` / `delivery.body` are what somebody chose on purpose.
    // Replacing them with the agent's account answers a different question
    // than the one they asked.
    const { runner, sent } = recordingRunner(1);
    const port = omnesisNotifyDelivery(
      () => runner,
      async () => ({ conversationId: "s_1", openingMessage: "Your speakers shipped today." }),
    );

    await port.send({
      ...FIRING,
      authoredCopy: { title: "Deliveries", body: "One of your orders moved." },
    });

    expect(sent[0]?.title).toBe("Deliveries");
    expect(sent[0]?.body).toBe("One of your orders moved.");
    // The conversation is still opened and still what a tap lands on: the
    // author chose the words, not whether there is something to open.
    expect(sent[0]?.conversationId).toBe("s_1");
  });

  it("clips an opening message too long for a banner", async () => {
    const { runner, sent } = recordingRunner(1);
    const opening = `The order ${"x".repeat(400)} shipped.`;
    const port = omnesisNotifyDelivery(
      () => runner,
      async () => ({
        conversationId: "s_1",
        openingMessage: opening,
      }),
    );

    await port.send(FIRING);

    expect(sent[0]!.body.length).toBeLessThan(opening.length);
    expect(sent[0]!.body.endsWith("…"), "a clipped body should read as an opening").toBe(true);
  });

  describe("what it records when the firing arrives as less than it should", () => {
    it("says nothing when the firing got its conversation", async () => {
      const { runner } = recordingRunner(1);
      const port = omnesisNotifyDelivery(
        () => runner,
        async () => ({
          conversationId: "s_1",
          openingMessage: "The order shipped this morning.",
        }),
      );

      // Absent, not `null` or `"none"`: a reader counting degrades must not
      // have to know which falsy shape means "nothing was lost".
      expect(await port.send(FIRING)).not.toHaveProperty("degraded");
    });

    it("names the install with no agent integration wired at all", async () => {
      const { runner } = recordingRunner(1);
      const outcome = await omnesisNotifyDelivery(() => runner).send(FIRING);
      expect(outcome.degraded).toBe("no-opener");
      // Still delivered. That is the whole reason the class has to be
      // recorded — every other number on the row says this went fine.
      expect(outcome.delivered).toBe(1);
    });

    it("distinguishes a backend that never answered from one that refused", async () => {
      const { runner } = recordingRunner(1);
      const swappingIn = omnesisNotifyDelivery(
        () => runner,
        () => {
          throw new WatchFiringThreadNoAgentError();
        },
      );
      expect((await swappingIn.send(FIRING)).degraded).toBe("no-agent");

      // An agent was there and the turn produced nothing. An operator does
      // something different about this than about an unassigned model, so the
      // two must not fold into one class.
      const refused = omnesisNotifyDelivery(
        () => runner,
        () => {
          throw new Error("the backend returned 503");
        },
      );
      expect((await refused.send(FIRING)).degraded).toBe("open-failed");
    });

    it("never puts the backend's own words on the row", async () => {
      const { runner } = recordingRunner(1);
      // A backend's error text can quote a value out of the corpus, and this
      // row outlives the log that holds the message.
      const port = omnesisNotifyDelivery(
        () => runner,
        () => {
          throw new Error("could not summarise the thread about invoice 4471");
        },
      );

      const outcome = await port.send(FIRING);
      expect(outcome.degraded).toBe("open-failed");
      expect(WATCH_THREAD_DEGRADES).toContain(outcome.degraded);
    });
  });
});
