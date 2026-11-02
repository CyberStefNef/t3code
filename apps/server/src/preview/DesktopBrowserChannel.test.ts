import { describe, expect, it } from "@effect/vitest";
import type { DesktopBrowserCommand } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import { makeRenderingActivity } from "./DesktopBrowserChannel.ts";

const key = { threadId: "thread", tabId: "tab" };
const fixture = Effect.gen(function* () {
  const commands = yield* Queue.unbounded<DesktopBrowserCommand>();
  const activity = yield* makeRenderingActivity(
    (command) => Queue.offer(commands, command).pipe(Effect.asVoid),
    () => true,
  );
  const take = Queue.take(commands).pipe(
    Effect.map((command) => {
      if (command.type !== "rendering") throw new Error("Expected rendering command");
      return command;
    }),
  );
  return { activity, take };
});

describe("desktop capture rendering leases", () => {
  it.effect(
    "waits for the matching layout acknowledgement and retains concurrent leases until their work drains",
    () =>
      Effect.gen(function* () {
        const { activity, take } = yield* fixture;
        const firstDrain = yield* Deferred.make<void>();
        const secondDrain = yield* Deferred.make<void>();
        const captures: string[] = [];
        const capture = (name: string, drain: Deferred.Deferred<void>) =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* activity.acquire(key);
              captures.push(name);
              yield* Deferred.await(drain);
            }),
          );
        const first = yield* capture("first", firstDrain).pipe(Effect.forkChild);
        const one = yield* take;
        const second = yield* capture("second", secondDrain).pipe(Effect.forkChild);
        const two = yield* take;
        expect(one.active && two.active).toBe(true);
        expect(captures).toEqual([]);
        yield* activity.acknowledge({ ...key, tabId: "wrong" }, one.leaseId);
        expect(captures).toEqual([]);
        yield* activity.acknowledge(key, one.leaseId);
        yield* activity.acknowledge(key, two.leaseId);
        yield* Deferred.succeed(firstDrain, undefined);
        yield* Fiber.join(first);
        expect(yield* take).toEqual({ ...one, active: false });
        expect(captures).toEqual(["first", "second"]);
        yield* Deferred.succeed(secondDrain, undefined);
        yield* Fiber.join(second);
        expect(yield* take).toEqual({ ...two, active: false });
      }),
  );

  it.effect("releases a lease when its layout acknowledgement times out", () =>
    Effect.gen(function* () {
      const { activity, take } = yield* fixture;
      const pending = yield* activity
        .acquire(key)
        .pipe(Effect.scoped, Effect.exit, Effect.forkChild);
      const acquired = yield* take;
      yield* TestClock.adjust("3 seconds");
      expect((yield* Fiber.join(pending))._tag).toBe("Failure");
      expect(yield* take).toEqual({ ...acquired, active: false });
      yield* activity.acknowledge(key, acquired.leaseId);
    }),
  );

  it.effect("fails and releases a pending lease on detach", () =>
    Effect.gen(function* () {
      const { activity, take } = yield* fixture;
      const pending = yield* activity
        .acquire(key)
        .pipe(Effect.scoped, Effect.exit, Effect.forkChild);
      const acquired = yield* take;
      yield* activity.detach(key);
      expect((yield* Fiber.join(pending))._tag).toBe("Failure");
      expect(yield* take).toEqual({ ...acquired, active: false });
    }),
  );
});
