const http = require("http");
const fs = require("fs");
const path = require("path");

const TARGET_PORT = 5001; // The bot container will be moved to port 5001
const PROXY_PORT = 5000; // The proxy will run on port 5000 (where Cloudflare points)
const PUBLIC_DIR = path.join(__dirname, "../public");
const DATA_DIR = path.join(__dirname, "../data");
const MOTIVO_FILE = path.join(DATA_DIR, "status_motivo.txt");
const FALLBACK_HTML_FILE = path.join(__dirname, "fallback.html");

// MIME types for static files when serving local fallbacks
const MIME_TYPES = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".ico": "image/x-icon",
	".svg": "image/svg+xml",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8"
};

const server = http.createServer((req, res) => {
	// 1. Prepare proxy request options
	const options = {
		hostname: "127.0.0.1",
		port: TARGET_PORT,
		path: req.url,
		method: req.method,
		headers: { ...req.headers }
	};

	// Forward the original IP if available
	if (req.headers["x-forwarded-for"]) {
		options.headers["x-forwarded-for"] = req.headers["x-forwarded-for"];
	} else {
		options.headers["x-forwarded-for"] = req.socket.remoteAddress;
	}

	// Create the proxy request
	const proxyReq = http.request(options, (proxyRes) => {
		// Copy headers and status code
		res.writeHead(proxyRes.statusCode, proxyRes.headers);
		// Stream the response directly to client
		proxyRes.pipe(res, { end: true });
	});

	// Handle client disconnect or connection errors
	req.on("error", (err) => {
		console.error(`[Proxy Request Client Error] ${req.method} ${req.url}:`, err.message);
		proxyReq.destroy();
	});

	// Handle proxy errors (e.g., target bot is down or restarting)
	proxyReq.on("error", (err) => {
		serveFallback(req, res, err);
	});

	// Pipe the request body (important for POST requests/API endpoints)
	req.pipe(proxyReq, { end: true });
});

function serveFallback(req, res, err) {
	let pathname = req.url.split("?")[0];

	// Normalize path to prevent directory traversal
	pathname = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");

	// Check if it's an API request or expects JSON
	const isApi =
		pathname.startsWith("/api/") ||
		(req.headers.accept && req.headers.accept.includes("application/json"));
	if (isApi) {
		res.writeHead(200, {
			"Content-Type": "application/json; charset=utf-8",
			"X-Ravena-Status": "offline"
		});
		res.end(
			JSON.stringify({
				status: "offline",
				message: "A ravena está temporariamente indisponível",
				reason: getReason() || "O bot está offline ou em manutenção."
			})
		);
		return;
	}

	// Try serving static files from the local public directory first (helps load styles/images/favicons)
	if (pathname !== "/" && pathname !== "/index.html") {
		const filePath = path.join(PUBLIC_DIR, pathname);
		// Security check: ensure the file path is within the public directory
		if (filePath.startsWith(PUBLIC_DIR)) {
			try {
				if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
					const ext = path.extname(filePath).toLowerCase();
					const contentType = MIME_TYPES[ext] || "application/octet-stream";
					res.writeHead(200, { "Content-Type": contentType });
					fs.createReadStream(filePath).pipe(res);
					return;
				}
			} catch (e) {
				// Skip on error, will fall back to error HTML
			}
		}
	}

	// Serve the beautiful fallback HTML status page
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Ravena-Status": "offline" });

	let html = `<!DOCTYPE html>
<html>
<head>
    <title>RavenaBot - Offline</title>
</head>
<body style="background-color: #0f0233; color: #1aafbc; font-family: sans-serif; text-align: center; padding: 50px;">
    <h1>502 Bad Gateway</h1>
    <p>A ravena está temporariamente indisponível.</p>
</body>
</html>`;

	try {
		if (fs.existsSync(FALLBACK_HTML_FILE)) {
			html = fs.readFileSync(FALLBACK_HTML_FILE, "utf8");
			const reason = getReason();
			const reasonHtml = reason
				? `<div class="reason-box">
                    <span class="reason-title"><i class="fas fa-info-circle"></i> Motivo da Indisponibilidade:</span>
                    <p class="reason-text">${reason}</p>
                   </div>`
				: `<div class="reason-box no-reason">
                    <span class="reason-title"><i class="fas fa-tools"></i> Status:</span>
                    <p class="reason-text">O bot está offline no momento ou em processo de reinicialização. A conexão será restabelecida automaticamente em instantes.</p>
                   </div>`;
			html = html.replace("{{MOTIVO}}", reasonHtml);
		}
	} catch (e) {
		console.error("Error reading fallback HTML:", e.message);
	}
	res.end(html);
}

function getReason() {
	try {
		if (fs.existsSync(MOTIVO_FILE)) {
			return fs.readFileSync(MOTIVO_FILE, "utf8").trim();
		}
	} catch (e) {
		// Ignore read errors
	}
	return "";
}

// Log startup and listen
server.listen(PROXY_PORT, "0.0.0.0", () => {
	console.log(
		`[Ravena Fallback Proxy] Running on port ${PROXY_PORT}, proxying to 127.0.0.1:${TARGET_PORT}`
	);
});
