const { exec } = require("child_process");
const path = require("path");
const cron = require("node-cron");
const Logger = require("./Logger");

const logger = new Logger("YtdlUpdater");
const scriptPath = path.resolve(__dirname, "..", "..", "update-ytdl.sh");

/**
 * Executes the update-ytdl.sh script
 */
function runUpdate() {
	return new Promise((resolve, reject) => {
		logger.info("Starting yt-dlp update process...");
		exec(`bash "${scriptPath}"`, (error, stdout, stderr) => {
			if (error) {
				logger.error(`Error updating yt-dlp: ${error.message}`);
				return reject(error);
			}
			if (stderr && !stderr.includes("Check for updates")) {
				// yt-dlp often outputs info to stderr, so we filter it a bit or just log it
				logger.debug(`yt-dlp update stderr: ${stderr}`);
			}
			logger.info("yt-dlp update process finished.");
			// logger.debug(`Output: ${stdout}`);
			resolve(stdout);
		});
	});
}

/**
 * Initializes the scheduler for nightly updates
 */
function start() {
	logger.info("YtdlUpdater service initialized.");

	// Run once on startup to ensure we are up to date
	runUpdate().catch((err) => logger.error("Initial yt-dlp update failed", err));

	// Schedule to run daily at 04:00 AM (usually a low traffic time)
	cron.schedule(
		"0 4 * * *",
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
