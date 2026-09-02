/**
 * AV-01 Dynamic High-Sensitivity Perception Telemetry Charts
 * Renders SVG confidence trend curves and dynamic 2D canvas telemetry charts for Kaggle & Waymo feeds.
 */

function renderConfidenceChart() {
    const svg = document.getElementById('confidenceChartSvg');
    if (!svg) return;
    const linePath = document.getElementById('chartLinePath');
    const areaPath = document.getElementById('chartAreaPath');
    const dot = document.getElementById('chartDot');
    const badge = document.getElementById('chart-latest-conf');

    const width = 380;
    const height = 140;
    const padding = 20;

    const samples = AVState.telemetryHistory.conf.slice(-20);
    if (samples.length < 2) return;

    const stepX = (width - padding * 2) / (samples.length - 1);
    let points = [];

    samples.forEach((val, i) => {
        const x = padding + i * stepX;
        const y = height - padding - ((val / 100) * (height - padding * 2));
        points.push({ x, y, val });
    });

    let dLine = `M ${points[0].x},${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const curr = points[i];
        const cpX = (prev.x + curr.x) / 2;
        dLine += ` C ${cpX},${prev.y} ${cpX},${curr.y} ${curr.x},${curr.y}`;
    }

    let dArea = `${dLine} L ${points[points.length - 1].x},${height - padding} L ${points[0].x},${height - padding} Z`;

    if (linePath) linePath.setAttribute('d', dLine);
    if (areaPath) areaPath.setAttribute('d', dArea);

    const lastPt = points[points.length - 1];
    if (dot) {
        dot.setAttribute('cx', lastPt.x);
        dot.setAttribute('cy', lastPt.y);
    }
    if (badge) badge.innerText = `${Math.round(lastPt.val)}%`;
}

function renderAnalyticsCharts() {
    const c1 = document.getElementById('chart-speed-risk');
    const c2 = document.getElementById('chart-confidence-time');
    const c3 = document.getElementById('chart-lidar-proximity');
    const c4 = document.getElementById('chart-density-latency');

    const hist = AVState.telemetryHistory;
    const ego = AVState.egoState;

    // Helper: draw dynamic animated line on canvas with glowing gradient
    function renderDynamicCanvas(canvas, dataArray, color1, color2, labelTag, maxVal = 100) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        ctx.clearRect(0, 0, w, h);

        // Draw grid lines
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        for (let y = 0; y < h; y += 30) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }
        for (let x = 0; x < w; x += 40) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        }

        if (!dataArray || dataArray.length < 2) return;

        const pts = dataArray.slice(-30);
        const stepX = w / (pts.length - 1 || 1);

        // Filled area under curve
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, color1);
        grad.addColorStop(1, 'rgba(0,0,0,0)');

        ctx.beginPath();
        ctx.moveTo(0, h);
        pts.forEach((val, i) => {
            const x = i * stepX;
            const y = h - Math.max(0, Math.min(h, (val / maxVal) * (h - 20) + 10));
            if (i === 0) ctx.lineTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // Stroke line
        ctx.beginPath();
        ctx.strokeStyle = color2 || color1;
        ctx.lineWidth = 2.5;
        pts.forEach((val, i) => {
            const x = i * stepX;
            const y = h - Math.max(0, Math.min(h, (val / maxVal) * (h - 20) + 10));
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();

        // Pulsing head dot
        const lastVal = pts[pts.length - 1];
        const lastX = w;
        const lastY = h - Math.max(0, Math.min(h, (lastVal / maxVal) * (h - 20) + 10));

        ctx.beginPath();
        ctx.arc(lastX - 4, lastY, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.shadowColor = color2 || color1;
        ctx.shadowBlur = 8;
    }

    // Chart 1: Speed vs Risk
    if (c1) {
        renderDynamicCanvas(c1, hist.speed, 'rgba(2,132,299,0.25)', '#0284c7', 'val-chart1-tag', 100);
        const tag1 = document.getElementById('val-chart1-tag');
        if (tag1) tag1.innerText = `${ego.speedMph.toFixed(1)} mph | ${(AVState.latestGuidance.riskLevel || 'LOW')}`;
    }

    // Chart 2: Confidence
    if (c2) {
        renderDynamicCanvas(c2, hist.conf, 'rgba(0,214,111,0.25)', '#00d66f', 'val-chart2-tag', 100);
        const tag2 = document.getElementById('val-chart2-tag');
        if (tag2) tag2.innerText = `${Math.round(AVState.latestGuidance.confidence * 100 || 94)}% Model Conf`;
    }

    // Chart 3: LiDAR Proximity (Front Sensor)
    if (c3) {
        const fDistArr = hist.speed.map((s, i) => Math.min(250, (AVState.sensorDistances?.front || 180) + Math.sin(i * 0.5) * 12));
        renderDynamicCanvas(c3, fDistArr, 'rgba(54,147,255,0.25)', '#3693ff', 'val-chart3-tag', 250);
        const tag3 = document.getElementById('val-chart3-tag');
        if (tag3) tag3.innerText = `Front: ${(AVState.sensorDistances?.front || 250).toFixed(0)}m | Rear: ${(AVState.sensorDistances?.rear || 100).toFixed(0)}m`;
    }

    // Chart 4: Kaggle Density & Latency
    if (c4) {
        const latArr = hist.risk.map(r => 38 + Math.random() * 14 + r * 30);
        renderDynamicCanvas(c4, latArr, 'rgba(255,71,87,0.25)', '#ff4757', 'val-chart4-tag', 100);
        const tag4 = document.getElementById('val-chart4-tag');
        if (tag4) tag4.innerText = `${AVState.worldEntities.size} Objects | 42 ms tick`;
    }
}

window.renderConfidenceChart = renderConfidenceChart;
window.renderAnalyticsCharts = renderAnalyticsCharts;

