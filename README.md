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

## Generated files

| File | Purpose |
|------|---------|
| `~/.pi/agent/watchdog.json` | Watchdog configuration |
| `~/.pi/agent/extensions/pi-watchdog/pi-loop.sh` | Bash respawn loop (auto-generated) |
| `~/.config/systemd/user/pi-agent.service` | systemd user service (auto-generated) |

## License

MIT
