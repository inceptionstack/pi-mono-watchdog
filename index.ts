import { chmod, readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { constants } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// --- Constants ---

const TELEGRAM_CONFIG_PATH = join(homedir(), ".pi", "agent", "telegram.json");
const WATCHDOG_CONFIG_PATH = join(homedir(), ".pi", "agent", "watchdog.json");
const SYSTEMD_USER_DIR = join(homedir(), ".config", "systemd", "user");
const SERVICE_NAME = "pi-agent";
const TMUX_SESSION = "pi";
const WRAPPER_SCRIPT_PATH = join(homedir(), ".pi", "agent", "extensions", "pi-watchdog", "pi-loop.sh");
const SCRIPT_PERMISSIONS = 0o700;

const EXEC_TIMEOUT_MS = 5000;
const RUN_TIMEOUT_MS = 10000;
const TELEGRAM_CONNECT_DELAY_MS = 2000;
const START_POLL_ATTEMPTS = 5;
const START_POLL_INTERVAL_MS = 1000;
const STOP_SETTLE_MS = 1000;
const MAX_LOG_LINES = 500;
const STATUS_PREVIEW_LINES = 8;

// Rapid-crash protection in the bash wrapper
const MAX_RAPID_CRASHES = 5;
const RAPID_CRASH_WINDOW_SEC = 60;
const RAPID_CRASH_BACKOFF_SEC = 120;

// --- Config types ---

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

interface TelegramConfig {
	botToken?: string;
	allowedUserId?: number;
	botUsername?: string;
}

// --- Config I/O ---

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

// --- Telegram ---

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

// --- Formatting helpers ---

function check(val: boolean, trueText = "✅", falseText = "❌"): string {
	return val ? trueText : falseText;
}

function attachHint(session: string): string {
	return `tmux attach -t ${session}`;
}

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// --- Shell utilities ---

function shellEscape(arg: string): string {
	if (typeof arg !== "string" || arg.length === 0) return "''";
	if (/^[a-zA-Z0-9_./:=@+~-]+$/.test(arg)) return arg;
	return `'${arg.replace(/'/g, "'\\''")}'`;
}

function runShell(cmd: string): { ok: boolean; output: string } {
	try {
		const output = execSync(cmd, { encoding: "utf8", timeout: RUN_TIMEOUT_MS }).trim();
		return { ok: true, output };
	} catch (e: any) {
		return { ok: false, output: e.stderr?.trim() || e.stdout?.trim() || e.message || "" };
	}
}

function whichBinary(name: string, fallbacks: string[] = []): string | null {
	try {
		return execSync(`which ${name}`, { encoding: "utf8", timeout: EXEC_TIMEOUT_MS }).trim();
	} catch {
		for (const c of fallbacks) {
			try {
				execSync(`test -x ${shellEscape(c)}`, { timeout: EXEC_TIMEOUT_MS });
				return c;
			} catch {}
		}
		return null;
	}
}

function getPiBinary(): string {
	const bin = whichBinary("pi", [
		join(homedir(), ".local", "bin", "pi"),
		join(homedir(), ".local", "share", "mise", "installs", "node", "latest", "bin", "pi"),
		"/usr/local/bin/pi",
	]);
	if (!bin) throw new Error("Could not find pi binary. Ensure pi is in PATH.");
	return bin;
}

function getTmuxBinary(): string {
	return whichBinary("tmux") ?? "tmux";
}

function getMiseShimPath(): string {
	return join(homedir(), ".local", "bin");
}

// --- tmux helpers ---

function isTmuxInstalled(): boolean {
	return whichBinary("tmux") !== null;
}

function isTmuxSessionRunning(session: string): boolean {
	return runShell(`tmux has-session -t ${shellEscape(session)} 2>/dev/null`).ok;
}

function killTmuxSession(session: string): void {
	if (isTmuxSessionRunning(session)) {
		runShell(`tmux kill-session -t ${shellEscape(session)}`);
	}
}

// --- systemd helpers ---

function systemctl(action: string): { ok: boolean; output: string } {
	return runShell(`systemctl --user ${action} ${SERVICE_NAME}.service 2>/dev/null`);
}

function isServiceInstalled(): boolean {
	return runShell(`systemctl --user cat ${SERVICE_NAME}.service 2>/dev/null`).ok;
}

function isServiceRunning(): boolean {
	return systemctl("is-active").output === "active";
}

function isServiceEnabled(): boolean {
	return systemctl("is-enabled").output === "enabled";
}

function getServiceStatus(): string {
	return runShell(`systemctl --user status ${SERVICE_NAME}.service 2>&1`).output;
}

function disableService(): string[] {
	const warnings: string[] = [];
	const stop = systemctl("stop");
	const disable = systemctl("disable");
	runShell("systemctl --user daemon-reload");
	if (!stop.ok) warnings.push(`  ⚠️  stop: ${stop.output}`);
	if (!disable.ok) warnings.push(`  ⚠️  disable: ${disable.output}`);
	return warnings;
}

// --- Composite operations ---

function stopWatchdog(session: string): void {
	if (isServiceInstalled()) {
		systemctl("stop");
	}
	killTmuxSession(session);
}

function startWatchdog(session: string): { ok: boolean; output: string } {
	if (isServiceInstalled()) {
		return systemctl("start");
	}
	return runShell(`tmux new-session -d -s ${shellEscape(session)} ${shellEscape(WRAPPER_SCRIPT_PATH)}`);
}

async function waitForSession(session: string): Promise<boolean> {
	for (let i = 0; i < START_POLL_ATTEMPTS; i++) {
		await delay(START_POLL_INTERVAL_MS);
		if (isTmuxSessionRunning(session)) return true;
	}
	return false;
}

/** Start watchdog and wait for tmux session. Returns user-facing message. */
async function startAndWait(session: string): Promise<{ ok: boolean; message: string }> {
	const { ok, output } = startWatchdog(session);
	if (!ok) {
		return { ok: false, message: `❌ Failed to start: ${output}` };
	}

	if (await waitForSession(session)) {
		return { ok: true, message: `🐕 pi-watchdog started in tmux session '${session}'.\n  Attach with: ${attachHint(session)}` };
	}
	return { ok: false, message: "❌ tmux session did not start. Check /watchdog-logs" };
}

async function isWrapperExecutable(): Promise<boolean> {
	try {
		await access(WRAPPER_SCRIPT_PATH, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Validate preconditions for starting the watchdog. Returns error message or null. */
async function validateStartPreconditions(config: WatchdogConfig): Promise<string | null> {
	if (!isTmuxInstalled()) return "❌ tmux is not installed.";
	if (!config.enabled) return "❌ Watchdog not enabled. Run /watchdog-enable first.";
	if (!(await isWrapperExecutable())) return "❌ Wrapper script missing. Run /watchdog-enable to regenerate.";
	if (isTmuxSessionRunning(config.tmuxSession)) {
		return `⚠️  tmux session '${config.tmuxSession}' is already running (another pi instance may be active).\n  Attach with: ${attachHint(config.tmuxSession)}`;
	}
	return null;
}

async function regenerateServiceFiles(config: WatchdogConfig): Promise<string> {
	await writeFile(WRAPPER_SCRIPT_PATH, generateWrapperScript(config), "utf8");
	await chmod(WRAPPER_SCRIPT_PATH, SCRIPT_PERMISSIONS);

	await mkdir(SYSTEMD_USER_DIR, { recursive: true });
	const servicePath = join(SYSTEMD_USER_DIR, `${SERVICE_NAME}.service`);
	await writeFile(servicePath, generateServiceUnit(config), "utf8");

	runShell("systemctl --user daemon-reload");
	return servicePath;
}

// --- Bash script generators ---

function generateTelegramCurlNotify(): string {
	return `
notify_telegram() {
    local MSG="$1"
    local CONFIG_FILE="${TELEGRAM_CONFIG_PATH}"
    if [ ! -f "$CONFIG_FILE" ]; then return; fi

    local TOKEN="" CHAT_ID=""

    if command -v jq >/dev/null 2>&1; then
        TOKEN=$(jq -r '.botToken // empty' "$CONFIG_FILE" 2>/dev/null)
        CHAT_ID=$(jq -r '.allowedUserId // empty' "$CONFIG_FILE" 2>/dev/null)
    else
        TOKEN=$(grep -o '"botToken"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG_FILE" | head -1 | sed 's/.*"\\([^"]*\\)"$/\\1/')
        CHAT_ID=$(grep -o '"allowedUserId"[[:space:]]*:[[:space:]]*[0-9]*' "$CONFIG_FILE" | head -1 | grep -o '[0-9]*$')
    fi

    if [ -z "$TOKEN" ] || [ -z "$CHAT_ID" ]; then return; fi

    local BODY
    if command -v jq >/dev/null 2>&1; then
        BODY=$(jq -cn --arg cid "$CHAT_ID" --arg txt "$MSG" '{chat_id: ($cid | tonumber), text: $txt}')
    else
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
	const piCmd = join(shimPath, "pi");

	const baseArgs = config.piArgs.includes("-c") ? [] : ["-c"];
	const piArgs = [...baseArgs, ...config.piArgs].map(shellEscape).join(" ");

	return `#!/usr/bin/env bash
# pi-watchdog respawn loop — runs inside tmux
# Auto-generated. Do not edit; re-run /watchdog-enable to regenerate.

set -u

export PATH="${shimPath}:${nodeDir}:\${PATH}"
export HOME="${homedir()}"
export NODE_NO_WARNINGS=1

cd "${homedir()}"

${generateTelegramCurlNotify()}

declare -a CRASH_TIMES=()

while true; do
    echo "[pi-watchdog] Starting pi at $(date -u +%Y-%m-%dT%H:%M:%SZ) ..."
    ${piCmd} ${piArgs}
    EXIT_CODE=$?
    NOW=$(date +%s)
    echo "[pi-watchdog] pi exited with code $EXIT_CODE at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

    if [ $EXIT_CODE -ne 0 ]; then
        notify_telegram "⚠️ pi-watchdog: pi crashed with exit code $EXIT_CODE at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        CRASH_TIMES+=("$NOW")
    fi

    # Prune crash timestamps older than the window
    PRUNED=()
    if (( \\${#CRASH_TIMES[@]} > 0 )); then
        for T in "\\${CRASH_TIMES[@]}"; do
            if (( NOW - T < ${RAPID_CRASH_WINDOW_SEC} )); then
                PRUNED+=("$T")
            fi
        done
    fi
    CRASH_TIMES=()
    if (( \\${#PRUNED[@]} > 0 )); then
        CRASH_TIMES=("\\${PRUNED[@]}")
    fi

    if (( \\${#CRASH_TIMES[@]} >= ${MAX_RAPID_CRASHES} )); then
        echo "[pi-watchdog] Detected \\${#CRASH_TIMES[@]} crashes in ${RAPID_CRASH_WINDOW_SEC}s — backing off for ${RAPID_CRASH_BACKOFF_SEC}s"
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

// --- Extension entry point ---

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (event) => {
		if (event.reason !== "startup") return;

		const config = await readConfig();
		if (!config.enabled || !config.autoTelegram) return;
		if (!(await readTelegramConfig())) return;

		await sendTelegramNotification(`🐕 pi-watchdog: pi started at ${new Date().toISOString()}`);

		setTimeout(() => {
			pi.sendUserMessage("/telegram-connect", { deliverAs: "followUp" });
		}, TELEGRAM_CONNECT_DELAY_MS);
	});

	// --- Commands ---

	pi.registerCommand("watchdog-status", {
		description: "Show pi-watchdog status",
		handler: async (_args, ctx) => {
			const config = await readConfig();
			const tmuxOk = isTmuxInstalled();
			const session = config.tmuxSession;
			const tmuxRunning = tmuxOk && isTmuxSessionRunning(session);
			const svcInstalled = isServiceInstalled();

			const lines = [
				"🐕 pi-watchdog status:",
				"",
				"  Config:",
				`    enabled:         ${check(config.enabled)}`,
				`    auto-telegram:   ${check(config.autoTelegram)}`,
				`    restart delay:   ${config.restartDelaySec}s`,
				`    tmux session:    ${session}`,
				`    extra pi args:   ${config.piArgs.length > 0 ? config.piArgs.join(" ") : "(none)"}`,
				"",
				"  Runtime:",
				`    tmux installed:  ${check(tmuxOk, "✅", "❌ (required)")}`,
				`    tmux session:    ${check(tmuxRunning, "✅ running", "❌ not running")}`,
				`    systemd svc:     ${svcInstalled ? check(isServiceEnabled(), "✅ enabled", "⚠️  installed but disabled") : "❌ not installed"}`,
				`    systemd active:  ${check(svcInstalled && isServiceRunning())}`,
				`    wrapper script:  ${check(await isWrapperExecutable(), "✅", "❌ missing")}`,
				`    telegram config: ${check((await readTelegramConfig()) !== null, "✅ found", "❌ not found")}`,
			];

			if (tmuxRunning) {
				lines.push("", `  Attach with: ${attachHint(session)}`);
			}

			if (svcInstalled) {
				lines.push("", "  Service details:");
				for (const line of getServiceStatus().split("\n").slice(0, STATUS_PREVIEW_LINES)) {
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

			const config = await readConfig();

			if (config.enabled && isServiceInstalled()) {
				if (!(await ctx.ui.confirm("Already enabled", "Watchdog is already enabled. Regenerate files?"))) return;
			}

			try {
				getPiBinary();
			} catch (e: any) {
				ctx.ui.notify(`❌ ${e.message}`, "error");
				return;
			}

			config.enabled = true;

			try {
				await writeConfig(config);
				const servicePath = await regenerateServiceFiles(config);

				runShell("loginctl enable-linger");
				runShell(`systemctl --user enable ${SERVICE_NAME}.service`);

				const session = config.tmuxSession;
				ctx.ui.notify(
					[
						"🐕 pi-watchdog enabled!",
						"",
						`  Wrapper script: ${WRAPPER_SCRIPT_PATH}`,
						`  Service file:   ${servicePath}`,
						`  tmux session:   ${session}`,
						"  Lingering:      enabled",
						`  Auto-start:     ${check(true)} on boot`,
						`  Auto-restart:   ${check(true)} on crash (respawn loop with backoff)`,
						`  Auto-telegram:  ${check(config.autoTelegram)}`,
						"",
						"  The service is NOT started yet (you're running pi interactively).",
						"  On next reboot it will start automatically.",
						"  Or use /watchdog-start to start it now.",
						`  Attach with: ${attachHint(session)}`,
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
			const config = await readConfig();
			const warnings: string[] = [];

			if (isServiceInstalled()) {
				warnings.push(...disableService());
			}
			killTmuxSession(config.tmuxSession);

			config.enabled = false;
			try {
				await writeConfig(config);
			} catch (e: any) {
				warnings.push(`  ⚠️  config write failed: ${e.message}`);
			}

			ctx.ui.notify(
				["🐕 pi-watchdog disabled.", ...warnings].join("\n"),
				warnings.length > 0 ? "warning" : "info"
			);
		},
	});

	pi.registerCommand("watchdog-start", {
		description: "Start the pi-watchdog tmux session now",
		handler: async (_args, ctx) => {
			const config = await readConfig();
			const error = await validateStartPreconditions(config);
			if (error) {
				ctx.ui.notify(error, error.startsWith("⚠️") ? "warning" : "error");
				return;
			}

			const result = await startAndWait(config.tmuxSession);
			ctx.ui.notify(result.message, result.ok ? "success" : "error");
		},
	});

	pi.registerCommand("watchdog-restart", {
		description: "Restart the pi-watchdog tmux session",
		handler: async (_args, ctx) => {
			const config = await readConfig();
			const session = config.tmuxSession;

			stopWatchdog(session);
			await delay(STOP_SETTLE_MS);

			if (!isServiceInstalled() && !(await isWrapperExecutable())) {
				ctx.ui.notify("❌ Not enabled or wrapper missing. Run /watchdog-enable first.", "error");
				return;
			}

			const result = await startAndWait(session);
			ctx.ui.notify(
				result.ok ? `🐕 pi-watchdog restarted.\n  Attach with: ${attachHint(session)}` : result.message,
				result.ok ? "success" : "error"
			);
		},
	});

	pi.registerCommand("watchdog-stop", {
		description: "Stop the pi-watchdog tmux session",
		handler: async (_args, ctx) => {
			stopWatchdog((await readConfig()).tmuxSession);
			ctx.ui.notify("🐕 pi-watchdog stopped.", "info");
		},
	});

	pi.registerCommand("watchdog-logs", {
		description: "Show recent pi-watchdog service logs (default 50, pass number for more)",
		handler: async (args, ctx) => {
			const count = Math.max(1, Math.min(MAX_LOG_LINES, parseInt(args?.trim() || "50", 10) || 50));
			const { output } = runShell(`journalctl --user -u ${SERVICE_NAME}.service -n ${count} --no-pager 2>&1`);
			ctx.ui.notify(`🐕 Recent watchdog logs (last ${count}):\n\n${output}`, "info");
		},
	});

	pi.registerCommand("watchdog-config", {
		description: "Configure pi-watchdog settings",
		handler: async (args, ctx) => {
			const config = await readConfig();

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
						`  auto-telegram:  ${config.autoTelegram}`,
						`  restart-delay:  ${config.restartDelaySec}s`,
						`  tmux-session:   ${config.tmuxSession}`,
						`  pi-args:        ${config.piArgs.join(" ") || "(none)"}`,
					].join("\n"),
					"info"
				);
				return;
			}

			const parts = args.trim().split(/\s+/);
			const subCmd = parts[0];
			const value = parts.slice(1).join(" ");

			switch (subCmd) {
				case "auto-telegram":
					config.autoTelegram = value === "on" || value === "true" || value === "yes";
					ctx.ui.notify(`🐕 auto-telegram: ${config.autoTelegram ? "on" : "off"}`, "info");
					break;
				case "restart-delay": {
					const sec = parseInt(value, 10);
					if (isNaN(sec) || sec < 1) {
						ctx.ui.notify("❌ Invalid delay. Must be >= 1", "error");
						return;
					}
					config.restartDelaySec = sec;
					ctx.ui.notify(`🐕 restart-delay: ${sec}s`, "info");
					break;
				}
				case "tmux-session":
					if (!value || !/^[a-zA-Z0-9_.-]+$/.test(value)) {
						ctx.ui.notify("❌ Invalid session name. Use alphanumeric, _, -, . only.", "error");
						return;
					}
					config.tmuxSession = value;
					ctx.ui.notify(`🐕 tmux-session: ${value}`, "info");
					break;
				case "pi-args":
					config.piArgs = value ? value.split(/\s+/) : [];
					ctx.ui.notify(`🐕 pi-args: ${config.piArgs.length > 0 ? config.piArgs.join(" ") : "(cleared)"}`, "info");
					break;
				default:
					ctx.ui.notify(`❌ Unknown: ${subCmd}. Run /watchdog-config for usage.`, "error");
					return;
			}

			await writeConfig(config);

			if (config.enabled) {
				try {
					await regenerateServiceFiles(config);
					ctx.ui.notify("  (service + wrapper regenerated)", "info");
				} catch (e: any) {
					ctx.ui.notify(`  ⚠️  Failed to regenerate: ${e.message}`, "warning");
				}
			}
		},
	});
}
