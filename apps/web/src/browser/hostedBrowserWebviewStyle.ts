import type { BrowserSurfaceRect } from "./browserSurfaceStore";

export interface HostedBrowserWebviewSize {
  readonly width: number;
  readonly height: number;
}

export interface HostedBrowserWebviewWrapperStyle {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
  readonly pointerEvents: "auto" | "none";
  readonly borderRadius?: number;
  readonly transform?: string;
  readonly transformOrigin?: string;
  readonly visibility?: "hidden" | "visible";
}

const HIDDEN_BROWSER_WEBVIEW_OFFSET = -100_000;

export function resolveHostedBrowserWebviewWrapperStyle(input: {
  readonly active: boolean;
  readonly renderingActive: boolean;
  readonly keepPaintableWhenInactive?: boolean;
  readonly cornerRadius?: number;
  readonly zIndex?: number;
  readonly rect: BrowserSurfaceRect | null;
  readonly hiddenSize: HostedBrowserWebviewSize;
}): HostedBrowserWebviewWrapperStyle {
  const {
    active,
    cornerRadius = 0,
    hiddenSize,
    keepPaintableWhenInactive = false,
    rect,
    renderingActive,
    zIndex = 30,
  } = input;
  if (active && rect) {
    return {
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      zIndex,
      pointerEvents: "auto",
      ...(cornerRadius > 0 ? { borderRadius: cornerRadius } : {}),
    };
  }

  if (renderingActive) {
    // Electron's frame subscriber drops guest frames clipped by the host window.
    // Fit the whole surface behind the app without resizing the page's viewport;
    // CDP keeps its native screenshot dimensions, clips and full-page contract.
    return {
      left: 0,
      top: 0,
      width: hiddenSize.width,
      height: hiddenSize.height,
      zIndex: -1,
      pointerEvents: "none",
      visibility: "visible",
      transform: `scale(min(1, calc(100vw / ${hiddenSize.width}px), calc(100vh / ${hiddenSize.height}px)))`,
      transformOrigin: "top left",
    };
  }

  return {
    left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
    top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
    width: hiddenSize.width,
    height: hiddenSize.height,
    zIndex: -1,
    pointerEvents: "none",
    visibility: keepPaintableWhenInactive ? "visible" : "hidden",
  };
}

/** Acknowledge only after the committed guest bounds have reached Chromium's layout. */
export function acknowledgeHostedBrowserWebviewLayout(
  wrapper: HTMLElement,
  ready: () => void,
): () => void {
  const view = wrapper.ownerDocument.defaultView;
  if (!view) return () => {};
  let frame = view.requestAnimationFrame(() => {
    wrapper.getBoundingClientRect();
    frame = view.requestAnimationFrame(() => {
      const rect = wrapper.getBoundingClientRect();
      if (
        wrapper.isConnected &&
        view.getComputedStyle(wrapper).visibility === "visible" &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < view.innerWidth &&
        rect.top < view.innerHeight
      )
        ready();
    });
  });
  return () => view.cancelAnimationFrame(frame);
}
