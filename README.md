# pi-mono-watchdog 🐕

A [pi](https://github.com/badlogic/pi-mono) extension that keeps pi running 24/7 using tmux + systemd. If pi crashes or the machine reboots, the watchdog automatically restarts it and reconnects Telegram.

## How it works

```
systemd (boot) → tmux session "pi" → bash respawn loop → pi -c (interactive)
```

- **systemd** starts a tmux session on boot (with lingering enabled)
- A **bash respawn loop** inside tmux restarts pi on crash with backoff
- **Telegram notifications** are sent on start and crash
- The [pi-telegram](https://github.com/badlogic/pi-telegram) bridge auto-connects if configured

## Install

```bash
pi install git:github.com/inceptionstack/pi-mono-watchdog
```

Or clone manually:

```bash
git clone https://github.com/inceptionstack/pi-mono-watchdog.git ~/.pi/agent/extensions/pi-watchdog
```

## Prerequisites

- **tmux** — `sudo yum install tmux` or `sudo apt install tmux`
- **systemd user services** — most Linux distros have this
- **lingering** — `sudo loginctl enable-linger $USER` (the extension tries this automatically, but may need sudo)

## Quick start

```
/watchdog-enable     # install systemd service, adopt current tmux session
/watchdog-status     # verify everything is ✅
```

On reboot, pi starts automatically inside tmux. Attach with:

```bash
tmux attach -t pi
```

## Commands

| Command | Description |
|---------|-------------|
| `/watchdog-enable` | Install systemd service and enable auto-restart on boot/crash |
| `/watchdog-disable` | Stop everything, remove systemd service |
| `/watchdog-start` | Start the watchdog tmux session now |
| `/watchdog-stop` | Stop the watchdog tmux session |
| `/watchdog-restart` | Restart the watchdog tmux session |
| `/watchdog-status` | Show full status (config, tmux, systemd, telegram) |
| `/watchdog-logs` | Show recent service logs (default 50, pass number for more) |
| `/watchdog-config` | Configure settings (see below) |

## Configuration

```
/watchdog-config auto-telegram on|off      # auto-connect telegram on start (default: on)
/watchdog-config restart-delay <seconds>   # delay between restarts (default: 5)
/watchdog-config tmux-session <name>       # tmux session name (default: pi)
/watchdog-config pi-args <args...>         # extra pi CLI arguments
/watchdog-config pi-args                   # clear extra args
```

Config is stored in `~/.pi/agent/watchdog.json`.

## Features

### Auto-restart with crash backoff

The respawn loop restarts pi immediately on exit. If pi crashes 5 times within 60 seconds, the watchdog backs off for 2 minutes to avoid spin loops.

### Telegram notifications

If [pi-telegram](https://github.com/badlogic/pi-telegram) is configured (`~/.pi/agent/telegram.json`):

- **On start**: sends a notification via Telegram, then auto-connects the bridge
- **On crash**: the bash wrapper sends a crash notification with exit code
- **On rapid crashes**: sends a backoff warning

### Dual-instance detection

If you manually start pi while the watchdog is already running:

- A warning is shown in the TUI
- Telegram auto-connect is skipped to avoid duplicate polling
- You're told to use `tmux attach -t pi` or `/watchdog-stop` to take over

### Session adoption

When you run `/watchdog-enable` from inside a tmux session (e.g., session `0`), the extension automatically renames it to the watchdog session name (default `pi`).

### Session continuity

The wrapper runs `pi -c` (continue previous session), so pi picks up where it left off after a crash or reboot.

## Headless VM setup (non-interactive)

To deploy a pi agent with watchdog pre-enabled on a fresh VM (EC2, GCP, etc.) without interactive setup, use the script below. This works for **Ubuntu/Debian** and **Amazon Linux/RHEL** on both x86_64 and arm64.

### Prerequisites

You'll need:
- An **API key** for your LLM provider (e.g., `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`)
- Optionally, a **Telegram bot token** and your **Telegram user ID** (from [@userinfobot](https://t.me/userinfobot))

### Setup script

Create `setup-pi-agent.sh` and run it as your target user (not root):

```bash
#!/usr/bin/env bash
set -euo pipefail

# --- Configuration (edit these) ---
API_KEY="your-api-key-here"          # e.g., Anthropic, Google, or OpenAI key
API_KEY_VAR="ANTHROPIC_API_KEY"       # env var name: ANTHROPIC_API_KEY, GOOGLE_API_KEY, OPENAI_API_KEY
TELEGRAM_BOT_TOKEN=""                # optional: your Telegram bot token
TELEGRAM_USER_ID=""                  # optional: your Telegram user ID (numeric)
PI_MODEL=""                          # optional: e.g., "anthropic/claude-sonnet-4-20250514"
# ----------------------------------

echo "[setup] Installing system dependencies..."
if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq && sudo apt-get install -y -qq tmux curl git jq
elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y -q tmux curl git jq
else
    echo "[setup] Unsupported package manager. Install tmux, curl, git, jq manually."
fi

# Install mise + node + pi
if ! command -v mise >/dev/null 2>&1; then
    echo "[setup] Installing mise..."
    curl -fsSL https://mise.run | sh
    echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc
    export PATH="$HOME/.local/bin:$PATH"
    eval "$(mise activate bash)"
fi

if ! command -v node >/dev/null 2>&1; then
    echo "[setup] Installing Node.js via mise..."
    mise use -g node@lts
fi

if ! command -v pi >/dev/null 2>&1; then
    echo "[setup] Installing pi..."
    npm install -g @mariozechner/pi-coding-agent
fi

# Set up API key
echo "[setup] Configuring API key..."
mkdir -p ~/.config/environment.d
echo "${API_KEY_VAR}=${API_KEY}" >> ~/.config/environment.d/pi.conf
export "${API_KEY_VAR}=${API_KEY}"

# Also add to .bashrc for interactive sessions
grep -q "${API_KEY_VAR}" ~/.bashrc 2>/dev/null || \
    echo "export ${API_KEY_VAR}=\"${API_KEY}\"" >> ~/.bashrc

# Install pi extensions
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

cat > ~/.pi/agent/watchdog.json << EOF
{
    "enabled": true,
    "autoTelegram": true,
    "piArgs": $(printf '%s\n' "${PI_EXTRA_ARGS[@]:-}" | jq -R . | jq -s .),
    "restartDelaySec": 5,
    "tmuxSession": "pi"
}
EOF

# Generate wrapper script
PI_BIN=$(which pi)
SHIM_PATH="$HOME/.local/bin"
NODE_DIR="$(dirname $(which node))"
HOME_DIR="$HOME"

mkdir -p ~/.pi/agent/extensions/pi-watchdog
# The wrapper script will be generated by the extension on first run.
# For headless boot, we generate a minimal one here.
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
    if [ $EXIT_CODE -ne 0 ]; then
        echo "[pi-watchdog] Restarting in 5s ..."
    fi
    sleep 5
done
WRAPPER
chmod 700 ~/.pi/agent/extensions/pi-watchdog/pi-loop.sh

# Generate systemd service
echo "[setup] Installing systemd service..."
mkdir -p ~/.config/systemd/user
TMUX_BIN=$(which tmux)
WRAPPER_PATH="$HOME/.pi/agent/extensions/pi-watchdog/pi-loop.sh"

cat > ~/.config/systemd/user/pi-agent.service << EOF
[Unit]
Description=pi coding agent (tmux watchdog)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment="HOME=${HOME_DIR}"
Environment="${API_KEY_VAR}=${API_KEY}"
Environment="PATH=${SHIM_PATH}:${NODE_DIR}:/usr/local/bin:/usr/bin:/bin"
ExecStart=${TMUX_BIN} new-session -d -s pi ${WRAPPER_PATH}
ExecStop=${TMUX_BIN} kill-session -t pi
RemainAfterExit=yes
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

# Enable lingering + service
echo "[setup] Enabling systemd service..."
sudo loginctl enable-linger "$(whoami)"

export XDG_RUNTIME_DIR="/run/user/$(id -u)"
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
```

### Usage

```bash
# On your fresh VM:
chmod +x setup-pi-agent.sh
./setup-pi-agent.sh

# Start immediately (or just reboot)
systemctl --user start pi-agent
tmux attach -t pi
```

### Cloud-init / user-data

For fully automated EC2/cloud deployment, wrap the script in cloud-init user data. Note: cloud-init runs as root, so use `su` to run as your target user:

```yaml
#cloud-config
packages:
  - tmux
  - curl
  - git
  - jq

runcmd:
  - |
    su - ubuntu -c 'bash -s' << 'SCRIPT'
    # Paste the setup script contents here (without the shebang),
    # or curl it from a URL:
    # curl -fsSL https://your-host/setup-pi-agent.sh | bash
    SCRIPT
```

Replace `ubuntu` with your VM's default user (`ec2-user` for Amazon Linux, `admin` for Debian, etc.).

### After first boot

Once pi starts via the watchdog, the extension will regenerate the wrapper script (`pi-loop.sh`) with full crash tracking, backoff, and Telegram notifications — replacing the minimal bootstrap version. No manual intervention needed.

## Generated files

| File | Purpose |
|------|---------|
| `~/.pi/agent/watchdog.json` | Watchdog configuration |
| `~/.pi/agent/extensions/pi-watchdog/pi-loop.sh` | Bash respawn loop (auto-generated) |
| `~/.config/systemd/user/pi-agent.service` | systemd user service (auto-generated) |

## License

MIT
