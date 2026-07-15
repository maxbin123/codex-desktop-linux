#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter, once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {
  BrowserUiRuntime,
  RPC_BRIDGE_METHODS,
  SERVICE_RESTART_CLOSE_CODE,
  SUPERSEDED_CLOSE_CODE,
  injectBrowserBridge,
  isAllowedBrowserHost,
  isAuthorizedWebSocketRequest,
  isPathWithinRoots,
  isPrimaryBridgeWindowCandidate,
  isSameOriginBrowserResourceRequest,
  safeStaticPath,
} = require("./runtime.cjs");
const {
  BROWSER_UI_BOOTSTRAP_MARKER,
  BROWSER_UI_PRELOAD_RELAY_MARKER,
  applyBrowserUiBootstrap,
  applyBrowserUiPreloadRelay,
  descriptors,
  patchBrowserUiPreloadRelay,
} = require("./patch.js");
const {
  enabledLinuxFeatureInstallPlan,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");

const MAIN_FIXTURE = "exports.runMainAppStartup=()=>{};";
const PRELOAD_FIXTURE =
  '"use strict";(()=>{var e=require(`electron`),d=`codex_desktop:connect-app-host`,S={seed:1},j={' +
  'existing:!0,windowType:`electron`,getPreloadStartedAtMs:()=>0,sendMessageFromView:async()=>{},' +
  'getPathForFile:()=>null,startFileDrag:()=>!1,sendWorkerMessageFromView:async()=>{},' +
  'subscribeToWorkerMessages:()=>()=>{},showContextMenu:async()=>{},showApplicationMenu:async()=>{},' +
  'getFastModeRolloutMetrics:async()=>null,getSharedObjectSnapshotValue:e=>S[e],' +
  'getSystemThemeVariant:()=>`light`,subscribeToSystemThemeVariant:()=>()=>{},' +
  'triggerSentryTestError:async()=>{},getSentryInitOptions:()=>({codexAppSessionId:`test`}),' +
  'getAppSessionId:()=>`test`,getBuildFlavor:()=>`prod`,isDeviceCheckSupported:()=>!1,' +
  'isIntelMacBuild:()=>!1,usesOwlAppShell:()=>!1};' +
  'e.contextBridge.exposeInMainWorld(`electronBridge`,j)})();';

function createBrowserBridgeHarness({ failedHealthProbes = 0 } = {}) {
  const listeners = new Map();
  const sockets = [];
  const timers = new Map();
  let timerCounter = 0;
  let reloads = 0;
  let healthProbeAttempts = 0;

  const addListener = (type, callback) => {
    const callbacks = listeners.get(type) ?? [];
    callbacks.push(callback);
    listeners.set(type, callbacks);
  };
  const window = {
    addEventListener: addListener,
    dispatchEvent(event) {
      for (const callback of listeners.get(event.type) ?? []) callback(event);
    },
    location: null,
    open() {},
  };
  const location = {
    protocol: "http:",
    host: "localhost:5999",
    href: "http://localhost:5999/",
    origin: "http://localhost:5999",
    reload() {
      reloads += 1;
    },
  };
  window.location = location;
  window.__CODEX_BROWSER_UI_CONFIG__ = {
    platformArch: "x64",
    sessionToken: "test-session-token",
    wsPath: "/__codex_browser_ui/ws",
  };

  class FakeWebSocket {
    static OPEN = 1;

    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = new Map();
      this.sent = [];
      sockets.push(this);
    }

    addEventListener(type, callback) {
      const callbacks = this.listeners.get(type) ?? [];
      callbacks.push(callback);
      this.listeners.set(type, callbacks);
    }

    emit(type, value = {}) {
      if (type === "open") this.readyState = FakeWebSocket.OPEN;
      if (type === "close") this.readyState = 3;
      for (const callback of this.listeners.get(type) ?? []) callback(value);
    }

    send(value) {
      this.sent.push(value);
    }

    close() {
      this.emit("close", { code: 1006 });
    }
  }

  function Document() {}
  Document.prototype.createElement = () => ({});
  function HTMLIFrameElement() {}
  Object.defineProperty(HTMLIFrameElement.prototype, "src", {
    configurable: true,
    get() {
      return this.__src || "";
    },
    set(value) {
      this.__src = String(value);
    },
  });
  function Element() {}
  const document = {
    body: null,
    documentElement: {
      classList: { toggle() {} },
      dataset: {},
    },
    querySelectorAll: () => [],
  };
  class MutationObserver {
    observe() {}
  }

  const context = {
    Blob,
    Document,
    Element,
    Event,
    File: class File {},
    HTMLIFrameElement,
    MessageChannel,
    MessageEvent,
    MutationObserver,
    Notification: class Notification {},
    URL,
    WebSocket: FakeWebSocket,
    XMLHttpRequest: class XMLHttpRequest {},
    addEventListener: addListener,
    clearTimeout(id) {
      timers.delete(id);
    },
    console,
    document,
    fetch: async (url) => {
      assert.equal(url, "/healthz");
      healthProbeAttempts += 1;
      if (healthProbeAttempts <= failedHealthProbes) throw new Error("server unavailable");
      return { ok: false, status: 503 };
    },
    innerHeight: 800,
    innerWidth: 1200,
    location,
    matchMedia: () => ({ matches: false }),
    navigator: {
      clipboard: null,
      sendBeacon: () => true,
      userAgent: "Mozilla/5.0 (Macintosh)",
    },
    performance: { timeOrigin: 123 },
    queueMicrotask,
    removeEventListener() {},
    setTimeout(callback, delay = 0) {
      const id = ++timerCounter;
      timers.set(id, { callback, delay });
      return id;
    },
    window,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "browser-ui-bridge.js"), "utf8"), context);

  return {
    emitWindowMessage(event) {
      for (const callback of listeners.get("message") ?? []) callback(event);
    },
    get reloads() {
      return reloads;
    },
    get healthProbeAttempts() {
      return healthProbeAttempts;
    },
    async runNextTimer() {
      const next = [...timers.entries()].sort((left, right) => left[1].delay - right[1].delay)[0];
      if (!next) return false;
      timers.delete(next[0]);
      await next[1].callback();
      return true;
    },
    sockets,
    timers,
    window,
  };
}

