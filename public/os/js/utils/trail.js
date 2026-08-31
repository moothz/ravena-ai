// trail.js - Retro 2000s Cursor Sparkles / Trail Effect

const CursorTrail = {
    canvas: null,
    ctx: null,
    particles: [],
    colors: ['#00f0ff', '#04a9f0', '#a29bfe', '#ffd700', '#ffffff'],
    lastX: 0,
    lastY: 0,

    init() {
        if (window.innerWidth < 768) return; // Skip on mobile

        this.canvas = document.createElement('canvas');
        this.canvas.id = 'cursor-trail-canvas';
        this.canvas.style.position = 'fixed';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.width = '100vw';
        this.canvas.style.height = '100vh';
        this.canvas.style.pointerEvents = 'none';
        this.canvas.style.zIndex = '999999';
        document.body.appendChild(this.canvas);

        this.ctx = this.canvas.getContext('2d');
        this.resize();

        window.addEventListener('resize', () => this.resize());

        let throttle = 0;
        document.addEventListener('mousemove', (e) => {
            const now = Date.now();
            if (now - throttle > 25) { // Spawn particle every ~25ms
                throttle = now;
                this.addParticle(e.clientX, e.clientY);
            }
        });

        this.animate();
    },

    resize() {
        if (this.canvas) {
            this.canvas.width = window.innerWidth;
            this.canvas.height = window.innerHeight;
        }
    },

    addParticle(x, y) {
        const count = 1 + Math.floor(Math.random() * 2);
        for (let i = 0; i < count; i++) {
            this.particles.push({
                x: x + (Math.random() * 8 - 4),
                y: y + (Math.random() * 8 - 4),
                vx: (Math.random() - 0.5) * 1.5,
                vy: (Math.random() - 0.5) * 1.5 - 0.5,
                size: Math.random() * 4 + 2,
                color: this.colors[Math.floor(Math.random() * this.colors.length)],
                alpha: 1,
                life: 1,
                decay: Math.random() * 0.04 + 0.03,
                shape: Math.random() > 0.4 ? 'star' : 'circle'
            });
        }
    },

    drawStar(cx, cy, spikes, outerRadius, innerRadius, color, alpha) {
        let rot = (Math.PI / 2) * 3;
        let x = cx;
        let y = cy;
        const step = Math.PI / spikes;

        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.moveTo(cx, cy - outerRadius);
        for (let i = 0; i < spikes; i++) {
            x = cx + Math.cos(rot) * outerRadius;
            y = cy + Math.sin(rot) * outerRadius;
            this.ctx.lineTo(x, y);
            rot += step;

            x = cx + Math.cos(rot) * innerRadius;
            y = cy + Math.sin(rot) * innerRadius;
            this.ctx.lineTo(x, y);
            rot += step;
        }
        this.ctx.lineTo(cx, cy - outerRadius);
        this.ctx.closePath();
        this.ctx.fillStyle = color;
        this.ctx.globalAlpha = alpha;
        this.ctx.shadowColor = color;
        this.ctx.shadowBlur = 6;
        this.ctx.fill();
        this.ctx.restore();
    },

    animate() {
        if (!this.ctx) return;

        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx;
            p.y += p.vy;
            p.alpha -= p.decay;

            if (p.alpha <= 0) {
                this.particles.splice(i, 1);
                continue;
            }

            if (p.shape === 'star') {
                this.drawStar(p.x, p.y, 4, p.size, p.size * 0.4, p.color, p.alpha);
            } else {
                this.ctx.save();
                this.ctx.beginPath();
                this.ctx.arc(p.x, p.y, p.size * 0.6, 0, Math.PI * 2);
                this.ctx.fillStyle = p.color;
                this.ctx.globalAlpha = p.alpha;
                this.ctx.shadowColor = p.color;
                this.ctx.shadowBlur = 4;
                this.ctx.fill();
                this.ctx.restore();
            }
        }

        requestAnimationFrame(() => this.animate());
    }
};

window.CursorTrail = CursorTrail;
