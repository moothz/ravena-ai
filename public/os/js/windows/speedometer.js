// windows/speedometer.js - Mensagímetro (Analog Gauge Speedometer for live message throughput)

WindowManager.register('speedometer', {
    title: 'Mensagímetro — Fluxo em Tempo Real',
    taskbarIcon: 'fa-gauge-high',
    width: '460px',
    height: '440px',
    singleton: true,

    render(wb) {
        const body = wb.body;

        body.innerHTML = `
            <div class="speedometer-view">
                <canvas id="speedometer-canvas" width="360" height="240"></canvas>
                <div class="speedometer-readout">
                    <div class="speedometer-val" id="speedo-digital-val">0</div>
                    <div class="speedometer-lbl">mensagens processadas / hora</div>
                    <div style="font-size: 11px; color: #8888aa; margin-top: 4px;" id="speedo-avg-val">
                        Média recente: 0 msgs/h &nbsp;|&nbsp; Pico: 0 msgs/h
                    </div>
                </div>
            </div>
        `;

        const canvas = body.querySelector('#speedometer-canvas');
        const digitalValEl = body.querySelector('#speedo-digital-val');
        const avgValEl = body.querySelector('#speedo-avg-val');

        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        let targetVal = 0;
        let currentVal = 0;
        let peakVal = 0;
        let animFrame = null;
        const maxVal = 30000;

        const drawGauge = (val) => {
            const width = canvas.width;
            const height = canvas.height;
            const cx = width / 2;
            const cy = height - 30;
            const radius = 130;

            ctx.clearRect(0, 0, width, height);

            const startAngle = Math.PI * 0.85;
            const endAngle = Math.PI * 2.15;
            const totalAngle = endAngle - startAngle;

            // Background arc
            ctx.beginPath();
            ctx.arc(cx, cy, radius, startAngle, endAngle);
            ctx.lineWidth = 14;
            ctx.strokeStyle = '#141030';
            ctx.lineCap = 'round';
            ctx.stroke();

            // Colored arc
            const gradient = ctx.createLinearGradient(cx - radius, cy, cx + radius, cy);
            gradient.addColorStop(0, '#28a745');
            gradient.addColorStop(0.35, '#04a9f0');
            gradient.addColorStop(0.65, '#f6ad55');
            gradient.addColorStop(0.9, '#e53e3e');
            gradient.addColorStop(1, '#a29bfe');

            const clampedVal = Math.min(maxVal, Math.max(0, val));
            const progress = clampedVal / maxVal;
            const currentAngle = startAngle + totalAngle * progress;

            ctx.beginPath();
            ctx.arc(cx, cy, radius, startAngle, currentAngle);
            ctx.lineWidth = 14;
            ctx.strokeStyle = gradient;
            ctx.lineCap = 'round';
            ctx.stroke();

            // Ticks and numbers
            const numTicks = 10;
            for (let i = 0; i <= numTicks; i++) {
                const tickProgress = i / numTicks;
                const angle = startAngle + totalAngle * tickProgress;
                const isMajor = i % 2 === 0;

                const innerR = radius - (isMajor ? 20 : 12);
                const outerR = radius - 6;

                const x1 = cx + Math.cos(angle) * innerR;
                const y1 = cy + Math.sin(angle) * innerR;
                const x2 = cx + Math.cos(angle) * outerR;
                const y2 = cy + Math.sin(angle) * outerR;

                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.lineWidth = isMajor ? 2 : 1;
                ctx.strokeStyle = isMajor ? '#04a9f0' : '#47486c';
                ctx.stroke();

                // Numbers for major ticks
                if (isMajor) {
                    const textR = radius - 32;
                    const tx = cx + Math.cos(angle) * textR;
                    const ty = cy + Math.sin(angle) * textR;
                    const tickVal = Math.round((i * (maxVal / numTicks)) / 1000);

                    ctx.font = "bold 10px 'JetBrains Mono', monospace";
                    ctx.fillStyle = '#8888aa';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(`${tickVal}k`, tx, ty);
                }
            }

            // Needle
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(currentAngle);

            ctx.beginPath();
            ctx.moveTo(0, -5);
            ctx.lineTo(radius - 15, 0);
            ctx.lineTo(0, 5);
            ctx.fillStyle = '#00f0ff';
            ctx.shadowColor = '#00f0ff';
            ctx.shadowBlur = 10;
            ctx.fill();

            // Center pivot
            ctx.beginPath();
            ctx.arc(0, 0, 8, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();

            ctx.restore();
        };

        const updateAnimation = () => {
            currentVal += (targetVal - currentVal) * 0.1;
            if (Math.abs(targetVal - currentVal) < 1) currentVal = targetVal;

            drawGauge(currentVal);

            digitalValEl.textContent = Math.round(currentVal).toLocaleString('pt-BR');

            if (currentVal > peakVal) peakVal = Math.round(currentVal);
            const avg = window.RavenaOS ? window.RavenaOS.state.averageMsgsHr : 0;
            avgValEl.innerHTML = `Média: ${Math.round(avg).toLocaleString('pt-BR')} msgs/h &nbsp;|&nbsp; Pico: ${peakVal.toLocaleString('pt-BR')} msgs/h`;

            if (currentVal !== targetVal) {
                animFrame = requestAnimationFrame(updateAnimation);
            }
        };

        const onRateUpdate = (rate) => {
            targetVal = rate;
            cancelAnimationFrame(animFrame);
            updateAnimation();
        };

        // Initial draw
        if (window.RavenaOS) {
            const count = window.RavenaOS.state.messageTimestamps ? window.RavenaOS.state.messageTimestamps.length : 0;
            targetVal = count * 60;
            updateAnimation();
            window.RavenaOS.on('realtimeRate', onRateUpdate);
        } else {
            drawGauge(0);
        }

        wb.onclose = () => {
            cancelAnimationFrame(animFrame);
            return false;
        };
    }
});