function withFeatureRoot(enabled, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-ui-test-"));
  try {
    fs.writeFileSync(path.join(root, "features.example.json"), '{"enabled":[]}\n');
    fs.writeFileSync(path.join(root, "features.json"), `${JSON.stringify({ enabled })}\n`);
    fs.cpSync(__dirname, path.join(root, "browser-ui"), { recursive: true });
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const BROWSER_LAUNCHER_ENV_KEYS = [
  "BROWSER_UI_CAPTURE",
  "BROWSER_UI_FAKE_EXIT",
  "BROWSER_UI_XVFB_STOP",
  "CODEX_BROWSER_UI_APP_LAUNCHER",
  "CODEX_BROWSER_UI_HEADLESS",
  "CODEX_BROWSER_UI_HOST",
  "CODEX_BROWSER_UI_PORT",
  "CODEX_BROWSER_UI_WORKSPACE",
  "CODEX_BROWSER_UI_XVFB_SCREEN",
  "CODEX_LINUX_WEB_UI",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "GDK_BACKEND",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
];

function createBrowserLauncherFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-ui-launcher-"));
  const appRoot = path.join(root, "codex-app");
  const featureDir = path.join(appRoot, ".codex-linux", "features", "browser-ui");
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const capture = path.join(root, "capture.txt");
  const launcher = path.join(featureDir, "launch.sh");
  const appLauncher = path.join(appRoot, "start.sh");

  fs.mkdirSync(featureDir, { recursive: true });
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  fs.copyFileSync(path.join(__dirname, "launch.sh"), launcher);
  fs.chmodSync(launcher, 0o755);
  fs.writeFileSync(
    appLauncher,
    "#!/usr/bin/env bash\n" +
      "{\n" +
      "  printf 'web=%s\\n' \"\${CODEX_LINUX_WEB_UI:-}\"\n" +
      "  printf 'workspace=%s\\n' \"\${CODEX_BROWSER_UI_WORKSPACE:-}\"\n" +
      "  printf 'host=%s\\n' \"\${CODEX_BROWSER_UI_HOST:-}\"\n" +
      "  printf 'port=%s\\n' \"\${CODEX_BROWSER_UI_PORT:-}\"\n" +
      "  printf 'display=%s\\n' \"\${DISPLAY:-}\"\n" +
      "  printf 'session=%s\\n' \"\${XDG_SESSION_TYPE:-}\"\n" +
      "  printf 'runtime=%s\\n' \"\${XDG_RUNTIME_DIR:-}\"\n" +
      "  printf 'arg=%s\\n' \"$@\"\n" +
      "} >\"$BROWSER_UI_CAPTURE\"\n" +
      "exit \"\${BROWSER_UI_FAKE_EXIT:-0}\"\n",
    { mode: 0o755 },
  );

  return { appLauncher, appRoot, capture, featureDir, home, launcher, root, workspace };
}

function browserLauncherEnvironment(fixture, overrides = {}) {
  const env = { ...process.env };
  for (const key of BROWSER_LAUNCHER_ENV_KEYS) delete env[key];
  Object.assign(env, {
    BROWSER_UI_CAPTURE: fixture.capture,
    BROWSER_UI_FAKE_EXIT: "0",
    HOME: fixture.home,
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value == null) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

function runBrowserLauncher(fixture, { args = [], env = {} } = {}) {
  return spawnSync(fixture.launcher, args, {
    cwd: fixture.workspace,
    encoding: "utf8",
    env: browserLauncherEnvironment(fixture, env),
  });
}

function evaluatePatchedSource({ env, platform = "linux", resourcesPath = "/opt/codex/resources" }) {
  const electron = { app: { name: "test-electron" } };
  const calls = [];
  const expectedRuntimePath = path.join(
    env.CODEX_LINUX_FEATURES_DIR ?? "/opt/codex/.codex-linux/features",
    "browser-ui",
    "runtime.cjs",
  );
  const runtime = {
    installBrowserUi(options) {
      calls.push(options);
    },
  };
  const context = {
    console,
    exports: {},
    process: { env, platform, resourcesPath },
    require(specifier) {
      if (specifier === "node:path") return path;
      if (specifier === "electron") return electron;
      if (specifier === expectedRuntimePath) return runtime;
      throw new Error(`Unexpected require: ${specifier}`);
    },
  };

  vm.runInNewContext(applyBrowserUiBootstrap(MAIN_FIXTURE), context);
  return { calls, electron, expectedRuntimePath };
}

test("browser UI bootstrap patch is idempotent", () => {
  const once = applyBrowserUiBootstrap(MAIN_FIXTURE);
  const twice = applyBrowserUiBootstrap(once);

  assert.equal(twice, once);
  assert.equal(twice.split(BROWSER_UI_BOOTSTRAP_MARKER).length - 1, 1);
  assert.equal(descriptors.length, 2);
  assert.equal(descriptors[0].phase, "main-bundle");
  assert.equal(descriptors[1].phase, "extracted-app:post-webview");
});

test("browser UI preload relay patch is idempotent and preserves the source map trailer", () => {
  const source = `${PRELOAD_FIXTURE}\n//# sourceMappingURL=preload.js.map\n`;
  const once = applyBrowserUiPreloadRelay(source);
  const twice = applyBrowserUiPreloadRelay(once);

  assert.notEqual(once, source);
  assert.equal(twice, once);
  assert.equal(once.split(BROWSER_UI_PRELOAD_RELAY_MARKER).length - 1, 1);
  assert.match(once, /__browserUiConnectPort\(id\)/u);
  assert.match(once, /__browserUiPostPortMessage\(id,data\)/u);
  assert.match(once, /__browserUiClosePort\(id\)/u);
  assert.match(once, /__browserUiGetSharedSnapshot\(\)/u);
  assert.ok(once.endsWith(`//# sourceMappingURL=preload.js.map\n`));
});

test("browser UI preload relay connects, forwards, posts, and closes MessagePorts", () => {
  const source = PRELOAD_FIXTURE;
  const exposed = {};
  const ipcCalls = [];
  const channels = [];
  const ipcHandlers = new Map();

  class FakePort {
    constructor() {
      this.closed = false;
      this.onmessage = null;
      this.peer = null;
    }

    postMessage(data) {
      this.peer?.onmessage?.({ data });
    }

    start() {}

    close() {
      this.closed = true;
    }
  }

  class FakeMessageChannel {
    constructor() {
      this.port1 = new FakePort();
      this.port2 = new FakePort();
      this.port1.peer = this.port2;
      this.port2.peer = this.port1;
      channels.push(this);
    }
  }

  const electron = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        exposed[name] = value;
      },
    },
    ipcRenderer: {
      postMessage(...args) {
        ipcCalls.push(["postMessage", ...args]);
      },
      send(...args) {
        ipcCalls.push(["send", ...args]);
      },
      on(channel, callback) {
        ipcHandlers.set(channel, callback);
      },
    },
  };
  vm.runInNewContext(applyBrowserUiPreloadRelay(source), {
    MessageChannel: FakeMessageChannel,
    process: { env: { CODEX_LINUX_WEB_UI: "1" }, platform: "linux" },
    require(specifier) {
      assert.equal(specifier, "electron");
      return electron;
    },
  });

  const bridge = exposed.electronBridge;
  assert.equal(bridge.existing, true);
  assert.deepEqual(JSON.parse(JSON.stringify(bridge.__browserUiGetSharedSnapshot())), { seed: 1 });
  assert.equal(bridge.__browserUiConnectPort("worker-1"), true);
  assert.equal(channels.length, 1);
  assert.equal(ipcCalls[0][0], "postMessage");
  assert.equal(ipcCalls[0][1], "codex_desktop:connect-app-host");
  assert.equal(ipcCalls[0][3][0], channels[0].port2);

  channels[0].port2.postMessage({ from: "worker" });
  assert.deepEqual(JSON.parse(JSON.stringify(ipcCalls[1])), [
    "send",
    "codex_linux_browser_ui:port-message",
    { id: "worker-1", data: { from: "worker" } },
  ]);

  const delivered = [];
  channels[0].port2.onmessage = (event) => delivered.push(event.data);
  assert.equal(bridge.__browserUiPostPortMessage("worker-1", { from: "browser" }), true);
  assert.deepEqual(delivered, [{ from: "browser" }]);
  ipcHandlers.get("codex_linux_browser_ui:port-message")(null, {
    id: "worker-1",
    data: { from: "main-ipc" },
  });
  assert.deepEqual(delivered, [{ from: "browser" }, { from: "main-ipc" }]);
  ipcHandlers.get("codex_linux_browser_ui:port-close")(null, { id: "worker-1" });
  assert.equal(channels[0].port1.closed, true);
  assert.equal(bridge.__browserUiPostPortMessage("worker-1", "late"), false);

  assert.equal(bridge.__browserUiConnectPort("worker-2"), true);
  assert.equal(bridge.__browserUiClosePort("worker-2"), true);
  assert.equal(channels[1].port1.closed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(ipcCalls.at(-1))), [
    "send",
    "codex_linux_browser_ui:port-close",
    { id: "worker-2" },
  ]);
  assert.equal(bridge.__browserUiPostPortMessage("worker-2", "late"), false);
});

