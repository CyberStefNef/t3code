// @effect-diagnostics globalTimers:off - Electron presentation and CDP promises settle outside Effect fibers.
/**
 * Occluded webviews can acknowledge DOM layout while CDP capture waits indefinitely
 * for a compositor frame. Keep the guest's presentation subscription alive through
 * the native capture; ending it at the first frame lets Chromium suspend again.
 */
type FrameLease = {
  users: number;
  readonly ready: Promise<void>;
  readonly stop: () => void;
};

const frames = new WeakMap<Electron.WebContents, FrameLease>();

const startFrames = (contents: Electron.WebContents): FrameLease => {
  const ready = Promise.withResolvers<void>();
  let waiting = true;
  let subscribed = false;
  const fail = () => {
    if (!waiting) return;
    waiting = false;
    ready.reject(new Error("The preview guest did not present a capture frame."));
  };
  // No native capture has started yet, so a missing presentation can safely fail.
  const timer = setTimeout(fail, 2_000);
  const lease: FrameLease = {
    users: 0,
    ready: ready.promise,
    stop: () => {
      clearTimeout(timer);
      contents.removeListener("destroyed", fail);
      if (subscribed && !contents.isDestroyed()) contents.endFrameSubscription();
    },
  };
  try {
    contents.once("destroyed", fail);
    contents.beginFrameSubscription(false, () => {
      // Frames remain inside Electron; only their presentation matters here.
      if (!waiting) return;
      waiting = false;
      clearTimeout(timer);
      ready.resolve();
    });
    subscribed = true;
    contents.invalidate();
  } catch {
    fail();
  }
  return lease;
};

export const withGuestCaptureFrame = async <A>(
  contents: Electron.WebContents,
  capture: () => Promise<A>,
): Promise<A> => {
  let lease = frames.get(contents);
  if (!lease) {
    lease = startFrames(contents);
    frames.set(contents, lease);
  }
  lease.users += 1;
  try {
    await lease.ready;
    return await capture();
  } finally {
    // A response deadline does not cancel the native capture or its painting lease.
    lease.users -= 1;
    if (lease.users === 0) {
      frames.delete(contents);
      lease.stop();
    }
  }
};
