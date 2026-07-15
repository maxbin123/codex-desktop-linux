"use strict";

const fs = require("node:fs");
const path = require("node:path");

const BROWSER_UI_BOOTSTRAP_MARKER = "__CODEX_LINUX_BROWSER_UI_BOOTSTRAP__";
const BROWSER_UI_PRELOAD_RELAY_MARKER = "__CODEX_LINUX_BROWSER_UI_PRELOAD_RELAY__";
const ELECTRON_BRIDGE_EXPOSE_PATTERN =
  /([A-Za-z_$][\w$]*)\.contextBridge\.exposeInMainWorld\(\s*([`'"])electronBridge\2\s*,\s*([A-Za-z_$][\w$]*)\s*\)/u;
const SHARED_OBJECT_GETTER_PATTERN =
  /getSharedObjectSnapshotValue\s*:\s*([A-Za-z_$][\w$]*)\s*=>\s*([A-Za-z_$][\w$]*)\s*\[\s*\1\s*\]/u;
const MAIN_STARTUP_PATTERN = /exports\.runMainAppStartup\s*=/u;
const REQUIRED_BRIDGE_METHODS = Object.freeze([
  "windowType",
  "getPreloadStartedAtMs",
  "sendMessageFromView",
  "getPathForFile",
  "startFileDrag",
  "sendWorkerMessageFromView",
  "subscribeToWorkerMessages",
  "showContextMenu",
  "showApplicationMenu",
  "getFastModeRolloutMetrics",
  "getSharedObjectSnapshotValue",
  "getSystemThemeVariant",
  "subscribeToSystemThemeVariant",
  "triggerSentryTestError",
  "getSentryInitOptions",
  "getAppSessionId",
  "getBuildFlavor",
  "isDeviceCheckSupported",
  "isIntelMacBuild",
  "usesOwlAppShell",
]);

const BROWSER_UI_BOOTSTRAP = `
;/*${BROWSER_UI_BOOTSTRAP_MARKER}*/(()=>{
  if(process.platform!==\`linux\`||process.env.CODEX_LINUX_WEB_UI!==\`1\`)return;
  try{
    const __codexBrowserUiPath=require(\`node:path\`);
    let __codexBrowserUiFeaturesDir=process.env.CODEX_LINUX_FEATURES_DIR;
    if(typeof __codexBrowserUiFeaturesDir!==\`string\`||__codexBrowserUiFeaturesDir.trim().length===0){
      if(typeof process.resourcesPath!==\`string\`||process.resourcesPath.length===0)throw Error(\`Browser UI feature directory is unavailable\`);
      __codexBrowserUiFeaturesDir=__codexBrowserUiPath.join(process.resourcesPath,\`..\`,\`.codex-linux\`,\`features\`);
    }
    const __codexBrowserUiRuntimePath=__codexBrowserUiPath.join(__codexBrowserUiFeaturesDir,\`browser-ui\`,\`runtime.cjs\`);
    const __codexBrowserUiRuntime=require(__codexBrowserUiRuntimePath);
    if(typeof __codexBrowserUiRuntime?.installBrowserUi!==\`function\`)throw TypeError(\`Browser UI runtime must export installBrowserUi({ electron })\`);
    __codexBrowserUiRuntime.installBrowserUi({electron:require(\`electron\`)});
  }catch(__codexBrowserUiError){
    console.error(\`[browser-ui] Failed to install browser UI runtime\`,__codexBrowserUiError);
    throw __codexBrowserUiError;
  }
})();
`;

function applyBrowserUiBootstrap(source) {
  if (source.includes(BROWSER_UI_BOOTSTRAP_MARKER)) {
    return source;
  }
  if (!MAIN_STARTUP_PATTERN.test(source)) {
    console.warn("WARN: Browser UI bootstrap skipped: current main startup contract was not found");
    return source;
  }
  return `${source}${source.endsWith("\n") ? "" : "\n"}${BROWSER_UI_BOOTSTRAP}`;
}

function browserUiPreloadRelaySource(electronAlias, bridgeAlias, sharedObjectAlias) {
  const sharedObjectGetter = sharedObjectAlias
    ? `__browserUiGetSharedSnapshot(){return{...${sharedObjectAlias}}},`
    : `__browserUiGetSharedSnapshot(){return{}},`;
  return [
    `/*${BROWSER_UI_PRELOAD_RELAY_MARKER}*/(()=>{`,
    `if(process.platform!==\`linux\`||process.env.CODEX_LINUX_WEB_UI!==\`1\`)return;`,
    `const __codexLinuxBrowserUiPorts=new Map;`,
    `const __codexLinuxBrowserUiClose=(id,notify)=>{let port=__codexLinuxBrowserUiPorts.get(id);if(port){__codexLinuxBrowserUiPorts.delete(id);try{port.close()}catch{}}if(notify)${electronAlias}.ipcRenderer.send(\`codex_linux_browser_ui:port-close\`,{id});return!!port};`,
    `Object.assign(${bridgeAlias},{`,
    `__browserUiConnectPort(id){__codexLinuxBrowserUiClose(id,!1);let channel=new MessageChannel,port=channel.port1;__codexLinuxBrowserUiPorts.set(id,port),port.onmessage=event=>${electronAlias}.ipcRenderer.send(\`codex_linux_browser_ui:port-message\`,{id,data:event.data}),port.onmessageerror=()=>{__codexLinuxBrowserUiPorts.get(id)===port&&__codexLinuxBrowserUiClose(id,!0)},port.start?.();try{${electronAlias}.ipcRenderer.postMessage(\`codex_desktop:connect-app-host\`,void 0,[channel.port2])}catch(error){__codexLinuxBrowserUiClose(id,!1);try{channel.port2.close()}catch{}throw error}return!0},`,
    `__browserUiPostPortMessage(id,data){let port=__codexLinuxBrowserUiPorts.get(id);return port?(port.postMessage(data),!0):!1},`,
    `__browserUiClosePort(id){return __codexLinuxBrowserUiClose(id,!0)},`,
    sharedObjectGetter,
    `});`,
    `${electronAlias}.ipcRenderer.on?.(\`codex_linux_browser_ui:port-message\`,(_event,payload)=>{payload&&${bridgeAlias}.__browserUiPostPortMessage(payload.id,payload.data)});`,
    `${electronAlias}.ipcRenderer.on?.(\`codex_linux_browser_ui:port-close\`,(_event,payload)=>{payload&&__codexLinuxBrowserUiClose(payload.id,!1)});`,
    `})(),`,
  ].join("");
}

function applyBrowserUiPreloadRelay(source) {
  if (source.includes(BROWSER_UI_PRELOAD_RELAY_MARKER)) {
    return source;
  }

  const exposeMatch = ELECTRON_BRIDGE_EXPOSE_PATTERN.exec(source);
  if (exposeMatch == null) {
    return source;
  }

  const sharedObjectMatch = SHARED_OBJECT_GETTER_PATTERN.exec(source);
  if (sharedObjectMatch == null) return source;
  if (!source.includes("codex_desktop:connect-app-host")) return source;
  if (REQUIRED_BRIDGE_METHODS.some((method) => !source.includes(method))) return source;
  const relay = browserUiPreloadRelaySource(
    exposeMatch[1],
    exposeMatch[3],
    sharedObjectMatch[2],
  );
  return `${source.slice(0, exposeMatch.index)}${relay}${source.slice(exposeMatch.index)}`;
}

function patchBrowserUiPreloadRelay(extractedDir) {
  const preloadPath = path.join(extractedDir, ".vite", "build", "preload.js");
  if (!fs.existsSync(preloadPath)) {
    const reason = `preload bundle not found at ${preloadPath}`;
    console.warn(`WARN: Browser UI preload relay skipped: ${reason}`);
    return { matched: false, changed: 0, reason };
  }

  const source = fs.readFileSync(preloadPath, "utf8");
  const patchedSource = applyBrowserUiPreloadRelay(source);
  if (patchedSource === source) {
    if (source.includes(BROWSER_UI_PRELOAD_RELAY_MARKER)) {
      return { matched: true, changed: 0 };
    }
    const reason = ELECTRON_BRIDGE_EXPOSE_PATTERN.test(source)
      ? SHARED_OBJECT_GETTER_PATTERN.test(source)
        ? source.includes("codex_desktop:connect-app-host")
          ? "required electronBridge method inventory drifted"
          : "connect-app-host preload contract was not found"
        : "shared-object snapshot preload contract was not found"
      : "electronBridge preload exposure was not found";
    console.warn(`WARN: Browser UI preload relay skipped: ${reason}`);
    return { matched: false, changed: 0, reason };
  }

  fs.writeFileSync(preloadPath, patchedSource, "utf8");
  return { matched: true, changed: 1 };
}

module.exports = {
  BROWSER_UI_BOOTSTRAP_MARKER,
  BROWSER_UI_PRELOAD_RELAY_MARKER,
  REQUIRED_BRIDGE_METHODS,
  applyBrowserUiBootstrap,
  applyBrowserUiPreloadRelay,
  patchBrowserUiPreloadRelay,
  descriptors: [
    {
      id: "browser-ui-main-bootstrap",
      phase: "main-bundle",
      order: 29_000,
      ciPolicy: "optional",
      apply: applyBrowserUiBootstrap,
    },
    {
      id: "browser-ui-preload-port-relay",
      phase: "extracted-app:post-webview",
      order: 29_010,
      ciPolicy: "optional",
      apply: patchBrowserUiPreloadRelay,
      status: (result, warnings) => ({
        status: result?.changed
          ? "applied"
          : result?.matched
            ? "already-applied"
            : "skipped-optional",
        reason: result?.reason ?? warnings[0] ?? null,
      }),
    },
  ],
};
