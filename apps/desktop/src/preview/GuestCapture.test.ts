import * as NodeEvents from "node:events";
import { expect, it, vi } from "vite-plus/test";

import { withGuestCaptureFrame } from "./GuestCapture.ts";

const fixture = () => {
  const events = new NodeEvents.EventEmitter();
  let present = () => {};
  let destroyed = false;
  const contents = Object.assign(events, {
    beginFrameSubscription: vi.fn((_onlyDirty: boolean, callback: () => void) => {
      present = callback;
    }),
    endFrameSubscription: vi.fn(),
    invalidate: vi.fn(),
    isDestroyed: () => destroyed,
  });
  return {
    contents: contents as unknown as Electron.WebContents,
    begin: contents.beginFrameSubscription,
    end: contents.endFrameSubscription,
    invalidate: contents.invalidate,
    present: () => present(),
    destroy: () => {
      destroyed = true;
      events.emit("destroyed");
    },
  };
};

it("waits for a presentation and retains painting until the native capture really settles", async () => {
  const guest = fixture();
  const entered = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<string>();
  const capture = vi.fn(() => {
    entered.resolve();
    return pending.promise;
  });
  const result = withGuestCaptureFrame(guest.contents, capture);
  expect(guest.invalidate).toHaveBeenCalledOnce();
  expect(capture).not.toHaveBeenCalled();
  guest.present();
  await entered.promise;
  expect(guest.end).not.toHaveBeenCalled();
  guest.present();
  expect(capture).toHaveBeenCalledOnce();
  expect(guest.end).not.toHaveBeenCalled();
  pending.resolve("native image");
  expect(await result).toBe("native image");
  expect(guest.end).toHaveBeenCalledOnce();
});

it("shares a guest's subscription without releasing another pending capture or touching another guest", async () => {
  const guest = fixture();
  const foreign = fixture();
  const one = Promise.withResolvers<string>();
  const two = Promise.withResolvers<string>();
  const entered = Promise.withResolvers<void>();
  const first = withGuestCaptureFrame(guest.contents, () => one.promise);
  const second = withGuestCaptureFrame(guest.contents, () => {
    entered.resolve();
    return two.promise;
  });
  guest.present();
  await entered.promise;
  expect(guest.begin).toHaveBeenCalledOnce();
  one.resolve("first");
  expect(await first).toBe("first");
  expect(guest.end).not.toHaveBeenCalled();
  two.resolve("second");
  expect(await second).toBe("second");
  expect(guest.end).toHaveBeenCalledOnce();
  expect(foreign.begin).not.toHaveBeenCalled();
  expect(foreign.invalidate).not.toHaveBeenCalled();
});

it("releases a failed native capture and acquires a fresh presentation for a retry", async () => {
  const guest = fixture();
  const failure = new Error("native capture failed");
  const first = withGuestCaptureFrame(guest.contents, () => Promise.reject(failure));
  const failed = expect(first).rejects.toBe(failure);
  guest.present();
  await failed;
  expect(guest.end).toHaveBeenCalledOnce();
  const capture = vi.fn(async () => "retry image");
  const retry = withGuestCaptureFrame(guest.contents, capture);
  expect(capture).not.toHaveBeenCalled();
  guest.present();
  expect(await retry).toBe("retry image");
  expect(guest.begin).toHaveBeenCalledTimes(2);
  expect(guest.end).toHaveBeenCalledTimes(2);
});

it("fails missing frame readiness before starting native capture", async () => {
  vi.useFakeTimers();
  try {
    const guest = fixture();
    const capture = vi.fn(async () => "image");
    const result = withGuestCaptureFrame(guest.contents, capture);
    const failed = expect(result).rejects.toThrow("did not present a capture frame");
    await vi.advanceTimersByTimeAsync(2_000);
    await failed;
    expect(capture).not.toHaveBeenCalled();
    expect(guest.end).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("rejects a destroyed guest's readiness without invoking capture or native cleanup on a destroyed object", async () => {
  const guest = fixture();
  const capture = vi.fn(async () => "image");
  const result = withGuestCaptureFrame(guest.contents, capture);
  const failed = expect(result).rejects.toThrow("did not present a capture frame");
  guest.destroy();
  await failed;
  expect(capture).not.toHaveBeenCalled();
  expect(guest.end).not.toHaveBeenCalled();
});
