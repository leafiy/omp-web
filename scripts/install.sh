#!/usr/bin/env bash
# One-step installer / updater for omp-web (Linux and macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/leafiy/omp-web/main/scripts/install.sh | bash
#   bash ~/code/omp-web/scripts/install.sh update
#   bash ~/code/omp-web/scripts/install.sh restart
#
# Requires git, Node.js 22.19+ and npm. It never installs runtimes or system
# packages. Checkout location is fixed: ~/code/omp-web.
#
# Commands:
#   (none)           install or update, and provision the background service
#   update           update on the current branch instead of main
#                    Existing login and service settings are kept by default.
#   restart          restart the installed service on its current build: no pull,
#                    no dependency install, no build. Takes no options.
#
# Options:
#   --service        explicitly install or reconfigure the background service
#                    (Linux: systemd, starts on boot; macOS: launchd, starts at login)
#   --no-service     do not provision a new service or start an inactive one
#   --host HOST      listen address for a new/reconfigured service (default 127.0.0.1)
#   --port PORT      listen port for the service (default 30141)
#   --ref REF        Git branch to install (default main; update keeps the current branch)
#   --force-build    rebuild even when the successful build is current
#   --force-install  reinstall dependencies and rebuild (repair missing/broken packages)
#
# The first install creates a login and prints its initial password. To supply
# your own, set OMP_WEB_USERNAME and OMP_WEB_PASSWORD before that install.
set -euo pipefail

# systemd | launchd | none. Set by detect_platform.
PLATFORM="none"
LAUNCHD_LABEL="io.github.leafiy.omp-web"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
LAUNCHD_DOMAIN="gui/$(id -u)"
HOLD_DROPIN="/run/systemd/system/omp-web.service.d/50-omp-web-install-hold.conf"
HOLD_ACTIVE="no"

