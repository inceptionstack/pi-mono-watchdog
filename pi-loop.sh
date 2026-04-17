#!/usr/bin/env bash
# pi-watchdog respawn loop — runs inside tmux
# Auto-generated. Do not edit; re-run /watchdog-enable to regenerate.

set -u

export PATH="/home/ec2-user/.local/bin:/home/ec2-user/.local/share/mise/installs/node/latest/bin:${PATH}"
export HOME="/home/ec2-user"
export NODE_NO_WARNINGS=1

cd "/home/ec2-user"


notify_telegram() {
    local MSG="$1"
    local CONFIG_FILE="/home/ec2-user/.pi/agent/telegram.json"
    if [ ! -f "$CONFIG_FILE" ]; then return; fi

    local TOKEN="" CHAT_ID=""

    if command -v jq >/dev/null 2>&1; then
        TOKEN=$(jq -r '.botToken // empty' "$CONFIG_FILE" 2>/dev/null)
        CHAT_ID=$(jq -r '.allowedUserId // empty' "$CONFIG_FILE" 2>/dev/null)
    else
        TOKEN=$(grep -o '"botToken"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG_FILE" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
        CHAT_ID=$(grep -o '"allowedUserId"[[:space:]]*:[[:space:]]*[0-9]*' "$CONFIG_FILE" | head -1 | grep -o '[0-9]*$')
    fi

    if [ -z "$TOKEN" ] || [ -z "$CHAT_ID" ]; then return; fi

    local BODY
    if command -v jq >/dev/null 2>&1; then
        BODY=$(jq -cn --arg cid "$CHAT_ID" --arg txt "$MSG" '{chat_id: ($cid | tonumber), text: $txt}')
    else
        local ESCAPED
        ESCAPED=$(printf '%s' "$MSG" | sed 's/\\/\\\\/g; s/"/\\"/g')
        BODY="{\"chat_id\": $CHAT_ID, \"text\": \"$ESCAPED\"}"
    fi

    curl -s -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
        -H "Content-Type: application/json" \
        -d "$BODY" >/dev/null 2>&1 || true
}

declare -a CRASH_TIMES=()

while true; do
    echo "[pi-watchdog] Starting pi at $(date -u +%Y-%m-%dT%H:%M:%SZ) ..."
    /home/ec2-user/.local/bin/pi -c
    EXIT_CODE=$?
    NOW=$(date +%s)
    echo "[pi-watchdog] pi exited with code $EXIT_CODE at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

    if [ $EXIT_CODE -ne 0 ]; then
        notify_telegram "⚠️ pi-watchdog: pi crashed with exit code $EXIT_CODE at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        CRASH_TIMES+=("$NOW")
    fi

    # Prune crash timestamps older than the window
    PRUNED=()
    if (( ${#CRASH_TIMES[@]} > 0 )); then
        for T in "${CRASH_TIMES[@]}"; do
            if (( NOW - T < 60 )); then
                PRUNED+=("$T")
            fi
        done
    fi
    CRASH_TIMES=()
    if (( ${#PRUNED[@]} > 0 )); then
        CRASH_TIMES=("${PRUNED[@]}")
    fi

    if (( ${#CRASH_TIMES[@]} >= 5 )); then
        echo "[pi-watchdog] Detected ${#CRASH_TIMES[@]} crashes in 60s — backing off for 120s"
        notify_telegram "🛑 pi-watchdog: 5 rapid crashes detected, backing off for 120s"
        sleep 120
        CRASH_TIMES=()
    else
        echo "[pi-watchdog] Restarting in 5s ..."
        sleep 5
    fi
done
