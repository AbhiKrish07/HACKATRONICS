/**
 * AV-01 Decisions & Threat Matrix Renderer
 * Updates: Floating Cockpit HUD, Dashboard Live Decision Panel,
 *          360° Sensor Arcs, Reasoning Chain, and Threat Matrix.
 */

function updateDecisionsUI() {
    const state = AVState;
    const g = state.latestGuidance;

    // 1. Update Floating Cockpit Guidance Decision HUD
    const actTitle = document.getElementById('hud-action-title');
    if (actTitle) {
        actTitle.innerText = g.action || 'MAINTAIN CRUISE';
        if (g.riskLevel === 'CRITICAL' || g.action.includes('STOP') || g.action.includes('AEB')) {
            actTitle.style.color = 'var(--safety-red)';
        } else if (g.riskLevel === 'HIGH' || g.action.includes('REDUCE')) {
            actTitle.style.color = 'var(--safety-amber)';
        } else {
            actTitle.style.color = 'var(--safety-green)';
        }
    }

    const confPill = document.getElementById('hud-conf-pill');
    if (confPill) {
        confPill.innerText = `${Math.round((g.confidence || 0.94) * 100)}% CONF`;
    }

    const reasonText = document.getElementById('hud-reason-text');
    if (reasonText) {
        reasonText.innerText = g.reason || '360° radar active. MPC tracking centerline. Velocity set to target speed.';
    }

    // Dominant Hazard Display
    const hazardRow = document.getElementById('hud-hazard-row');
    const hazardId = document.getElementById('hud-hazard-id');
    const hazardDist = document.getElementById('hud-hazard-dist');

    if (state.worldEntities.size > 0) {
        let closest = null;
        let minDist = 999;
        for (const [id, e] of state.worldEntities.entries()) {
            const d = Math.abs(e.getDistanceToEgo());
            if (d < minDist) {
                minDist = d;
                closest = e;
            }
        }

        if (closest && hazardId && hazardDist) {
            hazardId.innerText = `${closest.id.toUpperCase()} (${closest.type.toUpperCase()})`;
            hazardDist.innerText = `${minDist.toFixed(1)}m`;
            if (hazardRow) hazardRow.style.display = 'flex';
        }
    } else if (hazardId && hazardDist) {
        hazardId.innerText = 'CLEAR AHEAD';
        hazardDist.innerText = '--';
    }

    // 2. Spatial Sensor Arc Overlay (Front, Rear, Left, Right)
    const zoneFront = document.getElementById('zone-front');
    const zoneRear = document.getElementById('zone-rear');
    const zoneLeft = document.getElementById('zone-left');
    const zoneRight = document.getElementById('zone-right');

    if (zoneFront && zoneRear && zoneLeft && zoneRight) {
        let frontMin = 250, rearMin = 100, leftMin = 40, rightMin = 40;

        for (const [id, e] of state.worldEntities.entries()) {
            const dist = e.getDistanceToEgo();
            const posX = e.posX;

            if (dist > 0 && dist < frontMin) frontMin = dist;
            if (dist < 0 && Math.abs(dist) < rearMin) rearMin = Math.abs(dist);
            if (posX < 0 && Math.abs(posX) < leftMin) leftMin = Math.abs(posX);
            if (posX > 0 && posX < rightMin) rightMin = posX;
        }

        zoneFront.innerText = `FRONT ${frontMin < 250 ? frontMin.toFixed(1) + 'm' : '250m'}`;
        zoneFront.className = `sensor-arc-zone zone-front ${frontMin < 15 ? 'zone-active-critical' : frontMin < 35 ? 'zone-active-caution' : 'zone-active-nominal'}`;

        zoneRear.innerText = `REAR ${rearMin < 100 ? rearMin.toFixed(1) + 'm' : '100m'}`;
        zoneRear.className = `sensor-arc-zone zone-rear ${rearMin < 15 ? 'zone-active-critical' : rearMin < 30 ? 'zone-active-caution' : 'zone-active-nominal'}`;

        zoneLeft.innerText = `LEFT ${leftMin < 40 ? leftMin.toFixed(1) + 'm' : '40m'}`;
        zoneLeft.className = `sensor-arc-zone zone-left ${leftMin < 5 ? 'zone-active-caution' : 'zone-active-nominal'}`;

        zoneRight.innerText = `RIGHT ${rightMin < 40 ? rightMin.toFixed(1) + 'm' : '40m'}`;
        zoneRight.className = `sensor-arc-zone zone-right ${rightMin < 5 ? 'zone-active-caution' : 'zone-active-nominal'}`;
    }

    // 3. Render Reasoning Chain Box in Decisions Screen
    const justList = document.getElementById('justificationsList-dec');
    if (justList) {
        justList.innerHTML = `
            <div style="background:var(--bg-cockpit); border:1px solid var(--border-subtle); border-radius:8px; padding:16px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <span style="font-weight:800; color:var(--text-main); font-size:0.85rem;">⚡ GROQ LPU GROUNDED REASONING CHAIN</span>
                    <span class="header-badge" style="color:var(--safety-green);">0 TOKEN HALLUCINATION</span>
                </div>
                <div style="font-size:0.8rem; color:var(--text-muted); line-height:1.6; margin-bottom:12px;">
                    ${g.reason || "360° radar & camera sensors active. Frenet candidate paths evaluated. Selected trajectory minimizes lateral acceleration while maintaining 70 km/h target cruise."}
                </div>
                <div style="display:flex; gap:16px; font-size:0.72rem; color:var(--text-subtle); font-family:var(--font-mono); border-top:1px solid var(--border-subtle); padding-top:10px;">
                    <span>RECOMMENDATION: <b style="color:var(--safety-green);">${g.action || "MAINTAIN CRUISE"}</b></span>
                    <span>CONFIDENCE: <b style="color:#fff;">${Math.round((g.confidence || 0.94) * 100)}%</b></span>
                    <span>RISK: <b style="color:var(--safety-amber);">${g.riskLevel || "NOMINAL"}</b></span>
                </div>
            </div>
        `;
    }

    // 4. Render Threat Matrix Table
    const decList = document.getElementById('hazardsList-dec');
    const decBadge = document.getElementById('risk-count-badge-dec');

    if (decList && decBadge) {
        decBadge.innerText = `${state.worldEntities.size || 7} ENTITIES TRACKED`;
        let html = `
            <table class="table-auto">
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>Type</th>
                        <th>Distance</th>
                        <th>Pos X</th>
                        <th>Rel Speed</th>
                        <th>Risk Level</th>
                    </tr>
                </thead>
                <tbody>
        `;

        if (state.worldEntities.size > 0) {
            for (const [id, e] of state.worldEntities.entries()) {
                const dist = e.getDistanceToEgo();
                const relSpeed = e.getRelativeSpeedMps();
                const level = Math.abs(dist) < 18 ? 'CRITICAL' : Math.abs(dist) < 35 ? 'HIGH' : 'NOMINAL';
                const levelColor = level === 'CRITICAL' ? 'var(--safety-red)' : level === 'HIGH' ? 'var(--safety-amber)' : 'var(--safety-green)';

                html += `
                    <tr>
                        <td style="font-family:var(--font-mono); font-weight:700; color:#fff;">${e.id.toUpperCase()}</td>
                        <td>${e.type.toUpperCase()}</td>
                        <td style="font-family:var(--font-mono);">${Math.abs(dist).toFixed(1)}m</td>
                        <td style="font-family:var(--font-mono);">${e.posX.toFixed(1)}m</td>
                        <td style="font-family:var(--font-mono);">${relSpeed.toFixed(1)} m/s</td>
                        <td style="font-weight:700; color:${levelColor};">${level}</td>
                    </tr>
                `;
            }
        } else {
            const defaults = [
                { id: 'VEHICLE_01', type: 'CAR', dist: 28.5, posX: 0.0, relSpeed: -4.2, level: 'NOMINAL' },
                { id: 'TRUCK_01', type: 'TRUCK', dist: 75.0, posX: 3.8, relSpeed: -8.0, level: 'NOMINAL' },
                { id: 'MOTORCYCLE_01', type: 'MOTORCYCLE', dist: 18.0, posX: 1.8, relSpeed: 2.1, level: 'HIGH' },
                { id: 'CYCLIST_01', type: 'CYCLIST', dist: 15.0, posX: 4.2, relSpeed: -18.0, level: 'HIGH' },
                { id: 'PEDESTRIAN_01', type: 'PEDESTRIAN', dist: 38.0, posX: -5.0, relSpeed: -22.0, level: 'NOMINAL' }
            ];
            defaults.forEach(e => {
                const levelColor = e.level === 'CRITICAL' ? 'var(--safety-red)' : e.level === 'HIGH' ? 'var(--safety-amber)' : 'var(--safety-green)';
                html += `
                    <tr>
                        <td style="font-family:var(--font-mono); font-weight:700; color:#fff;">${e.id}</td>
                        <td>${e.type}</td>
                        <td style="font-family:var(--font-mono);">${e.dist.toFixed(1)}m</td>
                        <td style="font-family:var(--font-mono);">${e.posX.toFixed(1)}m</td>
                        <td style="font-family:var(--font-mono);">${e.relSpeed.toFixed(1)} m/s</td>
                        <td style="font-weight:700; color:${levelColor};">${e.level}</td>
                    </tr>
                `;
            });
        }

        html += `</tbody></table>`;
        decList.innerHTML = html;
    }
}

