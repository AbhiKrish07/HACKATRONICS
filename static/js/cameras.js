/**
 * AV-01 4-Channel Live Camera Vision Renderer
 * Renders simulated perspective camera views (Front, Left, Right, Rear)
 * with multi-agent bounding reticles, distance callouts, and scanline sweeps.
 */

function renderCameraFeeds() {
    const cams = [
        { id: 'camCanvasFront', title: 'FRONT FOV', angle: 'front' },
        { id: 'camCanvasLeft', title: 'LEFT BLIND', angle: 'left' },
        { id: 'camCanvasRight', title: 'RIGHT BLIND', angle: 'right' },
        { id: 'camCanvasRear', title: 'REAR SCAN', angle: 'rear' }
    ];

    const t = performance.now() * 0.002;
    const ego = AVState.egoState;

    cams.forEach(camInfo => {
        const canvas = document.getElementById(camInfo.id);
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        ctx.clearRect(0, 0, w, h);

        // Sky & Ground gradients
        const skyGrad = ctx.createLinearGradient(0, 0, 0, h * 0.45);
        skyGrad.addColorStop(0, '#040814');
        skyGrad.addColorStop(1, '#0f182e');
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, w, h * 0.45);

        const gndGrad = ctx.createLinearGradient(0, h * 0.45, 0, h);
        gndGrad.addColorStop(0, '#111827');
        gndGrad.addColorStop(1, '#090d16');
        ctx.fillStyle = gndGrad;
        ctx.fillRect(0, h * 0.45, w, h * 0.55);

        const horizonY = h * 0.45;
        const vpX = w / 2;

        // Horizon guide line
        ctx.strokeStyle = 'rgba(54,147,255,0.2)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, horizonY); ctx.lineTo(w, horizonY); ctx.stroke();

        // Dynamic perspective lane markings based on camera angle
        if (camInfo.angle === 'front') {
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(vpX - 6, horizonY); ctx.lineTo(15, h); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(vpX + 6, horizonY); ctx.lineTo(w - 15, h); ctx.stroke();

            const dashOffset = (t * 60) % 18;
            ctx.setLineDash([4, 6]);
            ctx.lineDashOffset = -dashOffset;
            ctx.strokeStyle = 'rgba(250,204,21,0.4)';
            ctx.beginPath(); ctx.moveTo(vpX, horizonY); ctx.lineTo(w * 0.5, h); ctx.stroke();
            ctx.setLineDash([]);
        } else if (camInfo.angle === 'left') {
            ctx.strokeStyle = 'rgba(255,255,255,0.15)';
            ctx.lineWidth = 1.5;
            const sideOffset = (t * 50) % 30;
            for (let i = -1; i < 4; i++) {
                const lx = (i * 45 + sideOffset);
                ctx.beginPath(); ctx.moveTo(lx, horizonY); ctx.lineTo(lx - 20, h); ctx.stroke();
            }
        } else if (camInfo.angle === 'right') {
            ctx.strokeStyle = 'rgba(255,255,255,0.15)';
            ctx.lineWidth = 1.5;
            const sideOffset = (t * 50) % 30;
            for (let i = -1; i < 4; i++) {
                const rx = w - (i * 45 + sideOffset);
                ctx.beginPath(); ctx.moveTo(rx, horizonY); ctx.lineTo(rx + 20, h); ctx.stroke();
            }
        } else if (camInfo.angle === 'rear') {
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(vpX - 6, horizonY); ctx.lineTo(25, h); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(vpX + 6, horizonY); ctx.lineTo(w - 25, h); ctx.stroke();
        }

        // Radar Scanline Effect
        const scanY = (t * 80) % h;
        ctx.strokeStyle = 'rgba(28,208,255,0.2)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, scanY); ctx.lineTo(w, scanY); ctx.stroke();

        // Render multi-agent entities in camera FOV
        for (const [id, e] of AVState.worldEntities.entries()) {
            const dist = e.getDistanceToEgo();
            const relX = e.posX - ego.x;
            let inView = false;

            if (camInfo.angle === 'front' && dist > 2.0 && dist < 90.0 && Math.abs(relX) < 12) inView = true;
            else if (camInfo.angle === 'left' && relX < -1.0 && Math.abs(dist) < 40.0) inView = true;
            else if (camInfo.angle === 'right' && relX > 1.0 && Math.abs(dist) < 40.0) inView = true;
            else if (camInfo.angle === 'rear' && dist < -2.0 && Math.abs(dist) < 70.0) inView = true;

            if (inView) {
                const projX = camInfo.angle === 'front' || camInfo.angle === 'rear'
                    ? vpX + (relX / 10.0) * (w * 0.38)
                    : camInfo.angle === 'left' ? w * 0.35 + (dist / 40.0) * (w * 0.4) : w * 0.65 - (dist / 40.0) * (w * 0.4);

                const projY = horizonY + (1.0 - Math.min(1.0, Math.abs(dist) / 80.0)) * (h - horizonY - 12);
                const boxW = Math.max(14, 38 - Math.abs(dist) * 0.3);
                const boxH = boxW * 1.15;

                const color = Math.abs(dist) < 18.0 ? '#e82127' : Math.abs(dist) < 40.0 ? '#ffb020' : '#00d66f';

                // Bounding Reticle Box
                ctx.strokeStyle = color;
                ctx.lineWidth = 2;
                ctx.strokeRect(projX - boxW / 2, projY - boxH / 2, boxW, boxH);
                ctx.fillStyle = color + '22';
                ctx.fillRect(projX - boxW / 2, projY - boxH / 2, boxW, boxH);

                // Distance Tag Pill
                ctx.fillStyle = 'rgba(6,10,20,0.9)';
                ctx.fillRect(projX - 20, projY - boxH / 2 - 13, 40, 12);
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 8px "JetBrains Mono", monospace';
                ctx.textAlign = 'center';
                ctx.fillText(`${Math.abs(dist).toFixed(1)}m`, projX, projY - boxH / 2 - 4);
            }
        }

        // Camera Feed Status Overlay
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '7px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(camInfo.title, 6, 12);
    });
}

window.renderCameraFeeds = renderCameraFeeds;