test("browser UI preload relay patches the extracted preload bundle idempotently", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-ui-preload-test-"));
  try {
    const preloadPath = path.join(root, ".vite", "build", "preload.js");
    fs.mkdirSync(path.dirname(preloadPath), { recursive: true });
    fs.writeFileSync(
      preloadPath,
      `${PRELOAD_FIXTURE}\n`,
    );

    assert.deepEqual(patchBrowserUiPreloadRelay(root), { matched: true, changed: 1 });
    assert.deepEqual(patchBrowserUiPreloadRelay(root), { matched: true, changed: 0 });
    assert.match(fs.readFileSync(preloadPath, "utf8"), new RegExp(BROWSER_UI_PRELOAD_RELAY_MARKER));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("browser UI runtime stays dormant without the explicit environment flag", () => {
  assert.deepEqual(evaluatePatchedSource({ env: {} }).calls, []);
  assert.deepEqual(evaluatePatchedSource({ env: { CODEX_LINUX_WEB_UI: "0" } }).calls, []);
  assert.deepEqual(
    evaluatePatchedSource({ env: { CODEX_LINUX_WEB_UI: "1" }, platform: "darwin" }).calls,
    [],
  );
});

test("browser UI runtime defaults its file root to the user home directory", () => {
  const originalWorkspace = process.env.CODEX_BROWSER_UI_WORKSPACE;
  delete process.env.CODEX_BROWSER_UI_WORKSPACE;
  try {
    const runtime = new BrowserUiRuntime({});
    assert.equal(runtime.workspaceRoot, path.resolve(os.homedir()));
    assert.notEqual(runtime.workspaceRoot, "/workspace");
  } finally {
    if (originalWorkspace == null) delete process.env.CODEX_BROWSER_UI_WORKSPACE;
    else process.env.CODEX_BROWSER_UI_WORKSPACE = originalWorkspace;
  }
});

test("browser UI runtime loads from the staged feature directory when enabled", () => {
  const featuresDir = "/tmp/codex-features";
  const result = evaluatePatchedSource({
    env: {
      CODEX_LINUX_FEATURES_DIR: featuresDir,
      CODEX_LINUX_WEB_UI: "1",
    },
  });

  assert.equal(
    result.expectedRuntimePath,
    path.join(featuresDir, "browser-ui", "runtime.cjs"),
  );
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].electron, result.electron);
});

test("browser UI feature exposes its patch and staged resource plan only when enabled", () => {
  withFeatureRoot([], (root) => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot: root }), []);
    assert.deepEqual(enabledLinuxFeatureInstallPlan({ featuresRoot: root }), {
      resources: [],
      runtimeHooks: [],
    });
  });

  withFeatureRoot(["browser-ui"], (root) => {
    const patches = loadLinuxFeaturePatchDescriptors({ featuresRoot: root });
    assert.equal(patches.length, 2);
    assert.equal(patches[0].name, "feature:browser-ui:browser-ui-main-bootstrap");
    assert.equal(patches[1].name, "feature:browser-ui:browser-ui-preload-port-relay");

    const plan = enabledLinuxFeatureInstallPlan({ featuresRoot: root });
    assert.deepEqual(plan.resources.map((resource) => resource.target), [
      ".codex-linux/features/browser-ui/runtime.cjs",
      ".codex-linux/features/browser-ui/browser-ui-bridge.js",
      ".codex-linux/features/browser-ui/launch.sh",
    ]);
    assert.deepEqual(plan.resources.map((resource) => resource.mode), [0o644, 0o644, 0o755]);
    assert.deepEqual(plan.runtimeHooks, []);
  });
});

