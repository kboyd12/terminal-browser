export type Cdp = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>;

export interface ChildFramePoint {
  sessionId: string;
  x: number;
  y: number;
}

interface AttachedToTarget {
  sessionId: string;
  targetInfo: { targetId: string };
}

const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: "iframe" }],
};

// Mouse input sent to an offscreen page never reaches frames running in another process
// (cross-site iframes, the PDF viewer), so those frames are reached through their own debugger session.
export class ChildFrames {
  private readonly cdp: Cdp;
  private readonly sessions = new Map<string, string>();

  constructor(cdp: Cdp) {
    this.cdp = cdp;
  }

  watch(sessionId?: string): Promise<unknown> {
    return this.cdp("Target.setAutoAttach", AUTO_ATTACH, sessionId);
  }

  onCdpEvent(method: string, params: unknown) {
    if (method === "Target.attachedToTarget") {
      const { sessionId, targetInfo } = params as AttachedToTarget;
      this.sessions.set(targetInfo.targetId, sessionId);
      void this.watch(sessionId).catch(() => {});
    } else if (method === "Target.detachedFromTarget") {
      const { sessionId } = params as { sessionId: string };
      for (const [frameId, session] of this.sessions) {
        if (session === sessionId) this.sessions.delete(frameId);
      }
    }
  }

  async at(x: number, y: number): Promise<ChildFramePoint | null> {
    let found: ChildFramePoint | null = null;
    let point: { sessionId?: string; x: number; y: number } = { x, y };
    while (this.sessions.size > 0) {
      const child = await this.childAt(point).catch(() => null);
      if (!child) break;
      found = child;
      point = child;
    }
    return found;
  }

  private async childAt(point: {
    sessionId?: string;
    x: number;
    y: number;
  }): Promise<ChildFramePoint | null> {
    const { sessionId, x, y } = point;
    const metrics = (await this.cdp("Page.getLayoutMetrics", {}, sessionId)) as {
      cssLayoutViewport: { pageX: number; pageY: number };
    };
    const scroll = metrics.cssLayoutViewport;
    const { backendNodeId } = (await this.cdp(
      "DOM.getNodeForLocation",
      {
        x: Math.round(x + scroll.pageX),
        y: Math.round(y + scroll.pageY),
        includeUserAgentShadowDOM: true,
        ignorePointerEventsNone: true,
      },
      sessionId,
    )) as { backendNodeId: number };
    const { node } = (await this.cdp("DOM.describeNode", { backendNodeId }, sessionId)) as {
      node: { frameId?: string };
    };
    const childSession = node.frameId && this.sessions.get(node.frameId);
    // A frame's own <html> element reports that frame's id.
    if (!childSession || childSession === sessionId) return null;
    const { model } = (await this.cdp("DOM.getBoxModel", { backendNodeId }, sessionId)) as {
      model: { content: number[] };
    };
    return { sessionId: childSession, x: x - model.content[0], y: y - model.content[1] };
  }
}
