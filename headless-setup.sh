#!/usr/bin/env bash
# Headless setup script for pi agent with watchdog.
# Run as your target user (not root) on a fresh VM.
# Works on Ubuntu/Debian and Amazon Linux/RHEL (x86_64 + arm64).
set -euo pipefail

# Disable GPG verification for mise node install (fails in non-interactive sessions)
export MISE_NODE_VERIFY=0

# --- Configuration (edit these) ---

# Provider mode: "api-key" or "bedrock-iam" or "bedrock-key"
#   api-key      — standard API key (Anthropic, Google, OpenAI, etc.)
#   bedrock-iam  — AWS Bedrock via IAM role (EC2 instance profile, no keys needed)
#   bedrock-key  — AWS Bedrock via access key + secret key
PROVIDER_MODE="bedrock-iam"

# For api-key mode:
API_KEY=""                           # your API key
API_KEY_VAR="ANTHROPIC_API_KEY"      # env var: ANTHROPIC_API_KEY, GOOGLE_API_KEY, OPENAI_API_KEY

# For bedrock-iam mode:
AWS_REGION_VAL="us-east-1"           # AWS region for Bedrock
AWS_PROFILE_VAL=""                   # optional: AWS profile name (leave empty for default)

# For bedrock-key mode:
AWS_ACCESS_KEY_ID_VAL=""             # AWS access key
AWS_SECRET_ACCESS_KEY_VAL=""         # AWS secret key
AWS_REGION_VAL_KEY="us-east-1"      # AWS region for Bedrock

# Common options:
TELEGRAM_BOT_TOKEN=""                # optional: your Telegram bot token
TELEGRAM_USER_ID=""                  # optional: your Telegram user ID (numeric)
PI_MODEL="amazon-bedrock/us.anthropic.claude-opus-4-6-v1"  # optional: e.g., "anthropic/claude-sonnet-4-20250514"
# ----------------------------------

# --- Validate ---
case "$PROVIDER_MODE" in
    api-key)
        if [[ -z "$API_KEY" ]]; then
            echo "ERROR: Set API_KEY for api-key mode." >&2
            exit 1
        fi
        ;;
    bedrock-iam)
        # No keys needed — uses instance profile / IAM role
        if [[ -z "$AWS_REGION_VAL" ]]; then
            echo "ERROR: Set AWS_REGION_VAL for bedrock-iam mode." >&2
            exit 1
        fi
        ;;
    bedrock-key)
        if [[ -z "$AWS_ACCESS_KEY_ID_VAL" || -z "$AWS_SECRET_ACCESS_KEY_VAL" ]]; then
            echo "ERROR: Set AWS_ACCESS_KEY_ID_VAL and AWS_SECRET_ACCESS_KEY_VAL for bedrock-key mode." >&2
            exit 1
        fi
        ;;
    *)
        echo "ERROR: PROVIDER_MODE must be api-key, bedrock-iam, or bedrock-key." >&2
        exit 1
        ;;
esac

echo "[setup] Installing system dependencies..."
if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq && sudo apt-get install -y -qq tmux curl git jq >/dev/null
elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y -q tmux git jq >/dev/null
    command -v curl >/dev/null || sudo yum install -y -q curl >/dev/null || true
else
    echo "[setup] Unsupported package manager. Install tmux, curl, git, jq manually." >&2
fi

# Install mise + node + pi
if ! command -v mise >/dev/null 2>&1; then
    echo "[setup] Installing mise..."
    curl -fsSL https://mise.run | sh
    grep -q 'mise activate bash' ~/.bashrc 2>/dev/null || \
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
    hash -r
fi

# --- Configure provider environment ---
echo "[setup] Configuring provider ($PROVIDER_MODE)..."
mkdir -p ~/.config/environment.d
ENV_CONF="$HOME/.config/environment.d/pi.conf"

# Start fresh (idempotent)
: > "$ENV_CONF"

write_env() {
    local key="$1" val="$2"
    echo "${key}=\"${val}\"" >> "$ENV_CONF"
    export "${key}=${val}"
    # Add to .bashrc for interactive sessions (idempotent) — skip secrets
    if [[ "$key" != *SECRET* && "$key" != *KEY* && "$key" != *TOKEN* ]]; then
        sed -i "/^export ${key}=/d" ~/.bashrc 2>/dev/null || true
        echo "export ${key}=\"${val}\"" >> ~/.bashrc
    fi
}

