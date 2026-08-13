/**
 * Status-bar button that opens the project's task graph inside the editor.
 *
 * Reuses the same server discovery the MCP entry uses: probe the ports this project has
 * recorded, verify the server actually belongs to this project, and only spawn a new one
 * when nothing is listening. The page renders in an editor tab (Simple Browser, or a
 * webview with a port mapping when Simple Browser is unavailable) instead of a browser.
 */
const vscode = require("vscode");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const HOST = "127.0.0.1";
const DEFAULT_PORT = 5177;
const START_TIMEOUT_MS = 60000;

function samePath(a, b) {
  if (!a || !b) return false;
  const normalize = (value) => path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

/** The folder holding task-tree.md wins; a single-folder workspace is the common case. */
function findProjectRoot() {
  const folders = vscode.workspace.workspaceFolders || [];
  const withTree = folders.find((folder) => fs.existsSync(path.join(folder.uri.fsPath, "task-tree.md")));
  return (withTree || folders[0])?.uri.fsPath || "";
}

function readPortList(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
}

function candidatePorts(root) {
  const ports = [
    ...readPortList(path.join(root, ".task-tree-port")),
    ...readPortList(path.join(root, ".task-tree-ports")),
    DEFAULT_PORT
  ];
  return [...new Set(ports)];
}

function getJson(port, endpoint, timeoutMs) {
  return new Promise((resolve) => {
    const request = http.get({ host: HOST, port, path: endpoint, timeout: timeoutMs }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve(null);
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    request.on("timeout", () => { request.destroy(); resolve(null); });
    request.on("error", () => resolve(null));
  });
}

async function findLivePort(root) {
  for (const port of candidatePorts(root)) {
    const project = await getJson(port, "/api/project", 1200);
    if (project && samePath(project.root, root)) return port;
  }
  return 0;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, HOST, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** The stub records where the shared kit lives; an embedded copy has server.js in the project. */
function resolveKitDir(root) {
  const configFile = path.join(root, "llm-task-tree", "task-tree.config.json");
  if (fs.existsSync(configFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, "utf8").replace(/^\uFEFF/, ""));
      const shared = config.sharedKitDir;
      if (shared && fs.existsSync(path.join(shared, "server.js"))) return shared;
    } catch {
      // fall through
    }
  }
  for (const candidate of [path.join(root, "llm-task-tree"), root]) {
    if (fs.existsSync(path.join(candidate, "server.js"))) return candidate;
  }
  return "";
}

function rememberPort(root, port) {
  try {
    fs.writeFileSync(path.join(root, ".task-tree-port"), `${port}\n`, "utf8");
    const knownFile = path.join(root, ".task-tree-ports");
    if (!readPortList(knownFile).includes(port)) fs.appendFileSync(knownFile, `${port}\n`, "utf8");
  } catch {
    // recording the port is a convenience, not a requirement
  }
}

async function startServer(root) {
  const kit = resolveKitDir(root);
  if (!kit) {
    throw new Error(`找不到任务图运行时（server.js）。检查 ${path.join(root, "llm-task-tree", "task-tree.config.json")}`);
  }

  const port = await freePort();
  const child = spawn(process.execPath.endsWith("node.exe") ? process.execPath : "node", ["server.js"], {
    cwd: kit,
    env: {
      ...process.env,
      HOST,
      PORT: String(port),
      TASK_TREE_STUB_DIR: fs.existsSync(path.join(root, "llm-task-tree")) ? path.join(root, "llm-task-tree") : "",
      TASK_TREE_PROJECT_ROOT: root
    },
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const project = await getJson(port, "/api/project", 800);
    if (project && samePath(project.root, root)) {
      rememberPort(root, port);
      return port;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`任务图服务在 ${START_TIMEOUT_MS / 1000}s 内没有起来（端口 ${port}）`);
}

async function openInEditor(url, port) {
  try {
    await vscode.commands.executeCommand("simpleBrowser.show", url);
    return "simple-browser";
  } catch {
    // Simple Browser is a built-in extension; fall back to our own tab when it is missing.
  }

  const panel = vscode.window.createWebviewPanel("llmTaskTree.panel", "任务图", vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    portMapping: [{ webviewPort: port, extensionHostPort: port }]
  });
  panel.webview.html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${url} http://${HOST}:${port};">
<style>html,body,iframe{margin:0;padding:0;height:100%;width:100%;border:0;display:block}</style>
</head>
<body><iframe src="${url}" allow="clipboard-read; clipboard-write"></iframe></body>
</html>`;
  return "webview";
}

async function openTaskTree() {
  const root = findProjectRoot();
  if (!root) {
    vscode.window.showWarningMessage("任务图：当前没有打开的工作区文件夹。");
    return;
  }

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "任务图" }, async (progress) => {
    try {
      let port = await findLivePort(root);
      if (!port) {
        progress.report({ message: "正在启动服务…" });
        port = await startServer(root);
      }
      await openInEditor(`http://${HOST}:${port}`, port);
    } catch (error) {
      vscode.window.showErrorMessage(`任务图打开失败：${error.message}`);
    }
  });
}

async function openExternal() {
  const root = findProjectRoot();
  if (!root) return;
  const port = (await findLivePort(root)) || (await startServer(root));
  await vscode.env.openExternal(vscode.Uri.parse(`http://${HOST}:${port}`));
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("llmTaskTree.open", openTaskTree),
    vscode.commands.registerCommand("llmTaskTree.openExternal", openExternal)
  );

  const button = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  button.text = "$(type-hierarchy) 任务图";
  button.tooltip = "打开本项目的任务图（在编辑器里）";
  button.command = "llmTaskTree.open";
  context.subscriptions.push(button);

  const sync = () => {
    const enabled = vscode.workspace.getConfiguration("llmTaskTree").get("showStatusBarButton", true);
    if (enabled && findProjectRoot()) button.show();
    else button.hide();
  };
  sync();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("llmTaskTree.showStatusBarButton")) sync();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(sync)
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
