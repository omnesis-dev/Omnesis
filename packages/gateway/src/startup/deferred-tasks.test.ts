// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { DeferredStartupTasks } from "./deferred-tasks.js";

function registration() {
  const stop = vi.fn();
  const register = vi.fn(() => ({ stop }));
  return { register, stop };
}

describe("DeferredStartupTasks", () => {
  it("defers registration until release, preserves order and starts only once", () => {
    const group = new DeferredStartupTasks();
    const order: number[] = [];
    const first = registration();
    const second = registration();
    group.defer(() => {
      order.push(1);
      return first.register();
    });
    group.defer(() => {
      order.push(2);
      return second.register();
    });
    expect(first.register).not.toHaveBeenCalled();
    expect(second.register).not.toHaveBeenCalled();
    group.start();
    group.start();
    expect(order).toEqual([1, 2]);
    expect(first.register).toHaveBeenCalledOnce();
    expect(second.register).toHaveBeenCalledOnce();
    group.stop();
    group.stop();
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it("never registers an individually cancelled pending task", () => {
    const group = new DeferredStartupTasks();
    const item = registration();
    const handle = group.defer(item.register);
    handle.stop();
    handle.stop();
    group.start();
    group.stop();
    expect(item.register).not.toHaveBeenCalled();
    expect(item.stop).not.toHaveBeenCalled();
  });

  it("never activates pending or newly deferred tasks after shutdown wins", () => {
    const group = new DeferredStartupTasks();
    const pending = registration();
    const late = registration();
    group.defer(pending.register);
    group.stop();
    group.start();
    const lateHandle = group.defer(late.register);
    lateHandle.stop();
    group.stop();
    group.start();
    expect(pending.register).not.toHaveBeenCalled();
    expect(late.register).not.toHaveBeenCalled();
  });

  it("registers immediately after release while retaining individual and group teardown", () => {
    const group = new DeferredStartupTasks();
    group.start();
    const first = registration();
    const second = registration();
    const firstHandle = group.defer(first.register);
    group.defer(second.register);
    expect(first.register).toHaveBeenCalledOnce();
    expect(second.register).toHaveBeenCalledOnce();
    firstHandle.stop();
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).not.toHaveBeenCalled();
    group.stop();
    firstHandle.stop();
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it("stops prior active tasks and blocks every later task when a registration fails", () => {
    const group = new DeferredStartupTasks();
    const first = registration();
    const last = registration();
    const failure = new Error("registration failed");
    group.defer(first.register);
    group.defer(() => {
      throw failure;
    });
    group.defer(last.register);
    expect(() => group.start()).toThrow(failure);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(last.register).not.toHaveBeenCalled();
    group.start();
    group.defer(last.register);
    group.stop();
    expect(first.stop).toHaveBeenCalledOnce();
    expect(last.register).not.toHaveBeenCalled();
  });

  it("shuts down an already released group if a late registration fails", () => {
    const group = new DeferredStartupTasks();
    const first = registration();
    group.defer(first.register);
    group.start();
    expect(() =>
      group.defer(() => {
        throw new Error("late registration failed");
      }),
    ).toThrow("late registration failed");
    expect(first.stop).toHaveBeenCalledOnce();
    const blocked = registration();
    group.defer(blocked.register);
    expect(blocked.register).not.toHaveBeenCalled();
  });

  it("attempts all cleanup even if one task's stop throws, without stopping it twice", () => {
    const group = new DeferredStartupTasks();
    const first = registration();
    const second = registration();
    first.stop.mockImplementation(() => {
      throw new Error("cleanup failed");
    });
    group.defer(first.register);
    group.defer(second.register);
    group.start();
    expect(() => group.stop()).toThrow("Deferred startup task cleanup failed");
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
    group.stop();
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it("preserves the registration failure while cleanup attempts all earlier handles", () => {
    const group = new DeferredStartupTasks();
    const first = registration();
    const second = registration();
    first.stop.mockImplementation(() => {
      throw new Error("cleanup failure");
    });
    group.defer(first.register);
    group.defer(second.register);
    const original = new Error("registration failure");
    group.defer(() => {
      throw original;
    });
    expect(() => group.start()).toThrow(original);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it("stops a just-created handle when shutdown occurs inside its registration", () => {
    const group = new DeferredStartupTasks();
    const item = registration();
    const next = registration();
    group.defer(() => {
      group.stop();
      return item.register();
    });
    group.defer(next.register);
    group.start();
    expect(item.stop).toHaveBeenCalledOnce();
    expect(next.register).not.toHaveBeenCalled();
    group.stop();
    expect(item.stop).toHaveBeenCalledOnce();
  });

  it("honors cancellation of the active registration before its concrete handle returns", () => {
    const group = new DeferredStartupTasks();
    const item = registration();
    const handle = group.defer(() => {
      handle.stop();
      return item.register();
    });
    group.start();
    expect(item.register).toHaveBeenCalledOnce();
    expect(item.stop).toHaveBeenCalledOnce();
    handle.stop();
    group.stop();
    expect(item.stop).toHaveBeenCalledOnce();
  });

  it("does not duplicate registrations if callbacks reenter start or defer", () => {
    const group = new DeferredStartupTasks();
    const first = registration();
    const nested = registration();
    group.defer(() => {
      group.start();
      group.defer(nested.register);
      return first.register();
    });
    group.start();
    expect(first.register).toHaveBeenCalledOnce();
    expect(nested.register).toHaveBeenCalledOnce();
    group.stop();
    expect(first.stop).toHaveBeenCalledOnce();
    expect(nested.stop).toHaveBeenCalledOnce();
  });

  it("cannot be revived by callbacks that reenter start or defer while stopping", () => {
    const group = new DeferredStartupTasks();
    const first = registration();
    const late = registration();
    first.stop.mockImplementation(() => {
      group.start();
      group.defer(late.register);
      group.stop();
    });
    group.defer(first.register);
    group.start();
    group.stop();
    expect(first.stop).toHaveBeenCalledOnce();
    expect(late.register).not.toHaveBeenCalled();
  });
});
