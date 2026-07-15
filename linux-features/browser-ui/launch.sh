#!/usr/bin/env bash
set -Eeuo pipefail

readonly EX_USAGE=64
readonly EX_UNAVAILABLE=69
readonly EX_SOFTWARE=70

resolve_script_dir() {
    local source="${BASH_SOURCE[0]}"
    local dir

    while [[ -L "$source" ]]; do
        dir="$(cd -P "$(dirname "$source")" && pwd)"
        source="$(readlink "$source")"
        [[ "$source" = /* ]] || source="$dir/$source"
    done

    cd -P "$(dirname "$source")" && pwd
}

fail() {
    local status="$1"
    shift
    printf 'Browser UI launcher: %s\n' "$*" >&2
    exit "$status"
}

find_app_launcher() {
    local candidate

    if [[ -n "${CODEX_BROWSER_UI_APP_LAUNCHER:-}" ]]; then
        printf '%s\n' "$CODEX_BROWSER_UI_APP_LAUNCHER"
        return
    fi

    for candidate in \
        "$SCRIPT_DIR/../../../start.sh" \
        "$SCRIPT_DIR/../../codex-app/start.sh"; do
        if [[ -x "$candidate" ]]; then
            printf '%s\n' "$candidate"
            return
        fi
    done

    return 1
}

normalize_port() {
    local value="$1"

    [[ "$value" =~ ^[0-9]+$ ]] || return 1
    while [[ "$value" == 0* && "${#value}" -gt 1 ]]; do
        value="${value#0}"
    done
    [[ "${#value}" -le 5 ]] || return 1
    value=$((10#$value))
    (( value >= 1 && value <= 65535 )) || return 1
    printf '%s\n' "$value"
}

process_is_active() {
    local pid="$1"
    local group="$2"

    if [[ "$group" == 1 ]]; then
        kill -0 -- "-$pid" 2>/dev/null
    else
        kill -0 "$pid" 2>/dev/null
    fi
}

signal_process() {
    local signal="$1"
    local pid="$2"
    local group="$3"

    if [[ "$group" == 1 ]]; then
        kill -"$signal" -- "-$pid" 2>/dev/null || true
    else
        kill -"$signal" "$pid" 2>/dev/null || true
    fi
}

terminate_process() {
    local pid="$1"
    local group="${2:-0}"
    local attempt

    [[ -n "$pid" ]] || return 0
    process_is_active "$pid" "$group" || return 0
    signal_process TERM "$pid" "$group"
    for ((attempt = 0; attempt < 50; attempt += 1)); do
        process_is_active "$pid" "$group" || break
        sleep 0.1
    done
    if process_is_active "$pid" "$group"; then
        signal_process KILL "$pid" "$group"
    fi
    wait "$pid" 2>/dev/null || true
}

readonly SCRIPT_DIR="$(resolve_script_dir)"

[[ -n "${HOME:-}" && "$HOME" = /* && -d "$HOME" ]] || \
    fail "$EX_USAGE" 'HOME must name an existing absolute directory'

app_launcher="$(find_app_launcher || true)"
[[ -n "$app_launcher" && -x "$app_launcher" ]] || \
    fail "$EX_UNAVAILABLE" 'generated start.sh was not found; build the app with browser-ui enabled first'

workspace="${CODEX_BROWSER_UI_WORKSPACE:-$PWD}"
[[ -d "$workspace" ]] || fail "$EX_USAGE" "workspace directory does not exist: $workspace"
workspace="$(cd -P "$workspace" && pwd)"

port="$(normalize_port "${CODEX_BROWSER_UI_PORT:-5999}" || true)"
[[ -n "$port" ]] || fail "$EX_USAGE" 'CODEX_BROWSER_UI_PORT must be between 1 and 65535'

host="${CODEX_BROWSER_UI_HOST:-127.0.0.1}"
case "$host" in
    127.0.0.1|localhost|::1|0.0.0.0|::) ;;
    *) fail "$EX_USAGE" 'CODEX_BROWSER_UI_HOST must be a loopback or wildcard bind address' ;;
esac

headless="${CODEX_BROWSER_UI_HEADLESS:-auto}"
case "$headless" in
    auto)
        if [[ -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ]]; then
            headless=0
        else
            headless=1
        fi
        ;;
    0)
        [[ -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ]] || \
            fail "$EX_USAGE" 'headless mode is disabled, but no graphical display is available'
        ;;
    1) ;;
    *) fail "$EX_USAGE" 'CODEX_BROWSER_UI_HEADLESS must be auto, 0, or 1' ;;
esac

export CODEX_LINUX_WEB_UI=1
export CODEX_BROWSER_UI_HOST="$host"
export CODEX_BROWSER_UI_PORT="$port"
export CODEX_BROWSER_UI_WORKSPACE="$workspace"

if [[ "$host" == ::1 ]]; then
    browser_url="http://[::1]:$port/"
else
    browser_url="http://localhost:$port/"
fi

if [[ "$headless" == 0 ]]; then
    printf 'Starting hidden Electron host; browser UI: %s\n' "$browser_url" >&2
    exec "$app_launcher" --new-instance "$@"
fi

command -v Xvfb >/dev/null 2>&1 || \
    fail "$EX_UNAVAILABLE" 'headless mode requires Xvfb on PATH'

display_file="$(mktemp "${TMPDIR:-/tmp}/codex-browser-ui-display.XXXXXX")"
runtime_dir=""
xvfb_pid=""
app_pid=""
app_process_group=0

cleanup() {
    local status=$?
    trap - EXIT INT TERM HUP
    terminate_process "$app_pid" "$app_process_group"
    terminate_process "$xvfb_pid" 0
    [[ -z "$display_file" ]] || rm -f "$display_file"
    [[ -z "$runtime_dir" ]] || rm -rf "$runtime_dir"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

Xvfb \
    -displayfd 3 \
    -screen 0 "${CODEX_BROWSER_UI_XVFB_SCREEN:-1280x800x24}" \
    -nolisten tcp \
    -noreset \
    3>"$display_file" &
xvfb_pid=$!

display_number=""
for ((attempt = 0; attempt < 100; attempt += 1)); do
    if [[ -s "$display_file" ]]; then
        read -r display_number <"$display_file"
        break
    fi
    if ! kill -0 "$xvfb_pid" 2>/dev/null; then
        wait "$xvfb_pid" 2>/dev/null || true
        fail "$EX_SOFTWARE" 'Xvfb exited before allocating a display'
    fi
    sleep 0.05
done
[[ "$display_number" =~ ^[0-9]+$ ]] || \
    fail "$EX_SOFTWARE" 'timed out waiting for Xvfb to allocate a display'
rm -f "$display_file"
display_file=""

export DISPLAY=":$display_number"
export XDG_SESSION_TYPE=x11
export GDK_BACKEND=x11
unset WAYLAND_DISPLAY

if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
    runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/codex-browser-ui-runtime.XXXXXX")"
    chmod 0700 "$runtime_dir"
    export XDG_RUNTIME_DIR="$runtime_dir"
fi

app_command=("$app_launcher" --new-instance --x11 --password-store=basic "$@")
if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]] && command -v dbus-run-session >/dev/null 2>&1; then
    app_command=(dbus-run-session -- "${app_command[@]}")
fi

printf 'Starting hidden Electron host on DISPLAY=%s; browser UI: %s\n' "$DISPLAY" "$browser_url" >&2
if command -v setsid >/dev/null 2>&1; then
    setsid "${app_command[@]}" &
    app_process_group=1
else
    "${app_command[@]}" &
fi
app_pid=$!

set +e
wait -n "$app_pid" "$xvfb_pid"
status=$?
set -e
if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    printf 'Browser UI launcher: Xvfb exited while the Electron host was running\n' >&2
    status=$EX_SOFTWARE
fi
exit "$status"
