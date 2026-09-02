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

// Source Feed Switchers
function startSyntheticFeed() {
    AVState.source = 'synthetic';
    updateSourceFeedButtons('btn-synthetic-feed', 'SYNTHETIC');
    if (typeof resetWorldEntities === 'function') resetWorldEntities('synthetic');
}

function startKaggleFeed() {
    AVState.source = 'kaggle';
    updateSourceFeedButtons('btn-kaggle-feed', 'KAGGLE-DRIVEN');
    if (typeof resetWorldEntities === 'function') resetWorldEntities('kaggle');
}

function startWaymoFeed() {
    AVState.source = 'waymo';
    updateSourceFeedButtons('btn-waymo-feed', 'WAYMO REPLAY');
    if (typeof resetWorldEntities === 'function') resetWorldEntities('waymo');
}

function updateSourceFeedButtons(activeBtnId, sourceName) {
    ['btn-synthetic-feed', 'btn-kaggle-feed', 'btn-waymo-feed'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.classList.toggle('active', id === activeBtnId);
    });
    const badge = document.getElementById('source-badge');
    if (badge) badge.innerText = `SOURCE: ${sourceName}`;
}

// Edge Case Handlers
function triggerEdgeCase(type) {
    const dot = document.getElementById('system-status-dot');
    const txt = document.getElementById('system-status-text');

    if (type === 'gap') {
        if (dot) dot.style.background = 'var(--safety-amber)';
        if (txt) txt.innerText = 'DEGRADED';
        AVState.setGuidance({
            action: '⚡ SENSOR GAP DETECTED',
            reason: 'Front camera unavailable. Decision based on corroborating radar evidence.',
            confidence: 0.62,
            riskLevel: 'HIGH'
        });
    } else if (type === 'conflict') {
        if (dot) dot.style.background = 'var(--safety-amber)';
        if (txt) txt.innerText = 'CONFLICT';
        AVState.setGuidance({
            action: '⚠️ SENSOR CONFLICT ARBITRATED',
            reason: 'Camera/LiDAR obstacle discrepancy. Executing conservative speed reduction.',
            confidence: 0.71,
            riskLevel: 'HIGH'
        });
    }
    if (typeof updateDecisionsUI === 'function') updateDecisionsUI();
}

function triggerAEB() {
    AVState.egoState.speedMph = 0;
    AVState.egoState.speedMps = 0;
    AVState.setGuidance({
        action: '🚨 AEB HARD STOP EXECUTED',
        reason: '360° Safety Net triggered emergency braking. Ego velocity reduced to 0 km/h.',
        confidence: 0.99,
        riskLevel: 'CRITICAL'
    });
    if (typeof updateDecisionsUI === 'function') updateDecisionsUI();
}

// Driving Mission Scenario Spawner
function spawnRealisticScenario(scenarioName) {
    console.log(`[Scenario] Spawning mission: ${scenarioName}`);
    if (typeof pageRouter !== 'undefined' && pageRouter.navigateTo) {
        pageRouter.navigateTo('dashboard');
    }

    if (scenarioName === 'pedestrian_crossing') {
        if (typeof spawnEntity === 'function') spawnEntity('pedestrian', 12.0, 0.0, 2.0);
        AVState.setGuidance({
            action: '🚨 REDUCE SPEED — PEDESTRIAN CROSSING',
            reason: 'Vulnerable Road User walking across ego trajectory at 12m.',
            confidence: 0.96,
            riskLevel: 'CRITICAL'
        });
    } else if (scenarioName === 'cyclist_overtake') {
        if (typeof spawnEntity === 'function') spawnEntity('cyclist', 18.0, 3.8, 10.0);
        AVState.setGuidance({
            action: '🚴 EXECUTING CYCLIST OVERTAKE',
            reason: 'Slow cyclist detected on right shoulder. RSS 1.5m lateral offset path calculated.',
            confidence: 0.92,
            riskLevel: 'HIGH'
        });
    } else if (scenarioName === 'lead_vehicle_brake') {
        if (typeof spawnEntity === 'function') spawnEntity('vehicle', 22.0, 0.0, 15.0);
        AVState.setGuidance({
            action: '🚗 TACC DECELERATION — LEAD BRAKE CHECK',
            reason: 'Lead vehicle rapidly decelerated. Matching lead speed with RSS safe headway gap.',
            confidence: 0.94,
            riskLevel: 'HIGH'
        });
    } else if (scenarioName === 'motorcycle_weaving') {
        if (typeof spawnEntity === 'function') spawnEntity('motorcycle', 14.0, 1.5, 55.0);
        AVState.setGuidance({
            action: '🏍️ CAUTION — MOTORCYCLE WEAVING',
            reason: 'Fast motorcycle executing high lateral velocity shifts ahead.',
            confidence: 0.89,
            riskLevel: 'HIGH'
        });
    }
    if (typeof updateDecisionsUI === 'function') updateDecisionsUI();
}

window.initApp = initApp;
window.setDriveMode = setDriveMode;
window.startSyntheticFeed = startSyntheticFeed;
window.startKaggleFeed = startKaggleFeed;
window.startWaymoFeed = startWaymoFeed;
window.triggerEdgeCase = triggerEdgeCase;
window.triggerAEB = triggerAEB;
window.spawnRealisticScenario = spawnRealisticScenario;

// Start app on DOM loaded
document.addEventListener('DOMContentLoaded', initApp);

