const { CATEGORY_EMOJIS, COMMAND_ORDER } = require("../../functions/MenuOrder");
const CommandsHelper = require("../../utils/CommandsHelper");

/**
 * Funções auxiliares para cálculo, agregação e cache de dados analíticos e comandos públicos
 */

function processDailyDataAggregated(rows) {
	const hourSums = Array(24).fill(0);
	const hourCounts = Array(24).fill(0);

	for (const row of rows) {
		const hour = new Date(row.hourKey).getHours();
		hourSums[hour] += row.totalMessages;
		hourCounts[hour]++;
	}

	return {
		values: hourSums.map((sum, i) => (hourCounts[i] > 0 ? Math.round(sum / hourCounts[i]) : 0))
	};
}

function processWeeklyDataAggregated(rows) {
	const dailyTotals = {};
	for (const row of rows) {
		if (!dailyTotals[row.dateKey]) dailyTotals[row.dateKey] = 0;
		dailyTotals[row.dateKey] += row.totalMessages;
	}

	const daySums = Array(7).fill(0);
	const dayCounts = Array(7).fill(0);

	for (const [dateKey, total] of Object.entries(dailyTotals)) {
		const dayOfWeek = new Date(dateKey + "T00:00:00Z").getUTCDay();
		daySums[dayOfWeek] += total;
		dayCounts[dayOfWeek]++;
	}

	return {
		values: daySums.map((sum, i) => (dayCounts[i] > 0 ? Math.round(sum / dayCounts[i]) : 0))
	};
}

function processMonthlyDataAggregated(rows) {
	const daySums = Array(31).fill(0);
	const dayCounts = Array(31).fill(0);

	for (const row of rows) {
		const day = parseInt(row.dayOfMonth, 10) - 1;
		if (day >= 0 && day < 31) {
			daySums[day] += row.totalMessages;
			dayCounts[day]++;
		}
	}

	return {
		values: daySums.map((sum, i) => (dayCounts[i] > 0 ? Math.round(sum / dayCounts[i]) : 0))
	};
}

function processYearlyDataAggregated(rows) {
	const dailyTotals = {};
	for (const row of rows) {
		if (!dailyTotals[row.dateKey]) dailyTotals[row.dateKey] = 0;
		dailyTotals[row.dateKey] += row.totalMessages;
	}

	const dates = Object.keys(dailyTotals).sort();
	const values = dates.map((d) => dailyTotals[d]);

	return { dates, values };
}

async function updateBotStatsCache(api) {
	if (api.isUpdatingBotStats) {
		api.logger.warn("Atualização de cache de estatísticas de bots já em andamento, pulando...");
		return;
	}

	api.isUpdatingBotStats = true;
	try {
		api.logger.info("Atualizando cache de estatísticas detalhadas dos bots...");
		const now = Date.now();
		const periods = {
			year: now - 365 * 24 * 60 * 60 * 1000,
			month: now - 30 * 24 * 60 * 60 * 1000,
			week: now - 7 * 24 * 60 * 60 * 1000,
			day: now - 24 * 60 * 60 * 1000,
			hour: now - 60 * 60 * 1000
		};

		const statsData = [];
		const botsAtivos = api.bots.filter((b) => !b.privado && !b.useTelegram && !b.useDiscord);

		const totalStats = {
			id: "TOTAL",
			groupsCount: 0,
			year: 0,
			month: 0,
			week: 0,
			day: 0,
			hour: 0
		};

		for (const bot of botsAtivos) {
			try {
				const groups = await bot.listGroups();
				const groupsCount = groups ? groups.length : 0;

				const periodPromises = Object.entries(periods).map(async ([key, startDate]) => {
					const stats = await bot.loadReport.getStatistics({
						startDate,
						endDate: now,
						botId: bot.id
					});

					let finalTotal = stats.totalMessages;

					if (key === "year" && stats.totalMessages > 0 && stats.firstReportTimestamp) {
						const daysAvailable = (now - stats.firstReportTimestamp) / (24 * 60 * 60 * 1000);

						if (daysAvailable > 1 && daysAvailable < 365) {
							const avgPerDay = stats.totalMessages / daysAvailable;
							const missingDays = 365 - daysAvailable;
							const extrapolated = stats.totalMessages + avgPerDay * missingDays * 1.0;
							finalTotal = Math.round(extrapolated);
						}
					}

					return {
						period: key,
						totalMessages: finalTotal
					};
				});

				const periodResults = await Promise.all(periodPromises);
				const botPeriodStats = {};
				periodResults.forEach((result) => {
					botPeriodStats[result.period] = result.totalMessages;
					totalStats[result.period] += result.totalMessages;
				});

				statsData.push({
					id: bot.id,
					groupsCount,
					year: botPeriodStats.year,
					month: botPeriodStats.month,
					week: botPeriodStats.week,
					day: botPeriodStats.day,
					hour: botPeriodStats.hour
				});

				totalStats.groupsCount += groupsCount;
			} catch (error) {
				api.logger.error(`Erro ao processar stats para bot ${bot.id}:`, error);
				statsData.push({
					id: bot.id,
					groupsCount: 0,
					year: 0,
					month: 0,
					week: 0,
					day: 0,
					hour: 0
				});
			}
		}

		statsData.push(totalStats);

		api.botStatsCache = {
			lastUpdate: now,
			cacheTime: 30 * 60000,
			data: statsData
		};

		api.logger.info("Cache de estatísticas detalhadas atualizado.");
	} catch (err) {
		api.logger.error("Erro durante updateBotStatsCache:", err);
	} finally {
		api.isUpdatingBotStats = false;
	}
}

