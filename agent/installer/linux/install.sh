#!/usr/bin/env bash
# Linux installer — installs the CSPC-ICTU monitoring agent as a systemd service.
# Run the matching binary (cspc-agent-linux-amd64 / -arm64) from the same folder.
#
# Usage: sudo bash install.sh <API_URL> <INSTALL_KEY> [--re-enroll]
#   e.g. sudo bash install.sh http://192.168.100.9:3000 AIK-...
#
# Get the key from the dashboard: Server Metrics -> Agent install keys -> + New key.
#
# --re-enroll discards the existing agent.conf and registers again. Needed when moving a
# machine onto a different install key (e.g. off the legacy .env key, or to another
# branch's key) — a plain re-run does NOT re-register, because agent.conf already exists.
set -euo pipefail

API_URL="${1:-}"
INSTALL_KEY="${2:-}"
RE_ENROLL="${3:-}"
if [[ -z "$API_URL" || -z "$INSTALL_KEY" ]]; then
  echo "Usage: sudo bash install.sh <API_URL> <INSTALL_KEY> [--re-enroll]"
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="/opt/cspc-agent"
SERVICE="/etc/systemd/system/cspc-agent.service"
CONF="$INSTALL_DIR/agent.conf"

# Pick the binary for this CPU.
BINARY_SRC="$HERE/cspc-agent-linux-amd64"
if [[ "$(uname -m)" == "aarch64" || "$(uname -m)" == "arm64" ]]; then
  BINARY_SRC="$HERE/cspc-agent-linux-arm64"
fi
if [[ ! -f "$BINARY_SRC" ]]; then
  echo "Binary not found: $BINARY_SRC (build it with 'make all')"
  exit 1
fi

mkdir -p "$INSTALL_DIR"
install -m 0755 "$BINARY_SRC" "$INSTALL_DIR/cspc-agent"

# Installs made before the 2026-08-18 rename put the binary at $INSTALL_DIR/go-agent and
# pointed the unit at it. The unit is rewritten below, so dropping the old file here just
# stops a dead binary sitting in the install directory. agent.conf is untouched, so the
# machine keeps its enrolment, its device id and its history.
rm -f "$INSTALL_DIR/go-agent"

# --re-enroll: drop the existing enrollment so the key below is actually presented.
if [[ "$RE_ENROLL" == "--re-enroll" && -f "$CONF" ]]; then
  echo "--re-enroll: removing $CONF to register again."
  rm -f "$CONF"
fi

# First run: register and block until an admin approves (writes agent.conf).
if [[ ! -f "$CONF" ]]; then
  echo "Registering with backend; waiting for admin approval (Ctrl-C to abort)..."
  "$INSTALL_DIR/cspc-agent" --register-only -api-url "$API_URL" -install-key "$INSTALL_KEY" -conf "$CONF"
else
  # Say so LOUDLY. The install key is a required argument, so silently ignoring it reads
  # as "the key was applied" — which is how a machine ends up still attributed to an old
  # key (or to none at all) while the operator believes they moved it onto the new one.
  echo "WARNING: $CONF already exists - this machine is ALREADY ENROLLED." >&2
  echo "WARNING: the install key you passed was NOT used and this server is NOT attributed to it." >&2
  # A machine that is still approved keeps its approval and its AGT- token through a
  # re-enroll — it is only re-filed under the new key. One whose key was revoked comes
  # back as pending and does need approving again.
  echo "WARNING: to move it onto that key, re-run with --re-enroll." >&2
fi

cat > "$SERVICE" <<EOF
[Unit]
Description=CSPC-ICTU Server Monitoring Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$INSTALL_DIR/cspc-agent -conf $CONF
# on-failure (not always): a clean exit means "deauthorized by the server" — stay stopped.
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable cspc-agent.service
# restart, not `enable --now`: an already-running service would otherwise keep executing
# the OLD binary path until someone rebooted the machine.
systemctl restart cspc-agent.service
echo "Installed. Check status with: systemctl status cspc-agent"
