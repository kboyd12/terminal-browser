const assert = require("node:assert/strict");
const { test } = require("node:test");

const { ChildFrames } = require("../dist/web/child-frames.js");

function fakePage(frames) {
  const calls = [];
  const cdp = async (method, params, sessionId) => {
    calls.push({ method, params, sessionId });
    const frame = frames[sessionId ?? "root"];
    switch (method) {
      case "Target.setAutoAttach":
        return {};
      case "Page.getLayoutMetrics":
        return { cssLayoutViewport: frame.scroll };
      case "DOM.getNodeForLocation":
        return { backendNodeId: frame.nodeAt(params.x, params.y) };
      case "DOM.describeNode":
        return { node: { frameId: frame.nodes[params.backendNodeId].frameId } };
      case "DOM.getBoxModel":
        return { model: { content: frame.nodes[params.backendNodeId].content } };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { cdp, calls };
}

function attach(childFrames, frameId, sessionId) {
  childFrames.onCdpEvent("Target.attachedToTarget", { sessionId, targetInfo: { targetId: frameId } });
}

test("a point over the PDF viewer resolves to the innermost frame in its own coordinates", async () => {
  const { cdp, calls } = fakePage({
    root: {
      scroll: { pageX: 0, pageY: 0 },
      nodeAt: () => 1,
      nodes: { 1: { frameId: "viewer", content: [0, 0, 1272, 0, 1272, 772, 0, 772] } },
    },
    "viewer-session": {
      scroll: { pageX: 0, pageY: 0 },
      nodeAt: (x) => (x < 301 ? 2 : 3),
      nodes: {
        2: {},
        3: { frameId: "document", content: [301, 56, 1272, 56, 1272, 772, 301, 772] },
      },
    },
    "document-session": {
      scroll: { pageX: 0, pageY: 1234 },
      nodeAt: () => 4,
      nodes: { 4: {} },
    },
  });
  const frames = new ChildFrames(cdp);
  attach(frames, "viewer", "viewer-session");
  attach(frames, "document", "document-session");

  assert.deepEqual(await frames.at(640, 380), { sessionId: "document-session", x: 339, y: 324 });
  assert.deepEqual(await frames.at(150, 380), { sessionId: "viewer-session", x: 150, y: 380 });

  const documentHitTest = calls.find(
    (call) => call.method === "DOM.getNodeForLocation" && call.sessionId === "document-session",
  );
  assert.deepEqual(
    { x: documentHitTest.params.x, y: documentHitTest.params.y },
    { x: 339, y: 1558 },
  );
});

test("a frame's own root element does not count as a child frame", async () => {
  const { cdp } = fakePage({
    root: {
      scroll: { pageX: 0, pageY: 0 },
      nodeAt: () => 1,
      nodes: { 1: { frameId: "embed", content: [100, 100, 900, 100, 900, 600, 100, 600] } },
    },
    "embed-session": {
      scroll: { pageX: 0, pageY: 0 },
      nodeAt: () => 2,
      nodes: { 2: { frameId: "embed", content: [0, 0, 800, 0, 800, 500, 0, 500] } },
    },
  });
  const frames = new ChildFrames(cdp);
  attach(frames, "embed", "embed-session");

  assert.deepEqual(await frames.at(400, 300), { sessionId: "embed-session", x: 300, y: 200 });
});

test("pages without child frames resolve without asking the page anything", async () => {
  const { cdp, calls } = fakePage({});
  const frames = new ChildFrames(cdp);

  assert.equal(await frames.at(10, 10), null);
  assert.equal(calls.length, 0);
});

test("a detached frame is no longer a target", async () => {
  const { cdp } = fakePage({
    root: {
      scroll: { pageX: 0, pageY: 0 },
      nodeAt: () => 1,
      nodes: { 1: { frameId: "embed", content: [0, 0, 10, 0, 10, 10, 0, 10] } },
    },
  });
  const frames = new ChildFrames(cdp);
  attach(frames, "embed", "embed-session");
  frames.onCdpEvent("Target.detachedFromTarget", { sessionId: "embed-session" });

  assert.equal(await frames.at(5, 5), null);
});