case "$PROVIDER_MODE" in
    api-key)
        write_env "$API_KEY_VAR" "$API_KEY"
        ;;
    bedrock-iam)
        write_env "AWS_DEFAULT_REGION" "$AWS_REGION_VAL"
        write_env "AWS_REGION" "$AWS_REGION_VAL"
        [ -n "$AWS_PROFILE_VAL" ] && write_env "AWS_PROFILE" "$AWS_PROFILE_VAL"
        # Ensure AWS CLI config exists for the region
        mkdir -p ~/.aws
        if [ ! -f ~/.aws/config ]; then
            cat > ~/.aws/config << AWSCFG
[default]
region = ${AWS_REGION_VAL}
output = json
AWSCFG
        fi
        ;;
    bedrock-key)
        write_env "AWS_ACCESS_KEY_ID" "$AWS_ACCESS_KEY_ID_VAL"
        write_env "AWS_SECRET_ACCESS_KEY" "$AWS_SECRET_ACCESS_KEY_VAL"
        write_env "AWS_DEFAULT_REGION" "${AWS_REGION_VAL_KEY}"
        write_env "AWS_REGION" "${AWS_REGION_VAL_KEY}"
        ;;
esac

chmod 600 "$ENV_CONF"

# Install pi extensions (idempotent — pi install skips if already present)
echo "[setup] Installing pi extensions..."
pi install git:github.com/badlogic/pi-telegram 2>/dev/null || true
pi install git:github.com/inceptionstack/pi-mono-watchdog 2>/dev/null || true

# Configure Telegram (optional)
if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_USER_ID" ]; then
    echo "[setup] Configuring Telegram..."
    mkdir -p ~/.pi/agent
    jq -n --arg token "$TELEGRAM_BOT_TOKEN" --argjson uid "$TELEGRAM_USER_ID" \
        '{botToken: $token, allowedUserId: $uid}' > ~/.pi/agent/telegram.json
    chmod 600 ~/.pi/agent/telegram.json
fi

# Lock down pi agent directory
mkdir -p ~/.pi/agent
chmod 700 ~/.pi/agent

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

# Generate a minimal bootstrap wrapper script that passes piArgs.
# On first run, the watchdog extension regenerates this with full crash
# tracking, backoff, and Telegram notifications — no manual intervention needed.
# The loop intentionally restarts on ALL exits (including clean exit 0)
# because the watchdog manages lifecycle. Use /watchdog-stop or kill the
# tmux session to stop pi.

# Build the pi command with args for the bootstrap wrapper
PI_CMD="pi -c"
if [ ${#PI_EXTRA_ARGS[@]} -gt 0 ]; then
    PI_CMD="pi -c $(printf '%q ' "${PI_EXTRA_ARGS[@]}")"
fi

mkdir -p ~/.pi/agent/extensions/pi-watchdog
cat > ~/.pi/agent/extensions/pi-watchdog/pi-loop.sh << WRAPPER
#!/usr/bin/env bash
set -u
export PATH="\$HOME/.local/share/mise/shims:\$HOME/.local/bin:\$PATH"
export NODE_NO_WARNINGS=1
cd "\$HOME"
while true; do
    echo "[pi-watchdog] Starting pi at \$(date -u +%Y-%m-%dT%H:%M:%SZ) ..."
    ${PI_CMD}
    EXIT_CODE=\$?
    echo "[pi-watchdog] pi exited with code \$EXIT_CODE at \$(date -u +%Y-%m-%dT%H:%M:%SZ)"
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
systemctl --user start pi-agent.service

# Wait briefly and verify
sleep 3
if tmux has-session -t pi 2>/dev/null; then
    TMUX_STATUS="running ✅"
else
    TMUX_STATUS="not running ❌"
fi

echo ""
echo "=== Setup complete ==="
echo "  Provider:      $PROVIDER_MODE"
echo "  pi agent is configured with watchdog."
echo "  It will start automatically on next boot."
echo ""
echo "  Service:       enabled and started"
echo "  tmux session:  $TMUX_STATUS"
echo "  To attach:     tmux attach -t pi"
echo "  To check:      systemctl --user status pi-agent"
[ -n "$TELEGRAM_BOT_TOKEN" ] && echo "  Telegram:      configured ✅"
echo ""
