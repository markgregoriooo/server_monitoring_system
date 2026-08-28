#!/usr/bin/env bash
# Linux installer — installs the CSPC-ICTU monitoring agent as a systemd service.
# Run the matching binary (cspc-agent-linux-amd64 / -arm64) from the same folder.
#
# Usage: sudo bash install.sh <API_URL> [INSTALL_KEY] [--re-enroll]
#   e.g. CSPC_INSTALL_KEY=AIK-... sudo -E bash install.sh http://<backend-server-ip>:3000
#
# PREFER the environment variable. A key passed as an ARGUMENT is visible in `ps aux` to
# every user on the machine while enrollment runs, is written to the invoking shell's
# history file, and is captured by execve auditing. `sudo -E` is what preserves the
# variable across the privilege change; without it sudo strips the environment and the
# installer will tell you the key is missing rather than enrolling with a blank one.
# The positional form still works and is still accepted, so existing runbooks do not
# break — it just warns.
#
# Get the key from the dashboard: Server Metrics -> Agent install keys -> + New key.
#
# --re-enroll discards the existing agent.conf and registers again. Needed when moving a
# machine onto a different install key (e.g. off the legacy .env key, or to another
# branch's key) — a plain re-run does NOT re-register, because agent.conf already exists.
set -euo pipefail

API_URL="${1:-}"
# The environment wins over the argument, matching the agent binary's own precedence.
# ${2} may legitimately be "--re-enroll" now that the key is optional, so it is only
# treated as a key when it does not start with a dash.
INSTALL_KEY="${CSPC_INSTALL_KEY:-}"
KEY_FROM_ARG=""
if [[ -z "$INSTALL_KEY" && -n "${2:-}" && "${2}" != -* ]]; then
  INSTALL_KEY="${2}"
  KEY_FROM_ARG="yes"
fi
# --re-enroll may arrive as $2 (env-var form) or $3 (positional-key form).
RE_ENROLL=""
for a in "${@:2}"; do [[ "$a" == "--re-enroll" ]] && RE_ENROLL="--re-enroll"; done

if [[ -z "$API_URL" || -z "$INSTALL_KEY" ]]; then
  echo "Usage: CSPC_INSTALL_KEY=AIK-... sudo -E bash install.sh <API_URL> [--re-enroll]"
  echo "   or: sudo bash install.sh <API_URL> <INSTALL_KEY> [--re-enroll]   (key visible in ps/history)"
  exit 1
fi
if [[ -n "$KEY_FROM_ARG" ]]; then
  echo "NOTE: the install key was passed as a command-line argument, so it is visible in" >&2
  echo "NOTE: the process list and in this shell's history. For future installs use:" >&2
  echo "NOTE:   CSPC_INSTALL_KEY=AIK-... sudo -E bash install.sh $API_URL" >&2
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
  # Handed over in the ENVIRONMENT, not as an argument — this is the whole point of the
  # change: even when the operator used the positional form, the key stops being visible
  # in the process list from here on. The agent unsets it as soon as it has read it.
  CSPC_INSTALL_KEY="$INSTALL_KEY" "$INSTALL_DIR/cspc-agent" --register-only -api-url "$API_URL" -conf "$CONF"
else
  # Say so LOUDLY. The install key is a required argument, so silently ignoring it reads
  # as "the key was applied" — which is how a machine ends up still attributed to an old
  # key (or to none at all) while the operator believes they moved it onto the new one.
  echo "NOTE: $CONF already exists - this machine is ALREADY ENROLLED." >&2
  echo "NOTE: the install key you passed was NOT used. The enrolment is unchanged, so this" >&2
  echo "      server stays attributed to whatever key first enrolled it (possibly this one)." >&2
  # A machine that is still approved keeps its approval and its AGT- token through a
  # re-enroll — it is only re-filed under the new key. One whose key was revoked comes
  # back as pending and does need approving again.
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
