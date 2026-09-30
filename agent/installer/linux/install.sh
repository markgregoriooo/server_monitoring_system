#!/usr/bin/env bash
# Linux installer: installs the CSPC-ICTU monitoring agent as a systemd service.
# Run it with the matching binary (cspc-agent-linux-amd64 / -arm64) in the same folder.
#
# Usage: sudo bash install.sh <API_URL> <INSTALL_KEY> [--re-enroll]
#   e.g. sudo bash install.sh https://datacenter.cspc.edu.ph AIK-...
#
# Get the key from the dashboard: Server Metrics -> Agent install keys -> + New key.
#
# --re-enroll removes the existing agent.conf and registers again, e.g. to move the
# machine to a different install key. A plain re-run does not re-register while
# agent.conf exists.
set -euo pipefail

API_URL="${1:-}"
INSTALL_KEY="${2:-}"
RE_ENROLL=""
[[ "${3:-}" == "--re-enroll" ]] && RE_ENROLL="--re-enroll"

if [[ -z "$API_URL" || -z "$INSTALL_KEY" || "$INSTALL_KEY" == -* ]]; then
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

# Installs before the 2026-08-18 rename used $INSTALL_DIR/go-agent. The unit is
# rewritten below, so remove the old binary. agent.conf is kept, so the machine keeps
# its enrollment, device id and history.
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
  # Warn clearly: the key is ignored here, and the operator may think it was applied.
  echo "NOTE: $CONF already exists - this machine is ALREADY ENROLLED." >&2
  echo "NOTE: the install key you passed was NOT used. The enrolment is unchanged, so this" >&2
  echo "      server stays attributed to whatever key first enrolled it (possibly this one)." >&2
  # An approved machine keeps its approval and AGT- token through a re-enroll; it is only
  # moved to the new key. One whose key was revoked comes back as pending and needs
  # approving again.
  echo "      Only if you meant to MOVE it onto a different key, re-run with --re-enroll." >&2
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