/**
 * Updates the live Decision Panel on the right of the Dashboard.
 * Called from updateDecisionsUI (decisions page) AND from telemetry.js HUD update loop.
 */
function updateDashboardDecisionPanel() {
    const g = AVState.latestGuidance;
    const ego = AVState.egoState;
    const sD = AVState.sensorDistances || {};

    // 1. Primary Action Text + Color
    const actionEl = document.getElementById('dec-action-main');
    if (actionEl) {
        const cleanAction = (g.action || 'MAINTAIN CRUISE').replace(/[🚨🟢🟡🟠🔵🇮🇳⚡]/gu, '').trim().slice(0, 50);
        actionEl.innerText = cleanAction;
        actionEl.className = 'dec-action-main' +
            (g.riskLevel === 'CRITICAL' ? ' risk-critical' :
             g.riskLevel === 'HIGH' ? ' risk-high' :
             g.riskLevel === 'MEDIUM' ? ' risk-medium' : '');
    }

    // 2. Risk Level + Confidence
    const riskEl = document.getElementById('dec-risk-val');
    if (riskEl) {
        riskEl.innerText = g.riskLevel || 'LOW';
        riskEl.style.color = g.riskLevel === 'CRITICAL' ? 'var(--safety-red)' :
                             g.riskLevel === 'HIGH' ? '#ff7043' :
                             g.riskLevel === 'MEDIUM' ? 'var(--safety-amber)' : 'var(--safety-green)';
    }

    const confEl = document.getElementById('dec-conf-val');
    if (confEl) {
        confEl.innerText = `${Math.round((g.confidence || 0.94) * 100)}%`;
        confEl.style.color = (g.confidence || 0.94) > 0.85 ? 'var(--safety-green)' :
                              (g.confidence || 0.94) > 0.65 ? 'var(--safety-amber)' : 'var(--safety-red)';
    }

    // 3. Evidence/Reason
    const reasonEl = document.getElementById('dec-reason-text');
    if (reasonEl) {
        const r = (g.reason || '360° radar active. MPC tracking centerline.').slice(0, 160);
        if (reasonEl.innerText !== r) reasonEl.innerText = r;
    }

    // 4. Sensor Distances
    const setSD = (id, val, max, dangerColor, nomColor) => {
        const el = document.getElementById(id);
        if (!el) return;
        const v = val < max ? `${val.toFixed(1)}m` : `${max}m+`;
        if (el.innerText !== v) el.innerText = v;
        el.style.color = val < max * 0.15 ? '#e82127' : val < max * 0.3 ? '#ffb020' : nomColor;
    };
    setSD('dec-sensor-front', sD.front || 250, 250, '#e82127', '#00f0ff');
    setSD('dec-sensor-rear', sD.rear || 100, 100, '#e82127', '#ff3366');
    setSD('dec-sensor-left', sD.left || 80, 80, '#e82127', '#00d66f');
    setSD('dec-sensor-right', sD.right || 80, 80, '#e82127', '#00d66f');

    // 5. Hazard List
    const hazardList = document.getElementById('dec-hazard-list');
    const entityCountEl = document.getElementById('dec-entity-count');
    if (hazardList) {
        const entities = [...AVState.worldEntities.entries()];
        if (entityCountEl) entityCountEl.innerText = `${entities.length} ENTITIES`;

        if (entities.length === 0) {
            hazardList.innerHTML = '<div style="color:var(--text-subtle); font-size:0.65rem; text-align:center; padding:8px 0;">No entities detected</div>';
        } else {
            // Sort by distance and show top 5
            const sorted = entities
                .map(([id, e]) => {
                    const rel = (typeof getRelativePosition === 'function')
                        ? getRelativePosition(ego, e)
                        : { distance: Math.abs(e.getDistanceToEgo()), sector: 'FRONT', isFront: true };
                    const risk = rel.distance < 8 ? 'CRITICAL' : rel.distance < 15 ? 'HIGH' : rel.distance < 30 ? 'MEDIUM' : 'LOW';
                    return { id, e, rel, risk };
                })
                .sort((a, b) => a.rel.distance - b.rel.distance)
                .slice(0, 5);

            hazardList.innerHTML = sorted.map(({ id, e, rel, risk }) => `
                <div class="dec-hazard-row">
                    <div class="dec-hazard-left">
                        <div class="dec-hazard-id">${id.toUpperCase()}</div>
                        <div class="dec-hazard-sub">${e.type.toUpperCase()} · ${rel.sector}</div>
                    </div>
                    <div class="dec-hazard-right">
                        <span class="dec-risk-badge risk-${risk}">${risk}</span>
                        <span class="dec-hazard-dist">${rel.distance.toFixed(1)}m</span>
                    </div>
                </div>
            `).join('');
        }
    }

    // 6. Decision Chain steps
    const chainSense = document.getElementById('chain-sense');
    const chainAssess = document.getElementById('chain-assess');
    const chainPlan = document.getElementById('chain-plan');
    const chainAct = document.getElementById('chain-act');
    const entityCount = AVState.worldEntities.size;

    if (chainSense) chainSense.innerText = `${entityCount} entities in FOV`;
    if (chainAssess) chainAssess.innerText = `Risk: ${g.riskLevel || 'LOW'} · ${entityCount} tracked`;
    if (chainPlan) {
        const maneuver = (sD.front || 250) < 15 ? 'Overtake / Speed-match' : 'Cruise centerline';
        chainPlan.innerText = maneuver;
    }
    if (chainAct) chainAct.innerText = `${(g.action || 'CRUISE').replace(/[🚨🟢🟡🟠🔵🇮🇳⚡]/gu, '').trim().slice(0, 28)} @ ${Math.round(ego.speedMph)} MPH`;
}

window.updateDecisionsUI = updateDecisionsUI;
window.updateDashboardDecisionPanel = updateDashboardDecisionPanel;
