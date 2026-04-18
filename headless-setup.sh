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

# --- Helpers ---

log() { echo "[setup] $1"; }
die() { echo "ERROR: $1" >&2; exit 1; }

# Install a command if missing. Usage: ensure_cmd <cmd> <install-fn>
ensure_cmd() {
    local cmd="$1"
    shift
    if ! command -v "$cmd" >/dev/null 2>&1; then
        "$@"
    fi
}

# Write an env var to pi.conf and export it.
# Secrets (KEY/SECRET/TOKEN in name) are NOT written to .bashrc.
write_env() {
    local key="$1" val="$2"
    echo "${key}=\"${val}\"" >> "$ENV_CONF"
    export "${key}=${val}"
    if [[ "$key" != *SECRET* && "$key" != *KEY* && "$key" != *TOKEN* ]]; then
        sed -i "/^export ${key}=/d" ~/.bashrc 2>/dev/null || true
        echo "export ${key}=\"${val}\"" >> ~/.bashrc
    fi
}

# Append a line to ~/.bashrc if not already present.
bashrc_add() {
    grep -qF "$1" ~/.bashrc 2>/dev/null || echo "$1" >> ~/.bashrc
}

# Create a directory with given permissions.
ensure_dir() {
    local dir="$1" mode="${2:-}"
    mkdir -p "$dir"
    [ -n "$mode" ] && chmod "$mode" "$dir"
}

# Write content to a file with given permissions.
write_file() {
    local path="$1" mode="${2:-}"
    cat > "$path"
    [ -n "$mode" ] && chmod "$mode" "$path"
}

# --- Validate ---

validate_config() {
    case "$PROVIDER_MODE" in
        api-key)
            [[ -n "$API_KEY" ]] || die "Set API_KEY for api-key mode."
            ;;
        bedrock-iam)
            [[ -n "$AWS_REGION_VAL" ]] || die "Set AWS_REGION_VAL for bedrock-iam mode."
            ;;
        bedrock-key)
            [[ -n "$AWS_ACCESS_KEY_ID_VAL" ]] || die "Set AWS_ACCESS_KEY_ID_VAL for bedrock-key mode."
            [[ -n "$AWS_SECRET_ACCESS_KEY_VAL" ]] || die "Set AWS_SECRET_ACCESS_KEY_VAL for bedrock-key mode."
            ;;
        *)
            die "PROVIDER_MODE must be api-key, bedrock-iam, or bedrock-key."
            ;;
    esac
}

# --- Install system dependencies ---

install_system_deps() {
    log "Installing system dependencies..."
    if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update -qq && sudo apt-get install -y -qq tmux curl git jq >/dev/null
    elif command -v yum >/dev/null 2>&1; then
        sudo yum install -y -q tmux git jq >/dev/null
        # Amazon Linux has curl-minimal which conflicts with curl
        command -v curl >/dev/null || sudo yum install -y -q curl >/dev/null || true
    else
        log "Unsupported package manager. Install tmux, curl, git, jq manually."
    fi
}

# --- Install mise, node, pi ---

install_mise() {
    log "Installing mise..."
    curl -fsSL https://mise.run | sh
    bashrc_add 'eval "$(~/.local/bin/mise activate bash)"'
}

install_runtime() {
    export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"

    ensure_cmd mise install_mise

    if ! command -v node >/dev/null 2>&1; then
        log "Installing Node.js via mise..."
        mise use -g node@lts
    fi

    if ! command -v pi >/dev/null 2>&1; then
        log "Installing pi..."
        npm install -g @mariozechner/pi-coding-agent
        hash -r
    fi
}

# --- Configure provider ---

configure_provider() {
    log "Configuring provider ($PROVIDER_MODE)..."
    ensure_dir ~/.config/environment.d
    ENV_CONF="$HOME/.config/environment.d/pi.conf"
    : > "$ENV_CONF"  # start fresh (idempotent)

    case "$PROVIDER_MODE" in
        api-key)
            write_env "$API_KEY_VAR" "$API_KEY"
            ;;
        bedrock-iam)
            write_env "AWS_DEFAULT_REGION" "$AWS_REGION_VAL"
            write_env "AWS_REGION" "$AWS_REGION_VAL"
            [ -n "$AWS_PROFILE_VAL" ] && write_env "AWS_PROFILE" "$AWS_PROFILE_VAL"
            ensure_dir ~/.aws
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
            write_env "AWS_DEFAULT_REGION" "$AWS_REGION_VAL_KEY"
            write_env "AWS_REGION" "$AWS_REGION_VAL_KEY"
            ;;
    esac

    chmod 600 "$ENV_CONF"
}

