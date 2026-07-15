"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { URL } = require("node:url");

const CHANNELS = Object.freeze({
  messageForView: "codex_desktop:message-for-view",
  mcpHostMessage: "codex_desktop:mcp-app-sandbox-host-message",
  portMessage: "codex_linux_browser_ui:port-message",
  portClose: "codex_linux_browser_ui:port-close",
  systemTheme: "codex_desktop:system-theme-variant-updated",
});

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 5999;
const MAX_WS_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const FEATURE_NAME = "browser-ui";
const BRIDGE_BACKEND_PATH = "/__codex_browser_ui_backend__";
const SUPERSEDED_CLOSE_CODE = 4001;
const SERVICE_RESTART_CLOSE_CODE = 1012;
const LOCAL_BROWSER_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const RPC_BRIDGE_METHODS = new Set([
  "__browserUiActivateApplicationMenu",
  "__browserUiGetApplicationMenu",
  "getFastModeRolloutMetrics",
  "sendMessageFromView",
  "sendWorkerMessageFromView",
  "triggerSentryTestError",
]);
const RUNTIME_BRIDGE_METHODS = new Set([...RPC_BRIDGE_METHODS, "__browserUiConnectPort"]);

const MIME_TYPES = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".ogg", "audio/ogg"],
  [".otf", "font/otf"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
]);

function log(level, message, extra) {
  const suffix = extra == null ? "" : ` ${safeInspect(extra)}`;
  const line = `[codex-browser-ui] ${message}${suffix}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function safeInspect(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isAllowedBrowserHost(hostHeader) {
  if (typeof hostHeader !== "string" || hostHeader.length === 0) return false;
  try {
    return LOCAL_BROWSER_HOSTS.has(new URL(`http://${hostHeader}`).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function tokensEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function isAuthorizedWebSocketRequest(request, requestUrl, sessionToken) {
  if (!isAllowedBrowserHost(request.headers.host)) return false;
  if (!tokensEqual(requestUrl.searchParams.get("token"), sessionToken)) return false;
  const origin = request.headers.origin;
  if (origin == null) return true;
  if (typeof origin !== "string") return false;
  try {
    const originUrl = new URL(origin);
    return (
      (originUrl.protocol === "http:" || originUrl.protocol === "https:") &&
      originUrl.origin.toLowerCase() === requestUrl.origin.toLowerCase()
    );
  } catch {
    return false;
  }
}

function isSameOriginBrowserResourceRequest(request) {
  const fetchSite = request.headers["sec-fetch-site"];
  if (typeof fetchSite === "string" && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  const referer = request.headers.referer;
  if (referer == null) return true;
  if (typeof referer !== "string") return false;
  try {
    return (
      new URL(referer).origin.toLowerCase() ===
      new URL(`http://${request.headers.host}`).origin.toLowerCase()
    );
  } catch {
    return false;
  }
}

function resolvedRoots(roots) {
  return roots.map((root) => {
    try {
      return fs.realpathSync(root);
    } catch {
      return path.resolve(root);
    }
  });
}

function resolvedPathIsWithinRoots(candidate, roots) {
  return roots.some((root) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  });
}

function isPathWithinRoots(filePath, roots) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return false;
  try {
    return resolvedPathIsWithinRoots(fs.realpathSync(filePath), resolvedRoots(roots));
  } catch {
    return false;
  }
}

function openFileWithinRoots(filePath, roots) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return null;
  let realFilePath;
  const realRoots = resolvedRoots(roots);
  try {
    realFilePath = fs.realpathSync(filePath);
  } catch {
    return null;
  }
  if (!resolvedPathIsWithinRoots(realFilePath, realRoots)) return null;

  let fd;
  try {
    fd = fs.openSync(realFilePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("Not a regular file");
    if (process.platform === "linux") {
      const openedPath = fs.realpathSync(`/proc/self/fd/${fd}`);
      if (!resolvedPathIsWithinRoots(openedPath, realRoots)) throw new Error("Opened file escaped roots");
    }
    return { fd, filePath: realFilePath, stat };
  } catch {
    if (fd != null) fs.closeSync(fd);
    return null;
  }
}