main() {
  local repo="${OMP_WEB_REPO:-https://github.com/leafiy/omp-web.git}"
  local mode="install" ref="" host="127.0.0.1" port="30141" service="auto"
  local dir="$HOME/code/omp-web"
  local force_build="no" force_install="no" total_started=$SECONDS options_given="no"

  while [ $# -gt 0 ]; do
    case "$1" in
      update|--update) mode="update" ;;
      restart|--restart) mode="restart" ;;
      --service) service="yes"; options_given="yes" ;;
      --no-service) service="no"; options_given="yes" ;;
      --host) host="${2:?--host needs a value}"; options_given="yes"; shift ;;
      --port) port="${2:?--port needs a value}"; options_given="yes"; shift ;;
      --ref) ref="${2:?--ref needs a value}"; options_given="yes"; shift ;;
      --force-build) force_build="yes"; options_given="yes" ;;
      --force-install) force_install="yes"; force_build="yes"; options_given="yes" ;;
      -h|--help) sed -n '2,30p' "$0" 2>/dev/null || true; return 0 ;;
      *) fail "Unknown option: $1" ;;
    esac
    shift
  done

  detect_platform

  if [ "$mode" = "restart" ]; then
    # A restart must not silently drop a requested setting change.
    [ "$options_given" = "no" ] || fail "restart takes no options; it keeps the installed service's settings. Use 'update' or a plain install to change them."
    restart_installed_service "$dir"
    return 0
  fi

  local provision_service="no"
  if [ "$service" = "yes" ]; then
    [ "$PLATFORM" != "none" ] || fail "No supported service manager (systemd or launchd) is available."
    provision_service="yes"
  elif [ "$service" = "auto" ] && [ "$PLATFORM" != "none" ] && ! service_installed; then
    provision_service="yes"
  fi

  say "Checking prerequisites"
  command -v git >/dev/null 2>&1 || fail "git is required. Install it first."
  command -v node >/dev/null 2>&1 || fail "Node.js 22.19+ is required. Install it first (e.g. with nvm or your package manager)."
  command -v npm >/dev/null 2>&1 || fail "npm is required. Install it together with Node.js."
  node -e '
    const [a, b] = process.versions.node.split(".").map(Number);
    if (a < 22 || (a === 22 && b < 19)) { console.error("Node.js " + process.versions.node + " is too old; 22.19.0+ is required."); process.exit(1); }
  ' || exit 1

  if [ -d "$dir/.git" ]; then
    if [ -z "$ref" ]; then
      if [ "$mode" = "update" ]; then
        ref="$(git -C "$dir" symbolic-ref --quiet --short HEAD)" || fail "$dir is not on a branch. Pass --ref BRANCH."
      else
        ref="main"
      fi
    fi
    say "Updating $dir ($ref)"
    if [ -n "$(git -C "$dir" status --porcelain)" ]; then
      fail "$dir has uncommitted changes. Commit or stash them, then run the installer again."
    fi
    local before after
    before="$(git -C "$dir" rev-parse --short HEAD)"
    git -C "$dir" fetch --quiet origin "$ref"
    git -C "$dir" checkout --quiet "$ref"
    git -C "$dir" pull --ff-only --quiet origin "$ref"
    after="$(git -C "$dir" rev-parse --short HEAD)"
    if [ "$before" = "$after" ]; then echo "  Already at $after; checking reusable dependencies and build."; else echo "  $before -> $after"; fi
  elif [ -e "$dir" ]; then
    fail "$dir exists but is not a Git checkout. Move it away and run the installer again."
  elif [ "$mode" = "update" ]; then
    fail "omp-web is not installed at $dir. Run the installer without 'update' first."
  else
    [ -n "$ref" ] || ref="main"
    say "Cloning $repo into $dir"
    mkdir -p "$HOME/code"
    git clone --quiet --branch "$ref" "$repo" "$dir"
  fi
  cd "$dir"

  local keys dependency_key build_key install_needed="yes" build_needed="yes"
  keys="$(node scripts/install-state.mjs keys)" || fail "Could not calculate update fingerprints."
  read -r dependency_key build_key <<<"$keys"
  if [ "$force_install" = "no" ] && node scripts/install-state.mjs check dependencies "$dependency_key"; then
    install_needed="no"
  fi
  if [ "$install_needed" = "no" ] && [ "$force_build" = "no" ] && node scripts/install-state.mjs check build "$build_key"; then
    build_needed="no"
  fi

  # The build guard refuses to overwrite .next while the service runs.
  # A no-op update must not interrupt chats or terminals.
  local was_active="no"
  if { [ "$build_needed" = "yes" ] || [ "$provision_service" = "yes" ]; } && service_active; then
    if inside_service; then
      fail "This shell runs inside omp-web (its terminal or one of its agents). Stopping the service would kill this run halfway. Run it from a separate terminal, e.g. over SSH."
    fi
    was_active="yes"
  fi
  # Other units can start the service by themselves (a Wants= dependency, a
  # timer, a restart loop). Keep it stopped until the new build is complete.
  if [ "$build_needed" = "yes" ] && service_installed; then hold_service; fi
  if [ "$was_active" = "yes" ]; then
    say "Stopping $(service_name)"
    service_stop
  fi

  local stopped_note=""
  if [ "$was_active" = "yes" ] && [ "$HOLD_ACTIVE" = "no" ]; then stopped_note=" $(service_name) is stopped; fix the problem and run this again."; fi
  local phase_started
  if [ "$build_needed" = "yes" ]; then
    # Invalidate BEFORE touching dependencies/output, including on failed/aborted runs.
    rm -f .next/.omp-web-build.json
  fi
  if [ "$install_needed" = "yes" ]; then
    rm -f node_modules/.omp-web-install.json
    say "Installing dependencies"
    phase_started=$SECONDS
    npm ci --include=dev --no-audit --no-fund || fail "npm ci failed.$stopped_note"
    node scripts/install-state.mjs record dependencies "$dependency_key" || fail "Could not record dependency installation.$stopped_note"
    say "Dependencies installed in $((SECONDS - phase_started))s"
  else
    say "Dependencies unchanged; skipping npm ci (use --force-install to repair)"
  fi
  if [ "$build_needed" = "yes" ]; then
    # Turbopack does not read webpack's persistent cache; it only wastes ~1 GB.
    rm -rf .next/cache/webpack
    say "Building with Turbopack (preserving .next/cache)"
    phase_started=$SECONDS
    npm run build || fail "Build failed.$stopped_note"
    node scripts/install-state.mjs record build "$build_key" || fail "Could not record build.$stopped_note"
    say "Build completed in $((SECONDS - phase_started))s"
  else
    say "Successful build is current; skipping build (use --force-build to rebuild)"
    # Recover a hold left by an interrupted update only after validating the build.
    if [ "$PLATFORM" = "systemd" ] && [ -f "$HOLD_DROPIN" ]; then HOLD_ACTIVE="yes"; fi
  fi

  # Existing service definitions can manage their own authentication.
  if [ "$provision_service" = "yes" ] || ! service_installed; then
    setup_login
  fi
  release_hold

  local started="no" url
  url="$(service_url "$host" "$port")"
  if [ "$provision_service" = "yes" ]; then
    install_service "$dir" "$host" "$port"
    wait_for_web "$url" || fail "$(service_name) did not become ready at $url. Logs: $(service_logs_hint "$dir")"
    started="yes"
  elif [ "$was_active" = "yes" ] || { [ "$service" != "no" ] && service_installed && ! service_active; }; then
    say "Starting $(service_name)"
    service_start
    started="yes"
  fi

  echo
  say "Done in $((SECONDS - total_started))s."
  if [ "$started" = "yes" ]; then
    if [ "$provision_service" = "yes" ]; then
      echo "  Open: $url"
    else
      echo "  $(service_name) is running again with its existing settings."
    fi
    echo "  Logs: $(service_logs_hint "$dir")"
  elif service_active; then
    echo "  $(service_name) was not restarted."
  else
    echo "  No background service is running."
    echo "  Start:  cd ~/code/omp-web && node bin/omp-web.js --hostname $host --port $port"
    echo "  Open:   $url"
  fi
  echo "  Update later:  bash ~/code/omp-web/scripts/install.sh update"
  if service_installed; then echo "  Restart only:  bash ~/code/omp-web/scripts/install.sh restart"; fi
  echo "  Change the web login in Settings, or run: node ~/code/omp-web/bin/omp-web.js passwd"
}

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

