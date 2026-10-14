import fs from "node:fs";
import path from "node:path";

import { app, BaseWindow, BrowserWindow, session as electronSession } from "electron";
import type { Extension, Session as ElectronSession, ServiceWorkerMain, WebContents } from "electron";
import { appLog } from "@zenbu-labs/pixel";
import { ElectronChromeExtensions } from "electron-chrome-extensions";

import type { Tab, TabManager } from "./tabs";

export interface ExtensionAction {
  extensionId: string;
  label: string;
}

interface Manifest {
  action?: { default_popup?: string; default_title?: string };
  browser_action?: { default_popup?: string; default_title?: string };
}

const WARNING_LEVEL = 2;
const MOUNT_POLL_MS = 10;
const MOUNT_TIMEOUT_MS = 5000;

// Chromium also exposes extension APIs as `browser`, which the extension library leaves unpatched,
// and some extensions (LastPass) read `browser` before `chrome`.
const BROWSER_NAMESPACE_PRELOAD = `if (process.type === "service-worker" || location.href.startsWith("chrome-extension://")) {
  require("electron").contextBridge.executeInMainWorld({
    func: () => Object.defineProperty(globalThis, "browser", { value: globalThis.chrome, configurable: true, writable: true }),
  });
}
`;

const supports = new Map<ElectronSession, ExtensionSupport>();

let browserNamespaceFile: string | null = null;
function browserNamespacePreload(): string {
  if (!browserNamespaceFile) {
    browserNamespaceFile = path.join(app.getPath("userData"), "extension-browser-namespace.js");
    fs.writeFileSync(browserNamespaceFile, BROWSER_NAMESPACE_PRELOAD);
  }
  return browserNamespaceFile;
}