function isPrimaryBridgeWindowCandidate(browserWindow) {
  try {
    const candidateUrl = new URL(browserWindow.webContents.getURL());
    const expectedUrl = new URL(bridgeBackendUrl());
    return (
      !candidateUrl.searchParams.has("initialRoute") &&
      candidateUrl.protocol === expectedUrl.protocol &&
      candidateUrl.port === expectedUrl.port &&
      LOCAL_BROWSER_HOSTS.has(candidateUrl.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

function bridgeBackendUrl() {
  const webviewPort = positiveInteger(process.env.CODEX_LINUX_WEBVIEW_PORT, 5175);
  return `http://127.0.0.1:${webviewPort}${BRIDGE_BACKEND_PATH}`;
}

function serializeError(error) {
  if (error == null) return { message: "Unknown error" };
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error",
    stack: error instanceof Error ? error.stack : undefined,
  };
}

function sanitizeDialogOptions(options) {
  const source = options && typeof options === "object" ? options : {};
  const sanitized = {};
  for (const key of [
    "buttonLabel",
    "buttons",
    "cancelId",
    "checkboxChecked",
    "checkboxLabel",
    "defaultId",
    "defaultPath",
    "detail",
    "filters",
    "message",
    "noLink",
    "normalizeAccessKeys",
    "properties",
    "showsTagField",
    "title",
    "type",
  ]) {
    const value = source[key];
    if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      if (value != null) sanitized[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      sanitized[key] = value.map((item) => {
        if (item == null || typeof item !== "object") return item;
        return Object.fromEntries(
          Object.entries(item).filter(([, nested]) =>
            nested == null || ["string", "number", "boolean"].includes(typeof nested) ||
            (Array.isArray(nested) && nested.every((entry) => typeof entry === "string")),
          ),
        );
      });
    }
  }
  return sanitized;
}

function encodeClosePayload(code, reason) {
  const reasonBuffer = Buffer.from(String(reason ?? "").slice(0, 123), "utf8");
  const payload = Buffer.allocUnsafe(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  return payload;
}

function encodeWebSocketFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

class WebSocketConnection {
  constructor(socket, head, options = {}) {
    this.socket = socket;
    this.buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    this.closed = false;
    this.fragmentOpcode = null;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.maxMessageBytes = options.maxMessageBytes ?? MAX_WS_MESSAGE_BYTES;
    this.onJson = options.onJson ?? (() => {});
    this.onClose = options.onClose ?? (() => {});

    socket.on("data", (chunk) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.parse();
    });
    socket.on("close", () => this.finish());
    socket.on("end", () => this.finish());
    socket.on("error", (error) => {
      log("warn", "WebSocket transport error", serializeError(error));
      this.finish();
    });

    if (this.buffer.length > 0) this.parse();
  }

  send(value) {
    if (this.closed || this.socket.destroyed) return false;
    let text;
    try {
      text = JSON.stringify(value);
    } catch (error) {
      log("warn", "Could not serialize browser bridge message", serializeError(error));
      return false;
    }
    this.socket.write(encodeWebSocketFrame(0x1, Buffer.from(text, "utf8")));
    return true;
  }

  ping() {
    if (!this.closed && !this.socket.destroyed) {
      this.socket.write(encodeWebSocketFrame(0x9));
    }
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    if (!this.socket.destroyed) {
      this.socket.end(encodeWebSocketFrame(0x8, encodeClosePayload(code, reason)));
    }
    this.onCloseOnce();
  }

  finish() {
    if (!this.closed) this.closed = true;
    this.onCloseOnce();
  }

  onCloseOnce() {
    if (this.closeNotified) return;
    this.closeNotified = true;
    try {
      this.onClose();
    } catch (error) {
      log("warn", "WebSocket close callback failed", serializeError(error));
    }
  }

  protocolError(reason) {
    this.close(1002, reason);
  }

  tooLarge() {
    this.close(1009, "Message too large");
  }

  parse() {
    while (!this.closed) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLength = second & 0x7f;
      let offset = 2;

      if (rsv !== 0 || !masked) {
        this.protocolError("Invalid frame flags");
        return;
      }
      if (payloadLength === 126) {
        if (this.buffer.length < 4) return;
        payloadLength = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.length < 10) return;
        const length64 = this.buffer.readBigUInt64BE(2);
        if (length64 > BigInt(this.maxMessageBytes)) {
          this.tooLarge();
          return;
        }
        payloadLength = Number(length64);
        offset = 10;
      }

      const isControl = opcode >= 0x8;
      if ((isControl && (!fin || payloadLength > 125)) || payloadLength > this.maxMessageBytes) {
        this.protocolError("Invalid frame length");
        return;
      }
      if (this.buffer.length < offset + 4 + payloadLength) return;

      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLength));
      this.buffer = this.buffer.subarray(offset + payloadLength);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
      this.handleFrame(opcode, fin, payload);
    }
  }

  handleFrame(opcode, fin, payload) {
    if (opcode === 0x8) {
      this.close(1000, "Peer closed");
      return;
    }
    if (opcode === 0x9) {
      if (!this.socket.destroyed) this.socket.write(encodeWebSocketFrame(0x0a, payload));
      return;
    }
    if (opcode === 0x0a) return;

    if (opcode === 0x0) {
      if (this.fragmentOpcode == null) {
        this.protocolError("Unexpected continuation");
        return;
      }
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > this.maxMessageBytes) {
        this.tooLarge();
        return;
      }
      if (fin) {
        const combined = Buffer.concat(this.fragments, this.fragmentBytes);
        const originalOpcode = this.fragmentOpcode;
        this.fragmentOpcode = null;
        this.fragments = [];
        this.fragmentBytes = 0;
        this.handleCompleteMessage(originalOpcode, combined);
      }
      return;
    }

    if (opcode !== 0x1 && opcode !== 0x2) {
      this.protocolError("Unsupported opcode");
      return;
    }
    if (this.fragmentOpcode != null) {
      this.protocolError("Interleaved fragments");
      return;
    }
    if (!fin) {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
      this.fragmentBytes = payload.length;
      return;
    }
    this.handleCompleteMessage(opcode, payload);
  }

  handleCompleteMessage(opcode, payload) {
    if (opcode !== 0x1) {
      this.close(1003, "Text messages only");
      return;
    }
    try {
      this.onJson(JSON.parse(payload.toString("utf8")));
    } catch (error) {
      log("warn", "Ignored invalid browser bridge JSON", serializeError(error));
    }
  }
}

function websocketAcceptValue(key) {
  return crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
    .digest("base64");
}