run_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else fail "Root privileges are needed for: $*"
  fi
}

detect_platform() {
  case "$(uname -s)" in
    Darwin) PLATFORM="launchd" ;;
    Linux) if [ -d /run/systemd/system ]; then PLATFORM="systemd"; fi ;;
  esac
}

service_name() {
  if [ "$PLATFORM" = "launchd" ]; then printf 'launchd agent %s' "$LAUNCHD_LABEL"; else printf 'omp-web.service'; fi
}

service_logs_hint() {
  if [ "$PLATFORM" = "launchd" ]; then printf 'tail -f %s/.local/logs/omp-web.log' "$1"; else printf 'journalctl -u omp-web -f'; fi
}

service_url() {
  local host="$1"
  case "$host" in
    0.0.0.0) host="127.0.0.1" ;;
    ::|'[::]') host="[::1]" ;;
    \[*\]) ;;
    *:*) host="[$host]" ;;
  esac
  printf 'http://%s:%s' "$host" "$2"
}

wait_for_web() {
  say "Waiting for $(service_name) to serve the login page"
  node - "$1" <<'JS'
const { setTimeout: delay } = require("node:timers/promises");
const url = new URL("/api/web-auth/status", process.argv[2]);
async function wait() {
  const expiresAt = Date.now() + 30_000;
  while (Date.now() < expiresAt) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000), redirect: "error" });
      if (response.ok && (await response.json()).configured === true) return;
    } catch {} // The listener may not be up yet.
    await delay(250);
  }
  process.exitCode = 1;
}
void wait();
JS
}

launchd_loaded() {
  launchctl print "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL" >/dev/null 2>&1
}

# Prints the service's main PID, or nothing when it has no process.
service_pid() {
  local pid=""
  case "$PLATFORM" in
    systemd) pid="$(systemctl show omp-web.service --property=MainPID --value 2>/dev/null || true)" ;;
    launchd) pid="$(launchctl print "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL" 2>/dev/null | awk '$1 == "pid" && $2 == "=" { print $3; exit }' || true)" ;;
  esac
  if [ "$pid" = "0" ]; then pid=""; fi
  printf '%s' "$pid"
}

service_installed() {
  case "$PLATFORM" in
    systemd) systemctl cat omp-web.service >/dev/null 2>&1 ;;
    launchd) [ -f "$LAUNCHD_PLIST" ] ;;
    *) return 1 ;;
  esac
}

