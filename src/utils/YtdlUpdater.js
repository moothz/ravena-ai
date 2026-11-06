const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const { setTimeout: sleep } = require("timers/promises");
const cron = require("node-cron");
const Logger = require("./Logger");

const logger = new Logger("YtdlUpdater");
let scriptPath = path.resolve(__dirname, "..", "..", "scripts", "update-ytdl.sh");
if (!fs.existsSync(scriptPath)) {
	scriptPath = path.resolve(__dirname, "..", "..", "update-ytdl.sh");
}

// yt-dlp nightly builds are served by GitHub releases, which intermittently
// return 502/504; a single blind attempt used to leave the container stale.
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [10000, 30000];

// Guards against the boot run and the cron overlapping with an in-flight update
let updateInFlight = false;

/**
 * Runs update-ytdl.sh once and resolves with its output instead of rejecting,
 * so the caller can inspect the RESULT marker of the script itself.
 */
function runScriptOnce() {
	return new Promise((resolve) => {
		execFile("bash", [scriptPath], (error, stdout, stderr) => {
			resolve({
				error,
				stdout: stdout || "",
				stderr: stderr || ""
			});
		});
	});
}

/**
 * Extracts the VERSION_BEFORE / VERSION_AFTER / RESULT markers printed by the script.
 */
function parseMarkers(stdout) {
	const read = (label) => {
		const match = new RegExp(`${label}:\\s*(\\S+)`).exec(stdout);
		return match ? match[1] : "unknown";
	};
	return {
		status: read("RESULT"),
		before: read("VERSION_BEFORE"),
		after: read("VERSION_AFTER")
	};
}

/**
 * Executes the update-ytdl.sh script with retry/backoff and reports the
 * resulting yt-dlp version at INFO level.
 */
async function runUpdate() {
	if (updateInFlight) {
		logger.warn("yt-dlp update already in progress, skipping this trigger.");
		return null;
	}

	updateInFlight = true;
	try {
		let lastError = null;

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			if (attempt > 1) {
				const delay = RETRY_DELAYS_MS[attempt - 2] || RETRY_DELAYS_MS.at(-1);
				logger.warn(
					`yt-dlp update failed, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}/${MAX_ATTEMPTS})...`
				);
				await sleep(delay);
			}

			logger.info(`Starting yt-dlp update process... (attempt ${attempt}/${MAX_ATTEMPTS})`);
			const { error, stdout, stderr } = await runScriptOnce();
			const markers = parseMarkers(stdout);
			const failed = Boolean(error) || markers.status === "failed";

			if (stderr && !stderr.includes("Check for updates")) {
				// yt-dlp often outputs info to stderr, so we filter it a bit or just log it
				logger[failed ? "warn" : "debug"](`yt-dlp update stderr: ${stderr.trim()}`);
			}

			if (!failed) {
				if (markers.status === "updated") {
					logger.info(`yt-dlp update process finished: ${markers.before} -> ${markers.after}`);
				} else {
					logger.info(`yt-dlp update process finished: already up to date (${markers.after}).`);
				}
				return stdout;
			}

			lastError =
				error || new Error(`update script reported RESULT: failed (version ${markers.after})`);
			logger.warn(
				`yt-dlp update attempt ${attempt}/${MAX_ATTEMPTS} failed (still on ${markers.after}): ${lastError.message}`
			);
		}

		logger.error(
			`yt-dlp update failed after ${MAX_ATTEMPTS} attempts, keeping current version: ${lastError.message}`
		);
		throw lastError;
	} finally {
		updateInFlight = false;
	}
}

/**
 * Initializes the scheduler for nightly updates
 */
function start() {
	logger.info("YtdlUpdater service initialized.");

	// Run once on startup to ensure we are up to date
	runUpdate().catch((err) => logger.error("Initial yt-dlp update failed", err));

	// 05:00 is the low traffic window, 17:00 covers containers that are recreated
	// (or restarted by the health-check) during business hours and never live
	// long enough to see the 05:00 window.
	cron.schedule(
		"0 5,17 * * *",
		() => {
			logger.info("Cron job triggered: Running nightly yt-dlp update.");
			runUpdate().catch((err) => {
				logger.error("Scheduled yt-dlp update failed:", err);
			});
		},
		{
			scheduled: true,
			timezone: "America/Sao_Paulo"
		}
	);
}

module.exports = {
	start,
	runUpdate
};
