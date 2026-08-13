/**
 * The task graph as an MCP Apps widget: the real UI, embedded in the chat.
 *
 * A picture answers "what does it look like"; it does not answer "let me drag that node". MCP Apps
 * is the only surface in the desktop app that renders something interactive.
 *
 * This started as an iframe pointing at the local server and that turned out to be impossible: the
 * widget runs on a sandbox origin the browser treats as public, so every request it makes to a
 * loopback address - frame, script, stylesheet, fetch - is refused before it leaves the process.
 * No server-side header reaches that decision. The measurements are in `widget-report.json`.
 *
 * So the page travels with the resource instead (see `server/widget-bundle.js`) and reaches its API
 * over the host's tool bridge. What remains here is the identity of the resource and the policy the
 * document needs.
 *
 * The host only enables the bridge for resources served as `text/html;profile=mcp-app`.
 */

export const WIDGET_URI = "ui://task-tree/graph.html";
export const WIDGET_MIME = "text/html;profile=mcp-app";

/** KaTeX renders formulas in node fields, and it is the one thing still loaded from the network. */
const CDN = ["https://cdn.jsdelivr.net"];

/**
 * Loopback origins stay declared even though nothing is loaded from them any more: a host that does
 * allow local network access can still serve the page's images and links directly, and declaring an
 * origin that goes unused costs nothing.
 */
export function widgetMeta(port = 0, httpsPort = 0) {
  const local = [];
  if (httpsPort) local.push(`https://127.0.0.1:${httpsPort}`, `https://localhost:${httpsPort}`);
  if (port) local.push(`http://127.0.0.1:${port}`, `http://localhost:${port}`);
  const domains = [...CDN, ...local];
  return {
    ui: {
      csp: { connectDomains: domains, resourceDomains: domains },
      preferBorder: false
    }
  };
}

export const WIDGET_META = widgetMeta();