# --- Install pi extensions ---

install_extensions() {
    log "Installing pi extensions..."
    pi install git:github.com/badlogic/pi-telegram 2>/dev/null || true
    pi install git:github.com/inceptionstack/pi-mono-watchdog 2>/dev/null || true
}

# --- Configure Telegram ---

configure_telegram() {
    [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_USER_ID" ] && return 0
    log "Configuring Telegram..."
    ensure_dir ~/.pi/agent 700
    jq -n --arg token "$TELEGRAM_BOT_TOKEN" --argjson uid "$TELEGRAM_USER_ID" \
        '{botToken: $token, allowedUserId: $uid}' | write_file ~/.pi/agent/telegram.json 600
}

# --- Configure watchdog ---

build_pi_args() {
    PI_EXTRA_ARGS=()
    [ -n "$PI_MODEL" ] && PI_EXTRA_ARGS=("--model" "$PI_MODEL")

    if [ ${#PI_EXTRA_ARGS[@]} -eq 0 ]; then
        ARGS_JSON="[]"
        PI_CMD="pi -c"
    else
        ARGS_JSON=$(printf '%s\n' "${PI_EXTRA_ARGS[@]}" | jq -R . | jq -s .)
        PI_CMD="pi -c $(printf '%q ' "${PI_EXTRA_ARGS[@]}")"
    fi
}

configure_watchdog() {
    log "Configuring watchdog..."
    ensure_dir ~/.pi/agent 700

    build_pi_args

    cat > ~/.pi/agent/watchdog.json << EOF
{
    "enabled": true,
    "autoTelegram": true,
    "piArgs": ${ARGS_JSON},
    "restartDelaySec": 5,
    "tmuxSession": "pi"
}
EOF
}

# --- Generate wrapper script ---
# Minimal bootstrap — the watchdog extension regenerates this on first run
# with full crash tracking, backoff, and Telegram notifications.
# The loop restarts on ALL exits; use /watchdog-stop to stop pi.

generate_wrapper() {
    ensure_dir ~/.pi/agent/extensions/pi-watchdog

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
}

# --- Generate and enable systemd service ---

install_systemd_service() {
    log "Installing systemd service..."
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"

    # Stop any existing instance before overwriting
    systemctl --user stop pi-agent.service 2>/dev/null || true

    local tmux_bin wrapper_path node_dir shim_path
    tmux_bin="$(command -v tmux)"
    wrapper_path="$HOME/.pi/agent/extensions/pi-watchdog/pi-loop.sh"
    node_dir="$(dirname "$(command -v node)")"
    shim_path="$HOME/.local/bin"

    ensure_dir ~/.config/systemd/user

    write_file ~/.config/systemd/user/pi-agent.service 600 << EOF
[Unit]
Description=pi coding agent (tmux watchdog)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment="HOME=${HOME}"
Environment="PATH=${shim_path}:${node_dir}:/usr/local/bin:/usr/bin:/bin"
EnvironmentFile=${HOME}/.config/environment.d/pi.conf
ExecStart=${tmux_bin} new-session -d -s pi ${wrapper_path}
ExecStop=${tmux_bin} kill-session -t pi
RemainAfterExit=yes
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF
}

enable_and_start_service() {
    log "Enabling and starting service..."
    sudo loginctl enable-linger "$(whoami)"
    systemctl --user daemon-reload
    systemctl --user enable pi-agent.service
    systemctl --user start pi-agent.service
}

# --- Summary ---

print_summary() {
    sleep 3
    local tmux_status="not running ❌"
    tmux has-session -t pi 2>/dev/null && tmux_status="running ✅"

    echo ""
    echo "=== Setup complete ==="
    echo "  Provider:      $PROVIDER_MODE"
    echo "  pi agent is configured with watchdog."
    echo "  It will start automatically on next boot."
    echo ""
    echo "  Service:       enabled and started"
    echo "  tmux session:  $tmux_status"
    echo "  To attach:     tmux attach -t pi"
    echo "  To check:      systemctl --user status pi-agent"
    [ -n "$TELEGRAM_BOT_TOKEN" ] && echo "  Telegram:      configured ✅"
    echo ""
}

# --- Main ---

validate_config
install_system_deps
install_runtime
configure_provider
install_extensions
configure_telegram
configure_watchdog
generate_wrapper
install_systemd_service
enable_and_start_service
print_summary