test("browser UI launcher is valid shell and contains no fixed workspace assumption", () => {
  const syntax = spawnSync("bash", ["-n", path.join(__dirname, "launch.sh")], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);

  for (const name of ["README.md", "browser-ui-bridge.js", "feature.json", "launch.sh", "runtime.cjs"]) {
    const source = fs.readFileSync(path.join(__dirname, name), "utf8");
    assert.doesNotMatch(source, /\/workspace\b/u, name);
  }
});

test("browser UI launcher reuses a graphical session and preserves the caller workspace", () => {
  const fixture = createBrowserLauncherFixture();
  try {
    const result = runBrowserLauncher(fixture, {
      args: ["--quick-chat"],
      env: {
        BROWSER_UI_FAKE_EXIT: "23",
        CODEX_BROWSER_UI_PORT: "05999",
        DISPLAY: ":88",
      },
    });

    assert.equal(result.status, 23, result.stderr);
    assert.match(result.stderr, /browser UI: http:\/\/localhost:5999\//u);
    const capture = fs.readFileSync(fixture.capture, "utf8");
    assert.match(capture, /^web=1$/mu);
    assert.match(capture, new RegExp("^workspace=" + fs.realpathSync(fixture.workspace) + "$", "mu"));
    assert.match(capture, /^host=127\.0\.0\.1$/mu);
    assert.match(capture, /^port=5999$/mu);
    assert.match(capture, /^display=:88$/mu);
    assert.match(capture, /^arg=--new-instance$/mu);
    assert.match(capture, /^arg=--quick-chat$/mu);
    assert.doesNotMatch(capture, /^arg=--x11$/mu);
    assert.doesNotMatch(capture, /^arg=--password-store=basic$/mu);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("browser UI launcher allows wildcard binding for local namespace forwarding", () => {
  const fixture = createBrowserLauncherFixture();
  try {
    for (const host of ["0.0.0.0", "::"]) {
      fs.rmSync(fixture.capture, { force: true });
      const result = runBrowserLauncher(fixture, {
        env: { CODEX_BROWSER_UI_HOST: host, DISPLAY: ":88" },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(fs.readFileSync(fixture.capture, "utf8"), new RegExp("^host=" + host.replaceAll(".", "\\.") + "$", "mu"));
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("browser UI launcher rejects invalid local runtime configuration", () => {
  const fixture = createBrowserLauncherFixture();
  try {
    const cases = [
      { CODEX_BROWSER_UI_PORT: "0", DISPLAY: ":88" },
      { CODEX_BROWSER_UI_PORT: "65536", DISPLAY: ":88" },
      { CODEX_BROWSER_UI_PORT: "not-a-port", DISPLAY: ":88" },
      { CODEX_BROWSER_UI_HEADLESS: "sometimes", DISPLAY: ":88" },
      { CODEX_BROWSER_UI_HOST: "192.0.2.10", DISPLAY: ":88" },
      { CODEX_BROWSER_UI_WORKSPACE: path.join(fixture.root, "missing"), DISPLAY: ":88" },
      { HOME: "relative-home", DISPLAY: ":88" },
      { CODEX_BROWSER_UI_HEADLESS: "0", DISPLAY: null, WAYLAND_DISPLAY: null },
    ];

    for (const env of cases) {
      fs.rmSync(fixture.capture, { force: true });
      const result = runBrowserLauncher(fixture, { env });
      assert.equal(result.status, 64, result.stderr);
      assert.equal(fs.existsSync(fixture.capture), false);
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("browser UI launcher owns and cleans up a private headless display", {
  skip: process.platform !== "linux",
}, () => {
  const fixture = createBrowserLauncherFixture();
  const fakeBin = path.join(fixture.root, "bin");
  const xvfbStop = path.join(fixture.root, "xvfb-stopped");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, "Xvfb"),
    "#!/usr/bin/env bash\n" +
      "trap 'printf stopped >\"$BROWSER_UI_XVFB_STOP\"; exit 0' TERM INT HUP\n" +
      "printf '77\\n' >&3\n" +
      "while :; do sleep 0.1; done\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(fakeBin, "dbus-run-session"),
    "#!/usr/bin/env bash\n" +
      "if [[ \"\${1:-}\" == -- ]]; then shift; fi\n" +
      "exec \"$@\"\n",
    { mode: 0o755 },
  );

  try {
    const result = runBrowserLauncher(fixture, {
      args: ["--quick-chat"],
      env: {
        BROWSER_UI_FAKE_EXIT: "23",
        BROWSER_UI_XVFB_STOP: xvfbStop,
        CODEX_BROWSER_UI_HEADLESS: "1",
        DISPLAY: null,
        PATH: fakeBin + path.delimiter + process.env.PATH,
        WAYLAND_DISPLAY: null,
      },
    });

    assert.equal(result.status, 23, result.stderr);
    assert.equal(fs.readFileSync(xvfbStop, "utf8"), "stopped");
    const capture = fs.readFileSync(fixture.capture, "utf8");
    assert.match(capture, /^display=:77$/mu);
    assert.match(capture, /^session=x11$/mu);
    assert.match(capture, /^arg=--new-instance$/mu);
    assert.match(capture, /^arg=--x11$/mu);
    assert.match(capture, /^arg=--password-store=basic$/mu);
    assert.match(capture, /^arg=--quick-chat$/mu);
    const runtimeDir = capture.match(/^runtime=(.+)$/mu)?.[1];
    assert.ok(runtimeDir);
    assert.equal(fs.existsSync(runtimeDir), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("browser UI launcher fails closed when its private display exits", {
  skip: process.platform !== "linux",
}, () => {
  const fixture = createBrowserLauncherFixture();
  const fakeBin = path.join(fixture.root, "bin");
  const appStop = path.join(fixture.root, "app-stopped");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, "Xvfb"),
    "#!/usr/bin/env bash\n" +
      "printf '78\\n' >&3\n" +
      "sleep 0.2\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(fakeBin, "dbus-run-session"),
    "#!/usr/bin/env bash\n" +
      "if [[ \"\${1:-}\" == -- ]]; then shift; fi\n" +
      "exec \"$@\"\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(
    fixture.appLauncher,
    "#!/usr/bin/env bash\n" +
      "trap 'printf stopped >\"$BROWSER_UI_CAPTURE\"; exit 0' TERM INT HUP\n" +
      "while :; do sleep 0.1; done\n",
    { mode: 0o755 },
  );

  try {
    const result = runBrowserLauncher(fixture, {
      env: {
        BROWSER_UI_CAPTURE: appStop,
        CODEX_BROWSER_UI_HEADLESS: "1",
        DISPLAY: null,
        PATH: fakeBin + path.delimiter + process.env.PATH,
        WAYLAND_DISPLAY: null,
      },
    });

    assert.equal(result.status, 70, result.stderr);
    assert.match(result.stderr, /Xvfb exited while the Electron host was running/u);
    assert.equal(fs.readFileSync(appStop, "utf8"), "stopped");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("browser UI HTML injection keeps the upstream module and enables same-origin bridge transport", () => {
  const source =
    `<!doctype html><html><head>` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; connect-src 'self'; frame-src 'self';">` +
    `<script type="module" src="/assets/index.js"></script></head><body></body></html>`;
  const patched = injectBrowserBridge(source);

  assert.match(patched, /\/__codex_browser_ui\/config\.js/u);
  assert.match(patched, /\/__codex_browser_ui\/bridge\.js/u);
  assert.match(patched, /<base href="\/">/u);
  assert.match(patched, /connect-src 'self' ws: wss:;/u);
  assert.match(patched, /frame-src 'self' https:;/u);
  assert.ok(patched.indexOf("config.js") < patched.indexOf("/assets/index.js"));
  assert.equal(injectBrowserBridge(patched), patched);

  const root = path.join(os.tmpdir(), "browser-ui-static-root");
  assert.equal(safeStaticPath(root, "/assets/index.js"), path.join(root, "assets", "index.js"));
  assert.equal(safeStaticPath(root, "/../../etc/passwd"), null);
});

test("browser UI transport accepts only local hosts, matching origins, tokens, and file roots", () => {
  assert.equal(isAllowedBrowserHost("localhost:5999"), true);
  assert.equal(isAllowedBrowserHost("127.0.0.1:5999"), true);
  assert.equal(isAllowedBrowserHost("evil.example:5999"), false);

  const requestUrl = new URL("http://localhost:5999/__codex_browser_ui/ws?token=secret");
  assert.equal(isAuthorizedWebSocketRequest({
    headers: { host: "localhost:5999", origin: "http://localhost:5999" },
  }, requestUrl, "secret"), true);
  assert.equal(isAuthorizedWebSocketRequest({
    headers: { host: "localhost:5999", origin: "https://evil.example" },
  }, requestUrl, "secret"), false);
  assert.equal(isAuthorizedWebSocketRequest({
    headers: { host: "localhost:5999", origin: "https://localhost:5999" },
  }, requestUrl, "secret"), false);
  assert.equal(isAuthorizedWebSocketRequest({
    headers: { host: "localhost:5999", origin: "http://localhost:5999" },
  }, requestUrl, "wrong"), false);
  assert.equal(isAuthorizedWebSocketRequest({
    headers: { host: "evil.example:5999", origin: "http://evil.example:5999" },
  }, new URL("http://evil.example:5999/__codex_browser_ui/ws?token=secret"), "secret"), false);
  assert.equal(isSameOriginBrowserResourceRequest({
    headers: {
      host: "localhost:5999",
      referer: "http://localhost:5999/",
      "sec-fetch-site": "same-origin",
    },
  }), true);
  assert.equal(isSameOriginBrowserResourceRequest({
    headers: {
      host: "localhost:5999",
      referer: "https://evil.example/",
      "sec-fetch-site": "cross-site",
    },
  }), false);
  assert.equal(isSameOriginBrowserResourceRequest({
    headers: {
      host: "localhost:5999",
      referer: "https://localhost:5999/",
    },
  }), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-ui-root-test-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-ui-outside-test-"));
  try {
    const insideFile = path.join(root, "inside.txt");
    const outsideFile = path.join(outside, "outside.txt");
    const escapeLink = path.join(root, "escape.txt");
    fs.writeFileSync(insideFile, "inside");
    fs.writeFileSync(outsideFile, "outside");
    fs.symlinkSync(outsideFile, escapeLink);
    assert.equal(isPathWithinRoots(insideFile, [root]), true);
    assert.equal(isPathWithinRoots(outsideFile, [root]), false);
    assert.equal(isPathWithinRoots(escapeLink, [root]), false);
    assert.equal(isPathWithinRoots(outsideFile, [path.parse(outsideFile).root]), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }

  assert.equal(RPC_BRIDGE_METHODS.has("sendMessageFromView"), true);
  assert.equal(RPC_BRIDGE_METHODS.has("getPathForFile"), false);
});

test("browser bridge waits for a restarted server before refreshing a rotated token", async () => {
  const harness = createBrowserBridgeHarness({ failedHealthProbes: 2 });
  assert.equal(harness.sockets.length, 1);
  assert.match(harness.sockets[0].url, /token=test-session-token/u);
  assert.equal(harness.window.document, undefined);
  assert.equal(harness.window.electronBridge.windowType, "electron");

  const firstSocket = harness.sockets[0];
  firstSocket.emit("open");
  const rpcPromise = harness.window.electronBridge.sendMessageFromView({ type: "unit-test" });
  const rpcMessage = JSON.parse(firstSocket.sent.at(-1));
  assert.equal(rpcMessage.method, "sendMessageFromView");
  firstSocket.emit("message", {
    data: JSON.stringify({ type: "rpc-result", requestId: rpcMessage.requestId, result: true }),
  });
  await rpcPromise;

  const localPort = {
    closeCalled: false,
    close() {
      this.closeCalled = true;
    },
    start() {},
  };
  harness.emitWindowMessage({
    data: { type: "connect-app-host" },
    origin: "http://localhost:5999",
    ports: [localPort],
    source: harness.window,
  });
  assert.equal(JSON.parse(firstSocket.sent.at(-1)).type, "port-connect");

  firstSocket.emit("close", { code: 1006 });
  assert.equal(localPort.closeCalled, true);
  assert.equal(await harness.runNextTimer(), true);
  assert.equal(harness.reloads, 0);
  assert.equal(await harness.runNextTimer(), true);
  assert.equal(harness.reloads, 0);
  assert.equal(await harness.runNextTimer(), true);
  assert.equal(harness.reloads, 1);
  assert.equal(harness.healthProbeAttempts, 3);
  assert.equal(harness.sockets.length, 1);
});

test("browser bridge refreshes a token rotated before the first WebSocket opens", async () => {
  const harness = createBrowserBridgeHarness({ failedHealthProbes: 1 });
  harness.sockets[0].emit("close", { code: 1006 });
  assert.equal(await harness.runNextTimer(), true);
  assert.equal(harness.reloads, 0);
  assert.equal(await harness.runNextTimer(), true);
  assert.equal(harness.reloads, 1);
  assert.equal(harness.healthProbeAttempts, 2);
  assert.equal(harness.sockets.length, 1);
});

test("browser bridge treats a newer tab as superseding instead of reconnecting", async () => {
  const harness = createBrowserBridgeHarness();
  const socket = harness.sockets[0];
  socket.emit("open");
  const pending = harness.window.electronBridge.triggerSentryTestError().catch((error) => error);
  socket.emit("close", { code: SUPERSEDED_CLOSE_CODE });
  assert.match((await pending).message, /newer Codex tab/u);
  assert.equal(await harness.runNextTimer(), false);
  assert.equal(harness.sockets.length, 1);
});

test("browser UI uses accessible DOM dialogs instead of unsupported prompt APIs", () => {
  const source = fs.readFileSync(path.join(__dirname, "browser-ui-bridge.js"), "utf8");

  assert.doesNotMatch(source, /window\.(?:prompt|confirm)\s*\(/u);
  assert.match(source, /dataset\.codexBrowserUiDialog/u);
  assert.match(source, /dataset\.codexDialogPath/u);
  assert.match(source, /dataset\.codexDialogFilePicker/u);
  assert.match(source, /setAttribute\("aria-modal", "true"\)/u);
});

test("browser UI discovery ignores ready auxiliary windows and waits for the primary", async () => {
  let primaryReady = false;
  let primaryUrl = "http://127.0.0.1:5175/";
  let auxiliaryProbeCount = 0;
  const makeWindow = ({ getUrl, probe }) => {
    const webContents = new EventEmitter();
    webContents.getURL = getUrl;
    webContents.isDestroyed = () => false;
    webContents.send = () => {};
    webContents.executeJavaScript = async (source) => {
      if (source.includes("Boolean(window.electronBridge")) return probe();
      if (source.includes("const b=window.electronBridge")) return { sharedObjects: {} };
      return null;
    };
    const browserWindow = new EventEmitter();
    browserWindow.hide = () => {};
    browserWindow.isDestroyed = () => false;
    browserWindow.setSkipTaskbar = () => {};
    browserWindow.webContents = webContents;
    browserWindow.loadURL = async (url) => {
      primaryUrl = url;
    };
    return browserWindow;
  };
  const primary = makeWindow({ getUrl: () => primaryUrl, probe: () => primaryReady });
  const auxiliary = makeWindow({
    getUrl: () => "http://127.0.0.1:5175/?initialRoute=%2Fsettings",
    probe: () => {
      auxiliaryProbeCount += 1;
      return true;
    },
  });
  const wrongOrigin = makeWindow({
    getUrl: () => "http://127.0.0.1:7777/",
    probe: () => true,
  });
  const runtime = new BrowserUiRuntime({
    BrowserWindow: { getAllWindows: () => [auxiliary, wrongOrigin, primary] },
  });

  assert.equal(isPrimaryBridgeWindowCandidate(primary), true);
  assert.equal(isPrimaryBridgeWindowCandidate(auxiliary), false);
  assert.equal(isPrimaryBridgeWindowCandidate(wrongOrigin), false);
  await runtime.discoverBridgeWindow();
  assert.equal(runtime.bridgeWindow, null);
  assert.equal(auxiliaryProbeCount, 0);

  primaryReady = true;
  await runtime.discoverBridgeWindow();
  assert.match(primaryUrl, /__codex_browser_ui_backend__/u);
  assert.equal(runtime.bridgeWindow, null);
  await runtime.discoverBridgeWindow();
  assert.equal(runtime.bridgeWindow, primary);
  runtime.bridgeLifecycleCleanup?.();
});

test("browser UI invalidates preload ports on navigation and renderer loss", () => {
  const reloadUrls = [];
  const webContents = new EventEmitter();
  webContents.getURL = () => "http://127.0.0.1:5175/__codex_browser_ui_backend__";
  webContents.isDestroyed = () => false;
  webContents.send = () => {};
  const browserWindow = new EventEmitter();
  browserWindow.isDestroyed = () => false;
  browserWindow.loadURL = async (url) => reloadUrls.push(url);
  browserWindow.webContents = webContents;
  const runtime = new BrowserUiRuntime({ BrowserWindow: { getAllWindows: () => [] } });
  const closeCalls = [];
  runtime.activeClient = { close: (...args) => closeCalls.push(args) };
  runtime.bindBridgeWindow(browserWindow);
  runtime.hiddenPorts.add("host-1");

  webContents.emit("did-start-navigation", {}, "https://frame.example", false, false);
  assert.equal(runtime.bridgeWindow, browserWindow);
  webContents.emit("did-start-navigation", {}, webContents.getURL(), false, true);
  assert.equal(runtime.bridgeWindow, null);
  assert.equal(runtime.hiddenPorts.size, 0);
  assert.equal(closeCalls[0][0], SERVICE_RESTART_CLOSE_CODE);
  assert.match(reloadUrls[0], /__codex_browser_ui_backend__/u);

  runtime.bindBridgeWindow(browserWindow);
  runtime.hiddenPorts.add("host-2");
  webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(runtime.bridgeWindow, null);
  assert.equal(runtime.hiddenPorts.size, 0);
  assert.equal(closeCalls[1][0], SERVICE_RESTART_CLOSE_CODE);
  assert.equal(reloadUrls.length, 2);
});

test("browser UI relays the full AppHost tunnel and queues frames during connection", async () => {
  const ipcMain = new EventEmitter();
  const runtime = new BrowserUiRuntime({ ipcMain });
  const sent = [];
  const clientMessages = [];
  let releaseConnect;
  const webContents = { send: (...args) => sent.push(args) };
  runtime.bridgeWindow = {
    isDestroyed: () => false,
    webContents,
  };
  runtime.installIpcHandlers();
  runtime.sendToClient = (message) => {
    clientMessages.push(message);
    return true;
  };
  runtime.invokeBridge = () => new Promise((resolve) => {
    releaseConnect = resolve;
  });

  const connecting = runtime.connectHiddenPort("host-1");
  runtime.postPortData("host-1", "first-frame");
  assert.deepEqual(sent, []);
  releaseConnect(true);
  await connecting;
  assert.deepEqual(sent, [[
    "codex_linux_browser_ui:port-message",
    { id: "host-1", data: "first-frame" },
  ]]);
  assert.deepEqual(clientMessages.at(-1), { type: "port-ready", id: "host-1" });

  ipcMain.emit("codex_linux_browser_ui:port-message", { sender: webContents }, {
    id: "host-1",
    data: "worker-frame",
  });
  assert.deepEqual(clientMessages.at(-1), {
    type: "port-data",
    id: "host-1",
    data: "worker-frame",
  });
  ipcMain.emit("codex_linux_browser_ui:port-close", { sender: webContents }, { id: "host-1" });
  assert.deepEqual(clientMessages.at(-1), { type: "port-close", id: "host-1" });
  assert.equal(runtime.hiddenPorts.has("host-1"), false);
});

test("browser UI reports AppHost connection failure without an unhandled rejection", async () => {
  const runtime = new BrowserUiRuntime({});
  const clientMessages = [];
  runtime.sendToClient = (message) => clientMessages.push(message);
  runtime.invokeBridge = async () => {
    throw new Error("preload unavailable");
  };

  assert.equal(await runtime.connectHiddenPort("host-failure"), false);
  assert.deepEqual(clientMessages, [{ type: "port-close", id: "host-failure" }]);
  assert.equal(runtime.connectingHiddenPorts.size, 0);
});

test("browser UI never resurrects an AppHost port canceled while connecting", async () => {
  const preloadMessages = [];
  const clientMessages = [];
  let releaseConnect;
  const runtime = new BrowserUiRuntime({});
  runtime.bridgeWindow = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (...args) => preloadMessages.push(args),
    },
  };
  runtime.sendToClient = (message) => clientMessages.push(message);
  runtime.invokeBridge = () => new Promise((resolve) => {
    releaseConnect = resolve;
  });

  const connecting = runtime.connectHiddenPort("host-canceled");
  runtime.postPortData("host-canceled", "queued-frame");
  runtime.closePort("host-canceled");
  releaseConnect(true);
  assert.equal(await connecting, false);
  assert.equal(runtime.hiddenPorts.has("host-canceled"), false);
  assert.equal(clientMessages.some((message) => message.type === "port-ready"), false);
  assert.deepEqual(preloadMessages, [[
    "codex_linux_browser_ui:port-close",
    { id: "host-canceled" },
  ]]);
});

test("browser UI never delivers a pending AppHost port to a superseding client", async () => {
  const preloadMessages = [];
  const clientMessages = [];
  let releaseConnect;
  const owner = { close() {} };
  const runtime = new BrowserUiRuntime({});
  runtime.activeClient = owner;
  runtime.bridgeWindow = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (...args) => preloadMessages.push(args),
    },
  };
  runtime.sendToClient = (message) => clientMessages.push(message);
  runtime.invokeBridge = () => new Promise((resolve) => {
    releaseConnect = resolve;
  });

  const connecting = runtime.connectHiddenPort("host-old-client", owner);
  runtime.clientDisconnected(owner);
  runtime.activeClient = { close() {} };
  releaseConnect(true);
  assert.equal(await connecting, false);
  assert.equal(runtime.hiddenPorts.has("host-old-client"), false);
  assert.equal(clientMessages.some((message) => message.type === "port-ready"), false);
  assert.deepEqual(preloadMessages, [[
    "codex_linux_browser_ui:port-close",
    { id: "host-old-client" },
  ]]);
});

test("browser UI preserves a newer completed AppHost port when an old same-id connect resolves", async () => {
  const preloadMessages = [];
  const clientMessages = [];
  const releases = [];
  const oldOwner = { close() {} };
  const newOwner = { close() {} };
  const runtime = new BrowserUiRuntime({});
  runtime.activeClient = oldOwner;
  runtime.bridgeWindow = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (...args) => preloadMessages.push(args),
    },
  };
  runtime.sendToClient = (message) => clientMessages.push(message);
  runtime.invokeBridge = () => new Promise((resolve) => releases.push(resolve));

  const oldConnect = runtime.connectHiddenPort("same-id", oldOwner);
  runtime.clientDisconnected(oldOwner);
  runtime.activeClient = newOwner;
  const newConnect = runtime.connectHiddenPort("same-id", newOwner);
  releases[1](true);
  assert.equal(await newConnect, true);
  releases[0](true);
  assert.equal(await oldConnect, false);

  assert.equal(runtime.hiddenPorts.has("same-id"), true);
  assert.deepEqual(clientMessages, [{ type: "port-ready", id: "same-id" }]);
  assert.deepEqual(preloadMessages, []);
});

test(
  "browser UI runtime serves native DOM and relays RPC plus streaming events",
  { skip: typeof WebSocket !== "function" ? "this Node.js does not expose WebSocket" : false },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-ui-runtime-test-"));
    fs.writeFileSync(
      path.join(root, "index.html"),
      `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; connect-src 'self';"><script type="module" src="/app.js"></script></head><body>DOM</body></html>`,
    );
    fs.writeFileSync(path.join(root, "app.js"), `document.body.dataset.loaded="true";`);
    fs.writeFileSync(path.join(root, "download.txt"), "native browser download\n");
    fs.writeFileSync(path.join(root, "empty.txt"), "");
    fs.writeFileSync(path.join(root, "report-😀.txt"), "unicode name\n");

    const app = new EventEmitter();
    app.whenReady = async () => {};
    const ipcMain = new EventEmitter();
    const bridgeCalls = [];
    const hiddenBridge = {
      async sendMessageFromView(...args) {
        bridgeCalls.push(args);
        return { accepted: true };
      },
    };
    const webContents = {
      id: 42,
      getURL: () => "http://127.0.0.1:5175/__codex_browser_ui_backend__",
      async executeJavaScript(source) {
        if (source.includes("Boolean(window.electronBridge")) return true;
        if (source.includes("const b=window.electronBridge")) {
          return {
            appSessionId: "test-session",
            buildFlavor: "prod",
            isDeviceCheckSupported: false,
            isIntelMacBuild: false,
            preloadStartedAtMs: 123,
            sentryInitOptions: { codexAppSessionId: "test-session" },
            sharedObjects: { initial: "snapshot" },
            systemTheme: "dark",
            usesOwlAppShell: false,
            windowType: "electron",
          };
        }
        const encoded = /atob\(("[^"]+")\)/u.exec(source)?.[1];
        if (encoded == null) return null;
        const payload = JSON.parse(Buffer.from(JSON.parse(encoded), "base64").toString("utf8"));
        const method = hiddenBridge[payload.method];
        if (typeof method !== "function") throw new Error(`Unknown bridge method: ${payload.method}`);
        return method(...payload.args);
      },
      send() {},
      postMessage() {},
    };
    const browserWindow = new EventEmitter();
    browserWindow.webContents = webContents;
    browserWindow.hide = () => {};
    browserWindow.isDestroyed = () => false;
    browserWindow.setSkipTaskbar = () => {};
    const electron = {
      app,
      ipcMain,
      BrowserWindow: { getAllWindows: () => [browserWindow] },
      clipboard: { writeText() {} },
      dialog: {
        showMessageBox: async () => ({ response: 0 }),
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async () => ({ canceled: true }),
      },
      shell: { openExternal: async () => {} },
    };
    const runtime = new BrowserUiRuntime(electron);
    runtime.assetRoot = root;
    runtime.workspaceRoot = root;
    runtime.fileRoots = [root, runtime.uploadRoot];
    runtime.host = "127.0.0.1";
    runtime.port = 0;
    runtime.install();
    t.after(() => {
      runtime.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    });
    if (!runtime.server.listening) await once(runtime.server, "listening");
    for (let attempt = 0; attempt < 100 && !runtime.isReady(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(runtime.isReady(), true);

    const port = runtime.server.address().port;
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      nativeDom: true,
      pixelStreaming: false,
      bridgeConnected: false,
      electronReady: true,
    });
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, /__codex_browser_ui\/bridge\.js/u);
    const deniedDownload = await fetch(
      `http://127.0.0.1:${port}/__codex_browser_ui/file?path=${encodeURIComponent(path.join(root, "download.txt"))}`,
    );
    assert.equal(deniedDownload.status, 403);
    const outsideDownload = await fetch(
      `http://127.0.0.1:${port}/__codex_browser_ui/file?path=${encodeURIComponent(__filename)}&token=${runtime.sessionToken}`,
    );
    assert.equal(outsideDownload.status, 403);
    const download = await fetch(
      `http://127.0.0.1:${port}/__codex_browser_ui/file?path=${encodeURIComponent(path.join(root, "download.txt"))}&token=${runtime.sessionToken}`,
    );
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition"), /download\.txt/u);
    assert.equal(download.headers.get("content-security-policy"), "sandbox; default-src 'none'");
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await download.text(), "native browser download\n");
    const emptyDownload = await fetch(
      `http://127.0.0.1:${port}/__codex_browser_ui/file?path=${encodeURIComponent(path.join(root, "empty.txt"))}&token=${runtime.sessionToken}`,
    );
    assert.equal(emptyDownload.status, 200);
    assert.equal(emptyDownload.headers.get("content-length"), "0");
    assert.equal(await emptyDownload.text(), "");
    const unicodeDownload = await fetch(
      `http://127.0.0.1:${port}/__codex_browser_ui/file?path=${encodeURIComponent(path.join(root, "report-😀.txt"))}&token=${runtime.sessionToken}`,
    );
    assert.equal(unicodeDownload.status, 200);
    assert.match(
      unicodeDownload.headers.get("content-disposition"),
      /filename\*=UTF-8''report-%F0%9F%98%80\.txt/u,
    );
    assert.equal(await unicodeDownload.text(), "unicode name\n");
    const localAsset = await fetch(
      `http://127.0.0.1:${port}/@fs${path.join(root, "download.txt")}?token=${runtime.sessionToken}`,
    );
    assert.equal(localAsset.headers.get("content-security-policy"), "sandbox; default-src 'none'");
    assert.equal(localAsset.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await localAsset.text(), "native browser download\n");

    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/__codex_browser_ui/ws?token=${runtime.sessionToken}`,
    );
    t.after(() => socket.close());
    const messages = [];
    socket.addEventListener("message", (event) => messages.push(JSON.parse(event.data)));
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    for (let attempt = 0; attempt < 100 && messages.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(messages[0].type, "hello");
    assert.equal(messages[0].config.sharedObjects.initial, "snapshot");

    socket.send(JSON.stringify({
      type: "rpc",
      requestId: "rpc-1",
      method: "sendMessageFromView",
      args: [{ type: "runtime-test" }],
    }));
    for (let attempt = 0; attempt < 100 && !messages.some((message) => message.requestId === "rpc-1"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const rpcResult = messages.find((message) => message.requestId === "rpc-1");
    assert.equal(rpcResult.type, "rpc-result");
    assert.deepEqual(rpcResult.result, { accepted: true });
    assert.deepEqual(bridgeCalls, [[{ type: "runtime-test" }]]);

    socket.send(JSON.stringify({
      type: "rpc",
      requestId: "rpc-denied",
      method: "getPathForFile",
      args: [],
    }));
    for (
      let attempt = 0;
      attempt < 100 && !messages.some((message) => message.requestId === "rpc-denied");
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const deniedRpc = messages.find((message) => message.requestId === "rpc-denied");
    assert.equal(deniedRpc.type, "rpc-error");
    assert.match(deniedRpc.error.message, /not allowed/u);

    webContents.send("codex_desktop:message-for-view", {
      type: "shared-object-updated",
      key: "live",
      value: 7,
    });
    for (let attempt = 0; attempt < 100 && !messages.some((message) => message.type === "view-message"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(messages.find((message) => message.type === "view-message").message.value, 7);
  },
);