export function extensionSupport(partition: string | null): ExtensionSupport {
  const target = partition
    ? electronSession.fromPartition(partition.startsWith("persist:") ? partition : `persist:${partition}`)
    : electronSession.defaultSession;
  let support = supports.get(target);
  if (!support) {
    support = new ExtensionSupport(target);
    supports.set(target, support);
  }
  return support;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function popupPage(extension: Extension): string | null {
  const manifest = extension.manifest as Manifest;
  return manifest.action?.default_popup ?? manifest.browser_action?.default_popup ?? null;
}

function ownWindow(contents: WebContents): BaseWindow {
  const window = BrowserWindow.fromWebContents(contents);
  if (!window) throw new Error(`tab ${contents.id} has no window`);
  return window;
}

async function mounted(tab: Tab): Promise<WebContents> {
  for (let waited = 0; waited < MOUNT_TIMEOUT_MS; waited += MOUNT_POLL_MS) {
    const handle = tab.ref.current;
    if (handle) return handle.webContents;
    await new Promise((resolve) => setTimeout(resolve, MOUNT_POLL_MS));
  }
  throw new Error(`tab ${tab.id} did not open`);
}

export class ExtensionSupport {
  readonly api: ElectronChromeExtensions;
  private readonly loaded = new Map<string, Extension>();
  private readonly windows: ExtensionWindow[] = [];

  constructor(private readonly target: ElectronSession) {
    // extensions like LastPass switch to their desktop-app code paths when the user agent mentions Electron
    const userAgent = target.getUserAgent().replace(/ (terminal-browser|Electron)\/\S+/g, "");
    target.setUserAgent(userAgent);
    app.userAgentFallback = userAgent;
    this.api = new ElectronChromeExtensions({
      license: "GPL-3.0",
      session: target,
      createTab: async (details) => {
        const window = this.windowWithAnchor(details.windowId) ?? this.current();
        const contents = await window.openTab(details.url ?? "about:blank", details.active !== false);
        return [contents, window.anchor];
      },
      selectTab: (contents) => this.ownerOf(contents)?.activate(contents),
      removeTab: (contents) => this.ownerOf(contents)?.close(contents),
      createWindow: async (details) => {
        const url = Array.isArray(details.url) ? details.url[0] : details.url;
        const contents = await this.current().openWindow(url ?? "about:blank", details.focused !== false);
        return ownWindow(contents);
      },
      removeWindow: (window) => {
        for (const owner of this.windows) owner.closeWindow(window);
      },
    });
    const preload = browserNamespacePreload();
    target.registerPreloadScript({ id: "browser-namespace-worker", type: "service-worker", filePath: preload });
    target.registerPreloadScript({ id: "browser-namespace-frame", type: "frame", filePath: preload });
    this.api.on("browser-action-popup-created", (popup) => {
      popup.destroy();
      this.current().openPopup(popup.extensionId);
    });
    target.serviceWorkers.on("console-message", (_event, details) => {
      if (details.level >= WARNING_LEVEL) {
        appLog(details.level > WARNING_LEVEL ? "error" : "warn", "extensions", `${details.sourceUrl}: ${details.message}`);
      }
    });
    target.serviceWorkers.on("running-status-changed", ({ versionId, runningStatus }) => {
      if (runningStatus !== "running") return;
      const worker = target.serviceWorkers.getWorkerFromVersionID(versionId);
      if (worker?.scope.startsWith("chrome-extension://")) this.keepAlive(worker);
    });
  }

  async load(paths: string[]): Promise<string[]> {
    const failures: string[] = [];
    for (const path of paths) {
      if (this.loaded.has(path)) continue;
      try {
        const extension = await this.target.extensions.loadExtension(path);
        this.loaded.set(path, extension);
        appLog("info", "extensions", `loaded ${extension.name} ${extension.version} (${extension.id}) from ${path}`);
      } catch (error) {
        failures.push(`${path}: ${errorText(error)}`);
      }
    }
    return failures;
  }

  actions(): ExtensionAction[] {
    return [...this.loaded.values()]
      .filter((extension) => popupPage(extension))
      .map((extension) => {
        const manifest = extension.manifest as Manifest;
        const title = manifest.action?.default_title ?? manifest.browser_action?.default_title;
        return { extensionId: extension.id, label: title || extension.name };
      });
  }

  popupUrl(extensionId: string): string | null {
    const extension = this.target.extensions.getExtension(extensionId);
    const page = extension && popupPage(extension);
    return page ? `${extension.url}${page.replace(/^\//, "")}` : null;
  }

  attach(window: ExtensionWindow) {
    this.windows.push(window);
  }

  detach(window: ExtensionWindow) {
    const at = this.windows.indexOf(window);
    if (at >= 0) this.windows.splice(at, 1);
  }

  focus(window: ExtensionWindow) {
    this.detach(window);
    this.windows.push(window);
  }

  private current(): ExtensionWindow {
    const window = this.windows[this.windows.length - 1];
    if (!window) throw new Error("no browser window is open");
    return window;
  }

  private windowWithAnchor(id: number | undefined): ExtensionWindow | null {
    return this.windows.find((window) => window.anchor.id === id) ?? null;
  }

  private ownerOf(contents: WebContents): ExtensionWindow | null {
    return this.windows.find((window) => window.owns(contents)) ?? null;
  }

  // Electron stops an extension's worker after 30 idle seconds and calls through the extension library don't count
  // as activity, so the worker would restart every 30 seconds and drop replies it still owes to pages.
  private keepAlive(worker: ServiceWorkerMain) {
    try {
      worker.startTask();
    } catch (error) {
      appLog("warn", "extensions", `could not keep ${worker.scope} running: ${errorText(error)}`);
    }
  }
}

export class ExtensionWindow {
  // extensions expect every tab to live in a window; this hidden one stands in for the pane
  readonly anchor = new BaseWindow({ show: false });
  private readonly tracked = new Map<number, WebContents>();
  private readonly ownWindowTabs = new Set<number>();
  private readonly popupTabs = new Set<number>();
  private selected: WebContents | null = null;
  private informing = false;

  constructor(
    private readonly support: ExtensionSupport,
    private readonly tabs: TabManager,
  ) {
    support.attach(this);
  }

  actions(): ExtensionAction[] {
    return this.support.actions();
  }

  focus() {
    this.support.focus(this);
    this.anchor.emit("focus");
    const active = this.tabs.active;
    if (active) this.select(active);
  }

  track(tab: Tab) {
    if (this.tracked.has(tab.id) || this.popupTabs.has(tab.id)) return;
    const handle = tab.ref.current;
    if (!handle) return;
    const contents = handle.webContents;
    this.tracked.set(tab.id, contents);
    contents.once("destroyed", () => this.tracked.delete(tab.id));
    this.inform(() => this.support.api.addTab(contents, this.ownWindowTabs.has(tab.id) ? ownWindow(contents) : this.anchor));
    const active = this.tabs.active;
    if (active) this.select(active);
  }

  select(tab: Tab) {
    // popup tabs are untracked, so extensions keep seeing the page tab that was in front before them
    const selected = this.tracked.get(tab.id) ?? this.selected;
    this.selected = selected;
    if (selected && !selected.isDestroyed()) this.inform(() => this.support.api.selectTab(selected));
  }

  owns(contents: WebContents): boolean {
    return [...this.tracked.values()].includes(contents);
  }

  async openTab(url: string, active: boolean): Promise<WebContents> {
    const tab = this.tabs.create(url, active);
    const contents = this.closeWithPage(tab, await mounted(tab));
    // tracked here so the extension library never adds this tab itself, which can select it
    this.track(tab);
    return contents;
  }

  async openWindow(url: string, active: boolean): Promise<WebContents> {
    const tab = this.tabs.create(url, active);
    this.ownWindowTabs.add(tab.id);
    const contents = this.closeWithPage(tab, await mounted(tab));
    this.track(tab);
    return contents;
  }

  openPopup(extensionId: string) {
    const url = this.support.popupUrl(extensionId);
    if (!url) return;
    const tab = this.tabs.create(url, true);
    this.popupTabs.add(tab.id);
    void mounted(tab).then((contents) => this.closeWithPage(tab, contents));
  }

  activate(contents: WebContents) {
    if (this.informing) return;
    const tab = this.tabs.findByContents(contents.id);
    if (tab) this.tabs.activate(tab.id);
  }

  close(contents: WebContents) {
    const tab = this.tabs.findByContents(contents.id);
    if (tab) this.tabs.close(tab.id);
  }

  closeWindow(window: BaseWindow) {
    for (const [id, contents] of this.tracked) {
      if (this.ownWindowTabs.has(id) && !contents.isDestroyed() && BrowserWindow.fromWebContents(contents)?.id === window.id) {
        this.tabs.close(id);
      }
    }
  }

  dispose() {
    this.support.detach(this);
    this.anchor.destroy();
  }

  // the extension library answers every tab we add or select by asking us to activate it; that must not switch tabs
  private inform(update: () => void) {
    this.informing = true;
    try {
      update();
    } finally {
      this.informing = false;
    }
  }

  // a page closing itself (window.close() in an extension popup) leaves its tab behind otherwise
  private closeWithPage(tab: Tab, contents: WebContents): WebContents {
    contents.once("destroyed", () => {
      if (this.tabs.has(tab.id)) this.tabs.close(tab.id);
    });
    return contents;
  }
}
