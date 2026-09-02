/**
 * AV-01 4-Channel Live Camera Vision Renderer
 *
 * Renders to TWO sets of canvas elements:
 *   Dashboard thumbnails: camThumbFront, camThumbRear, camThumbLeft, camThumbRight
 *   Camera page full-view: camPageFront, camPageLeft, camPageRight, camPageRear
 *
 * Both sets use the same rendering logic — driven by AVState.worldEntities.
 */

function renderCameraView(ctx, w, h, angle, t, ego) {
    ctx.clearRect(0, 0, w, h);

    // Sky & Ground
    const skyGrad = ctx.createLinearGradient(0, 0, 0, h * 0.45);
    skyGrad.addColorStop(0, '#040814');
    skyGrad.addColorStop(1, '#0f1828');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, w, h * 0.45);

    const gndGrad = ctx.createLinearGradient(0, h * 0.45, 0, h);
    gndGrad.addColorStop(0, '#111827');
    gndGrad.addColorStop(1, '#070b12');
    ctx.fillStyle = gndGrad;
    ctx.fillRect(0, h * 0.45, w, h * 0.55);

    const horizonY = h * 0.45;
    const vpX = w / 2;

    // Horizon line
    ctx.strokeStyle = 'rgba(54,147,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, horizonY); ctx.lineTo(w, horizonY); ctx.stroke();

    // Lane markings per angle
    if (angle === 'front') {
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(vpX - 6, horizonY); ctx.lineTo(15, h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(vpX + 6, horizonY); ctx.lineTo(w - 15, h); ctx.stroke();
        // Centre dashes
        const dashOff = (t * 60) % 18;
        ctx.setLineDash([4, 6]);
        ctx.lineDashOffset = -dashOff;
        ctx.strokeStyle = 'rgba(250,204,21,0.35)';
        ctx.beginPath(); ctx.moveTo(vpX, horizonY); ctx.lineTo(w * 0.5, h); ctx.stroke();
        ctx.setLineDash([]);
    } else if (angle === 'left') {
        ctx.strokeStyle = 'rgba(255,255,255,0.14)';
        ctx.lineWidth = 1.5;
        const so = (t * 50) % 30;
        for (let i = -1; i < 4; i++) {
            const lx = (i * 45 + so);
            ctx.beginPath(); ctx.moveTo(lx, horizonY); ctx.lineTo(lx - 20, h); ctx.stroke();
        }
    } else if (angle === 'right') {
        ctx.strokeStyle = 'rgba(255,255,255,0.14)';
        ctx.lineWidth = 1.5;
        const so = (t * 50) % 30;
        for (let i = -1; i < 4; i++) {
            const rx = w - (i * 45 + so);
            ctx.beginPath(); ctx.moveTo(rx, horizonY); ctx.lineTo(rx + 20, h); ctx.stroke();
        }
    } else if (angle === 'rear') {
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(vpX - 6, horizonY); ctx.lineTo(25, h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(vpX + 6, horizonY); ctx.lineTo(w - 25, h); ctx.stroke();
    }

    // Radar scanline
    const scanY = (t * 80) % h;
    ctx.strokeStyle = 'rgba(28,208,255,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, scanY); ctx.lineTo(w, scanY); ctx.stroke();

    // Multi-agent entity bounding boxes
    for (const [id, e] of AVState.worldEntities.entries()) {
        const dist = e.getDistanceToEgo();
        const relX = e.posX - ego.x;
        let inView = false;

        if (angle === 'front' && dist > 2.0 && dist < 90.0 && Math.abs(relX) < 12) inView = true;
        else if (angle === 'left' && relX < -1.0 && Math.abs(dist) < 50.0) inView = true;
        else if (angle === 'right' && relX > 1.0 && Math.abs(dist) < 50.0) inView = true;
        else if (angle === 'rear' && dist < -2.0 && Math.abs(dist) < 70.0) inView = true;

        if (!inView) continue;

        const projX = (angle === 'front' || angle === 'rear')
            ? vpX + (relX / 10.0) * (w * 0.38)
            : angle === 'left'
                ? w * 0.35 + (Math.abs(dist) / 50.0) * (w * 0.4)
                : w * 0.65 - (Math.abs(dist) / 50.0) * (w * 0.4);

        const projY = horizonY + (1.0 - Math.min(1.0, Math.abs(dist) / 80.0)) * (h - horizonY - 12);
        const boxW = Math.max(10, 36 - Math.abs(dist) * 0.3);
        const boxH = boxW * 1.2;

        const color = Math.abs(dist) < 18.0 ? '#e82127' : Math.abs(dist) < 40.0 ? '#ffb020' : '#10b981';

        // Bounding reticle
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(projX - boxW / 2, projY - boxH / 2, boxW, boxH);
        ctx.fillStyle = color + '18';
        ctx.fillRect(projX - boxW / 2, projY - boxH / 2, boxW, boxH);

        // Corner brackets for premium look
        const cs = 5;
        ctx.lineWidth = 2;
        [[projX - boxW/2, projY - boxH/2, 1, 1], [projX + boxW/2, projY - boxH/2, -1, 1],
         [projX - boxW/2, projY + boxH/2, 1, -1], [projX + boxW/2, projY + boxH/2, -1, -1]].forEach(([cx, cy, dx, dy]) => {
            ctx.beginPath();
            ctx.moveTo(cx + dx * cs, cy);
            ctx.lineTo(cx, cy);
            ctx.lineTo(cx, cy + dy * cs);
            ctx.stroke();
        });

        // Distance tag
        ctx.fillStyle = 'rgba(6,10,20,0.85)';
        ctx.fillRect(projX - 18, projY - boxH / 2 - 13, 36, 11);
        ctx.fillStyle = color;
        ctx.font = `bold ${Math.max(7, Math.min(10, w / 60))}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(`${Math.abs(dist).toFixed(1)}m`, projX, projY - boxH / 2 - 4);

        // Entity type label (on larger canvases only)
        if (w > 200) {
            ctx.fillStyle = 'rgba(255,255,255,0.4)';
            ctx.font = `${Math.max(6, w / 80)}px "JetBrains Mono", monospace`;
            ctx.fillText(e.type.toUpperCase(), projX, projY + boxH / 2 + 10);
        }
    }

    // Camera label overlay
    const labels = { front: 'FRONT · 1080P 60FPS', rear: 'REAR · 720P 60FPS', left: 'FRONT-LEFT · 720P', right: 'FRONT-RIGHT · 720P' };
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = `bold ${Math.max(7, w / 65)}px "JetBrains Mono", monospace`;
    ctx.textAlign = 'left';
    ctx.fillText(labels[angle] || angle.toUpperCase(), 7, 13);

    // AEB warning overlay
    if (AVState.egoState.aebActive) {
        ctx.fillStyle = 'rgba(232,33,39,0.12)';
        ctx.fillRect(0, 0, w, h);
        if (angle === 'front' && w > 150) {
            ctx.strokeStyle = '#e82127';
            ctx.lineWidth = Math.max(2, w / 100);
            ctx.strokeRect(2, 2, w - 4, h - 4);
            ctx.fillStyle = '#e82127';
            ctx.font = `bold ${Math.max(8, w / 50)}px Inter, sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillText('⚡ AEB ACTIVE', w / 2, h / 2);
        }
    }
}

