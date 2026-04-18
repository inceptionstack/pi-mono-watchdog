#!/usr/bin/env bash
# Headless setup script for pi agent with watchdog.
# Run as your target user (not root) on a fresh VM.
# Works on Ubuntu/Debian and Amazon Linux/RHEL (x86_64 + arm64).
set -euo pipefail

# --- Configuration (edit these) ---
API_KEY="your-api-key-here"          # e.g., Anthropic, Google, or OpenAI key
API_KEY_VAR="ANTHROPIC_API_KEY"      # env var name: ANTHROPIC_API_KEY, GOOGLE_API_KEY, OPENAI_API_KEY
TELEGRAM_BOT_TOKEN=""                # optional: your Telegram bot token
TELEGRAM_USER_ID=""                  # optional: your Telegram user ID (numeric)
PI_MODEL=""                          # optional: e.g., "anthropic/claude-sonnet-4-20250514"
# ----------------------------------

# --- Validate ---
if [[ "$API_KEY" == "your-api-key-here" || -z "$API_KEY" ]]; then
    echo "ERROR: Set API_KEY in this script before running." >&2
    exit 1
fi

echo "[setup] Installing system dependencies..."
if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq && sudo apt-get install -y -qq tmux curl git jq >/dev/null
elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y -q tmux curl git jq >/dev/null
else
    echo "[setup] Unsupported package manager. Install tmux, curl, git, jq manually." >&2
fi

# Install mise + node + pi
if ! command -v mise >/dev/null 2>&1; then
    echo "[setup] Installing mise..."
    curl -fsSL https://mise.run | sh
    echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc
fi

# Ensure mise shims are on PATH for this script
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
    echo "[setup] Installing Node.js via mise..."
    mise use -g node@lts
fi

if ! command -v pi >/dev/null 2>&1; then
    echo "[setup] Installing pi..."
    npm install -g @mariozechner/pi-coding-agent
fi

# Set up API key via environment.d (picked up by systemd user services)
echo "[setup] Configuring API key..."
mkdir -p ~/.config/environment.d
ENV_CONF="$HOME/.config/environment.d/pi.conf"
# Idempotent: remove old entry, write fresh
grep -v "^${API_KEY_VAR}=" "$ENV_CONF" > "${ENV_CONF}.tmp" 2>/dev/null || true
echo "${API_KEY_VAR}=${API_KEY}" >> "${ENV_CONF}.tmp"
mv "${ENV_CONF}.tmp" "$ENV_CONF"
chmod 600 "$ENV_CONF"
export "${API_KEY_VAR}=${API_KEY}"

# Also add to .bashrc for interactive sessions (idempotent)
grep -q "^export ${API_KEY_VAR}=" ~/.bashrc 2>/dev/null || \
    echo "export ${API_KEY_VAR}=\"${API_KEY}\"" >> ~/.bashrc

# Install pi extensions (idempotent — pi install skips if already present)
echo "[setup] Installing pi extensions..."
pi install git:github.com/badlogic/pi-telegram 2>/dev/null || true
pi install git:github.com/inceptionstack/pi-mono-watchdog 2>/dev/null || true

# Configure Telegram (optional)
if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_USER_ID" ]; then
    echo "[setup] Configuring Telegram..."
    mkdir -p ~/.pi/agent
    cat > ~/.pi/agent/telegram.json << EOF
{
    "botToken": "${TELEGRAM_BOT_TOKEN}",
    "allowedUserId": ${TELEGRAM_USER_ID}
}
EOF
    chmod 600 ~/.pi/agent/telegram.json
fi

# Pre-configure watchdog as enabled
echo "[setup] Configuring watchdog..."
mkdir -p ~/.pi/agent

PI_EXTRA_ARGS=()
[ -n "$PI_MODEL" ] && PI_EXTRA_ARGS=("--model" "$PI_MODEL")

if [ ${#PI_EXTRA_ARGS[@]} -eq 0 ]; then
    ARGS_JSON="[]"
else
    ARGS_JSON=$(printf '%s\n' "${PI_EXTRA_ARGS[@]}" | jq -R . | jq -s .)
fi

cat > ~/.pi/agent/watchdog.json << EOF
{
    "enabled": true,
    "autoTelegram": true,
    "piArgs": ${ARGS_JSON},
    "restartDelaySec": 5,
    "tmuxSession": "pi"
}
EOF

# Generate a minimal bootstrap wrapper script.
# On first run, the watchdog extension regenerates this with full crash
# tracking, backoff, and Telegram notifications — no manual intervention needed.
# The loop intentionally restarts on ALL exits (including clean exit 0)
# because the watchdog manages lifecycle. Use /watchdog-stop or kill the
# tmux session to stop pi.
mkdir -p ~/.pi/agent/extensions/pi-watchdog
cat > ~/.pi/agent/extensions/pi-watchdog/pi-loop.sh << 'WRAPPER'
#!/usr/bin/env bash
set -u
export NODE_NO_WARNINGS=1
cd "$HOME"
while true; do
    echo "[pi-watchdog] Starting pi at $(date -u +%Y-%m-%dT%H:%M:%SZ) ..."
    pi -c
    EXIT_CODE=$?
    echo "[pi-watchdog] pi exited with code $EXIT_CODE at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "[pi-watchdog] Restarting in 5s ..."
    sleep 5
done
WRAPPER
chmod 700 ~/.pi/agent/extensions/pi-watchdog/pi-loop.sh

# Generate systemd service
echo "[setup] Installing systemd service..."
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

# Stop any existing instance before overwriting
systemctl --user stop pi-agent.service 2>/dev/null || true

TMUX_BIN="$(command -v tmux)"
WRAPPER_PATH="$HOME/.pi/agent/extensions/pi-watchdog/pi-loop.sh"
NODE_DIR="$(dirname "$(command -v node)")"
SHIM_PATH="$HOME/.local/bin"

mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/pi-agent.service << EOF
[Unit]
Description=pi coding agent (tmux watchdog)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment="HOME=${HOME}"
Environment="PATH=${SHIM_PATH}:${NODE_DIR}:/usr/local/bin:/usr/bin:/bin"
EnvironmentFile=${HOME}/.config/environment.d/pi.conf
ExecStart=${TMUX_BIN} new-session -d -s pi ${WRAPPER_PATH}
ExecStop=${TMUX_BIN} kill-session -t pi
RemainAfterExit=yes
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF
chmod 600 ~/.config/systemd/user/pi-agent.service

# Enable lingering + service
echo "[setup] Enabling systemd service..."
sudo loginctl enable-linger "$(whoami)"
systemctl --user daemon-reload
systemctl --user enable pi-agent.service

echo ""
echo "=== Setup complete ==="
echo "  pi agent is configured with watchdog."
echo "  It will start automatically on next boot."
echo ""
echo "  To start now:  systemctl --user start pi-agent"
echo "  To attach:     tmux attach -t pi"
echo "  To check:      systemctl --user status pi-agent"
[ -n "$TELEGRAM_BOT_TOKEN" ] && echo "  Telegram:      configured ✅"
echo ""
