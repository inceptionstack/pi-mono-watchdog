import { chmod, readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { constants } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const TELEGRAM_CONFIG_PATH = join(homedir(), ".pi", "agent", "telegram.json");
const WATCHDOG_CONFIG_PATH = join(homedir(), ".pi", "agent", "watchdog.json");
const SYSTEMD_USER_DIR = join(homedir(), ".config", "systemd", "user");
const SERVICE_NAME = "pi-agent";
const TMUX_SESSION = "pi";
const WRAPPER_SCRIPT_PATH = join(homedir(), ".pi", "agent", "extensions", "pi-watchdog", "pi-loop.sh");

// Rapid-crash protection: if pi exits N times within WINDOW_SEC, pause for BACKOFF_SEC
const MAX_RAPID_CRASHES = 5;
const RAPID_CRASH_WINDOW_SEC = 60;
const RAPID_CRASH_BACKOFF_SEC = 120;

interface WatchdogConfig {
	enabled: boolean;
	autoTelegram: boolean;
	piArgs: string[];
	restartDelaySec: number;
	tmuxSession: string;
}

const DEFAULT_CONFIG: WatchdogConfig = {
	enabled: false,
	autoTelegram: true,
	piArgs: [],
	restartDelaySec: 5,
	tmuxSession: TMUX_SESSION,
};

async function readConfig(): Promise<WatchdogConfig> {
	try {
		const content = await readFile(WATCHDOG_CONFIG_PATH, "utf8");
		return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

async function writeConfig(config: WatchdogConfig): Promise<void> {
	await writeFile(WATCHDOG_CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n", "utf8");
}

interface TelegramConfig {
	botToken?: string;
	allowedUserId?: number;
	botUsername?: string;
}

async function readTelegramConfig(): Promise<TelegramConfig | null> {
	try {
		const content = await readFile(TELEGRAM_CONFIG_PATH, "utf8");
		const config = JSON.parse(content);
		if (config.botToken && config.allowedUserId) return config;
		return null;
	} catch {
		return null;
	}
}

async function hasTelegramConfig(): Promise<boolean> {
	return (await readTelegramConfig()) !== null;
}

async function sendTelegramNotification(message: string): Promise<boolean> {
	const tgConfig = await readTelegramConfig();
	if (!tgConfig?.botToken || !tgConfig?.allowedUserId) return false;

	try {
		const res = await fetch(`https://api.telegram.org/bot${tgConfig.botToken}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: tgConfig.allowedUserId,
				text: message,
			}),
		});
		const data = (await res.json()) as { ok: boolean };
		return data.ok;
	} catch (e) {
		console.error("[pi-watchdog] Telegram notification failed:", e);
		return false;
	}
}

function getPiBinary(): string {
	try {
		return execSync("which pi", { encoding: "utf8", timeout: 5000 }).trim();
	} catch {
		// Fallback: check common locations
		const candidates = [
			join(homedir(), ".local", "bin", "pi"),
			join(homedir(), ".local", "share", "mise", "installs", "node", "latest", "bin", "pi"),
			"/usr/local/bin/pi",
		];
		for (const c of candidates) {
			try {
				execSync(`test -x ${c}`, { timeout: 2000 });
				return c;
			} catch {}
		}
		throw new Error("Could not find pi binary. Ensure pi is in PATH.");
	}
}

function getTmuxBinary(): string {
	try {
		return execSync("which tmux", { encoding: "utf8", timeout: 5000 }).trim();
	} catch {
		return "tmux";
	}
}

function getMiseShimPath(): string {
	return join(homedir(), ".local", "bin");
}

function shellEscape(arg: string): string {
	if (typeof arg !== "string" || arg.length === 0) return "''";
	if (/^[a-zA-Z0-9_./:=@+~-]+$/.test(arg)) return arg;
	return `'${arg.replace(/'/g, "'\\''")}'`;
}

// --- tmux helpers ---

function isTmuxSessionRunning(session: string): boolean {
	try {
		execSync(`tmux has-session -t ${shellEscape(session)} 2>/dev/null`, { timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

function isTmuxInstalled(): boolean {
	try {
		execSync("which tmux", { encoding: "utf8", timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

// --- systemd helpers ---

function run(cmd: string): { ok: boolean; output: string } {
	try {
		const output = execSync(cmd, { encoding: "utf8", timeout: 10000 }).trim();
		return { ok: true, output };
	} catch (e: any) {
		return { ok: false, output: e.stderr?.trim() || e.stdout?.trim() || e.message || "" };
	}
}

function isServiceInstalled(): boolean {
	return run(`systemctl --user cat ${SERVICE_NAME}.service 2>/dev/null`).ok;
}

function isServiceRunning(): boolean {
	const { output } = run(`systemctl --user is-active ${SERVICE_NAME}.service 2>/dev/null`);
	return output === "active";
}

function isServiceEnabled(): boolean {
	const { output } = run(`systemctl --user is-enabled ${SERVICE_NAME}.service 2>/dev/null`);
	return output === "enabled";
}

function getServiceStatus(): string {
	const { output } = run(`systemctl --user status ${SERVICE_NAME}.service 2>&1`);
	return output;
}

// --- generators ---

function generateTelegramCurlNotify(): string {
	// Inline bash snippet that sends a Telegram notification if config exists.
	// Uses jq if available, falls back to grep+sed. JSON-encodes the message
	// body via jq or printf to avoid injection via special characters.
	return `
notify_telegram() {
    local MSG="$1"
    local CONFIG_FILE="${TELEGRAM_CONFIG_PATH}"
    if [ ! -f "$CONFIG_FILE" ]; then return; fi

    local TOKEN="" CHAT_ID=""

    # Extract token and chat ID — prefer jq, fall back to grep
    if command -v jq >/dev/null 2>&1; then
        TOKEN=$(jq -r '.botToken // empty' "$CONFIG_FILE" 2>/dev/null)
        CHAT_ID=$(jq -r '.allowedUserId // empty' "$CONFIG_FILE" 2>/dev/null)
    else
        TOKEN=$(grep -o '"botToken"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG_FILE" | head -1 | sed 's/.*"\([^"]*\)"$/\\1/')
        CHAT_ID=$(grep -o '"allowedUserId"[[:space:]]*:[[:space:]]*[0-9]*' "$CONFIG_FILE" | head -1 | grep -o '[0-9]*$')
    fi

    if [ -z "$TOKEN" ] || [ -z "$CHAT_ID" ]; then return; fi

    # Build JSON body safely — use jq if available, otherwise printf-escape
    local BODY
    if command -v jq >/dev/null 2>&1; then
        BODY=$(jq -cn --arg cid "$CHAT_ID" --arg txt "$MSG" '{chat_id: ($cid | tonumber), text: $txt}')
    else
        # Escape \\ and " for JSON
        local ESCAPED
        ESCAPED=$(printf '%s' "$MSG" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
        BODY="{\\"chat_id\\": $CHAT_ID, \\"text\\": \\"$ESCAPED\\"}"
    fi

    curl -s -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \\
        -H "Content-Type: application/json" \\
        -d "$BODY" >/dev/null 2>&1 || true
}`;
}

function generateWrapperScript(config: WatchdogConfig): string {
	const shimPath = getMiseShimPath();
	const nodeDir = join(homedir(), ".local", "share", "mise", "installs", "node", "latest", "bin");

	// Use the shim path so the wrapper survives pi/node upgrades
	const piCmd = join(shimPath, "pi");

	// Deduplicate -c if user already passed it in piArgs
	const baseArgs = config.piArgs.includes("-c") ? [] : ["-c"];
	const piArgs = [...baseArgs, ...config.piArgs].map(shellEscape).join(" ");

	return `#!/usr/bin/env bash
# pi-watchdog respawn loop — runs inside tmux
# Auto-generated by pi-watchdog extension. Do not edit; re-run /watchdog-enable to regenerate.

set -u

export PATH="${shimPath}:${nodeDir}:\${PATH}"
export HOME="${homedir()}"
export NODE_NO_WARNINGS=1

cd "${homedir()}"

${generateTelegramCurlNotify()}

# Rapid-crash detection: track recent exit timestamps
declare -a CRASH_TIMES=()

while true; do
    START_TS=$(date +%s)
    echo "[pi-watchdog] Starting pi at $(date -u +%Y-%m-%dT%H:%M:%SZ) ..."
    ${piCmd} ${piArgs}
    EXIT_CODE=$?
    NOW=$(date +%s)
    echo "[pi-watchdog] pi exited with code $EXIT_CODE at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

    if [ $EXIT_CODE -ne 0 ]; then
        notify_telegram "⚠️ pi-watchdog: pi crashed with exit code $EXIT_CODE at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

        # Track crash timestamps (only non-zero exits) for rapid-failure detection
        CRASH_TIMES+=("$NOW")
    fi

    # Prune timestamps older than the window
    PRUNED=()
    if (( \${#CRASH_TIMES[@]} > 0 )); then
        for T in "\${CRASH_TIMES[@]}"; do
            if (( NOW - T < ${RAPID_CRASH_WINDOW_SEC} )); then
                PRUNED+=("$T")
            fi
        done
    fi
    CRASH_TIMES=()
    if (( \${#PRUNED[@]} > 0 )); then
        CRASH_TIMES=("\${PRUNED[@]}")
    fi

    if (( \${#CRASH_TIMES[@]} >= ${MAX_RAPID_CRASHES} )); then
        echo "[pi-watchdog] Detected \${#CRASH_TIMES[@]} crashes in ${RAPID_CRASH_WINDOW_SEC}s — backing off for ${RAPID_CRASH_BACKOFF_SEC}s"
        notify_telegram "🛑 pi-watchdog: ${MAX_RAPID_CRASHES} rapid crashes detected, backing off for ${RAPID_CRASH_BACKOFF_SEC}s"
        sleep ${RAPID_CRASH_BACKOFF_SEC}
        CRASH_TIMES=()
    else
        echo "[pi-watchdog] Restarting in ${config.restartDelaySec}s ..."
        sleep ${config.restartDelaySec}
    fi
done
`;
}

function generateServiceUnit(config: WatchdogConfig): string {
	const tmuxBinary = getTmuxBinary();
	const session = shellEscape(config.tmuxSession);

	return `[Unit]
Description=pi coding agent (tmux watchdog)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment="HOME=${homedir()}"
ExecStart=${tmuxBinary} new-session -d -s ${session} ${shellEscape(WRAPPER_SCRIPT_PATH)}
ExecStop=${tmuxBinary} kill-session -t ${session}
RemainAfterExit=yes
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

async function ensureWrapperExists(): Promise<boolean> {
	try {
		await access(WRAPPER_SCRIPT_PATH, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	let watchdogConfig: WatchdogConfig = { ...DEFAULT_CONFIG };

	// On startup, auto-connect telegram if watchdog is enabled and config exists
	pi.on("session_start", async (event, _ctx) => {
		watchdogConfig = await readConfig();

		// Only auto-connect on initial startup, not on /reload, /new, /resume, /fork
		if (event.reason !== "startup") return;

		if (watchdogConfig.enabled && watchdogConfig.autoTelegram) {
			const hasTg = await hasTelegramConfig();
			if (hasTg) {
				const now = new Date().toISOString();
				await sendTelegramNotification(`🐕 pi-watchdog: pi started at ${now}`);

				setTimeout(() => {
					pi.sendUserMessage("/telegram-connect", { deliverAs: "followUp" });
				}, 2000);
			}
		}
	});

	// --- Commands ---

	pi.registerCommand("watchdog-status", {
		description: "Show pi-watchdog status",
		handler: async (_args, ctx) => {
			watchdogConfig = await readConfig();
			const tmuxInstalled = isTmuxInstalled();
			const sessionName = watchdogConfig.tmuxSession;
			const tmuxRunning = tmuxInstalled && isTmuxSessionRunning(sessionName);
			const svcInstalled = isServiceInstalled();
			const svcEnabled = svcInstalled && isServiceEnabled();
			const svcRunning = svcInstalled && isServiceRunning();
			const hasTg = await hasTelegramConfig();
			const wrapperExists = await ensureWrapperExists();

			const lines = [
				"🐕 pi-watchdog status:",
				"",
				"  Config:",
				`    enabled:         ${watchdogConfig.enabled ? "✅" : "❌"}`,
				`    auto-telegram:   ${watchdogConfig.autoTelegram ? "✅" : "❌"}`,
				`    restart delay:   ${watchdogConfig.restartDelaySec}s`,
				`    tmux session:    ${sessionName}`,
				`    extra pi args:   ${watchdogConfig.piArgs.length > 0 ? watchdogConfig.piArgs.join(" ") : "(none)"}`,
				"",
				"  Runtime:",
				`    tmux installed:  ${tmuxInstalled ? "✅" : "❌ (required)"}`,
				`    tmux session:    ${tmuxRunning ? "✅ running" : "❌ not running"}`,
				`    systemd svc:     ${svcInstalled ? (svcEnabled ? "✅ enabled" : "⚠️  installed but disabled") : "❌ not installed"}`,
				`    systemd active:  ${svcRunning ? "✅" : "❌"}`,
				`    wrapper script:  ${wrapperExists ? "✅" : "❌ missing"}`,
				`    telegram config: ${hasTg ? "✅ found" : "❌ not found"}`,
			];

			if (tmuxRunning) {
				lines.push("", `  Attach with: tmux attach -t ${sessionName}`);
			}

			if (svcInstalled) {
				lines.push("", "  Service details:");
				const status = getServiceStatus();
				for (const line of status.split("\n").slice(0, 8)) {
					lines.push(`    ${line}`);
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("watchdog-enable", {
		description: "Enable pi-watchdog: install tmux-based systemd service for auto-restart on crash/reboot",
		handler: async (_args, ctx) => {
			if (!isTmuxInstalled()) {
				ctx.ui.notify("❌ tmux is not installed. Install it first:\n  sudo yum install tmux   # or: sudo apt install tmux", "error");
				return;
			}

			watchdogConfig = await readConfig();

			if (watchdogConfig.enabled && isServiceInstalled()) {
				const ok = await ctx.ui.confirm("Already enabled", "Watchdog is already enabled. Regenerate files?");
				if (!ok) return;
			}

			watchdogConfig.enabled = true;

			try {
				// Validate pi binary before generating anything
				getPiBinary();
			} catch (e: any) {
				ctx.ui.notify(`❌ ${e.message}`, "error");
				return;
			}

			try {
				await writeConfig(watchdogConfig);

				// Generate wrapper script and ensure executable
				await writeFile(WRAPPER_SCRIPT_PATH, generateWrapperScript(watchdogConfig), "utf8");
				await chmod(WRAPPER_SCRIPT_PATH, 0o700);

				// Generate and install systemd service
				await mkdir(SYSTEMD_USER_DIR, { recursive: true });
				const servicePath = join(SYSTEMD_USER_DIR, `${SERVICE_NAME}.service`);
				await writeFile(servicePath, generateServiceUnit(watchdogConfig), "utf8");

				// Enable lingering so user services run without login
				run("loginctl enable-linger");

				// Reload and enable
				run("systemctl --user daemon-reload");
				run(`systemctl --user enable ${SERVICE_NAME}.service`);

				const session = watchdogConfig.tmuxSession;

				ctx.ui.notify(
					[
						"🐕 pi-watchdog enabled!",
						"",
						`  Wrapper script: ${WRAPPER_SCRIPT_PATH}`,
						`  Service file:   ${servicePath}`,
						`  tmux session:   ${session}`,
						"  Lingering:      enabled",
						"  Auto-start:     ✅ on boot",
						"  Auto-restart:   ✅ on crash (respawn loop with backoff)",
						`  Auto-telegram:  ${watchdogConfig.autoTelegram ? "✅" : "❌"}`,
						"",
						"  The service is NOT started yet (you're running pi interactively).",
						"  On next reboot it will start automatically.",
						"  Or use /watchdog-start to start it now.",
						`  Attach with: tmux attach -t ${session}`,
					].join("\n"),
					"success"
				);
			} catch (e: any) {
				ctx.ui.notify(`❌ Failed to enable watchdog: ${e.message}`, "error");
			}
		},
	});

	pi.registerCommand("watchdog-disable", {
		description: "Disable pi-watchdog: stop tmux session and remove systemd service",
		handler: async (_args, ctx) => {
			watchdogConfig = await readConfig();
			const session = watchdogConfig.tmuxSession;

			const results: string[] = [];

			// Stop systemd service (this kills the tmux session)
			if (isServiceInstalled()) {
				const stop = run(`systemctl --user stop ${SERVICE_NAME}.service`);
				const disable = run(`systemctl --user disable ${SERVICE_NAME}.service`);
				run("systemctl --user daemon-reload");
				if (!stop.ok) results.push(`  ⚠️  stop: ${stop.output}`);
				if (!disable.ok) results.push(`  ⚠️  disable: ${disable.output}`);
			}

			// Kill tmux session if still around
			if (isTmuxSessionRunning(session)) {
				run(`tmux kill-session -t ${shellEscape(session)}`);
			}

			// Write config last — so if stopping fails, config still says enabled
			watchdogConfig.enabled = false;
			try {
				await writeConfig(watchdogConfig);
			} catch (e: any) {
				results.push(`  ⚠️  config write failed: ${e.message}`);
			}

			const msg = ["🐕 pi-watchdog disabled.", ...results];
			ctx.ui.notify(msg.join("\n"), results.length > 0 ? "warning" : "info");
		},
	});

	pi.registerCommand("watchdog-start", {
		description: "Start the pi-watchdog tmux session now",
		handler: async (_args, ctx) => {
			watchdogConfig = await readConfig();
			const session = watchdogConfig.tmuxSession;

			if (!isTmuxInstalled()) {
				ctx.ui.notify("❌ tmux is not installed.", "error");
				return;
			}

			if (!watchdogConfig.enabled) {
				ctx.ui.notify("❌ Watchdog not enabled. Run /watchdog-enable first.", "error");
				return;
			}

			if (!(await ensureWrapperExists())) {
				ctx.ui.notify("❌ Wrapper script missing. Run /watchdog-enable to regenerate.", "error");
				return;
			}

			if (isTmuxSessionRunning(session)) {
				ctx.ui.notify(
					`⚠️  tmux session '${session}' is already running (another pi instance may be active).\n  Attach with: tmux attach -t ${session}`,
					"warning"
				);
				return;
			}

			// Start via systemd if installed, otherwise start tmux directly
			if (isServiceInstalled()) {
				const { ok, output } = run(`systemctl --user start ${SERVICE_NAME}.service`);
				if (!ok) {
					ctx.ui.notify(`❌ Failed to start service: ${output}`, "error");
					return;
				}
			} else {
				const { ok, output } = run(`tmux new-session -d -s ${shellEscape(session)} ${shellEscape(WRAPPER_SCRIPT_PATH)}`);
				if (!ok) {
					ctx.ui.notify(`❌ Failed to start tmux session: ${output}`, "error");
					return;
				}
			}

			// Poll for session to appear (up to 5s)
			let started = false;
			for (let i = 0; i < 5; i++) {
				await new Promise((r) => setTimeout(r, 1000));
				if (isTmuxSessionRunning(session)) {
					started = true;
					break;
				}
			}

			if (started) {
				ctx.ui.notify(`🐕 pi-watchdog started in tmux session '${session}'.\n  Attach with: tmux attach -t ${session}`, "success");
			} else {
				ctx.ui.notify("❌ tmux session did not start. Check /watchdog-logs", "error");
			}
		},
	});

	pi.registerCommand("watchdog-restart", {
		description: "Restart the pi-watchdog tmux session",
		handler: async (_args, ctx) => {
			watchdogConfig = await readConfig();
			const session = watchdogConfig.tmuxSession;

			// Stop
			if (isServiceInstalled()) {
				run(`systemctl --user stop ${SERVICE_NAME}.service`);
			}
			if (isTmuxSessionRunning(session)) {
				run(`tmux kill-session -t ${shellEscape(session)}`);
			}

			// Wait for cleanup
			await new Promise((r) => setTimeout(r, 1000));

			// Start
			if (isServiceInstalled()) {
				const { ok, output } = run(`systemctl --user start ${SERVICE_NAME}.service`);
				if (!ok) {
					ctx.ui.notify(`❌ Failed to restart: ${output}`, "error");
					return;
				}
			} else if (await ensureWrapperExists()) {
				const { ok, output } = run(`tmux new-session -d -s ${shellEscape(session)} ${shellEscape(WRAPPER_SCRIPT_PATH)}`);
				if (!ok) {
					ctx.ui.notify(`❌ Failed to restart: ${output}`, "error");
					return;
				}
			} else {
				ctx.ui.notify("❌ Not enabled or wrapper missing. Run /watchdog-enable first.", "error");
				return;
			}

			await new Promise((r) => setTimeout(r, 2000));

			if (isTmuxSessionRunning(session)) {
				ctx.ui.notify(`🐕 pi-watchdog restarted.\n  Attach with: tmux attach -t ${session}`, "success");
			} else {
				ctx.ui.notify("❌ Restart failed. Check /watchdog-logs", "error");
			}
		},
	});

	pi.registerCommand("watchdog-stop", {
		description: "Stop the pi-watchdog tmux session",
		handler: async (_args, ctx) => {
			watchdogConfig = await readConfig();
			const session = watchdogConfig.tmuxSession;

			if (isServiceInstalled()) {
				run(`systemctl --user stop ${SERVICE_NAME}.service`);
			}

			if (isTmuxSessionRunning(session)) {
				run(`tmux kill-session -t ${shellEscape(session)}`);
			}

			ctx.ui.notify("🐕 pi-watchdog stopped.", "info");
		},
	});

	pi.registerCommand("watchdog-logs", {
		description: "Show recent pi-watchdog service logs (default 50, pass number for more)",
		handler: async (args, ctx) => {
			const count = Math.max(1, Math.min(500, parseInt(args?.trim() || "50", 10) || 50));
			const { output } = run(`journalctl --user -u ${SERVICE_NAME}.service -n ${count} --no-pager 2>&1`);
			ctx.ui.notify(`🐕 Recent watchdog logs (last ${count}):\n\n${output}`, "info");
		},
	});

	pi.registerCommand("watchdog-config", {
		description: "Configure pi-watchdog settings",
		handler: async (args, ctx) => {
			watchdogConfig = await readConfig();

			if (!args || args.trim() === "") {
				ctx.ui.notify(
					[
						"🐕 Watchdog config usage:",
						"  /watchdog-config auto-telegram on|off",
						"  /watchdog-config restart-delay <seconds>",
						"  /watchdog-config tmux-session <name>",
						"  /watchdog-config pi-args <args...>",
						"  /watchdog-config pi-args              (clear)",
						"",
						"Current config:",
						`  auto-telegram:  ${watchdogConfig.autoTelegram}`,
						`  restart-delay:  ${watchdogConfig.restartDelaySec}s`,
						`  tmux-session:   ${watchdogConfig.tmuxSession}`,
						`  pi-args:        ${watchdogConfig.piArgs.join(" ") || "(none)"}`,
					].join("\n"),
					"info"
				);
				return;
			}

			const parts = args.trim().split(/\s+/);
			const subCmd = parts[0];
			const value = parts.slice(1).join(" ");

			switch (subCmd) {
				case "auto-telegram": {
					watchdogConfig.autoTelegram = value === "on" || value === "true" || value === "yes";
					await writeConfig(watchdogConfig);
					ctx.ui.notify(`🐕 auto-telegram: ${watchdogConfig.autoTelegram ? "on" : "off"}`, "info");
					break;
				}
				case "restart-delay": {
					const sec = parseInt(value, 10);
					if (isNaN(sec) || sec < 1) {
						ctx.ui.notify("❌ Invalid delay. Must be >= 1", "error");
						return;
					}
					watchdogConfig.restartDelaySec = sec;
					await writeConfig(watchdogConfig);
					ctx.ui.notify(`🐕 restart-delay: ${sec}s`, "info");
					break;
				}
				case "tmux-session": {
					if (!value || !/^[a-zA-Z0-9_.-]+$/.test(value)) {
						ctx.ui.notify("❌ Invalid session name. Use alphanumeric, _, -, . only.", "error");
						return;
					}
					watchdogConfig.tmuxSession = value;
					await writeConfig(watchdogConfig);
					ctx.ui.notify(`🐕 tmux-session: ${value}`, "info");
					break;
				}
				case "pi-args": {
					watchdogConfig.piArgs = value ? value.split(/\s+/) : [];
					await writeConfig(watchdogConfig);
					ctx.ui.notify(
						`🐕 pi-args: ${watchdogConfig.piArgs.length > 0 ? watchdogConfig.piArgs.join(" ") : "(cleared)"}`,
						"info"
					);
					break;
				}
				default:
					ctx.ui.notify(`❌ Unknown: ${subCmd}. Run /watchdog-config for usage.`, "error");
					return;
			}

			// Regenerate files if enabled
			if (watchdogConfig.enabled) {
				try {
					await writeFile(WRAPPER_SCRIPT_PATH, generateWrapperScript(watchdogConfig), "utf8");
					await chmod(WRAPPER_SCRIPT_PATH, 0o700);
					await mkdir(SYSTEMD_USER_DIR, { recursive: true });
					const servicePath = join(SYSTEMD_USER_DIR, `${SERVICE_NAME}.service`);
					await writeFile(servicePath, generateServiceUnit(watchdogConfig), "utf8");
					run("systemctl --user daemon-reload");
					ctx.ui.notify("  (service + wrapper regenerated)", "info");
				} catch (e: any) {
					ctx.ui.notify(`  ⚠️  Failed to regenerate: ${e.message}`, "warning");
				}
			}
		},
	});
}
