import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  createTab: vi.fn<DesktopPreviewBridge["createTab"]>(),
  closeTab: vi.fn<DesktopPreviewBridge["closeTab"]>(),
  registerWebview: vi.fn<DesktopPreviewBridge["registerWebview"]>(),
  getPreviewConfig: vi.fn<DesktopPreviewBridge["getPreviewConfig"]>(),
}));

vi.mock(import("~/env"), async (original) => ({ ...(await original()), isElectron: true }));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));

vi.mock(import("~/localApi"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    ensureLocalApi: () => ({ ...actual.ensureLocalApi(), persistence: mocks as never }),
  };
});

// The Electron desktop bridge; a browser has none.
vi.mock(import("~/components/preview/previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    registerWebview: mocks.registerWebview,
    getPreviewConfig: mocks.getPreviewConfig,
  } as never,
}));

vi.mock(import("~/components/preview/usePreviewBridge"), async (original) => ({
  ...(await original()),
  usePreviewBridge: () => undefined,
}));

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { reconcilePreviewServerSessions, resetPreviewStateForTests } from "~/previewStateStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { ElectronBrowserHost } from "./ElectronBrowserHost";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";

const threadRef = scopeThreadRef(
  EnvironmentId.make("host-webview-order"),
  ThreadId.make("thread-webview-order"),
);

const snapshot = (tabId: string, updatedAt: string): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus: { _tag: "Success", url: `https://example.com/${tabId}`, title: tabId },
  canGoBack: false,
  canGoForward: false,
  updatedAt,
});

function setup(): Disposable {
  __resetClientSettingsPersistenceForTests();
  mocks.getClientSettings.mockReset().mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
  mocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  mocks.createTab.mockReset().mockResolvedValue(undefined);
  mocks.closeTab.mockReset().mockResolvedValue(undefined);
  mocks.registerWebview.mockReset().mockResolvedValue(undefined);
  mocks.getPreviewConfig.mockReset().mockResolvedValue({
    partition: "persist:t3-preview-default",
    webPreferences: "contextIsolation=yes",
    preloadUrl: null,
  });
  return {
    [Symbol.dispose]() {
      resetPreviewStateForTests();
      __resetClientSettingsPersistenceForTests();
    },
  };
}

async function renderHost() {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <AppAtomRegistryProvider>
        <ElectronBrowserHost />
      </AppAtomRegistryProvider>,
    ),
  );
  // Unmounting releases each tab on a close timer; run it now so it never fires in a later test.
  stack.defer(async () => {
    using _timers = fakeTimers();
    await screen.unmount();
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(() => ensureClientSettingsHydrated());
  const environment = stack.move();
  return { container: screen.container, [Symbol.asyncDispose]: () => environment.disposeAsync() };
}

describe("ElectronBrowserHost", () => {
  it("never moves a tab's webview when the server reorders tabs by last update", async () => {
    using _state = setup();
    reconcilePreviewServerSessions(threadRef, {
      sessions: [
        snapshot("tab_7", "2026-01-01T00:00:01.000Z"),
        snapshot("tab_8", "2026-01-01T00:00:02.000Z"),
      ],
      serverEpoch: "server-a",
      revision: 1,
    });
    await using screen = await renderHost();

    const host = screen.container.querySelector("[data-electron-browser-host]")!;
    const webviews = () => [...host.querySelectorAll("webview")];
    const before = webviews();
    expect(before.map((node) => node.getAttribute("data-preview-server-tab")).toSorted()).toEqual([
      "tab_7",
      "tab_8",
    ]);

    // Electron destroys a webview's guest when its element leaves the DOM, so a reorder that
    // detaches and re-inserts the element blanks the tab.
    const detached: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) detached.push(...record.removedNodes);
    });
    observer.observe(host, { childList: true, subtree: true });

    await act(async () => {
      reconcilePreviewServerSessions(threadRef, {
        sessions: [
          snapshot("tab_8", "2026-01-01T00:00:02.000Z"),
          snapshot("tab_7", "2026-01-01T00:00:03.000Z"),
        ],
        serverEpoch: "server-a",
        revision: 2,
      });
    });
    observer.takeRecords().forEach((record) => detached.push(...record.removedNodes));
    observer.disconnect();

    expect(detached).toEqual([]);
    const after = webviews();
    expect(after).toHaveLength(2);
    expect(after.every((node, index) => node.isSameNode(before[index]!))).toBe(true);
  });
});

it("acknowledges background capture layout and keeps the guest paintable until every lease is released", async () => {
  using _state = setup();
  const previousBridge = window.desktopBridge;
  const listeners = new Set<Parameters<DesktopPreviewBridge["onRenderActivity"]>[0]>();
  const acknowledgeRendering = vi.fn(async (_leaseId: string) => {});
  window.desktopBridge = {
    preview: {
      onPointerEvent: () => () => {},
      onOpenLink: () => () => {},
      setAnnotationTheme: async () => {},
      onRenderActivity: (listener: Parameters<DesktopPreviewBridge["onRenderActivity"]>[0]) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      acknowledgeRendering,
    },
  } as unknown as NonNullable<typeof window.desktopBridge>;
  using _bridge = {
    [Symbol.dispose]: () => {
      if (previousBridge) window.desktopBridge = previousBridge;
      else delete window.desktopBridge;
    },
  };
  reconcilePreviewServerSessions(threadRef, {
    sessions: [
      {
        ...snapshot("capture-tab", "2026-01-01T00:00:01.000Z"),
        viewport: { _tag: "freeform", width: 3000, height: 2000 },
      },
    ],
    serverEpoch: "capture-server",
    revision: 1,
  });
  let runtimeTabId: string;
  {
    await using screen = await renderHost();
    const guest = screen.container.querySelector("webview")!;
    Object.assign(guest, { getWebContentsId: () => 42 });
    runtimeTabId = guest.getAttribute("data-preview-tab")!;
    const wrapper = guest.closest<HTMLElement>("[data-preview-rendering]")!;
    const emit = (leaseId: string, active: boolean) =>
      act(() => {
        for (const listener of listeners) listener({ leaseId, active, webContentsId: 42 });
      });
    await emit("first", true);
    await vi.waitFor(() => expect(acknowledgeRendering).toHaveBeenCalledWith("first"));
    expect(wrapper.dataset.previewRendering).toBe("active");
    expect(wrapper.style.left).toBe("0px");
    expect(wrapper.style.zIndex).toBe("-1");
    // A partial intersection ACK lets Electron discard frames clipped by the host.
    const bounds = wrapper.getBoundingClientRect();
    expect(bounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
    expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
    expect(wrapper.offsetWidth).toBe(3000);
    expect(wrapper.offsetHeight).toBe(2000);
    await emit("second", true);
    await vi.waitFor(() => expect(acknowledgeRendering).toHaveBeenCalledWith("second"));
    await emit("first", false);
    expect(wrapper.dataset.previewRendering).toBe("active");
    await emit("second", false);
    expect(wrapper.dataset.previewRendering).toBe("suspended");
    await emit("unmount", true);
  }
  expect(useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId]).toBeUndefined();
  expect(listeners.size).toBe(0);
});