function updatePublicCommandsCache(api) {
	try {
		if (!api.bots || api.bots.length === 0) return null;
		const bot = api.bots[0];
		if (!bot?.eventHandler?.commandHandler?.fixedCommands) return null;

		const fixedCommands = bot.eventHandler.commandHandler.fixedCommands.getAllCommands();

		const groupCommandsByCategory = (commands) => {
			const categories = {};
			Object.keys(CATEGORY_EMOJIS).forEach((category) => {
				categories[category] = [];
			});

			for (const cmd of commands) {
				if (cmd.hidden) continue;
				let category = cmd.category?.toLowerCase() ?? "resto";
				if (category.length < 1) category = "resto";
				if (!categories[category]) categories[category] = [];
				categories[category].push(cmd);
			}
			return categories;
		};

		const groupRelatedCommands = (commands) => {
			const groupedCommands = [];
			const groups = {};
			for (const cmd of commands) {
				if (cmd.group) {
					if (!groups[cmd.group]) groups[cmd.group] = [];
					groups[cmd.group].push(cmd);
				} else {
					groupedCommands.push([cmd]);
				}
			}
			for (const groupName in groups) {
				if (groups[groupName].length > 0) {
					groups[groupName].sort((a, b) => a.name.localeCompare(b.name));
					groupedCommands.push(groups[groupName]);
				}
			}
			return groupedCommands;
		};

		const sortCommands = (commands) =>
			commands.sort((a, b) => {
				const cmdA = Array.isArray(a) ? a[0] : a;
				const cmdB = Array.isArray(b) ? b[0] : b;
				const indexA = COMMAND_ORDER.indexOf(cmdA.name);
				const indexB = COMMAND_ORDER.indexOf(cmdB.name);
				if (indexA !== -1 && indexB !== -1) return indexA - indexB;
				if (indexA !== -1) return -1;
				if (indexB !== -1) return 1;
				return cmdA.name.localeCompare(cmdB.name);
			});

		const categorizedCommands = groupCommandsByCategory(fixedCommands);
		const finalCategories = [];
		const commandsHelper = CommandsHelper.getInstance();

		for (const category in CATEGORY_EMOJIS) {
			const commands = categorizedCommands[category] || [];
			if (commands.length === 0) continue;

			const grouped = groupRelatedCommands(commands);
			const sorted = sortCommands(grouped);

			const categoryData = {
				name: category.charAt(0).toUpperCase() + category.slice(1),
				emoji: CATEGORY_EMOJIS[category],
				commands: []
			};

			if (categoryData.name.length < 4) categoryData.name = categoryData.name.toUpperCase();

			for (const item of sorted) {
				const cmd = Array.isArray(item) ? item[0] : item;
				let aliases = [];
				if (Array.isArray(item)) {
					item.forEach((c) => {
						if (c.name !== cmd.name) aliases.push(c.name);
						if (c.aliases) aliases.push(...c.aliases);
					});
				} else {
					if (cmd.aliases) aliases = cmd.aliases;
				}

				aliases = [...new Set(aliases)];
				const meta = commandsHelper.findCommandMeta(cmd.name);
				const usage =
					meta?.usage && meta.usage.length > 0
						? meta.usage
						: cmd.usage
							? Array.isArray(cmd.usage)
								? cmd.usage
								: [cmd.usage]
							: [`!${cmd.name}`];

				categoryData.commands.push({
					name: cmd.name,
					description: cmd.description || meta?.desc || "Sem descrição.",
					aliases,
					reaction: cmd.reactions?.trigger || null,
					usage,
					examples: usage,
					about: meta?.about || "",
					category: cmd.category || category,
					isManagement: false
				});
			}
			finalCategories.push(categoryData);
		}

		const managementCommands =
			bot.eventHandler.commandHandler.management?.getManagementCommands() || {};
		const sortedMgmtKeys = Object.keys(managementCommands).sort((a, b) => {
			const indexA = COMMAND_ORDER.indexOf(a);
			const indexB = COMMAND_ORDER.indexOf(b);
			if (indexA !== -1 && indexB !== -1) return indexA - indexB;
			if (indexA !== -1) return -1;
			if (indexB !== -1) return 1;
			return a.localeCompare(b);
		});

		const sortedMgmt = {};
		sortedMgmtKeys.forEach((key) => {
			const mgmtCmd = managementCommands[key];
			const meta =
				commandsHelper.findCommandMeta(`g-${key}`) || commandsHelper.findCommandMeta(key);
			const usage =
				meta?.usage && meta.usage.length > 0
					? meta.usage
					: mgmtCmd?.usage
						? Array.isArray(mgmtCmd.usage)
							? mgmtCmd.usage
							: [mgmtCmd.usage]
						: [`!g-${key}`];

			sortedMgmt[key] = {
				name: `g-${key}`,
				description: mgmtCmd?.description || meta?.desc || "Comando de administração do grupo.",
				aliases: mgmtCmd?.aliases || [],
				usage,
				examples: usage,
				about: meta?.about || "Configuração e moderação de grupos",
				category: meta?.category || "gerenciamento",
				isManagement: true
			};
		});

		api.publicCommandsCache = {
			categories: finalCategories,
			management: sortedMgmt
		};
		api.publicCommandsLastUpdate = Date.now();
		return api.publicCommandsCache;
	} catch (error) {
		api.logger.error("Erro ao atualizar cache de comandos públicos:", error);
		return null;
	}
}

