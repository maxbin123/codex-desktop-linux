# Browser UI

`browser-ui` is a disabled-by-default experiment that exposes the original
ChatGPT Desktop renderer as a normal browser DOM application. Electron remains
running as a hidden host for the upstream preload bridge and main-process IPC;
this feature does not use VNC, xpra, screenshots, or other pixel streaming.

## Enable

Copy `linux-features/features.example.json` to the git-ignored
`linux-features/features.json`, enable the feature, and rebuild the app:

```json
{
  "enabled": [
    "browser-ui"
  ]
}
```

The staged server and Electron runtime remain dormant during ordinary desktop
launches. The patched preload still contains inert relay helpers. From the
project you want Codex to use, start the generated browser-mode launcher:

```bash
cd /absolute/path/to/project
/path/to/codex-app/.codex-linux/features/browser-ui/launch.sh
```

Open <http://localhost:5999/>. Use `localhost` rather than `127.0.0.1` so
upstream OpenAI sandbox iframes accept the parent origin. The launcher stays in
the foreground, enables browser mode, starts an isolated app instance, and
uses the caller's current directory as the workspace. The normal `CODEX_HOME`
location is unchanged, so existing Codex authentication and settings are used.

On a graphical Linux session, the launcher reuses the current display. On a
headless Linux system, it automatically starts a private Xvfb display; install
`Xvfb` through the system package manager first. Xvfb is only an invisible
display backend required by the hidden Electron host. No frames are streamed:
the browser receives the original DOM, assets, fonts, and input events over
HTTP and WebSocket.

Useful overrides:

```bash
CODEX_BROWSER_UI_WORKSPACE=/absolute/path/to/project \
  CODEX_BROWSER_UI_PORT=6099 \
  CODEX_BROWSER_UI_HEADLESS=1 \
  /path/to/codex-app/.codex-linux/features/browser-ui/launch.sh
```

- `CODEX_BROWSER_UI_HEADLESS=auto|0|1` controls display detection.
- `CODEX_BROWSER_UI_XVFB_SCREEN=1280x800x24` changes the private display size.
- `CODEX_BROWSER_UI_HOST=0.0.0.0` permits local port forwarding across a
  separate network namespace; the default is `127.0.0.1`.
- `CODEX_BROWSER_UI_FILE_ROOTS` adds path-delimited roots for browser file
  previews and downloads.

For a headless machine reached over SSH, keep the server on loopback and
forward it locally:

```bash
ssh -N -L 5999:127.0.0.1:5999 user@linux-host
```

Then open <http://localhost:5999/> locally. For custom process supervision, the
equivalent direct launch is:

```bash
CODEX_BROWSER_UI_WORKSPACE=/absolute/path/to/project \
  CODEX_LINUX_WEB_UI=1 \
  ./codex-app/start.sh --new-instance
```

The caller must provide a working graphical display for this direct form.

## Architecture

The feature owns five integration pieces:

- `patch.js` appends a small, idempotent main-process bootstrap.
- A second descriptor in `patch.js` adds private MessagePort relay methods to
  the existing preload bridge.
- `runtime.cjs` exports `installBrowserUi({ electron })` and owns the HTTP and
  WebSocket runtime around the hidden Electron window.
- `browser-ui-bridge.js` supplies the browser-side adapter for the upstream
  `window.electronBridge` contract, browser-native dialog/menu/file adapters,
  and an iframe adapter for upstream `<webview>` call sites.
- `launch.sh` selects the current graphical session or a private Xvfb display,
  then runs the generated app with browser mode explicitly enabled.

The two runtime files and launcher are staged under
`.codex-linux/features/browser-ui/`. The bootstrap loads them only on Linux and
only when `CODEX_LINUX_WEB_UI=1`; enabling the build feature alone does not
change normal desktop behavior.

## Test

Run the focused tests with:

```bash
node --test linux-features/browser-ui/test.js
```

The focused suite executes the patch/preload contracts, the actual browser
bridge in a headless DOM harness, HTTP and authenticated WebSocket serving,
bidirectional AppHost traffic, window selection, renderer restart recovery,
and the disabled-runtime path. A real upstream DMG build and browser smoke test
remain the release gate because upstream private contracts can drift without a
source-level signal.

## Support risks

This mode depends on upstream private renderer and preload contracts. A new DMG
can change message shapes or add bridge methods, so enabled-feature acceptance
must treat drift as a release blocker. Native dialogs, secondary Electron
windows, host file paths, desktop menus, notifications, and device APIs need
explicit browser equivalents; serving the static webview bundle alone does not
provide them.

The main shell and sandboxed MCP surfaces are native browser DOM. Browser Use
and internal Chromium pages are unsupported in this mode. Some checkout/OAuth
flows can also fail on sites that prohibit framing. Browser
transient-activation rules can affect clipboard, notifications, popups, and
file pickers. The AppHost and Electron RPC relays currently accept JSON-shaped
messages; transferable, cyclic, or binary-only payloads are not supported.
Only one browser tab owns the Electron bridge at a time; opening a newer tab
intentionally disconnects the previous one.

The runtime is intended for local use. It accepts only `localhost` and loopback
Host headers, requires an exact browser Origin plus a random per-process token
for WebSockets, and token-protects uploads and file reads. Dynamic file reads
are limited to the workspace and this process's upload directory, with symlink
escapes rejected. Additional trusted roots can be added with the
path-delimited `CODEX_BROWSER_UI_FILE_ROOTS` variable. This session token is
not user authentication and the static shell remains unauthenticated; keep the
port on loopback and do not expose it directly to an untrusted network.
