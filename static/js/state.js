/**
 * AV-01 State Manager
 * Unified single source of truth for telemetry, multi-agent world state,
 * trip metrics, guidance, and system status across all 9 screens.
 */

class StateManager {
    constructor() {
        this.worldEntities = new Map();
        
        this.egoState = {
            worldZ: 0.0,
            x: 0.0,
            speedMph: 52.0,
            targetCruiseMph: 60.0,
            speedMps: 23.2,
            steer: 0.0,
            yaw: 0.0,
            isAutoPilot: true,
            aebActive: false,
            safetyScore: 98,
            scoreMultiplier: 1.0,
            lane: 2
        };

        this.latestGuidance = {
            action: "MAINTAIN CRUISE",
            reason: "Path clear. MPC tracking centerline. Multi-agent radar active.",
            riskLevel: "LOW",
            confidence: 0.94,
            trafficSignal: "GREEN",
            trafficSignalDist: 85,
            maneuver: "STRAIGHT",
            evidence: []
        };

        this.telemetryHistory = {
            speed: [],
            risk: [],
            conf: [],
            timestamps: [],
            maxLen: 40
        };

        this.tripSummary = {
            timerSec: 0,
            distanceKm: 0.0,
            hazardsTracked: 0,
            alertsTriggered: 0,
            avgConfidence: 94
        };

        this.datasetSource = "WAYMO + KAGGLE HYBRID";
        this.listeners = [];
    }

    subscribe(listener) {
        this.listeners.push(listener);
    }

    notify() {
        this.listeners.forEach(fn => fn(this));
    }

    updateEgoSpeed(newSpeedMph) {
        this.egoState.speedMph = newSpeedMph;
        this.egoState.speedMps = (newSpeedMph * 1.609) / 3.6;
        this.notify();
    }

    setGuidance(guidance) {
        this.latestGuidance = { ...this.latestGuidance, ...guidance };
        this.notify();
    }

    addTelemetrySample(speed, risk, conf) {
        const h = this.telemetryHistory;
        h.speed.push(speed);
        h.risk.push(risk);
        h.conf.push(conf);
        const now = new Date();
        const timeStr = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
        h.timestamps.push(timeStr);

        if (h.speed.length > h.maxLen) {
            h.speed.shift();
            h.risk.shift();
            h.conf.shift();
            h.timestamps.shift();
        }
        this.notify();
    }
}

window.AVState = new StateManager();