# A loaded launchd agent counts as active even between restarts: launchd may
# respawn it in the middle of a build.
service_active() {
  case "$PLATFORM" in
    systemd) [ -n "$(service_pid)" ] ;;
    launchd) launchd_loaded ;;
    *) return 1 ;;
  esac
}

# True when this script is a descendant of the service it is about to stop.
inside_service() {
  if [ "$PLATFORM" = "systemd" ] && grep -q '/omp-web\.service' /proc/self/cgroup 2>/dev/null; then return 0; fi
  local target pid="$$" hops=0
  target="$(service_pid)"
  [ -n "$target" ] || return 1
  while [ -n "$pid" ] && [ "$pid" != "0" ] && [ "$pid" != "1" ] && [ "$hops" -lt 64 ]; do
    if [ "$pid" = "$target" ]; then return 0; fi
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    hops=$((hops + 1))
  done
  return 1
}

# Makes systemd skip every start of omp-web.service while this file exists,
# including starts pulled in by other units (which would otherwise cancel our
# stop job, or start the server on a half-written build). It lives in /run, so
# a reboot clears a hold left behind by an interrupted run.
hold_service() {
  [ "$PLATFORM" = "systemd" ] || return 0
  local tmp
  tmp="$(mktemp)"
  cat >"$tmp" <<HOLD
# Written by omp-web scripts/install.sh while it rebuilds; removed when it
# finishes. While this file exists, systemd skips every start of the service.
[Unit]
ConditionPathExists=!$HOLD_DROPIN
HOLD
  run_root install -d -m 0755 "$(dirname "$HOLD_DROPIN")"
  run_root install -m 0644 "$tmp" "$HOLD_DROPIN"
  rm -f "$tmp"
  HOLD_ACTIVE="yes"
  run_root systemctl daemon-reload
}

release_hold() {
  [ "$HOLD_ACTIVE" = "yes" ] || return 0
  run_root rm -f "$HOLD_DROPIN"
  HOLD_ACTIVE="no"
  run_root systemctl daemon-reload
}

on_exit() {
  local status=$?
  if [ "$status" -ne 0 ] && [ "$HOLD_ACTIVE" = "yes" ]; then
    printf '\033[1;33mnote:\033[0m omp-web.service is held stopped so nothing starts it on an incomplete build.\n' >&2
    printf '      Fix the problem and run this again, or release the hold:\n' >&2
    printf '      sudo rm -f %s && sudo systemctl daemon-reload\n' "$HOLD_DROPIN" >&2
  fi
}
trap on_exit EXIT

service_stop() {
  case "$PLATFORM" in
    systemd)
      # A start request from another unit can cancel the stop job ("Job for
      # omp-web.service canceled"); under the hold that start is skipped, so
      # wait for the unit itself to settle instead of trusting the job result.
      run_root systemctl stop omp-web.service || true
      local waited=0 state
      while :; do
        state="$(systemctl show omp-web.service --property=ActiveState --value 2>/dev/null || true)"
        case "$state" in inactive|failed) break ;; esac
        waited=$((waited + 1))
        [ "$waited" -le 300 ] || fail "omp-web.service did not stop within 300 seconds (state: ${state:-unknown})."
        sleep 1
      done
      ;;
    launchd)
      launchctl bootout "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL" 2>/dev/null || true
      # bootout can return while the process is still shutting down.
      local waited=0
      while launchd_loaded; do
        waited=$((waited + 1))
        [ "$waited" -le 30 ] || fail "$(service_name) did not stop within 30 seconds."
        sleep 1
      done
      ;;
  esac
}

service_start() {
  case "$PLATFORM" in
    systemd) run_root systemctl start omp-web.service ;;
    launchd)
      launchctl enable "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL" 2>/dev/null || true
      launchctl bootstrap "$LAUNCHD_DOMAIN" "$LAUNCHD_PLIST" \
        || fail "launchctl could not load $LAUNCHD_PLIST. The agent needs this user's desktop session; log in on the Mac and run this again."
      ;;
  esac
}

service_restart() {
  case "$PLATFORM" in
    systemd) run_root systemctl restart omp-web.service ;; # also starts an inactive unit
    launchd)
      if launchd_loaded; then service_stop; fi
      service_start
      ;;
  esac
}

