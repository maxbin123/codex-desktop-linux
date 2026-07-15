(function installCodexBrowserUiBridge() {
  "use strict";

  const config = window.__CODEX_BROWSER_UI_CONFIG__ || {};
  const sessionToken = typeof config.sessionToken === "string" ? config.sessionToken : "";
  const authenticatedPath = (value) => {
    const url = new URL(value, location.origin);
    url.searchParams.set("token", sessionToken);
    return `${url.pathname}${url.search}${url.hash}`;
  };
  const reportClientFailure = (kind, value) => {
    try {
      const error = value instanceof Error ? value : value?.reason instanceof Error ? value.reason : null;
      const payload = JSON.stringify({
        kind,
        message: error?.message || value?.message || String(value?.reason ?? value ?? "Unknown browser error"),
        stack: error?.stack || null,
        source: value?.filename || null,
        line: value?.lineno || null,
        column: value?.colno || null,
      });
      navigator.sendBeacon(
        authenticatedPath("/__codex_browser_ui/client-log"),
        new Blob([payload], { type: "application/json" }),
      );
    } catch {
      // Diagnostics must never interfere with renderer startup.
    }
  };
  window.addEventListener("error", (event) => reportClientFailure("error", event));
  window.addEventListener("unhandledrejection", (event) => reportClientFailure("unhandledrejection", event));

  if (window.electronBridge) {
    document.documentElement.dataset.codexBrowserUiBridge = "preexisting";
    return;
  }

  const inheritedWindowType = window.codexWindowType;
  const sharedObjects = { ...(config.sharedObjects || {}) };
  const workerSubscribers = new Map();
  const themeSubscribers = new Set();
  const pendingRequests = new Map();
  const localPorts = new Map();
  const queuedMessages = [];
  const uploadedPaths = new WeakMap();
  const wsScheme = location.protocol === "https:" ? "wss:" : "ws:";
  const wsTarget = new URL(config.wsPath || "/__codex_browser_ui/ws", location.href);
  wsTarget.protocol = wsScheme;
  wsTarget.searchParams.set("token", sessionToken);
  const wsUrl = wsTarget.href;
  const workspacePath = config.workspacePath || "/";
  let socket = null;
  let requestCounter = 0;
  let portCounter = 0;
  let systemTheme = config.systemTheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  let liveConfig = { ...config };
  let disconnectedAt = Date.now();
  let bridgeBanner = null;
  let activeDragEvent = null;
  let activeDomDialogCancel = null;
  let dialogRequestQueue = Promise.resolve();
  let domDialogCounter = 0;

  const bridge = {
    windowType: "electron",
    getPreloadStartedAtMs: () => liveConfig.preloadStartedAtMs ?? performance.timeOrigin,
    sendMessageFromView: async (message) => {
      if (message?.type === "shared-object-set") updateSharedObject(message.key, message.value);
      if (openClientUrlFromMessage(message)) return;
      if (handleClientNavigationFromMessage(message)) return;
      await rpc("sendMessageFromView", [message]);
    },
    getPathForFile: (file) => uploadedPaths.get(file) ?? null,
    startFileDrag: (payload) => startBrowserFileDrag(payload),
    sendWorkerMessageFromView: async (workerId, message) => {
      await rpc("sendWorkerMessageFromView", [workerId, message]);
    },
    subscribeToWorkerMessages: (workerId, callback) => {
      let subscribers = workerSubscribers.get(workerId);
      if (!subscribers) {
        subscribers = new Set();
        workerSubscribers.set(workerId, subscribers);
      }
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
        if (subscribers.size === 0) workerSubscribers.delete(workerId);
      };
    },
    showContextMenu: (items) => showDomMenu(items),
    showApplicationMenu: async (menuId, x, y) => {
      const items = await rpc("__browserUiGetApplicationMenu", [menuId]);
      const selection = await showDomMenu(items, { x, y });
      if (selection.id) await rpc("__browserUiActivateApplicationMenu", [selection.id]);
    },
    getFastModeRolloutMetrics: (params) => rpc("getFastModeRolloutMetrics", [params]),
    getSharedObjectSnapshotValue: (key) => sharedObjects[key],
    getSystemThemeVariant: () => systemTheme,
    subscribeToSystemThemeVariant: (callback) => {
      themeSubscribers.add(callback);
      return () => themeSubscribers.delete(callback);
    },
    triggerSentryTestError: () => rpc("triggerSentryTestError", []),
    getSentryInitOptions: () => liveConfig.sentryInitOptions ?? null,
    getAppSessionId: () => liveConfig.appSessionId ?? liveConfig.sentryInitOptions?.codexAppSessionId ?? null,
    getBuildFlavor: () => liveConfig.buildFlavor ?? null,
    isDeviceCheckSupported: () => false,
    isIntelMacBuild: () => false,
    usesOwlAppShell: () => Boolean(liveConfig.usesOwlAppShell),
  };

  try {
    if (window.codexWindowType == null) {
      Object.defineProperty(window, "codexWindowType", {
        configurable: false,
        enumerable: true,
        value: "electron",
        writable: false,
      });
    }
  } catch (error) {
    console.warn("[codex-browser-ui] Could not expose codexWindowType", error);
  }
  Object.defineProperty(window, "electronBridge", {
    configurable: false,
    enumerable: true,
    value: Object.freeze(bridge),
    writable: false,
  });
  document.documentElement.dataset.codexBrowserUiBridge = "exposed";
  document.documentElement.dataset.codexBrowserUiWindowType = String(window.codexWindowType ?? "missing");
  document.documentElement.dataset.codexBrowserUiInheritedWindowType = String(inheritedWindowType ?? "missing");

  for (const [name, install] of [
    ["Linux browser identity", forceLinuxPlatform],
    ["local asset adapter", installLocalAssetRewrite],
    ["webview adapter", installWebviewPolyfill],
    ["file adapter", installFileUploadCapture],
    ["MessagePort adapter", installPortConnectCapture],
  ]) {
    try {
      install();
    } catch (error) {
      console.warn(`[codex-browser-ui] Could not install ${name}`, error);
    }
  }
  setTheme(systemTheme);
  connect();

  function connect() {
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      reloadWhenServerReturns();
      return;
    }
    socket.addEventListener("open", () => {
      document.documentElement.dataset.codexBrowserUiSocket = "open";
      disconnectedAt = 0;
      hideBridgeBanner();
      while (queuedMessages.length > 0 && socket.readyState === WebSocket.OPEN) {
        socket.send(queuedMessages.shift());
      }
    });
    socket.addEventListener("message", (event) => {
      try {
        handleServerMessage(JSON.parse(event.data));
      } catch (error) {
        console.warn("[codex-browser-ui] Invalid bridge message", error);
      }
    });
    socket.addEventListener("close", (event) => {
      if (event.code === 4001) {
        rejectPendingRequests(new Error("A newer Codex tab took control"));
        closeAllLocalPorts();
        queuedMessages.length = 0;
        showBridgeBanner("This tab was disconnected because a newer Codex tab took control.");
        return;
      }
      if (!disconnectedAt) disconnectedAt = Date.now();
      rejectPendingRequests(new Error("The Electron bridge disconnected"));
      closeAllLocalPorts();
      queuedMessages.length = 0;
      setTimeout(() => {
        if (disconnectedAt && Date.now() - disconnectedAt >= 1500) showBridgeBanner();
      }, 1600);
      reloadWhenServerReturns();
    });
    socket.addEventListener("error", () => socket.close());
  }

  function reloadWhenServerReturns() {
    const probe = () => fetch("/healthz", { cache: "no-store", credentials: "same-origin" })
      .then(() => location.reload())
      .catch(() => setTimeout(probe, 500));
    setTimeout(probe, 250);
  }

  function send(message) {
    const serialized = JSON.stringify(message);
    if (socket?.readyState === WebSocket.OPEN) socket.send(serialized);
    else queuedMessages.push(serialized);
  }

  function rpc(method, args) {
    const requestId = `browser-${Date.now()}-${++requestCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`Electron bridge call timed out: ${method}`));
      }, 5 * 60 * 1000);
      pendingRequests.set(requestId, { resolve, reject, timer });
      send({ type: "rpc", requestId, method, args });
    });
  }

  function handleServerMessage(message) {
    switch (message?.type) {
      case "hello":
        liveConfig = { ...liveConfig, ...(message.config || {}) };
        Object.assign(sharedObjects, message.config?.sharedObjects || {});
        setTheme(message.config?.systemTheme);
        break;
      case "rpc-result":
        settleRequest(message.requestId, null, message.result);
        break;
      case "rpc-error": {
        const error = new Error(message.error?.message || "Electron bridge call failed");
        if (message.error?.name) error.name = message.error.name;
        if (message.error?.stack) error.stack = message.error.stack;
        settleRequest(message.requestId, error);
        break;
      }
      case "view-message":
        dispatchViewMessage(message.message);
        break;
      case "worker-message":
        for (const callback of workerSubscribers.get(message.workerId) || []) callback(message.message);
        break;
      case "theme":
        setTheme(message.value);
        break;
      case "port-data":
        document.documentElement.dataset.codexBrowserUiPortIn = String(
          Number(document.documentElement.dataset.codexBrowserUiPortIn || 0) + 1,
        );
        localPorts.get(message.id)?.postMessage(message.data);
        break;
      case "port-ready":
        document.documentElement.dataset.codexBrowserUiAppHost = "connected";
        break;
      case "port-close":
        closeLocalPort(message.id, false);
        break;
      case "port-offer":
        acceptPortOffer(message);
        break;
      case "dialog-request":
        dialogRequestQueue = dialogRequestQueue.then(() => handleDialogRequest(message));
        break;
      case "open-url":
        if (typeof message.url === "string") window.open(message.url, "_blank", "noopener,noreferrer");
        break;
      case "clipboard-write":
        navigator.clipboard?.writeText?.(String(message.text ?? "")).catch(() => {});
        break;
      case "notification":
        showBrowserNotification(message);
        break;
      default:
        break;
    }
  }

  function settleRequest(requestId, error, result) {
    const pending = pendingRequests.get(requestId);
    if (!pending) return;
    pendingRequests.delete(requestId);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  function rejectPendingRequests(error) {
    for (const [requestId, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      pendingRequests.delete(requestId);
    }
  }

  function dispatchViewMessage(message) {
    if (message?.type === "shared-object-updated") updateSharedObject(message.key, message.value);
    window.dispatchEvent(new MessageEvent("message", { data: message }));
  }

  function updateSharedObject(key, value) {
    if (value === undefined) delete sharedObjects[key];
    else sharedObjects[key] = value;
  }

  function setTheme(value) {
    if (value !== "light" && value !== "dark") return;
    systemTheme = value;
    document.documentElement.classList.toggle("electron-dark", value === "dark");
    document.documentElement.classList.toggle("electron-light", value === "light");
    for (const callback of themeSubscribers) callback();
  }

  function openClientUrlFromMessage(message) {
    if (!message || typeof message !== "object") return false;
    const clientTypes = new Set([
      "open-in-browser",
      "open-external-url",
      "open-url-in-external-browser",
      "open-link-in-browser",
    ]);
    if (!clientTypes.has(message.type)) return false;
    const url = message.url || message.href || message.path;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
    window.open(url, "_blank", "noopener,noreferrer");
    return true;
  }

  function handleClientNavigationFromMessage(message) {
    if (!message || typeof message !== "object") return false;
    let target = null;
    if (message.type === "show-settings") target = `/settings/${message.section || "general-settings"}`;
    else if (message.type === "open-in-main-window" || message.type === "open-in-new-window") target = message.path;
    else if (message.type === "open-current-main-window") return true;
    if (typeof target !== "string" || !target.startsWith("/")) return false;
    dispatchViewMessage({ type: "navigate-to-route", path: target });
    return true;
  }

  function showBrowserNotification(message) {
    if (!("Notification" in window)) return;
    const show = () => {
      if (Notification.permission !== "granted") return;
      const notification = new Notification(message.title || "Codex", {
        body: message.body || "",
        icon: message.icon,
        silent: Boolean(message.silent),
      });
      if (message.url) notification.onclick = () => window.open(message.url, "_blank", "noopener,noreferrer");
    };
    if (Notification.permission === "default") Notification.requestPermission().then(show).catch(() => {});
    else show();
  }

  function installPortConnectCapture() {
    window.addEventListener(
      "message",
      (event) => {
        if (
          event.source === window &&
          event.origin === window.location.origin &&
          event.data?.type === "connect-app-host"
        ) {
          const port = event.ports?.[0] || event.data.port;
          if (!port) return;
          const id = `host-${Date.now()}-${++portCounter}`;
          bindLocalPort(id, port);
          document.documentElement.dataset.codexBrowserUiAppHost = "connecting";
          send({ type: "port-connect", id });
          return;
        }
        relaySandboxInitFromFrame(event);
      },
      true,
    );
  }

  function relaySandboxInitFromFrame(event) {
    if (event.data?.type !== "init" || event.source == null || event.source === window) return;
    const frame = Array.from(document.querySelectorAll("iframe[data-codex-webview-polyfill='true']"))
      .find((candidate) => candidate.contentWindow === event.source);
    if (!frame) return;
    let sourceUrl;
    try {
      sourceUrl = new URL(frame.src);
    } catch {
      return;
    }
    if (event.origin !== sourceUrl.origin) return;
    if (!sourceUrl.hostname.endsWith(".web-sandbox.oaiusercontent.com") && sourceUrl.hostname !== "web-sandbox.oaiusercontent.com") return;
    const initId = new URLSearchParams(sourceUrl.hash.slice(1)).get("initId");
    const partition = frame.getAttribute("partition") || "";
    const sandboxId = partition
      .replace(/^persist:/, "")
      .replace(/^codex-mcp-app-sandbox:/, "");
    const namedPorts = event.data.ports;
    const replyPort = event.data.replyPort;
    if (!initId || !sandboxId || !namedPorts || typeof namedPorts !== "object" || !replyPort) return;
    const portNames = Object.keys(namedPorts);
    const ports = portNames.map((name) => namedPorts[name]);
    if (ports.some((port) => !port)) return;
    window.postMessage(
      {
        type: "init",
        initId,
        origin: sourceUrl.origin,
        portNames,
        sandboxId,
      },
      window.location.origin,
      [...ports, replyPort],
    );
  }

  function bindLocalPort(id, port) {
    closeLocalPort(id, false);
    localPorts.set(id, port);
    port.onmessage = (event) => {
      document.documentElement.dataset.codexBrowserUiPortOut = String(
        Number(document.documentElement.dataset.codexBrowserUiPortOut || 0) + 1,
      );
      send({ type: "port-data", id, data: event.data });
    };
    port.onmessageerror = () => closeLocalPort(id, true);
    port.start?.();
  }

  function closeLocalPort(id, notify) {
    const port = localPorts.get(id);
    if (!port) return;
    localPorts.delete(id);
    try {
      port.close();
    } catch {
      // Already closed.
    }
    if (notify) send({ type: "port-close", id });
  }

  function closeAllLocalPorts() {
    for (const id of [...localPorts.keys()]) closeLocalPort(id, false);
  }

  function acceptPortOffer(message) {
    if (!Array.isArray(message.portIds)) return;
    const transferred = [];
    for (const id of message.portIds) {
      const channel = new MessageChannel();
      bindLocalPort(id, channel.port1);
      transferred.push(channel.port2);
    }
    window.postMessage(message.message, window.location.origin, transferred);
  }

  function uploadFileSync(file) {
    if (!(file instanceof File) || uploadedPaths.has(file)) return uploadedPaths.get(file) ?? null;
    try {
      const request = new XMLHttpRequest();
      request.open("POST", authenticatedPath("/__codex_browser_ui/upload"), false);
      request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      request.setRequestHeader("X-Codex-Filename", encodeURIComponent(file.name || "upload"));
      request.send(file);
      if (request.status < 200 || request.status >= 300) return null;
      const response = JSON.parse(request.responseText);
      if (typeof response.path !== "string") return null;
      uploadedPaths.set(file, response.path);
      return response.path;
    } catch (error) {
      console.warn("[codex-browser-ui] File upload failed", error);
      return null;
    }
  }

  function installFileUploadCapture() {
    const uploadFromEvent = (event) => {
      const files = event.target?.files || event.dataTransfer?.files || event.clipboardData?.files;
      if (!files) return;
      for (const file of Array.from(files)) uploadFileSync(file);
    };
    window.addEventListener("change", uploadFromEvent, true);
    window.addEventListener("drop", uploadFromEvent, true);
    window.addEventListener("paste", uploadFromEvent, true);
    window.addEventListener("dragstart", (event) => {
      activeDragEvent = event;
      queueMicrotask(() => {
        if (activeDragEvent === event) activeDragEvent = null;
      });
    }, true);
  }

  function startBrowserFileDrag(payload) {
    const filePath = typeof payload?.path === "string" ? payload.path : null;
    const transfer = activeDragEvent?.dataTransfer;
    if (!filePath || !transfer) return false;
    const url = new URL("/__codex_browser_ui/file", location.origin);
    url.searchParams.set("path", filePath);
    url.searchParams.set("token", sessionToken);
    const fileName = filePath.split(/[\\/]/u).at(-1) || "download";
    try {
      transfer.effectAllowed = "copy";
      transfer.setData("DownloadURL", `application/octet-stream:${fileName}:${url.href}`);
      transfer.setData("text/uri-list", url.href);
      transfer.setData("text/plain", fileName);
      return true;
    } catch {
      return false;
    }
  }

  function forceLinuxPlatform() {
    const define = (target, key, value) => {
      try {
        Object.defineProperty(target, key, { configurable: true, get: () => value });
      } catch {
        // A browser can make individual Navigator properties non-configurable.
      }
    };
    const architecture = config.platformArch === "arm64" ? "aarch64" : "x86_64";
    define(navigator, "platform", `Linux ${architecture}`);
    define(navigator, "userAgent", navigator.userAgent.replace(/Macintosh|Mac OS X|Windows NT[^;)]*/gi, `X11; Linux ${architecture}`));
    if (navigator.userAgentData) {
      const original = navigator.userAgentData;
      const linuxData = {
        brands: original.brands,
        mobile: original.mobile,
        platform: "Linux",
        getHighEntropyValues: async (hints) => ({
          ...(await original.getHighEntropyValues(hints)),
          platform: "Linux",
          platformVersion: "",
        }),
        toJSON: () => ({ brands: original.brands, mobile: original.mobile, platform: "Linux" }),
      };
      define(navigator, "userAgentData", linuxData);
    }
  }

  function installLocalAssetRewrite() {
    const rewriteValue = (value) => {
      if (typeof value !== "string" || !value.startsWith("app://fs/@fs/")) return value;
      return authenticatedPath(value.slice("app://fs".length));
    };
    const rewriteElement = (element) => {
      if (!(element instanceof Element)) return;
      for (const attribute of ["src", "href", "poster"]) {
        const value = element.getAttribute(attribute);
        const rewritten = rewriteValue(value);
        if (rewritten !== value) element.setAttribute(attribute, rewritten);
      }
      for (const child of element.querySelectorAll?.("[src],[href],[poster]") || []) rewriteElement(child);
    };
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") rewriteElement(record.target);
        for (const node of record.addedNodes || []) rewriteElement(node);
      }
    }).observe(document, {
      attributes: true,
      attributeFilter: ["src", "href", "poster"],
      childList: true,
      subtree: true,
    });
  }

  async function handleDialogRequest(message) {
    let result = null;
    try {
      if (message.kind === "open") {
        const multiple = message.options?.properties?.includes?.("multiSelections");
        const directory = message.options?.properties?.includes?.("openDirectory");
        if (!directory) {
          result = { paths: await chooseBrowserFiles(message.options, multiple) };
        } else {
          const answer = await showDomDialog({
            kind: "open",
            title: message.options?.title || "Choose folder",
            message: multiple
              ? "Enter folder paths on the machine running Codex, one per line."
              : "Enter a folder path on the machine running Codex.",
            input: {
              label: multiple ? "Codex host folder paths" : "Codex host folder path",
              multiline: Boolean(multiple),
              path: true,
              value: message.options?.defaultPath || workspacePath,
            },
            buttons: [
              { action: "cancel", label: "Cancel", value: "cancel" },
              {
                action: "accept",
                label: message.options?.buttonLabel || "Use folder",
                primary: true,
                value: "accept",
              },
            ],
            cancelValue: "cancel",
          });
          const rawPaths = answer?.action === "accept" ? answer.inputValue : null;
          result = {
            paths: rawPaths == null
              ? []
              : (multiple ? rawPaths.split(/\r?\n/) : [rawPaths])
                .map((item) => item.trim())
                .filter((item) => item.startsWith("/")),
          };
        }
      } else if (message.kind === "save") {
        const configuredPath = String(message.options?.defaultPath || "");
        const defaultName = configuredPath.split(/[\\/]/).pop() || "download";
        const answer = await showDomDialog({
          kind: "save",
          title: message.options?.title || "Save file",
          message: "Enter the destination path on the machine running Codex.",
          input: {
            label: "Codex host file path",
            path: true,
            value: configuredPath.startsWith("/") ? configuredPath : `${workspacePath}/${defaultName}`,
          },
          buttons: [
            { action: "cancel", label: "Cancel", value: "cancel" },
            {
              action: "accept",
              label: message.options?.buttonLabel || "Save",
              primary: true,
              value: "accept",
            },
          ],
          cancelValue: "cancel",
        });
        const path = answer?.action === "accept" ? answer.inputValue.trim() : "";
        result = { path: path.startsWith("/") ? path : null };
      } else if (message.kind === "message") {
        const buttons = Array.isArray(message.options?.buttons) ? message.options.buttons : ["OK", "Cancel"];
        const defaultId = Number.isInteger(message.options?.defaultId) ? message.options.defaultId : 0;
        const cancelId = Number.isInteger(message.options?.cancelId)
          ? message.options.cancelId
          : Math.min(1, buttons.length - 1);
        const answer = await showDomDialog({
          kind: "message",
          title: message.options?.title || "Codex",
          message: message.options?.message,
          detail: message.options?.detail,
          checkbox: message.options?.checkboxLabel
            ? {
                checked: Boolean(message.options.checkboxChecked),
                label: message.options.checkboxLabel,
              }
            : null,
          buttons: buttons.map((label, index) => ({
            action: index === cancelId ? "cancel" : index === defaultId ? "accept" : "response",
            label,
            primary: index === defaultId,
            responseIndex: index,
            value: index,
          })),
          cancelValue: cancelId,
        });
        result = {
          checkboxChecked: Boolean(answer?.checkboxChecked),
          response: Number.isInteger(answer?.action) ? answer.action : cancelId,
        };
      }
    } catch (error) {
      console.warn("[codex-browser-ui] Browser dialog failed", error);
    } finally {
      send({ type: "dialog-response", requestId: message.requestId, result });
    }
  }

  function showDomDialog({ kind, title, message, detail, input, checkbox, buttons, cancelValue, filePicker }) {
    return new Promise((resolve) => {
      activeDomDialogCancel?.();

      const id = `codex-browser-ui-dialog-${++domDialogCounter}`;
      const dialog = document.createElement("dialog");
      dialog.dataset.codexBrowserUiDialog = "";
      dialog.dataset.dialogKind = String(kind || "message");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", `${id}-title`);
      Object.assign(dialog.style, {
        background: "Canvas",
        border: "1px solid color-mix(in srgb, CanvasText 20%, transparent)",
        borderRadius: "12px",
        boxShadow: "0 24px 80px rgb(0 0 0 / .35)",
        color: "CanvasText",
        maxWidth: "min(560px, calc(100vw - 32px))",
        padding: "0",
        width: "min(560px, calc(100vw - 32px))",
      });

      const form = document.createElement("form");
      form.method = "dialog";
      Object.assign(form.style, { display: "grid", gap: "16px", padding: "22px" });

      const heading = document.createElement("h2");
      heading.id = `${id}-title`;
      heading.textContent = String(title || "Codex");
      Object.assign(heading.style, { font: "600 18px/1.35 system-ui, sans-serif", margin: "0" });
      form.append(heading);

      const description = [message, detail].filter(Boolean).join("\n\n");
      if (description) {
        const descriptionNode = document.createElement("p");
        descriptionNode.id = `${id}-description`;
        descriptionNode.textContent = description;
        descriptionNode.style.cssText = "font:14px/1.5 system-ui,sans-serif;margin:0;white-space:pre-wrap;";
        dialog.setAttribute("aria-describedby", descriptionNode.id);
        form.append(descriptionNode);
      }

      let inputNode = null;
      if (input) {
        const field = document.createElement("label");
        field.textContent = String(input.label || "Value");
        Object.assign(field.style, { display: "grid", font: "500 13px/1.4 system-ui, sans-serif", gap: "7px" });
        inputNode = document.createElement(input.multiline ? "textarea" : "input");
        if (!input.multiline) inputNode.type = "text";
        if (input.multiline) inputNode.rows = 4;
        inputNode.value = String(input.value || "");
        if (input.path) inputNode.dataset.codexDialogPath = "";
        Object.assign(inputNode.style, {
          background: "Field",
          border: "1px solid color-mix(in srgb, CanvasText 28%, transparent)",
          borderRadius: "8px",
          color: "FieldText",
          font: "14px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace",
          minWidth: "0",
          padding: "9px 10px",
          resize: input.multiline ? "vertical" : "none",
          width: "100%",
        });
        field.append(inputNode);
        form.append(field);
      }

      let checkboxNode = null;
      if (checkbox?.label) {
        const checkboxLabel = document.createElement("label");
        Object.assign(checkboxLabel.style, { alignItems: "center", display: "flex", font: "14px system-ui, sans-serif", gap: "8px" });
        checkboxNode = document.createElement("input");
        checkboxNode.type = "checkbox";
        checkboxNode.checked = Boolean(checkbox.checked);
        checkboxLabel.append(checkboxNode, document.createTextNode(String(checkbox.label)));
        form.append(checkboxLabel);
      }

      let fileInput = null;
      if (filePicker) {
        const hint = document.createElement("p");
        hint.textContent = filePicker.multiple
          ? "Choose files from this browser. They will be copied to the machine running Codex."
          : "Choose a file from this browser. It will be copied to the machine running Codex.";
        hint.style.cssText = "font:13px/1.45 system-ui,sans-serif;margin:0;opacity:.78;";
        form.append(hint);
        fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.multiple = Boolean(filePicker.multiple);
        fileInput.style.display = "none";
        if (filePicker.accept) fileInput.accept = filePicker.accept;
        form.append(fileInput);
      }

      const actions = document.createElement("div");
      Object.assign(actions.style, { display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "flex-end" });
      form.append(actions);
      dialog.append(form);
      document.body.append(dialog);

      let finished = false;
      const finish = (action, extra = {}) => {
        if (finished) return;
        finished = true;
        if (activeDomDialogCancel === cancel) activeDomDialogCancel = null;
        removeEventListener("keydown", onKeyDown, true);
        if (dialog.open) dialog.close();
        dialog.remove();
        resolve({
          action,
          checkboxChecked: Boolean(checkboxNode?.checked),
          inputValue: inputNode?.value ?? "",
          ...extra,
        });
      };
      const cancel = () => finish(cancelValue);
      activeDomDialogCancel = cancel;
      const onKeyDown = (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        cancel();
      };
      addEventListener("keydown", onKeyDown, true);
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        cancel();
      });
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const primary = buttons.find((button) => button.primary) || buttons.at(-1);
        if (primary && !primary.opensFilePicker) finish(primary.value);
      });

      if (fileInput) {
        fileInput.addEventListener("change", () => {
          const paths = Array.from(fileInput.files || []).map(uploadFileSync).filter(Boolean);
          finish(paths.length > 0 ? "accept" : cancelValue, { filePaths: paths });
        }, { once: true });
        fileInput.addEventListener("cancel", cancel, { once: true });
      }

      let focusTarget = inputNode;
      for (const button of buttons) {
        const element = document.createElement("button");
        element.type = button.primary && !button.opensFilePicker ? "submit" : "button";
        element.textContent = String(button.label);
        element.dataset.codexDialogAction = String(button.action || "response");
        if (Number.isInteger(button.responseIndex)) {
          element.dataset.codexDialogResponseIndex = String(button.responseIndex);
        }
        if (button.opensFilePicker) element.dataset.codexDialogFilePicker = "";
        Object.assign(element.style, {
          background: button.primary ? "AccentColor" : "ButtonFace",
          border: "1px solid color-mix(in srgb, CanvasText 22%, transparent)",
          borderRadius: "8px",
          color: button.primary ? "AccentColorText" : "ButtonText",
          cursor: "pointer",
          font: "500 14px system-ui, sans-serif",
          minHeight: "34px",
          padding: "6px 13px",
        });
        element.addEventListener("click", (event) => {
          event.preventDefault();
          if (button.opensFilePicker) fileInput?.click();
          else finish(button.value);
        });
        actions.append(element);
        if (!focusTarget && button.primary) focusTarget = element;
      }

      try {
        dialog.showModal();
      } catch (error) {
        dialog.remove();
        activeDomDialogCancel = null;
        removeEventListener("keydown", onKeyDown, true);
        resolve({ action: cancelValue, checkboxChecked: false, inputValue: "", error });
        return;
      }
      queueMicrotask(() => focusTarget?.focus());
    });
  }

  async function chooseBrowserFiles(options, multiple) {
    const extensions = (options?.filters || []).flatMap((filter) => filter.extensions || []);
    const answer = await showDomDialog({
      kind: "open",
      title: options?.title || "Choose file",
      message: options?.message,
      filePicker: {
        accept: extensions.length > 0 ? extensions.map((extension) => `.${extension}`).join(",") : "",
        multiple: Boolean(multiple),
      },
      buttons: [
        { action: "cancel", label: "Cancel", value: "cancel" },
        {
          action: "accept",
          label: options?.buttonLabel || (multiple ? "Choose files" : "Choose file"),
          opensFilePicker: true,
          primary: true,
          value: "accept",
        },
      ],
      cancelValue: "cancel",
    });
    return Array.isArray(answer?.filePaths) ? answer.filePaths : [];
  }

  function showDomMenu(items, position = {}) {
    return new Promise((resolve) => {
      const old = document.getElementById("codex-browser-ui-native-menu");
      old?.remove();
      const menu = document.createElement("div");
      menu.id = "codex-browser-ui-native-menu";
      menu.setAttribute("role", "menu");
      Object.assign(menu.style, {
        position: "fixed",
        zIndex: "2147483647",
        minWidth: "190px",
        maxWidth: "360px",
        maxHeight: "min(70vh, 620px)",
        overflow: "auto",
        padding: "5px",
        border: "1px solid color-mix(in srgb, CanvasText 18%, transparent)",
        borderRadius: "9px",
        background: "Canvas",
        color: "CanvasText",
        boxShadow: "0 12px 36px rgb(0 0 0 / .24)",
        font: "menu",
      });
      const x = Math.min(innerWidth - 380, Math.max(4, position.x ?? window.event?.clientX ?? 12));
      const y = Math.min(innerHeight - 400, Math.max(4, position.y ?? window.event?.clientY ?? 12));
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;

      let finished = false;
      const finish = (id) => {
        if (finished) return;
        finished = true;
        menu.remove();
        removeEventListener("pointerdown", outside, true);
        removeEventListener("keydown", keyboard, true);
        resolve({ id: id ?? null });
      };
      const outside = (event) => {
        if (!menu.contains(event.target)) finish(null);
      };
      const keyboard = (event) => {
        if (event.key === "Escape") finish(null);
      };

      const appendItems = (parent, entries, labelPrefix = "") => {
        for (const item of Array.isArray(entries) ? entries : []) {
          if (item?.type === "separator") {
            const separator = document.createElement("div");
            separator.setAttribute("role", "separator");
            Object.assign(separator.style, { height: "1px", margin: "5px 3px", background: "color-mix(in srgb, CanvasText 16%, transparent)" });
            parent.append(separator);
            continue;
          }
          if (item?.submenu) {
            appendItems(parent, item.submenu, `${labelPrefix}${item.label || item.id || "Menu"} › `);
            continue;
          }
          const button = document.createElement("button");
          button.type = "button";
          button.disabled = item?.enabled === false;
          button.setAttribute("role", item?.type === "checkbox" ? "menuitemcheckbox" : "menuitem");
          button.textContent = `${item?.checked ? "✓  " : ""}${labelPrefix}${item?.label || item?.id || ""}${item?.accelerator ? `    ${item.accelerator}` : ""}`;
          Object.assign(button.style, {
            display: "block",
            width: "100%",
            padding: "7px 9px",
            border: "0",
            borderRadius: "6px",
            background: "transparent",
            color: "inherit",
            textAlign: "left",
            font: "inherit",
            cursor: button.disabled ? "default" : "pointer",
            opacity: button.disabled ? ".45" : "1",
          });
          button.addEventListener("pointerenter", () => {
            if (!button.disabled) button.style.background = "Highlight";
          });
          button.addEventListener("pointerleave", () => {
            button.style.background = "transparent";
          });
          button.addEventListener("click", () => {
            if (!button.disabled) finish(item?.id ?? null);
          });
          parent.append(button);
        }
      };
      appendItems(menu, items);
      document.body.append(menu);
      setTimeout(() => {
        addEventListener("pointerdown", outside, true);
        addEventListener("keydown", keyboard, true);
      }, 0);
    });
  }

  function installWebviewPolyfill() {
    const originalCreateElement = Document.prototype.createElement;
    Document.prototype.createElement = function createElement(tagName, options) {
      if (String(tagName).toLowerCase() !== "webview") return originalCreateElement.call(this, tagName, options);
      const frame = originalCreateElement.call(this, "iframe");
      initializeWebviewFrame(frame);
      return frame;
    };
  }

  function initializeWebviewFrame(frame) {
    frame.dataset.codexWebviewPolyfill = "true";
    frame.setAttribute("allow", "clipboard-read; clipboard-write; fullscreen; microphone; camera; autoplay");
    frame.style.border = "0";
    let loading = true;
    let zoomFactor = 1;
    const emit = (name, details = {}) => {
      const event = new Event(name);
      Object.assign(event, details);
      frame.dispatchEvent(event);
    };
    const nativeSrc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src");
    Object.defineProperty(frame, "src", {
      configurable: true,
      get: () => nativeSrc.get.call(frame),
      set: (value) => {
        loading = true;
        emit("did-start-navigation", { url: String(value), isMainFrame: true });
        emit("did-start-loading");
        nativeSrc.set.call(frame, value);
      },
    });
    frame.addEventListener("load", () => {
      loading = false;
      const url = frame.src;
      emit("dom-ready");
      emit("did-navigate", { url });
      emit("did-finish-load");
      emit("did-stop-loading");
      emit("page-title-updated", { title: frame.getTitle() });
    });
    frame.getURL = () => frame.src || "about:blank";
    frame.getTitle = () => {
      try {
        return frame.contentDocument?.title || frame.title || "";
      } catch {
        return frame.title || "";
      }
    };
    frame.isLoading = () => loading;
    frame.loadURL = (url) => new Promise((resolve) => {
      frame.addEventListener("load", resolve, { once: true });
      frame.src = url;
    });
    frame.reload = () => frame.contentWindow?.location.reload();
    frame.reloadIgnoringCache = frame.reload;
    frame.stop = () => frame.contentWindow?.stop();
    frame.goBack = () => frame.contentWindow?.history.back();
    frame.goForward = () => frame.contentWindow?.history.forward();
    frame.canGoBack = () => true;
    frame.canGoForward = () => true;
    frame.clearHistory = () => {};
    frame.getWebContentsId = () => -1;
    frame.openDevTools = () => {};
    frame.closeDevTools = () => {};
    frame.isDevToolsOpened = () => false;
    frame.setAudioMuted = (muted) => { frame.muted = Boolean(muted); };
    frame.isAudioMuted = () => Boolean(frame.muted);
    frame.setZoomFactor = (factor) => {
      zoomFactor = Number(factor) || 1;
      frame.style.zoom = String(zoomFactor);
    };
    frame.getZoomFactor = () => zoomFactor;
    frame.send = (channel, ...args) => {
      let targetOrigin;
      try {
        targetOrigin = new URL(frame.src, location.href).origin;
      } catch {
        return;
      }
      if (targetOrigin === "null") return;
      frame.contentWindow?.postMessage({ channel, args, type: "electron-ipc-message" }, targetOrigin);
    };
    frame.executeJavaScript = async (source) => {
      try {
        return frame.contentWindow.eval(source);
      } catch {
        return undefined;
      }
    };
    frame.insertCSS = async (css) => {
      try {
        const style = frame.contentDocument.createElement("style");
        style.textContent = css;
        frame.contentDocument.head.append(style);
        return `browser-ui-${Date.now()}`;
      } catch {
        return "";
      }
    };
    frame.removeInsertedCSS = async () => {};
    frame.capturePage = async () => null;
    frame.print = () => frame.contentWindow?.print();
  }

  function showBridgeBanner(message = "Reconnecting to the Codex backend…") {
    if (bridgeBanner || !document.body) return;
    bridgeBanner = document.createElement("div");
    bridgeBanner.textContent = message;
    Object.assign(bridgeBanner.style, {
      position: "fixed",
      zIndex: "2147483647",
      right: "12px",
      bottom: "12px",
      padding: "8px 12px",
      borderRadius: "8px",
      background: "CanvasText",
      color: "Canvas",
      boxShadow: "0 8px 24px rgb(0 0 0 / .2)",
      font: "13px system-ui, sans-serif",
    });
    document.body.append(bridgeBanner);
  }

  function hideBridgeBanner() {
    bridgeBanner?.remove();
    bridgeBanner = null;
  }
})();