function renderCameraFeeds() {
    const t = performance.now() * 0.002;
    const ego = AVState.egoState;

    const anglePairs = [
        { thumb: 'camThumbFront', page: 'camPageFront',  angle: 'front' },
        { thumb: 'camThumbRear',  page: 'camPageRear',   angle: 'rear'  },
        { thumb: 'camThumbLeft',  page: 'camPageLeft',   angle: 'left'  },
        { thumb: 'camThumbRight', page: 'camPageRight',  angle: 'right' },
    ];

    for (const { thumb, page, angle } of anglePairs) {
        // Dashboard thumbnail
        const thumbCanvas = document.getElementById(thumb);
        if (thumbCanvas) {
            const ctx = thumbCanvas.getContext('2d');
            const rect = thumbCanvas.getBoundingClientRect();
            const w = rect.width > 0 ? Math.round(rect.width) : 110;
            const h = rect.height > 0 ? Math.round(rect.height) : 62;
            if (thumbCanvas.width !== w) thumbCanvas.width = w;
            if (thumbCanvas.height !== h) thumbCanvas.height = h;
            renderCameraView(ctx, w, h, angle, t, ego);
        }

        // Camera page full-view (only render when page is visible to save GPU)
        const pageCanvas = document.getElementById(page);
        if (pageCanvas && pageCanvas.closest('.view-pane.active')) {
            const ctx = pageCanvas.getContext('2d');
            const rect = pageCanvas.getBoundingClientRect();
            const w = rect.width > 0 ? Math.round(rect.width) : 640;
            const h = rect.height > 0 ? Math.round(rect.height) : (angle === 'front' ? 360 : 200);
            if (pageCanvas.width !== w) pageCanvas.width = w;
            if (pageCanvas.height !== h) pageCanvas.height = h;
            renderCameraView(ctx, w, h, angle, t, ego);
        }
    }
}

window.renderCameraFeeds = renderCameraFeeds;