async function updateAnalyticsCache(api) {
	if (api.isUpdatingAnalytics) {
		api.logger.warn("Atualização de cache de dados analíticos já em andamento, pulando...");
		return;
	}

	api.isUpdatingAnalytics = true;
	try {
		api.logger.info("Atualizando cache de dados analíticos (otimizado)...");

		const yearStart = new Date();
		yearStart.setDate(yearStart.getDate() - 370);

		const aggregatedData = await api.database.getAggregatedLoadReports(yearStart.getTime());

		if (!aggregatedData || aggregatedData.length === 0) {
			api.logger.warn("Nenhum dado analítico encontrado para processamento");
			api.analyticsCache.lastUpdate = Date.now();
			return;
		}

		const botDataGroups = {};
		for (const row of aggregatedData) {
			if (!botDataGroups[row.botId]) {
				botDataGroups[row.botId] = [];
			}
			botDataGroups[row.botId].push(row);
		}

		for (const botId of Object.keys(botDataGroups)) {
			const botRows = botDataGroups[botId];
			api.analyticsCache.daily[botId] = processDailyDataAggregated(botRows);
			api.analyticsCache.weekly[botId] = processWeeklyDataAggregated(botRows);
			api.analyticsCache.monthly[botId] = processMonthlyDataAggregated(botRows);
			api.analyticsCache.yearly[botId] = processYearlyDataAggregated(botRows);
			await new Promise((resolve) => setImmediate(resolve));
		}

		const yearlyDates = new Set();
		for (const data of Object.values(api.analyticsCache.yearly)) {
			if (data && data.dates) {
				for (const date of data.dates) {
					yearlyDates.add(date);
				}
			}
		}

		const sortedDates = Array.from(yearlyDates).sort();

		for (const botId of Object.keys(api.analyticsCache.yearly)) {
			const botData = api.analyticsCache.yearly[botId];
			if (botData) {
				const newValues = [];
				const dateValueMap = {};

				if (botData.dates && botData.values) {
					for (let i = 0; i < botData.dates.length; i++) {
						dateValueMap[botData.dates[i]] = botData.values[i] ?? 0;
					}
				}

				for (const date of sortedDates) {
					newValues.push(dateValueMap[date] ?? 0);
				}

				api.analyticsCache.yearly[botId] = {
					dates: sortedDates,
					values: newValues
				};
			}
			await new Promise((resolve) => setImmediate(resolve));
		}

		api.analyticsCache.lastUpdate = Date.now();
		api.logger.info("Cache de dados analíticos atualizado com sucesso");
	} catch (error) {
		api.logger.error("Erro ao atualizar cache de dados analíticos:", error);
	} finally {
		api.isUpdatingAnalytics = false;
	}
}