function acceptWebSocket(request, socket, head, callbacks) {
  const key = request.headers["sec-websocket-key"];
  const version = request.headers["sec-websocket-version"];
  if (typeof key !== "string" || version !== "13") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return null;
  }
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${websocketAcceptValue(key)}`,
      "\r\n",
    ].join("\r\n"),
  );
  return new WebSocketConnection(socket, head, callbacks);
}

function findAssetRoot(resourcesPath) {
  const candidates = [
    process.env.CODEX_BROWSER_UI_ASSET_ROOT,
    resourcesPath && path.resolve(resourcesPath, "..", "content", "webview"),
    resourcesPath && path.join(resourcesPath, "app.asar", "webview"),
    resourcesPath && path.join(resourcesPath, "app", "webview"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.statSync(path.join(candidate, "index.html")).isFile()) return candidate;
    } catch {
      // Try the next current-build layout.
    }
  }
  return null;
}

function injectBrowserBridge(html) {
  const bootstrap = [
    /<base\b/i.test(html) ? null : '<base href="/">',
    '<script src="/__codex_browser_ui/config.js"></script>',
    '<script src="/__codex_browser_ui/bridge.js"></script>',
  ].filter(Boolean).join("\n    ");
  const selfSource = "(?:&#39;|&apos;|')self(?:&#39;|&apos;|')";
  const addSources = (source, directive, additions) => {
    const hasAll = additions.every((addition) =>
      new RegExp(`${directive}[^\"]*(?:^|\\s)${addition.replace(":", "\\:")}(?:\\s|;)`, "i").test(source),
    );
    if (hasAll) return source;
    return source.replace(
      new RegExp(`(${directive}\\s+${selfSource})`, "i"),
      (match) => `${match} ${additions.join(" ")}`,
    );
  };
  let patched = addSources(html, "connect-src", ["ws:", "wss:"]);
  patched = addSources(patched, "child-src", ["https:"]);
  patched = addSources(patched, "frame-src", ["https:"]);
  if (patched.includes("/__codex_browser_ui/bridge.js")) return patched;
  return /<head(?:\s[^>]*)?>/i.test(patched)
    ? patched.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}\n    ${bootstrap}`)
    : `${bootstrap}\n${patched}`;
}

function safeStaticPath(assetRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded.replace(/^\/+/, "");
  const candidate = path.resolve(assetRoot, relative || "index.html");
  const rootPrefix = `${path.resolve(assetRoot)}${path.sep}`;
  return candidate === path.resolve(assetRoot) || candidate.startsWith(rootPrefix) ? candidate : null;
}

function contentTypeFor(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

function writeJson(response, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  response.end(body);
}

function readinessPage(port) {
  return Buffer.from(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Starting Codex</title><style>html{font-family:system-ui,sans-serif;color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}.card{max-width:34rem;padding:2rem;text-align:center}.dot{display:inline-block;animation:pulse 1s infinite alternate}@keyframes pulse{to{opacity:.25}}</style></head>
<body><main class="card"><h1>Starting Codex<span class="dot">…</span></h1><p>The native backend is loading. This page will continue automatically.</p></main>
<script>setTimeout(()=>location.reload(),1000)</script></body></html>`, "utf8");
}

function sanitizeUploadName(rawName) {
  let decoded = rawName ?? "upload";
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the undecoded value.
  }
  const base = path.basename(decoded).replace(/[\u0000-\u001f]/g, "").slice(0, 180);
  return base && base !== "." && base !== ".." ? base : "upload";
}