# Restarts the installed service on the build it already has. Nothing is pulled,
# installed or built, so it neither needs nor touches git/npm state.
restart_installed_service() {
  local dir="$1"
  [ "$PLATFORM" != "none" ] || fail "No supported service manager (systemd or launchd) is available; stop and start omp-web manually."
  service_installed || fail "No background service is installed. Install one with: bash ~/code/omp-web/scripts/install.sh"
  # The receipt is removed before every build and recorded only after it succeeds.
  [ -f "$dir/.next/.omp-web-build.json" ] || fail "No completed build in $dir. Run: bash ~/code/omp-web/scripts/install.sh update"
  if [ "$PLATFORM" = "systemd" ] && [ -f "$HOLD_DROPIN" ]; then
    fail "An interrupted update holds omp-web.service stopped. Finish it with: bash ~/code/omp-web/scripts/install.sh update"
  fi
  if service_active && inside_service; then
    fail "This shell runs inside omp-web (its terminal or one of its agents). Restarting would kill this run halfway. Run it from a separate terminal, e.g. over SSH."
  fi
  say "Restarting $(service_name) (no update; active chats and terminals will be interrupted)"
  service_restart
  say "$(service_name) restarted on the existing build."
  echo "  Logs: $(service_logs_hint "$dir")"
}

setup_login() {
  node <<'JS'
const { randomBytes } = require("node:crypto");
const { loadWebCredentials, setWebCredentials } = require("./bin/web-credentials.js");
async function setup() {
  const existing = loadWebCredentials();
  if (existing?.source === "file") return;
  const username = existing?.username || process.env.OMP_WEB_USERNAME?.trim() || "admin";
  const supplied = existing?.legacyPassword || process.env.OMP_WEB_PASSWORD;
  const password = supplied || randomBytes(24).toString("base64url");
  await setWebCredentials(username, password);
  console.log(`  Web account: ${username}`);
  if (!supplied) console.log(`  Initial password (save it now): ${password}`);
}
setup().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
JS
}

install_service() {
  case "$PLATFORM" in
    systemd) install_systemd_service "$@" ;;
    launchd) install_launchd_service "$@" ;;
    *) fail "No supported service manager (systemd or launchd) is available; start omp-web manually instead." ;;
  esac
}

install_systemd_service() {
  local dir="$1" host="$2" port="$3"
  local user node_bin unit
  user="$(id -un)"
  node_bin="$(command -v node)"
  unit="$(mktemp)"
  cat >"$unit" <<UNIT
[Unit]
Description=omp-web (browser UI for local coding agents)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$user
WorkingDirectory=$dir
Environment="HOME=$HOME"
Environment="PATH=$PATH"
Environment=NODE_ENV=production
ExecStart=$node_bin $dir/bin/omp-web.js --hostname $host --port $port --no-open
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
  say "Installing /etc/systemd/system/omp-web.service"
  run_root install -m 0644 "$unit" /etc/systemd/system/omp-web.service
  rm -f "$unit"
  run_root systemctl daemon-reload
  run_root systemctl enable --now omp-web.service
}

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# A per-user LaunchAgent, not a system daemon: the agent CLIs read this user's
# keychain and files, and no root is needed. It runs while the user is logged in.
install_launchd_service() {
  local dir="$1" host="$2" port="$3"
  local node_bin log
  node_bin="$(command -v node)"
  log="$dir/.local/logs/omp-web.log"
  mkdir -p "$dir/.local/logs" "$HOME/Library/LaunchAgents"
  say "Installing $LAUNCHD_PLIST"
  cat >"$LAUNCHD_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LAUNCHD_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$node_bin")</string>
    <string>$(xml_escape "$dir/bin/omp-web.js")</string>
    <string>--hostname</string>
    <string>$(xml_escape "$host")</string>
    <string>--port</string>
    <string>$(xml_escape "$port")</string>
    <string>--no-open</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$dir")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$PATH")</string>
    <key>LANG</key>
    <string>$(xml_escape "${LANG:-en_US.UTF-8}")</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$log")</string>
</dict>
</plist>
PLIST
  chmod 0644 "$LAUNCHD_PLIST"
  service_start
}

main "$@"
exit 0