function filterAnalyticsData(api, period, selectedBots) {
	try {
		const result = {
			status: "ok",
			timestamp: Date.now(),
			daily: {},
			weekly: {},
			monthly: {},
			yearly: {}
		};

		const processMonthly = () => {
			const botStats = api.botStatsCache.data;
			const filteredStats = botStats.filter((b) => selectedBots.includes(b.id) && b.id !== "TOTAL");

			const categories = filteredStats.map((b) => b.id);
			const data = filteredStats.map((b) => b.week || 0);

			return {
				days: categories,
				series: [
					{
						name: "Msgs na Semana",
						data
					}
				]
			};
		};

		const processData = (periodKey) => {
			if (periodKey === "monthly") return processMonthly();

			const periodData = api.analyticsCache[periodKey];
			let combinedValues = null;
			let dates = null;

			selectedBots.forEach((botId) => {
				if (periodData[botId] && periodData[botId].values) {
					const values = periodData[botId].values;

					if (periodKey === "yearly" && !dates && periodData[botId].dates) {
						dates = periodData[botId].dates;
					}

					if (!combinedValues) {
						combinedValues = [...values];
					} else {
						for (let i = 0; i < combinedValues.length; i++) {
							combinedValues[i] += values[i] || 0;
						}
					}
				}
			});

			let seriesName = "Total";
			switch (periodKey) {
				case "daily":
					seriesName = "Média Msgs/Hora";
					break;
				case "weekly":
					seriesName = "Média Msgs/Dia";
					break;
				case "yearly":
					seriesName = "Msgs no ano";
					break;
			}

			if (periodKey === "yearly" && dates && combinedValues) {
				const currentYear = new Date().getFullYear();
				const currentMonth = new Date().getMonth();

				const currentYearData = [];
				for (let i = 0; i < dates.length; i++) {
					if (dates[i].startsWith(currentYear)) {
						currentYearData.push({ date: dates[i], value: combinedValues[i] });
					}
				}

				const finalCategories = [];
				const dailySeriesData = [];
				const monthlySeriesData = [];

				const monthNames = [
					"Janeiro",
					"Fevereiro",
					"Março",
					"Abril",
					"Maio",
					"Junho",
					"Julho",
					"Agosto",
					"Setembro",
					"Outubro",
					"Novembro",
					"Dezembro"
				];

				if (currentMonth <= 2) {
					currentYearData.forEach((item) => {
						const parts = item.date.split("-");
						finalCategories.push(`${parts[2]}/${parts[1]}`);
						dailySeriesData.push(item.value);
						monthlySeriesData.push(null);
					});
				} else {
					const cutoffMonthIndex = currentMonth - 1;
					const monthlyTotals = {};

					currentYearData.forEach((item) => {
						const d = new Date(item.date + "T12:00:00");
						const mIdx = d.getMonth();

						if (mIdx < cutoffMonthIndex) {
							if (!monthlyTotals[mIdx]) monthlyTotals[mIdx] = 0;
							monthlyTotals[mIdx] += item.value;
						}
					});

					for (let i = 0; i < cutoffMonthIndex; i++) {
						if (monthlyTotals[i] !== undefined) {
							finalCategories.push(monthNames[i]);
							monthlySeriesData.push(monthlyTotals[i]);
							dailySeriesData.push(null);
						}
					}

					currentYearData.forEach((item) => {
						const d = new Date(item.date + "T12:00:00");
						const mIdx = d.getMonth();
						if (mIdx >= cutoffMonthIndex) {
							const parts = item.date.split("-");
							finalCategories.push(`${parts[2]}/${parts[1]}`);
							dailySeriesData.push(item.value);
							monthlySeriesData.push(null);
						}
					});
				}

				return {
					dates: finalCategories,
					series: [
						{
							name: "Total Mensal",
							type: "column",
							data: monthlySeriesData,
							color: "#3e0ea7",
							yAxis: 0
						},
						{
							name: "Total Diário",
							type: "areaspline",
							data: dailySeriesData,
							color: "#04a9f0",
							yAxis: 0
						}
					]
				};
			}

			const seriesData = [
				{
					name: seriesName,
					data: combinedValues || []
				}
			];

			return {
				hours: periodKey === "daily" ? Array.from({ length: 24 }, (_, i) => i) : null,
				days:
					periodKey === "weekly"
						? ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"]
						: null,
				dates: periodKey === "yearly" ? (dates ?? []) : null,
				values: null,
				series: seriesData
			};
		};

		result.daily = processData("daily");
		result.weekly = processData("weekly");
		result.monthly = processData("monthly");
		result.yearly = processData("yearly");

		return result;
	} catch (error) {
		api.logger.error("Erro ao filtrar dados analíticos:", error);
		return {
			status: "error",
			message: "Erro ao filtrar dados analíticos",
			timestamp: Date.now()
		};
	}
}

module.exports = {
	processDailyDataAggregated,
	processWeeklyDataAggregated,
	processMonthlyDataAggregated,
	processYearlyDataAggregated,
	updateBotStatsCache,
	updatePublicCommandsCache,
	updateAnalyticsCache,
	filterAnalyticsData
};
