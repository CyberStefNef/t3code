import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeStream from "@effect/platform-node/NodeStream";
import { describe, expect, it } from "@effect/vitest";
import type { DesktopBrowserCommand } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";

vi.mock("@effect/platform-node/NodeStream", () => ({ fromReadable: vi.fn() }));
vi.mock("node:net", () => ({
  Socket: class {
    destroy() {}
  },
}));

it.effect("protects unknown desktop visibility until an explicit hidden report arrives", () =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<Uint8Array>();
    vi.mocked(NodeStream.fromReadable).mockReturnValue(Stream.fromQueue(input));
    const config = yield* ServerConfig.ServerConfig;
    yield* Effect.gen(function* () {
      const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
      const key = { threadId: "thread-1", tabId: "tab-1" };
      const send = (event: object) =>
        Queue.offer(input, new TextEncoder().encode(`${JSON.stringify(event)}\n`));

      expect(channel.isShown(key)).toBe(true);
      yield* send({ type: "attached", ...key });
      yield* channel.awaitAttached(key, "5 seconds");
      expect(channel.isShown(key)).toBe(true);

      yield* send({ type: "shown", ...key, shown: false });
      yield* send({ type: "attached", threadId: key.threadId, tabId: "sentinel-1" });
      yield* channel.awaitAttached({ threadId: key.threadId, tabId: "sentinel-1" }, "5 seconds");
      expect(channel.isShown(key)).toBe(false);

      yield* send({ type: "shown", ...key, shown: true });
      yield* send({ type: "attached", threadId: key.threadId, tabId: "sentinel-2" });
      yield* channel.awaitAttached({ threadId: key.threadId, tabId: "sentinel-2" }, "5 seconds");
      expect(channel.isShown(key)).toBe(true);

      yield* send({ type: "shown", ...key, shown: false });
      yield* send({ type: "detached", ...key });
      yield* send({ type: "attached", threadId: key.threadId, tabId: "sentinel-3" });
      yield* channel.awaitAttached({ threadId: key.threadId, tabId: "sentinel-3" }, "5 seconds");
      expect(channel.isShown(key)).toBe(true);
    }).pipe(
      Effect.provide(
        DesktopBrowserChannel.layer.pipe(
          Layer.provide(
            ServerConfig.layer({ ...config, desktopBrowserFd: 41, desktopBrowserControlFd: 42 }),
          ),
        ),
      ),
    );
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "desktop-browser-channel-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

const key = { threadId: "thread", tabId: "tab" };
const fixture = Effect.gen(function* () {
  const commands = yield* Queue.unbounded<DesktopBrowserCommand>();
  const activity = yield* DesktopBrowserChannel.makeRenderingActivity(
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
