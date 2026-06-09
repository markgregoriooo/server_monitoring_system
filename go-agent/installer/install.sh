#!/usr/bin/env bash
# Linux installer — installs the CSPC-ICTU monitoring agent as a systemd service.
# Run the matching binary (go-agent-linux-amd64 / -arm64) from the same folder.
#
# Usage: sudo bash install.sh <API_URL> <INSTALL_KEY>
#   e.g. sudo bash install.sh http://192.168.100.9:3000 my-shared-install-key
set -euo pipefail

API_URL="${1:-}"
INSTALL_KEY="${2:-}"
if [[ -z "$API_URL" || -z "$INSTALL_KEY" ]]; then
  echo "Usage: sudo bash install.sh <API_URL> <INSTALL_KEY>"
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="/opt/cspc-agent"
SERVICE="/etc/systemd/system/cspc-agent.service"
CONF="$INSTALL_DIR/agent.conf"

# Pick the binary for this CPU.
BINARY_SRC="$HERE/go-agent-linux-amd64"
if [[ "$(uname -m)" == "aarch64" || "$(uname -m)" == "arm64" ]]; then
  BINARY_SRC="$HERE/go-agent-linux-arm64"
fi
if [[ ! -f "$BINARY_SRC" ]]; then
  echo "Binary not found: $BINARY_SRC (build it with 'make all')"
  exit 1
fi

mkdir -p "$INSTALL_DIR"
install -m 0755 "$BINARY_SRC" "$INSTALL_DIR/go-agent"

# First run: register and block until an admin approves (writes agent.conf).
if [[ ! -f "$CONF" ]]; then
  echo "Registering with backend; waiting for admin approval (Ctrl-C to abort)..."
  "$INSTALL_DIR/go-agent" --register-only -api-url "$API_URL" -install-key "$INSTALL_KEY" -conf "$CONF"
fi

cat > "$SERVICE" <<EOF
[Unit]
Description=CSPC-ICTU Server Monitoring Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$INSTALL_DIR/go-agent -conf $CONF
# on-failure (not always): a clean exit means "deauthorized by the server" — stay stopped.
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now cspc-agent.service
echo "Installed. Check status with: systemctl status cspc-agent"
