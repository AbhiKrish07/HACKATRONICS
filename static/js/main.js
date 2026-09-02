/**
 * AV-01 Main Application Bootstrap
 * Orchestrates simulation loop, 2D radar, camera vision, charts, decisions, and controls.
 */

let lastFrameTimestamp = performance.now();
let sampleAccumulator = 0;
const activeKeys = {};

function initApp() {
    console.log('Bootstrapping AV-01 Autonomous Navigation System...');

    // Keyboard Listeners
    window.addEventListener('keydown', e => { activeKeys[e.key.toLowerCase()] = true; });
    window.addEventListener('keyup', e => { activeKeys[e.key.toLowerCase()] = false; });

    // Initialize 3D CARLA Engine
    if (typeof initSimulationEngine === 'function') {
        initSimulationEngine();
    }

    // Connect Telemetry WebSocket Stream
    if (typeof connectTelemetryWebSocket === 'function') {
        connectTelemetryWebSocket();
    }

    // Start 60FPS Render & Physics Loop
    requestAnimationFrame(mainAnimationLoop);

    // Clock update ticker
    setInterval(updateClockUI, 1000);
}

function mainAnimationLoop(timestamp) {
    const dt = Math.min(0.05, (timestamp - lastFrameTimestamp) / 1000);
    lastFrameTimestamp = timestamp;
    sampleAccumulator += dt;

    const ego = AVState.egoState;

    // Manual Drive Mode (WASD / Arrow Keys) with Vehicle Kinematic Physics
    if (!ego.isAutoPilot) {
        let isThrottle = false, isBrake = false, isLeft = false, isRight = false;
        if (activeKeys['w'] || activeKeys['arrowup']) { ego.speedMph = Math.min(85.0, ego.speedMph + 30.0 * dt); isThrottle = true; }
        if (activeKeys['s'] || activeKeys['arrowdown']) { ego.speedMph = Math.max(0.0, ego.speedMph - 45.0 * dt); isBrake = true; }
        if (activeKeys['a'] || activeKeys['arrowleft']) { ego.x = Math.max(-10.5, ego.x - 5.5 * dt); ego.yaw = Math.max(-0.15, ego.yaw - 0.5 * dt); isLeft = true; }
        if (activeKeys['d'] || activeKeys['arrowright']) { ego.x = Math.min(10.5, ego.x + 5.5 * dt); ego.yaw = Math.min(0.15, ego.yaw + 0.5 * dt); isRight = true; }
        
        // Natural speed decay & steering centering friction
        if (!isThrottle && !isBrake && ego.speedMph > 0) {
            ego.speedMph = Math.max(0.0, ego.speedMph - 8.0 * dt);
        }
        if (!isLeft && !isRight) {
            ego.yaw += (0 - ego.yaw) * 6.0 * dt;
        }
        ego.speedMps = (ego.speedMph * 1.609) / 3.6;

        AVState.setGuidance({
            action: `🎮 MANUAL DRIVE ACTIVE (${Math.round(ego.speedMph)} MPH)`,
            reason: `Driver in manual override. Enforcing vehicle physics & rigid body collision bounds.`,
            riskLevel: ego.speedMph > 65 ? "HIGH" : "LOW"
        });
    }

    // 1. Update 3D CARLA Engine & Multi-Agent Simulation
    if (typeof updateSimulationLoop === 'function') {
        updateSimulationLoop(dt);
    }

    // 2. Render 2D Tesla Top-Down Surround Distance Radar (Preserved 100%)
    if (typeof render2DRadarCanvas === 'function') {
        render2DRadarCanvas();
    }

    // 3. Render 4-Channel Live Camera Vision Feeds (Preserved 100%)
    if (typeof renderCameraFeeds === 'function') {
        renderCameraFeeds();
    }

    // 4. Continuously push live telemetry samples for moving charts (Every ~150ms)
    if (sampleAccumulator >= 0.15) {
        sampleAccumulator = 0;
        const noise = (Math.random() - 0.5) * 3;
        AVState.addTelemetrySample(
            ego.speedMph,
            AVState.latestGuidance.riskLevel === 'HIGH' ? 0.75 : AVState.latestGuidance.riskLevel === 'CRITICAL' ? 0.95 : 0.2,
            Math.min(100, Math.max(70, Math.round((AVState.latestGuidance.confidence || 0.94) * 100 + noise)))
        );
    }

    // 5. Render Moving Telemetry & Perception Charts
    if (typeof renderConfidenceChart === 'function') {
        renderConfidenceChart();
    }
    if (typeof renderAnalyticsCharts === 'function') {
        renderAnalyticsCharts();
    }

    // 6. Sync Speedometer & Sensor Distance Pills on HUD
    const speedEl = document.getElementById('hud-speed-sim');
    if (speedEl) speedEl.innerText = Math.round(ego.speedMph);

    const sD = AVState.sensorDistances;
    if (sD) {
        const frontPill = document.getElementById('hud-sensor-front');
        if (frontPill) frontPill.innerText = `FRONT: ${sD.front.toFixed(1)}m`;
        const leftPill = document.getElementById('hud-sensor-left');
        if (leftPill) leftPill.innerText = `LEFT: ${sD.left.toFixed(1)}m`;
        const rightPill = document.getElementById('hud-sensor-right');
        if (rightPill) rightPill.innerText = `RIGHT: ${sD.right.toFixed(1)}m`;
        const rearPill = document.getElementById('hud-sensor-rear');
        if (rearPill) rearPill.innerText = `REAR: ${sD.rear.toFixed(1)}m`;
    }

    requestAnimationFrame(mainAnimationLoop);
}

function setDriveMode(isAuto) {
    AVState.egoState.isAutoPilot = isAuto;
    const btnPilot = document.getElementById('btn-pilot-mode');
    const btnManual = document.getElementById('btn-manual-mode');
    if (btnPilot && btnManual) {
        btnPilot.classList.toggle('active', isAuto);
        btnManual.classList.toggle('active', !isAuto);
    }
}

function updateClockUI() {
    const clockEl = document.getElementById('header-clock');
    if (clockEl) {
        const now = new Date();
        clockEl.innerText = now.toLocaleTimeString();
    }
}

function openDecisionLogicModal() {
    const modal = document.getElementById('decisionLogicModal');
    if (modal) modal.classList.add('active');
}

function closeDecisionLogicModal() {
    const modal = document.getElementById('decisionLogicModal');
    if (modal) modal.classList.remove('active');
}

function sendTrafficSignal(color) {
    AVState.latestGuidance.trafficSignal = color;
    const badge = document.getElementById('traffic-light-header-badge');
    if (badge) {
        badge.innerText = `SIGNAL: ${color} (85m)`;
        badge.className = `badge ${color === 'GREEN' ? 'badge-healthy' : color === 'YELLOW' ? 'badge-degraded' : 'badge-critical'}`;
    }
}

function triggerManeuver(type) {
    const badge = document.getElementById('route-maneuver-badge');
    if (badge) {
        badge.innerText = `🛣️ ROUTE: MANEUVER ${type} EXECUTED`;
    }
}

window.initApp = initApp;
window.setDriveMode = setDriveMode;
window.openDecisionLogicModal = openDecisionLogicModal;
window.closeDecisionLogicModal = closeDecisionLogicModal;
window.sendTrafficSignal = sendTrafficSignal;
window.triggerManeuver = triggerManeuver;

// Start app on DOM loaded
document.addEventListener('DOMContentLoaded', initApp);