function attachmentContentDisposition(filePath) {
  const rawName = path.basename(filePath).replace(/["\\\u0000-\u001F\u007F]/gu, "_") || "download";
  const name = typeof rawName.toWellFormed === "function"
    ? rawName.toWellFormed()
    : rawName.replace(/[\uD800-\uDFFF]/gu, "_");
  const asciiName = name.replace(/[^\x20-\x7E]/gu, "_") || "download";
  const encodedName = encodeURIComponent(name).replace(/['()*]/gu, (character) =>
    `%${character.codePointAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}

function serveFile(request, response, filePath, options = {}) {
  const openedFile = options.openedFile ?? null;
  let stat = openedFile?.stat;
  let fd = openedFile?.fd;
  const closeFd = () => {
    if (fd == null) return;
    fs.closeSync(fd);
    fd = null;
  };
  try {
    stat ??= fs.statSync(filePath);
  } catch {
    closeFd();
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  if (!stat.isFile()) {
    closeFd();
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": options.cacheControl ?? "public, max-age=31536000, immutable",
    "Content-Type": contentTypeFor(filePath),
    ...(options.headers ?? {}),
  };
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  const range = request.headers.range;
  if (typeof range === "string") {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
    if (match) {
      if (match[1]) start = Number.parseInt(match[1], 10);
      if (match[2]) end = Number.parseInt(match[2], 10);
      if (!match[1] && match[2]) {
        const suffix = Number.parseInt(match[2], 10);
        start = Math.max(0, stat.size - suffix);
        end = stat.size - 1;
      }
      if (start > end || start >= stat.size) {
        closeFd();
        response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        response.end();
        return;
      }
      end = Math.min(end, stat.size - 1);
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
    }
  }
  headers["Content-Length"] = Math.max(0, end - start + 1);
  response.writeHead(status, headers);
  if (request.method === "HEAD") {
    closeFd();
    response.end();
    return;
  }
  if (stat.size === 0) {
    closeFd();
    response.end();
    return;
  }
  const streamOptions = fd == null ? { start, end } : { autoClose: true, fd, start, end };
  fd = null;
  const stream = fs.createReadStream(openedFile?.filePath ?? filePath, streamOptions);
  stream.on("error", (error) => response.destroy(error));
  stream.pipe(response);
}

function currentPlatformSnapshot() {
  return {
    appSessionId: null,
    buildFlavor: null,
    isDeviceCheckSupported: false,
    isIntelMacBuild: false,
    preloadStartedAtMs: Date.now(),
    sentryInitOptions: null,
    sharedObjects: {},
    systemTheme: "light",
    usesOwlAppShell: false,
    windowType: "electron",
  };
}

class BrowserUiRuntime {
  constructor(electron) {
    this.electron = electron;
    this.host = process.env.CODEX_BROWSER_UI_HOST?.trim() || DEFAULT_HOST;
    this.port = positiveInteger(process.env.CODEX_BROWSER_UI_PORT, DEFAULT_PORT);
    this.maxUploadBytes = positiveInteger(process.env.CODEX_BROWSER_UI_MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES);
    this.assetRoot = findAssetRoot(process.resourcesPath);
    this.bridgeScriptPath = path.join(__dirname, "browser-ui-bridge.js");
    this.uploadRoot = path.join(os.tmpdir(), `codex-browser-ui-${process.getuid?.() ?? "user"}`);
    this.workspaceRoot = path.resolve(process.env.CODEX_BROWSER_UI_WORKSPACE || os.homedir());
    this.fileRoots = [
      this.workspaceRoot,
      this.uploadRoot,
      ...(process.env.CODEX_BROWSER_UI_FILE_ROOTS || "")
        .split(path.delimiter)
        .map((root) => root.trim())
        .filter(Boolean)
        .map((root) => path.resolve(root)),
    ];
    this.sessionToken = crypto.randomBytes(32).toString("base64url");
    this.bridgeWindow = null;
    this.bridgeLifecycleCleanup = null;
    this.activeClient = null;
    this.snapshot = currentPlatformSnapshot();
    this.hiddenPorts = new Set();
    this.connectingHiddenPorts = new Map();
    this.dialogRequests = new Map();
    this.requestCounter = 0;
    this.applicationMenuItems = new Map();
    this.server = null;
    this.discoveryTimer = null;
    this.heartbeatTimer = null;
    this.installed = false;
  }

  install() {
    if (this.installed) return this;
    this.installed = true;
    fs.rmSync(this.uploadRoot, { recursive: true, force: true });
    fs.mkdirSync(this.uploadRoot, { recursive: true, mode: 0o700 });
    this.installIpcHandlers();
    this.installNativeAdapters();
    this.startServer();
    this.electron.app.on("browser-window-created", (_event, browserWindow) => {
      try {
        browserWindow.hide();
        browserWindow.setSkipTaskbar?.(true);
      } catch {
        // The window can disappear during startup.
      }
      setTimeout(() => this.discoverBridgeWindow(), 0).unref?.();
    });
    this.electron.app.once("will-quit", () => this.dispose());
    this.electron.app.whenReady().then(() => this.beginDiscovery()).catch((error) => {
      log("error", "Electron app readiness failed", serializeError(error));
    });
    return this;
  }

  dispose() {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.discoveryTimer = null;
    this.heartbeatTimer = null;
    this.activeClient?.close(1001, "Electron is shutting down");
    this.activeClient = null;
    this.bridgeLifecycleCleanup?.();
    this.bridgeLifecycleCleanup = null;
    this.bridgeWindow = null;
    this.hiddenPorts.clear();
    this.connectingHiddenPorts.clear();
    for (const pending of this.dialogRequests.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.dialogRequests.clear();
    this.server?.close();
    this.server = null;
    fs.rmSync(this.uploadRoot, { recursive: true, force: true });
  }

  installIpcHandlers() {
    const { ipcMain } = this.electron;
    ipcMain.on(CHANNELS.portMessage, (event, payload) => {
      if (!this.isBridgeSender(event.sender) || !payload || typeof payload.id !== "string") return;
      this.sendToClient({ type: "port-data", id: payload.id, data: payload.data });
    });
    ipcMain.on(CHANNELS.portClose, (event, payload) => {
      if (!this.isBridgeSender(event.sender) || !payload || typeof payload.id !== "string") return;
      this.hiddenPorts.delete(payload.id);
      this.sendToClient({ type: "port-close", id: payload.id });
    });
  }

  isBridgeSender(sender) {
    return this.bridgeWindow != null && !this.bridgeWindow.isDestroyed() && this.bridgeWindow.webContents === sender;
  }

  installNativeAdapters() {
    const { dialog, shell, clipboard } = this.electron;
    if (dialog && !dialog.__codexBrowserUiPatched) {
      Object.defineProperty(dialog, "__codexBrowserUiPatched", { value: true });
      const originalOpen = dialog.showOpenDialog.bind(dialog);
      const originalSave = dialog.showSaveDialog.bind(dialog);
      const originalMessage = dialog.showMessageBox.bind(dialog);
      dialog.showOpenDialog = (...args) => {
        if (!this.activeClient) return originalOpen(...args);
        const options = args.at(-1) ?? {};
        return this.requestDialog("open", options).then((answer) => ({
          canceled: answer == null || !Array.isArray(answer.paths) || answer.paths.length === 0,
          filePaths: Array.isArray(answer?.paths) ? answer.paths : [],
        }));
      };
      dialog.showSaveDialog = (...args) => {
        if (!this.activeClient) return originalSave(...args);
        const options = args.at(-1) ?? {};
        return this.requestDialog("save", options).then((answer) => ({
          canceled: answer?.path == null,
          filePath: answer?.path ?? undefined,
        }));
      };
      dialog.showMessageBox = (...args) => {
        if (!this.activeClient) return originalMessage(...args);
        const options = args.at(-1) ?? {};
        return this.requestDialog("message", options).then((answer) => ({
          checkboxChecked: Boolean(answer?.checkboxChecked),
          response: Number.isInteger(answer?.response) ? answer.response : (options.cancelId ?? 0),
        }));
      };
    }

    if (shell && !shell.__codexBrowserUiPatched) {
      Object.defineProperty(shell, "__codexBrowserUiPatched", { value: true });
      const originalOpenExternal = shell.openExternal.bind(shell);
      shell.openExternal = async (url, options) => {
        if (!this.activeClient) return originalOpenExternal(url, options);
        this.sendToClient({ type: "open-url", url: String(url) });
      };
    }

    if (clipboard && !clipboard.__codexBrowserUiPatched) {
      Object.defineProperty(clipboard, "__codexBrowserUiPatched", { value: true });
      const originalWriteText = clipboard.writeText.bind(clipboard);
      clipboard.writeText = (text, type) => {
        originalWriteText(text, type);
        this.sendToClient({ type: "clipboard-write", text: String(text) });
      };
    }
  }

  requestDialog(kind, options) {
    if (!this.activeClient) return Promise.resolve(null);
    const requestId = `dialog-${Date.now()}-${++this.requestCounter}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.dialogRequests.delete(requestId);
        resolve(null);
      }, 5 * 60 * 1000);
      timer.unref?.();
      this.dialogRequests.set(requestId, { resolve, timer });
      this.sendToClient({
        type: "dialog-request",
        requestId,
        kind,
        options: sanitizeDialogOptions(options),
      });
    });
  }

  startServer() {
    if (this.server) return;
    this.server = http.createServer((request, response) => {
      Promise.resolve(this.handleHttp(request, response)).catch((error) => {
        log("error", "HTTP handler failed", serializeError(error));
        if (!response.headersSent) writeJson(response, 500, { error: "Internal server error" });
        else response.destroy(error);
      });
    });
    this.server.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
    this.server.on("error", (error) => {
      log("error", "Browser UI server failed", serializeError(error));
      if (typeof this.electron.app?.exit === "function") this.electron.app.exit(1);
      else setImmediate(() => { throw error; });
    });
    this.server.listen(this.port, this.host, () => {
      log("info", `Native browser DOM available at http://${this.host}:${this.port}`);
      if (!this.assetRoot) log("warn", "Could not locate current webview assets");
    });
    this.heartbeatTimer = setInterval(() => this.activeClient?.ping(), 30_000);
    this.heartbeatTimer.unref?.();
  }

  async handleHttp(request, response) {
    if (!isAllowedBrowserHost(request.headers.host)) {
      writeJson(response, 403, { error: "Local browser Host required" });
      return;
    }
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const pathname = requestUrl.pathname;
    const protectedPath =
      pathname === "/__codex_browser_ui/client-log" ||
      pathname === "/__codex_browser_ui/file" ||
      pathname === "/__codex_browser_ui/upload" ||
      pathname.startsWith("/@fs/");
    if (protectedPath && !tokensEqual(requestUrl.searchParams.get("token"), this.sessionToken)) {
      writeJson(response, 403, { error: "Invalid browser session" });
      return;
    }

    if (
      request.method === "GET" &&
      pathname === "/" &&
      /^127\.0\.0\.1(?::\d+)?$/u.test(request.headers.host ?? "") &&
      process.env.CODEX_BROWSER_UI_DISABLE_LOCALHOST_REDIRECT !== "1"
    ) {
      const port = request.headers.host?.split(":").at(-1) || String(this.port);
      response.writeHead(302, {
        "Cache-Control": "no-store",
        Location: `http://localhost:${port}/`,
      });
      response.end();
      return;
    }

    if (pathname === "/healthz") {
      writeJson(response, this.isReady() ? 200 : 503, {
        ok: this.isReady(),
        nativeDom: true,
        pixelStreaming: false,
        bridgeConnected: Boolean(this.activeClient),
        electronReady: this.bridgeWindow != null,
      });
      return;
    }
    if (pathname === "/__codex_browser_ui/config.js") {
      if (!isSameOriginBrowserResourceRequest(request)) {
        writeJson(response, 403, { error: "Same-origin browser resource required" });
        return;
      }
      await this.refreshSnapshot();
      const json = JSON.stringify(this.browserConfig()).replaceAll("<", "\\u003c");
      const body = Buffer.from(`window.__CODEX_BROWSER_UI_CONFIG__=${json};\n`, "utf8");
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": body.length,
        "Content-Type": "text/javascript; charset=utf-8",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(body);
      return;
    }
    if (pathname === "/__codex_browser_ui/bridge.js") {
      if (!isSameOriginBrowserResourceRequest(request)) {
        writeJson(response, 403, { error: "Same-origin browser resource required" });
        return;
      }
      serveFile(request, response, this.bridgeScriptPath, {
        cacheControl: "no-store",
        headers: {
          "Cross-Origin-Resource-Policy": "same-origin",
          "X-Content-Type-Options": "nosniff",
        },
      });
      return;
    }
    if (pathname === "/__codex_browser_ui/client-log") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "POST required" }, { Allow: "POST" });
        return;
      }
      const chunks = [];
      let size = 0;
      await new Promise((resolve) => {
        request.on("data", (chunk) => {
          if (size < 64 * 1024) chunks.push(chunk.subarray(0, 64 * 1024 - size));
          size += chunk.length;
        });
        request.on("end", resolve);
        request.on("error", resolve);
      });
      let payload = Buffer.concat(chunks).toString("utf8");
      try {
        payload = JSON.parse(payload);
      } catch {
        // Preserve a non-JSON diagnostic as text.
      }
      log("error", "Browser renderer reported a startup error", payload);
      response.writeHead(204, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (pathname === "/__codex_browser_ui/upload") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "POST required" }, { Allow: "POST" });
        return;
      }
      await this.handleUpload(request, response);
      return;
    }
    if (pathname === "/__codex_browser_ui/file") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        writeJson(response, 405, { error: "GET or HEAD required" }, { Allow: "GET, HEAD" });
        return;
      }
      const filePath = requestUrl.searchParams.get("path");
      if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
        writeJson(response, 400, { error: "An absolute file path is required" });
        return;
      }
      const openedFile = openFileWithinRoots(filePath, this.fileRoots);
      if (!openedFile) {
        writeJson(response, 403, { error: "File is outside the configured browser roots" });
        return;
      }
      serveFile(request, response, openedFile.filePath, {
        cacheControl: "no-store",
        headers: {
          "Content-Disposition": attachmentContentDisposition(filePath),
          "Content-Security-Policy": "sandbox; default-src 'none'",
          "Cross-Origin-Resource-Policy": "same-origin",
          "X-Content-Type-Options": "nosniff",
        },
        openedFile,
      });
      return;
    }
    if (pathname.startsWith("/@fs/")) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        writeJson(response, 405, { error: "GET or HEAD required" }, { Allow: "GET, HEAD" });
        return;
      }
      let filePath;
      try {
        filePath = decodeURIComponent(pathname.slice(4));
      } catch {
        writeJson(response, 400, { error: "Invalid file path" });
        return;
      }
      if (!path.isAbsolute(filePath)) {
        writeJson(response, 400, { error: "An absolute file path is required" });
        return;
      }
      const openedFile = openFileWithinRoots(filePath, this.fileRoots);
      if (!openedFile) {
        writeJson(response, 403, { error: "File is outside the configured browser roots" });
        return;
      }
      serveFile(request, response, openedFile.filePath, {
        cacheControl: "no-store",
        headers: {
          "Content-Security-Policy": "sandbox; default-src 'none'",
          "Cross-Origin-Resource-Policy": "same-origin",
          "X-Content-Type-Options": "nosniff",
        },
        openedFile,
      });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      writeJson(response, 405, { error: "GET or HEAD required" }, { Allow: "GET, HEAD" });
      return;
    }
    if (!this.isReady()) {
      const body = readinessPage(this.port);
      response.writeHead(503, {
        "Cache-Control": "no-store",
        "Content-Length": body.length,
        "Content-Type": "text/html; charset=utf-8",
        "Retry-After": "1",
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    if (!this.assetRoot) {
      writeJson(response, 500, { error: "Webview asset root was not found" });
      return;
    }

    let filePath = safeStaticPath(this.assetRoot, pathname);
    if (filePath == null) {
      writeJson(response, 400, { error: "Invalid path" });
      return;
    }
    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch {
      // SPA routes fall through to index.html.
    }
    if (stat?.isDirectory()) filePath = path.join(filePath, "index.html");
    else if (!stat?.isFile() && !path.extname(pathname)) filePath = path.join(this.assetRoot, "index.html");

    if (path.basename(filePath) === "index.html") {
      const html = injectBrowserBridge(fs.readFileSync(filePath, "utf8"));
      const body = Buffer.from(html, "utf8");
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": body.length,
        "Content-Type": "text/html; charset=utf-8",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    serveFile(request, response, filePath);
  }

  async handleUpload(request, response) {
    const declaredLength = Number.parseInt(String(request.headers["content-length"] ?? "0"), 10);
    if (Number.isFinite(declaredLength) && declaredLength > this.maxUploadBytes) {
      writeJson(response, 413, { error: "Upload too large" });
      request.resume();
      return;
    }
    const name = sanitizeUploadName(request.headers["x-codex-filename"]);
    const uploadDir = path.join(this.uploadRoot, crypto.randomUUID());
    fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
    const target = path.join(uploadDir, name);
    const stream = fs.createWriteStream(target, { flags: "wx", mode: 0o600 });
    let bytes = 0;
    let settled = false;

    await new Promise((resolve, reject) => {
      request.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > this.maxUploadBytes && !settled) {
          settled = true;
          request.destroy();
          stream.destroy();
          reject(Object.assign(new Error("Upload too large"), { statusCode: 413 }));
        }
      });
      request.on("error", reject);
      stream.on("error", reject);
      stream.on("finish", resolve);
      request.pipe(stream);
    }).catch((error) => {
      fs.rmSync(uploadDir, { recursive: true, force: true });
      if (!response.headersSent) writeJson(response, error.statusCode ?? 500, { error: error.message });
    });
    if (response.headersSent) return;
    writeJson(response, 201, { path: target, name, size: bytes });
  }

  handleUpgrade(request, socket, head) {
    if (!isAllowedBrowserHost(request.headers.host)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (requestUrl.pathname !== "/__codex_browser_ui/ws") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!isAuthorizedWebSocketRequest(request, requestUrl, this.sessionToken)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }

    let connection;
    connection = acceptWebSocket(request, socket, head, {
      onJson: (message) => {
        void this.handleClientMessage(connection, message).catch((error) => {
          log("warn", "Browser bridge message failed", serializeError(error));
        });
      },
      onClose: () => this.clientDisconnected(connection),
    });
    if (!connection) return;
    if (this.activeClient && this.activeClient !== connection) {
      const previousClient = this.activeClient;
      previousClient.close(SUPERSEDED_CLOSE_CODE, "A newer browser tab connected");
      this.clientDisconnected(previousClient);
    }
    this.activeClient = connection;
    connection.send({ type: "hello", config: this.browserConfig() });
    log("info", "Browser bridge connected");
  }

  clientDisconnected(connection) {
    if (this.activeClient !== connection) return;
    this.activeClient = null;
    for (const [requestId, pending] of this.dialogRequests) {
      clearTimeout(pending.timer);
      pending.resolve(null);
      this.dialogRequests.delete(requestId);
    }
    if (this.bridgeWindow && !this.bridgeWindow.isDestroyed()) {
      for (const id of this.hiddenPorts) {
        this.bridgeWindow.webContents.send(CHANNELS.portClose, { id });
      }
    }
    this.hiddenPorts.clear();
    this.connectingHiddenPorts.clear();
    log("info", "Browser bridge disconnected");
  }

  async handleClientMessage(connection, message) {
    if (connection !== this.activeClient || message == null || typeof message !== "object") return;
    switch (message.type) {
      case "rpc":
        await this.handleRpc(connection, message);
        break;
      case "port-connect":
        await this.connectHiddenPort(message.id, connection);
        break;
      case "port-data":
        this.postPortData(message.id, message.data);
        break;
      case "port-close":
        this.closePort(message.id);
        break;
      case "dialog-response":
        this.resolveDialog(message);
        break;
      case "open-url":
        if (typeof message.url === "string") this.sendToClient({ type: "open-url", url: message.url });
        break;
      case "ping":
        connection.send({ type: "pong", now: Date.now() });
        break;
      default:
        break;
    }
  }

  async handleRpc(connection, message) {
    const requestId = message.requestId;
    if (typeof requestId !== "string" || typeof message.method !== "string") return;
    try {
      if (!RPC_BRIDGE_METHODS.has(message.method)) {
        throw new Error(`Browser RPC method is not allowed: ${message.method}`);
      }
      const result = await this.invokeBridge(message.method, Array.isArray(message.args) ? message.args : []);
      connection.send({ type: "rpc-result", requestId, result });
    } catch (error) {
      connection.send({ type: "rpc-error", requestId, error: serializeError(error) });
    }
  }

  async invokeBridge(method, args) {
    if (!RUNTIME_BRIDGE_METHODS.has(method)) {
      throw new Error(`Electron bridge method is not allowed: ${method}`);
    }
    if (method === "__browserUiGetApplicationMenu") {
      return this.serializeApplicationMenu(args[0]);
    }
    if (method === "__browserUiActivateApplicationMenu") {
      return this.activateApplicationMenuItem(args[0]);
    }
    const webContents = this.requireBridgeWebContents();
    const payload = Buffer.from(JSON.stringify({ method, args }), "utf8").toString("base64");
    return webContents.executeJavaScript(
      `(()=>{const p=JSON.parse(atob(${JSON.stringify(payload)}));const f=window.electronBridge?.[p.method];if(typeof f!=="function")throw new Error("Unknown Electron bridge method: "+p.method);return Promise.resolve(f(...p.args));})()`,
      true,
    );
  }

  serializeApplicationMenu(menuId) {
    const menu = this.electron.Menu?.getApplicationMenu?.();
    this.applicationMenuItems.clear();
    if (!menu) return [];
    const normalizedId = typeof menuId === "string" ? menuId.toLowerCase() : "";
    const topLevel = menu.items?.find((item) =>
      item.id === menuId || item.role === menuId || item.label?.toLowerCase().replaceAll("&", "") === normalizedId,
    );
    const sourceItems = topLevel?.submenu?.items ?? menu.items ?? [];
    const serializeItems = (items, prefix = "menu") => items.map((item, index) => {
      const syntheticId = `${prefix}-${index}`;
      this.applicationMenuItems.set(syntheticId, item);
      return {
        id: syntheticId,
        label: item.label ?? item.role ?? "",
        type: item.type ?? (item.submenu ? "submenu" : "normal"),
        enabled: item.enabled !== false,
        checked: Boolean(item.checked),
        accelerator: item.accelerator ?? null,
        submenu: item.submenu ? serializeItems(item.submenu.items ?? [], syntheticId) : undefined,
      };
    });
    return serializeItems(sourceItems);
  }

  activateApplicationMenuItem(id) {
    const item = this.applicationMenuItems.get(id);
    if (!item || item.enabled === false || item.submenu) return false;
    try {
      if (typeof item.click === "function") item.click(item, this.bridgeWindow, undefined);
      else if (item.role) this.electron.Menu?.sendActionToFirstResponder?.(item.role);
      return true;
    } catch (error) {
      log("warn", "Application menu action failed", serializeError(error));
      return false;
    }
  }

  async connectHiddenPort(id, ownerConnection = this.activeClient) {
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      this.hiddenPorts.has(id) ||
      this.connectingHiddenPorts.has(id)
    ) return;
    const connecting = { ownerConnection, queued: [] };
    this.connectingHiddenPorts.set(id, connecting);
    try {
      await this.invokeBridge("__browserUiConnectPort", [id]);
      if (this.connectingHiddenPorts.get(id) !== connecting) {
        if (
          !this.connectingHiddenPorts.has(id) &&
          !this.hiddenPorts.has(id) &&
          this.bridgeWindow &&
          !this.bridgeWindow.isDestroyed() &&
          !this.bridgeWindow.webContents.isDestroyed?.()
        ) {
          this.bridgeWindow.webContents.send(CHANNELS.portClose, { id });
        }
        return false;
      }
      this.hiddenPorts.add(id);
      this.connectingHiddenPorts.delete(id);
      for (const data of connecting.queued) this.postPortData(id, data);
      if (ownerConnection == null || ownerConnection === this.activeClient) {
        this.sendToClient({ type: "port-ready", id });
      }
    } catch (error) {
      if (this.connectingHiddenPorts.get(id) === connecting) {
        this.connectingHiddenPorts.delete(id);
        if (ownerConnection == null || ownerConnection === this.activeClient) {
          this.sendToClient({ type: "port-close", id });
        }
      }
      log("warn", "Could not connect browser AppHost port", serializeError(error));
      return false;
    }
    return true;
  }

  postPortData(id, data) {
    if (typeof id !== "string") return;
    const connecting = this.connectingHiddenPorts.get(id);
    if (connecting) {
      connecting.queued.push(data);
      return;
    }
    if (this.hiddenPorts.has(id) && this.bridgeWindow && !this.bridgeWindow.isDestroyed()) {
      this.bridgeWindow.webContents.send(CHANNELS.portMessage, { id, data });
    }
  }

  closePort(id) {
    if (typeof id !== "string") return;
    this.connectingHiddenPorts.delete(id);
    if (this.hiddenPorts.delete(id) && this.bridgeWindow && !this.bridgeWindow.isDestroyed()) {
      this.bridgeWindow.webContents.send(CHANNELS.portClose, { id });
    }
  }

  resolveDialog(message) {
    const pending = this.dialogRequests.get(message.requestId);
    if (!pending) return;
    this.dialogRequests.delete(message.requestId);
    clearTimeout(pending.timer);
    pending.resolve(message.result ?? null);
  }

  beginDiscovery() {
    this.discoverBridgeWindow();
    this.discoveryTimer = setInterval(() => this.discoverBridgeWindow(), 500);
    this.discoveryTimer.unref?.();
  }

  async discoverBridgeWindow() {
    if (this.discoveryInFlight) return;
    if (this.bridgeWindow && !this.bridgeWindow.isDestroyed() && !this.bridgeWindow.webContents.isDestroyed?.()) return;
    this.discoveryInFlight = true;
    try {
      const windows = this.electron.BrowserWindow.getAllWindows().filter(isPrimaryBridgeWindowCandidate);
      for (const browserWindow of windows) {
        if (browserWindow.isDestroyed()) continue;
        try {
          browserWindow.hide();
          browserWindow.setSkipTaskbar?.(true);
          const bridgeAvailable = await browserWindow.webContents.executeJavaScript(
            "Boolean(window.electronBridge?.sendMessageFromView)",
            true,
          );
          if (!bridgeAvailable) continue;
          if (new URL(browserWindow.webContents.getURL()).pathname !== BRIDGE_BACKEND_PATH) {
            await browserWindow.loadURL(bridgeBackendUrl());
            return;
          }
          this.bindBridgeWindow(browserWindow);
          await this.refreshSnapshot();
          return;
        } catch {
          // This can be a splash, utility, or not-yet-loaded window.
        }
      }
    } finally {
      this.discoveryInFlight = false;
    }
  }

  bindBridgeWindow(browserWindow) {
    this.bridgeLifecycleCleanup?.();
    this.bridgeWindow = browserWindow;
    const webContents = browserWindow.webContents;
    if (!webContents.__codexBrowserUiSendPatched) {
      const originalSend = webContents.send.bind(webContents);
      webContents.send = (channel, ...args) => {
        const result = originalSend(channel, ...args);
        this.forwardWebContentsSend(channel, args);
        return result;
      };
      Object.defineProperty(webContents, "__codexBrowserUiSendPatched", { value: true });
    }
    const onClosed = () => this.invalidateBridgeWindow(browserWindow, "window closed");
    const onDestroyed = () => this.invalidateBridgeWindow(browserWindow, "web contents destroyed");
    const onRenderProcessGone = () => this.invalidateBridgeWindow(browserWindow, "render process gone");
    const onDidStartNavigation = (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame !== false) this.invalidateBridgeWindow(browserWindow, "main frame navigated");
    };
    browserWindow.on?.("closed", onClosed);
    webContents.on?.("destroyed", onDestroyed);
    webContents.on?.("render-process-gone", onRenderProcessGone);
    webContents.on?.("did-start-navigation", onDidStartNavigation);
    this.bridgeLifecycleCleanup = () => {
      browserWindow.off?.("closed", onClosed);
      webContents.off?.("destroyed", onDestroyed);
      webContents.off?.("render-process-gone", onRenderProcessGone);
      webContents.off?.("did-start-navigation", onDidStartNavigation);
    };
    log("info", "Attached to the real Electron preload bridge", { url: webContents.getURL() });
  }

  invalidateBridgeWindow(browserWindow, reason) {
    if (this.bridgeWindow !== browserWindow) return;
    this.bridgeLifecycleCleanup?.();
    this.bridgeLifecycleCleanup = null;
    this.bridgeWindow = null;
    this.hiddenPorts.clear();
    this.connectingHiddenPorts.clear();
    this.activeClient?.close(SERVICE_RESTART_CLOSE_CODE, "Electron bridge window was recreated");
    log("warn", "Electron preload bridge invalidated", { reason });
    if (!browserWindow.isDestroyed() && !browserWindow.webContents.isDestroyed?.()) {
      Promise.resolve(browserWindow.loadURL?.(bridgeBackendUrl())).catch((error) => {
        log("warn", "Could not recreate Electron preload bridge", serializeError(error));
      });
    }
    setTimeout(() => this.discoverBridgeWindow(), 0).unref?.();
  }

  forwardWebContentsSend(channel, args) {
    if (channel === CHANNELS.messageForView) {
      const message = args[0];
      if (message?.type === "shared-object-updated") {
        if (message.value === undefined) delete this.snapshot.sharedObjects[message.key];
        else this.snapshot.sharedObjects[message.key] = message.value;
      }
      this.sendToClient({ type: "view-message", message });
      return;
    }
    const workerMatch = /^codex_desktop:worker:(.+):for-view$/.exec(channel);
    if (workerMatch) {
      this.sendToClient({ type: "worker-message", workerId: workerMatch[1], message: args[0] });
      return;
    }
    if (channel === CHANNELS.systemTheme) {
      this.snapshot.systemTheme = args[0];
      this.sendToClient({ type: "theme", value: args[0] });
    }
  }

  async refreshSnapshot() {
    if (!this.bridgeWindow || this.bridgeWindow.isDestroyed()) return this.snapshot;
    try {
      const next = await this.bridgeWindow.webContents.executeJavaScript(`(()=>{
        const b=window.electronBridge;
        if(!b)return null;
        const safe=(f,d=null)=>{try{return typeof f==="function"?f():d}catch{return d}};
        return {
          windowType:b.windowType??"electron",
          preloadStartedAtMs:safe(b.getPreloadStartedAtMs,performance.timeOrigin),
          sharedObjects:safe(b.__browserUiGetSharedSnapshot,{}),
          systemTheme:safe(b.getSystemThemeVariant,"light"),
          sentryInitOptions:safe(b.getSentryInitOptions,null),
          appSessionId:safe(b.getAppSessionId,null),
          buildFlavor:safe(b.getBuildFlavor,null),
          isDeviceCheckSupported:safe(b.isDeviceCheckSupported,false),
          isIntelMacBuild:safe(b.isIntelMacBuild,false),
          usesOwlAppShell:safe(b.usesOwlAppShell,false)
        };
      })()`, true);
      if (next && typeof next === "object") {
        this.snapshot = { ...currentPlatformSnapshot(), ...next, sharedObjects: next.sharedObjects ?? {} };
      }
    } catch (error) {
      log("warn", "Could not refresh preload snapshot", serializeError(error));
    }
    return this.snapshot;
  }

  browserConfig() {
    return {
      ...this.snapshot,
      ready: this.isReady(),
      nativeDom: true,
      pixelStreaming: false,
      platformArch: process.arch,
      sessionToken: this.sessionToken,
      wsPath: "/__codex_browser_ui/ws",
      workspacePath: this.workspaceRoot,
    };
  }

  isReady() {
    return Boolean(
      this.assetRoot &&
      this.bridgeWindow &&
      !this.bridgeWindow.isDestroyed() &&
      !this.bridgeWindow.webContents.isDestroyed?.(),
    );
  }

  requireBridgeWebContents() {
    if (
      !this.bridgeWindow ||
      this.bridgeWindow.isDestroyed() ||
      this.bridgeWindow.webContents.isDestroyed?.()
    ) {
      throw new Error("The Electron preload bridge is not ready");
    }
    return this.bridgeWindow.webContents;
  }

  sendToClient(message) {
    return this.activeClient?.send(message) ?? false;
  }
}

let singleton = null;

function installBrowserUi({ electron } = {}) {
  if (process.platform !== "linux" || process.env.CODEX_LINUX_WEB_UI !== "1") return null;
  if (singleton) return singleton;
  if (!electron) throw new Error("installBrowserUi requires Electron");
  singleton = new BrowserUiRuntime(electron).install();
  return singleton;
}

module.exports = {
  BrowserUiRuntime,
  RPC_BRIDGE_METHODS,
  SERVICE_RESTART_CLOSE_CODE,
  SUPERSEDED_CLOSE_CODE,
  WebSocketConnection,
  encodeWebSocketFrame,
  injectBrowserBridge,
  installBrowserUi,
  isAllowedBrowserHost,
  isAuthorizedWebSocketRequest,
  isPathWithinRoots,
  isPrimaryBridgeWindowCandidate,
  isSameOriginBrowserResourceRequest,
  safeStaticPath,
  websocketAcceptValue,
};
