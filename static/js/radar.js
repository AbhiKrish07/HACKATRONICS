/**
 * AV-01 2D Tesla Top-Down Surround Distance Radar
 * Reads from unified AVState to render 8-directional sonar rays,
 * numeric distance pills, multi-agent footprints, and expanding radar waves.
 */

function render2DRadarCanvas() {
    const canvas = document.getElementById('radarCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Deep Dark Background with Grid
    ctx.fillStyle = '#060a14';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 25) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += 25) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    const centerX = w / 2;
    const centerY = h / 2 + 10;
    const ego = AVState.egoState;

    // Concentric Sonar Range Circles
    const tNow = performance.now() * 0.003;
    const pulseR = (tNow * 45) % 115;
    
    [30, 60, 90, 120].forEach(r => {
        ctx.strokeStyle = 'rgba(54,147,255,0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(centerX, centerY, r, 0, Math.PI * 2); ctx.stroke();
    });

    // Expanding Sonar Wave
    ctx.strokeStyle = 'rgba(0,214,111,0.25)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(centerX, centerY, pulseR, 0, Math.PI * 2); ctx.stroke();

    // 8 Directional Sonar Rays
    const angles = [
        { name: 'FRONT', rad: -Math.PI / 2, dx: 0, dy: -1 },
        { name: 'FL', rad: -Math.PI * 0.75, dx: -0.707, dy: -0.707 },
        { name: 'FR', rad: -Math.PI * 0.25, dx: 0.707, dy: -0.707 },
        { name: 'LEFT', rad: Math.PI, dx: -1, dy: 0 },
        { name: 'RIGHT', rad: 0, dx: 1, dy: 0 },
        { name: 'RL', rad: Math.PI * 0.75, dx: -0.707, dy: 0.707 },
        { name: 'RR', rad: Math.PI * 0.25, dx: 0.707, dy: 0.707 },
        { name: 'REAR', rad: Math.PI / 2, dx: 0, dy: 1 }
    ];

    const distances = { FRONT: 99, FL: 99, FR: 99, LEFT: 99, RIGHT: 99, RL: 99, RR: 99, REAR: 99 };

    for (const [id, e] of AVState.worldEntities.entries()) {
        const d = e.getDistanceToEgo();
        const relX = e.posX - ego.x;
        if (d >= 0 && d < 60) {
            if (Math.abs(relX) < 2.0 && d < distances.FRONT) distances.FRONT = d;
            else if (relX < -1.5 && d < 35 && d < distances.FL) distances.FL = d;
            else if (relX > 1.5 && d < 35 && d < distances.FR) distances.FR = d;
        } else if (d < 0 && Math.abs(d) < 40) {
            if (Math.abs(relX) < 2.0 && Math.abs(d) < distances.REAR) distances.REAR = Math.abs(d);
            else if (relX < -1.5 && Math.abs(d) < distances.RL) distances.RL = Math.abs(d);
            else if (relX > 1.5 && Math.abs(d) < distances.RR) distances.RR = Math.abs(d);
        }
        if (Math.abs(d) < 25) {
            if (relX < -1.5 && Math.abs(relX) < distances.LEFT) distances.LEFT = Math.abs(relX) * 3;
            if (relX > 1.5 && Math.abs(relX) < distances.RIGHT) distances.RIGHT = Math.abs(relX) * 3;
        }
    }

    // Baselines if sector empty
    if (distances.FRONT === 99) distances.FRONT = 18.4 + Math.sin(tNow * 2) * 1.5;
    if (distances.FL === 99) distances.FL = 8.2 + Math.cos(tNow * 1.5) * 0.8;
    if (distances.FR === 99) distances.FR = 6.5 + Math.sin(tNow * 1.8) * 0.9;
    if (distances.LEFT === 99) distances.LEFT = 3.4 + Math.sin(tNow * 2.5) * 0.4;
    if (distances.RIGHT === 99) distances.RIGHT = 2.8 + Math.cos(tNow * 2.2) * 0.5;
    if (distances.RL === 99) distances.RL = 7.5;
    if (distances.RR === 99) distances.RR = 8.1;
    if (distances.REAR === 99) distances.REAR = 12.0 + Math.sin(tNow * 1.2) * 2.0;

    // Render 8 Directional Rays & Arcs
    angles.forEach(dir => {
        const distVal = distances[dir.name];
        const maxLen = 95;
        const lineLen = Math.min(maxLen, Math.max(25, distVal * 3.2));

        const endX = centerX + dir.dx * lineLen;
        const endY = centerY + dir.dy * lineLen;

        const color = distVal < 2.5 ? '#e82127' : distVal < 6.0 ? '#ffb020' : '#00d66f';

        // Ray line
        ctx.strokeStyle = color;
        ctx.lineWidth = distVal < 2.5 ? 2.5 : 1.5;
        ctx.setLineDash(distVal < 2.5 ? [4, 2] : []);
        ctx.beginPath(); ctx.moveTo(centerX, centerY); ctx.lineTo(endX, endY); ctx.stroke();
        ctx.setLineDash([]);

        // Proximity Arc
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(centerX, centerY, lineLen, dir.rad - 0.2, dir.rad + 0.2);
        ctx.stroke();

        // Distance Callout Badge Pill
        const pillX = centerX + dir.dx * (lineLen + 14);
        const pillY = centerY + dir.dy * (lineLen + 14);
        ctx.fillStyle = 'rgba(10,14,24,0.92)';
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.fillRect(pillX - 18, pillY - 8, 36, 16);
        ctx.strokeRect(pillX - 18, pillY - 8, 36, 16);

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${distVal.toFixed(1)}m`, pillX, pillY);
    });

    // Ego Car Silhouette graphic in center (Tesla Model style)
    ctx.shadowColor = '#3693ff';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(centerX - 12, centerY - 22, 24, 44, 5);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Roof glass
    ctx.fillStyle = '#111827';
    ctx.beginPath();
    ctx.roundRect(centerX - 9, centerY - 14, 18, 26, 3);
    ctx.fill();

    // Headlights & Taillights
    ctx.fillStyle = '#1cd0ff';
    ctx.fillRect(centerX - 10, centerY - 21, 5, 2);
    ctx.fillRect(centerX + 5, centerY - 21, 5, 2);
    ctx.fillStyle = '#e82127';
    ctx.fillRect(centerX - 10, centerY + 20, 5, 2);
    ctx.fillRect(centerX + 5, centerY + 20, 5, 2);

    // Draw Multi-Agent Entities on 2D Radar
    for (const [id, e] of AVState.worldEntities.entries()) {
        const d = e.getDistanceToEgo();
        const relX = e.posX - ego.x;
        if (Math.abs(d) < 70 && Math.abs(relX) < 15) {
            const ex = centerX + (relX / 10.0) * 80;
            const ey = centerY - (d / 70.0) * 90;
            const col = Math.abs(d) < 15 ? '#e82127' : '#ffb020';

            ctx.fillStyle = col;
            ctx.shadowColor = col;
            ctx.shadowBlur = 6;
            ctx.fillRect(ex - 6, ey - 10, 12, 20);
            ctx.shadowBlur = 0;

            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 8px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(`${Math.abs(d).toFixed(0)}m`, ex, ey - 12);
        }
    }
}

window.render2DRadarCanvas = render2DRadarCanvas;
