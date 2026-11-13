const ScheduledEventService = require("../../services/ScheduledEventService");
const Logger = require("../../utils/Logger");

const logger = new Logger("bot-api-events");

function getCurrentBrtYear() {
	return Number(
		new Intl.DateTimeFormat("en-CA", {
			timeZone: "America/Sao_Paulo",
			year: "numeric"
		}).format(new Date())
	);
}

/**
 * Registra endpoints REST dos Eventos Programados (/api/events/*)
 * @param {import('../../BotAPI')} api
 */
function registerEventsRoutes(api) {
	const app = api.app;
	const scheduledEventService = ScheduledEventService.getInstance();

	/**
	 * Lista pública de eventos do ano selecionado (padrão: ano atual em BRT)
	 */
	app.get("/api/events/public", async (req, res) => {
		try {
			const currentYear = getCurrentBrtYear();
			const rawYear = req.query.year ? String(req.query.year).trim() : String(currentYear);
			const year = /^\d{4}$/.test(rawYear) ? Number(rawYear) : currentYear;

			const [yearEvents, allEvents] = await Promise.all([
				scheduledEventService.listEvents({ year }),
				scheduledEventService.listEvents({})
			]);

			const yearsSet = new Set([currentYear, year]);
			for (const ev of allEvents) {
				const startYear = Number(
					new Intl.DateTimeFormat("en-CA", {
						timeZone: "America/Sao_Paulo",
						year: "numeric"
					}).format(new Date(ev.startTime))
				);
				const endYear = Number(
					new Intl.DateTimeFormat("en-CA", {
						timeZone: "America/Sao_Paulo",
						year: "numeric"
					}).format(new Date(ev.endTime))
				);
				if (Number.isFinite(startYear)) yearsSet.add(startYear);
				if (Number.isFinite(endYear)) yearsSet.add(endYear);
			}

			return res.json({
				ok: true,
				year,
				availableYears: Array.from(yearsSet).sort((a, b) => b - a),
				events: yearEvents,
				catalog: ScheduledEventService.getCatalog(),
				serverTime: Date.now()
			});
		} catch (err) {
			logger.error("Erro em GET /api/events/public:", err);
			return res.status(500).json({ ok: false, error: err.message });
		}
	});

	/**
	 * Lista administrativa completa de eventos programados + catálogo de buffs
	 */
	app.get("/api/events/admin", api.authenticateBasic, async (req, res) => {
		try {
			if (api.isAdmin(req)) api.setAdminSessionCookie(res);
			const rawYear = req.query.year ? String(req.query.year).trim() : "all";
			const year = /^\d{4}$/.test(rawYear) ? Number(rawYear) : null;

			const events = await scheduledEventService.listEvents({ year });
			return res.json({
				ok: true,
				events,
				catalog: ScheduledEventService.getCatalog(),
				serverTime: Date.now()
			});
		} catch (err) {
			logger.error("Erro em GET /api/events/admin:", err);
			return res.status(500).json({ ok: false, error: err.message });
		}
	});

	/**
	 * Criação de evento programado (Admin)
	 */
	app.post("/api/events/admin", api.authenticateBasic, async (req, res) => {
		try {
			if (api.isAdmin(req)) api.setAdminSessionCookie(res);
			const created = await scheduledEventService.createEvent(req.body || {});
			return res.status(201).json({ ok: true, event: created });
		} catch (err) {
			const status = err.statusCode || 500;
			if (status >= 500) {
				logger.error("Erro em POST /api/events/admin:", err);
			}
			return res.status(status).json({ ok: false, error: err.message });
		}
	});

	/**
	 * Edição de evento programado (Admin)
	 */
	app.put("/api/events/admin/:id", api.authenticateBasic, async (req, res) => {
		try {
			if (api.isAdmin(req)) api.setAdminSessionCookie(res);
			const id = Number(req.params.id);
			if (!Number.isInteger(id) || id <= 0) {
				return res.status(400).json({ ok: false, error: "ID de evento inválido." });
			}

			const updated = await scheduledEventService.updateEvent(id, req.body || {});
			return res.json({ ok: true, event: updated });
		} catch (err) {
			const status = err.statusCode || 500;
			if (status >= 500) {
				logger.error("Erro em PUT /api/events/admin/:id:", err);
			}
			return res.status(status).json({ ok: false, error: err.message });
		}
	});

	/**
	 * Exclusão de evento programado (Admin)
	 */
	app.delete("/api/events/admin/:id", api.authenticateBasic, async (req, res) => {
		try {
			if (api.isAdmin(req)) api.setAdminSessionCookie(res);
			const id = Number(req.params.id);
			if (!Number.isInteger(id) || id <= 0) {
				return res.status(400).json({ ok: false, error: "ID de evento inválido." });
			}

			const deleted = await scheduledEventService.deleteEvent(id);
			if (!deleted) {
				return res.status(404).json({ ok: false, error: "Evento não encontrado." });
			}
			return res.json({ ok: true });
		} catch (err) {
			logger.error("Erro em DELETE /api/events/admin/:id:", err);
			return res.status(500).json({ ok: false, error: err.message });
		}
	});

	/**
	 * Gera (e opcionalmente salva) a mensagem formatada de WhatsApp para um evento
	 */
	app.post("/api/events/admin/generate-message", api.authenticateBasic, async (req, res) => {
		try {
			if (api.isAdmin(req)) api.setAdminSessionCookie(res);
			const body = req.body || {};
			let sourcePayload = body;
			let existingEvent = null;

			if (body.id) {
				existingEvent = await scheduledEventService.getEventById(Number(body.id));
				if (!existingEvent) {
					return res.status(404).json({ ok: false, error: "Evento não encontrado." });
				}
				if (!body.name && !body.startTime && !body.endTime) {
					sourcePayload = {
						name: existingEvent.name,
						startTime: existingEvent.startTime,
						endTime: existingEvent.endTime,
						startGrants: existingEvent.startGrants,
						ongoingBuffs: existingEvent.ongoingBuffs,
						message: ""
					};
				}
			}

			const validated = ScheduledEventService.validateEventPayload(
				{ ...sourcePayload, message: "" },
				{ requireTimes: true }
			);
			const generatedMessage = ScheduledEventService.generateWhatsAppMessage(validated);

			if (body.save && existingEvent) {
				const updated = await scheduledEventService.updateEvent(existingEvent.id, {
					name: validated.name,
					startTime: validated.startTime,
					endTime: validated.endTime,
					startGrants: validated.startGrants,
					ongoingBuffs: validated.ongoingBuffs,
					message: generatedMessage
				});
				return res.json({ ok: true, message: generatedMessage, event: updated });
			}

			return res.json({ ok: true, message: generatedMessage });
		} catch (err) {
			const status = err.statusCode || 500;
			if (status >= 500) {
				logger.error("Erro em POST /api/events/admin/generate-message:", err);
			}
			return res.status(status).json({ ok: false, error: err.message });
		}
	});
}

module.exports = registerEventsRoutes;
