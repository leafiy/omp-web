#!/usr/bin/env bash
# One-step installer / updater for omp-web.
#
#   curl -fsSL https://raw.githubusercontent.com/leafiy/omp-web/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/leafiy/omp-web/main/scripts/install.sh | bash -s -- --service --host 127.0.0.1 --port 30141
#
# Requires git, Node.js 22.19+ and npm. It never installs runtimes or system
# packages. Checkout location is fixed: ~/code/omp-web.
#
# Options:
#   --service        install and start a systemd service (omp-web.service)
#   --no-service     never ask about a systemd service
#   --host HOST      listen address for the service (default 127.0.0.1)
#   --port PORT      listen port for the service (default 30141)
#   --ref REF        Git branch to install (default main)
#
# Unattended login setup: set OMP_WEB_USERNAME and OMP_WEB_PASSWORD.
set -euo pipefail

main() {
  local repo="${OMP_WEB_REPO:-https://github.com/leafiy/omp-web.git}"
  local ref="main" host="127.0.0.1" port="30141" service="ask"
  local dir="$HOME/code/omp-web"

  while [ $# -gt 0 ]; do
    case "$1" in
      --service) service="yes" ;;
      --no-service) service="no" ;;
      --host) host="${2:?--host needs a value}"; shift ;;
      --port) port="${2:?--port needs a value}"; shift ;;
      --ref) ref="${2:?--ref needs a value}"; shift ;;
      -h|--help) sed -n '2,17p' "$0" 2>/dev/null || true; return 0 ;;
      *) fail "Unknown option: $1" ;;
    esac
    shift
  done

  local tty=""
  if [ -r /dev/tty ] && [ -w /dev/tty ] && { : </dev/tty; } 2>/dev/null; then tty="/dev/tty"; fi

  say "Checking prerequisites"
  command -v git >/dev/null 2>&1 || fail "git is required. Install it first."
  command -v node >/dev/null 2>&1 || fail "Node.js 22.19+ is required. Install it first (e.g. with nvm or your package manager)."
  command -v npm >/dev/null 2>&1 || fail "npm is required. Install it together with Node.js."
  node -e '
    const [a, b] = process.versions.node.split(".").map(Number);
    if (a < 22 || (a === 22 && b < 19)) { console.error("Node.js " + process.versions.node + " is too old; 22.19.0+ is required."); process.exit(1); }
  ' || exit 1

  if [ -d "$dir/.git" ]; then
    say "Updating $dir"
    if [ -n "$(git -C "$dir" status --porcelain)" ]; then
      fail "$dir has uncommitted changes. Commit or stash them, then run the installer again."
    fi
    git -C "$dir" fetch --quiet origin "$ref"
    git -C "$dir" checkout --quiet "$ref"
    git -C "$dir" pull --ff-only --quiet origin "$ref"
  elif [ -e "$dir" ]; then
    fail "$dir exists but is not a Git checkout. Move it away and run the installer again."
  else
    say "Cloning $repo into $dir"
    mkdir -p "$HOME/code"
    git clone --quiet --branch "$ref" "$repo" "$dir"
  fi
  cd "$dir"

  # The build guard refuses to overwrite .next while the service runs.
  local was_running="no"
  if service_running; then
    if confirm "omp-web.service is running. Stop it now to rebuild? Active chats and terminals will be interrupted." "$tty"; then
      run_root systemctl stop omp-web.service
      was_running="yes"
    else
      fail "Stopped. Rebuild later after stopping omp-web.service."
    fi
  fi

  say "Installing dependencies"
  npm ci --include=dev --no-audit --no-fund
  say "Building"
  npm run build

  setup_login "$tty"

  if [ "$service" = "ask" ] && [ -d /run/systemd/system ] && [ -n "$tty" ]; then
    if confirm "Install a systemd service that starts omp-web on boot?" "$tty"; then service="yes"; fi
  fi
  if [ "$service" = "yes" ]; then
    install_service "$dir" "$host" "$port"
  elif [ "$was_running" = "yes" ]; then
    run_root systemctl start omp-web.service
  fi

  echo
  say "Done."
  if [ "$service" = "yes" ] || [ "$was_running" = "yes" ]; then
    echo "  omp-web.service is running: http://$host:$port"
    echo "  Logs: journalctl -u omp-web -f"
  else
    echo "  Start:  cd ~/code/omp-web && node bin/omp-web.js --hostname $host --port $port"
    echo "  Open:   http://$host:$port"
  fi
  echo "  Change the web login later in Settings, or run: node ~/code/omp-web/bin/omp-web.js passwd"
}

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

confirm() {
  local question="$1" tty="$2" answer=""
  [ -n "$tty" ] || return 1
  printf '%s [y/N] ' "$question" >"$tty"
  read -r answer <"$tty" || true
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

run_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else fail "Root privileges are needed for: $*"
  fi
}

service_running() {
  [ -d /run/systemd/system ] || return 1
  local pid
  pid="$(systemctl show omp-web.service --property=MainPID --value 2>/dev/null || true)"
  [ -n "$pid" ] && [ "$pid" != "0" ]
}

has_login() {
  node -e 'try { process.exit(require("./bin/web-credentials.js").loadWebCredentials() ? 0 : 1); } catch (e) { console.error(e.message); process.exit(1); }' 2>/dev/null
}

setup_login() {
  local tty="$1"
  if [ -n "${OMP_WEB_PASSWORD:-}" ]; then
    say "Saving the web login from OMP_WEB_USERNAME / OMP_WEB_PASSWORD"
    printf '%s\n' "$OMP_WEB_PASSWORD" | node bin/omp-web.js passwd --username "${OMP_WEB_USERNAME:-admin}"
    return
  fi
  if has_login; then
    if confirm "A web login already exists. Replace it?" "$tty"; then
      node bin/omp-web.js passwd <"$tty"
    fi
    return
  fi
  [ -n "$tty" ] || fail "No terminal for the login prompt. Re-run with OMP_WEB_USERNAME and OMP_WEB_PASSWORD set."
  say "Set the web login (required; there is no anonymous access)"
  node bin/omp-web.js passwd <"$tty"
}

install_service() {
  local dir="$1" host="$2" port="$3"
  [ -d /run/systemd/system ] || fail "systemd is not available; start omp-web manually instead."
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

main "$@"
