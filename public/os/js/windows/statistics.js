// windows/statistics.js - Statistics window with bot stats table and Highcharts graphs

WindowManager.register('statistics', {
    title: 'Estatísticas de Mensagens e Fluxo',
    taskbarIcon: 'fa-chart-bar',
    width: '820px',
    height: '560px',
    singleton: true,

    render(wb) {
        const body = wb.body;

        body.innerHTML = `
            <div class="stats-window">
                <div>
                    <h3 style="font-size: 12px; color: var(--bright-blue); margin-bottom: 8px; font-family: var(--font-display);">
                        📊 Mensagens Processadas por Bot
                    </h3>
                    <div class="stats-table-wrap">
                        <table class="stats-table" id="os-bot-stats-table">
                            <thead>
                                <tr>
                                    <th>Bot</th>
                                    <th>Grupos</th>
                                    <th>1 Hora</th>
                                    <th>24 Horas</th>
                                    <th>7 Dias</th>
                                    <th>30 Dias</th>
                                    <th>365 Dias</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr><td colspan="7" style="text-align: center; padding: 15px;"><i class="fas fa-spinner fa-spin"></i> Carregando dados da tabela...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <hr class="win-xp-separator">

                <div>
                    <h3 style="font-size: 12px; color: var(--bright-blue); margin-bottom: 8px; font-family: var(--font-display);">
                        📈 Análise Gráfica
                    </h3>
                    <div class="stats-charts-grid">
                        <div class="chart-box" id="os-chart-daily">
                            <div class="chart-box-title">Média de Mensagens do Dia</div>
                            <div style="text-align: center; padding: 40px; font-size: 11px; color: #888;">Carregando gráfico...</div>
                        </div>
                        <div class="chart-box" id="os-chart-weekly">
                            <div class="chart-box-title">Média de Mensagens da Semana</div>
                            <div style="text-align: center; padding: 40px; font-size: 11px; color: #888;">Carregando gráfico...</div>
                        </div>
                        <div class="chart-box" id="os-chart-monthly">
                            <div class="chart-box-title">Média de Mensagens do Mês</div>
                            <div style="text-align: center; padding: 40px; font-size: 11px; color: #888;">Carregando gráfico...</div>
                        </div>
                        <div class="chart-box" id="os-chart-yearly">
                            <div class="chart-box-title">Total de Mensagens por Dia do Ano</div>
                            <div style="text-align: center; padding: 40px; font-size: 11px; color: #888;">Carregando gráfico...</div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        this.loadTableData(body);
        this.loadAnalyticsData(body);
    },

    async loadTableData(body) {
        try {
            const data = await Api.get('/api/bot-stats');
            const tbody = body.querySelector('#os-bot-stats-table tbody');
            if (!tbody) return;

            if (!Array.isArray(data) || data.length === 0) {
                tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 15px;">Nenhum dado disponível.</td></tr>`;
                return;
            }

            tbody.innerHTML = data.map(item => {
                const isTotal = item.id === 'TOTAL';
                const style = isTotal ? 'font-weight: 700; background: rgba(4, 169, 240, 0.15); color: #ffffff;' : '';
                return `
                    <tr style="${style}">
                        <td style="font-weight: 600;">${item.id}</td>
                        <td>${Formatters.number(item.groupsCount)}</td>
                        <td>${Formatters.number(item.hour)}</td>
                        <td>${Formatters.number(item.day)}</td>
                        <td>${Formatters.number(item.week)}</td>
                        <td>${Formatters.number(item.month)}</td>
                        <td>${Formatters.number(item.year)}</td>
                    </tr>
                `;
            }).join('');
        } catch (err) {
            console.error('Error loading bot stats:', err);
            const tbody = body.querySelector('#os-bot-stats-table tbody');
            if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #ff5555; padding: 15px;">Erro: ${err.message}</td></tr>`;
        }
    },

    async loadAnalyticsData(body) {
        if (typeof Highcharts === 'undefined') {
            console.warn('Highcharts not loaded');
            return;
        }

        try {
            const data = await Api.get('/analytics?period=today');
            this.renderHighcharts(body, data);
        } catch (err) {
            console.error('Error loading analytics:', err);
        }
    },

    getCommonHighchartsTheme() {
        return {
            chart: {
                backgroundColor: '#110d29',
                style: { fontFamily: "'JetBrains Mono', monospace" }
            },
            title: { text: null },
            credits: { enabled: false },
            legend: {
                itemStyle: { color: '#b7b7c5', fontSize: '10px' },
                itemHoverStyle: { color: '#ffffff' }
            },
            xAxis: {
                gridLineColor: '#24253a',
                lineColor: '#47486c',
                tickColor: '#47486c',
                labels: { style: { color: '#8888aa', fontSize: '9px' } }
            },
            yAxis: {
                gridLineColor: '#24253a',
                lineColor: '#47486c',
                title: { text: null },
                labels: { style: { color: '#8888aa', fontSize: '9px' } }
            },
            tooltip: {
                backgroundColor: '#1c1542',
                borderColor: '#04a9f0',
                style: { color: '#ffffff', fontSize: '10px' }
            },
            colors: ['#04a9f0', '#ffd700', '#28a745', '#ff6b6b', '#a29bfe', '#00f0ff']
        };
    },

    renderHighcharts(body, data) {
        if (!data) return;
        const theme = this.getCommonHighchartsTheme();

        // 1. Daily Chart
        if (data.daily && body.querySelector('#os-chart-daily')) {
            Highcharts.chart('os-chart-daily', Highcharts.merge(theme, {
                chart: { type: 'column', height: 200 },
                xAxis: { categories: data.daily.hours.map(h => `${h}h`) },
                series: data.daily.series || []
            }));
        }

        // 2. Weekly Chart
        if (data.weekly && body.querySelector('#os-chart-weekly')) {
            Highcharts.chart('os-chart-weekly', Highcharts.merge(theme, {
                chart: { type: 'column', height: 200 },
                xAxis: { categories: data.weekly.days || [] },
                series: data.weekly.series || []
            }));
        }

        // 3. Monthly Chart
        if (data.monthly && body.querySelector('#os-chart-monthly')) {
            Highcharts.chart('os-chart-monthly', Highcharts.merge(theme, {
                chart: { type: 'line', height: 200 },
                xAxis: { categories: data.monthly.days || [] },
                series: data.monthly.series || []
            }));
        }

        // 4. Yearly Chart
        if (data.yearly && body.querySelector('#os-chart-yearly')) {
            Highcharts.chart('os-chart-yearly', Highcharts.merge(theme, {
                chart: { type: 'area', height: 200 },
                xAxis: { categories: data.yearly.dates || [] },
                series: data.yearly.series || []
            }));
        }
    }
});
