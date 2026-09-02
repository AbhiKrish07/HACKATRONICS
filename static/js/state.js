/**
 * AV-01 State Manager — Single Source of Truth
 *
 * Architecture:
 *   WebSocket (10Hz) → updateFromWebSocket() → AVState
 *   60 FPS render loop reads AVState → never independently invents state
 *
 * All pages (Dashboard, Decisions, Analytics, Logs, Radar, Cameras, Map)
 * read from this single store. No page maintains private state.
 */

class StateManager {
    constructor() {
        this.worldEntities = new Map(); // id → WorldEntity (persistent, pooled)

        this.egoState = {
            worldZ: 0.0,
            x: 0.0,
            speedMph: 52.0,
            targetCruiseMph: 60.0,
            speedMps: 14.4,
            steer: 0.0,
            yaw: 0.0,
            isAutoPilot: true,
            aebActive: false,
            safetyScore: 98,
            scoreMultiplier: 1.0,
            lane: 2
        };

        this.latestGuidance = {
            action: 'MAINTAIN CRUISE',
            reason: 'Path clear. MPC tracking centerline.',
            riskLevel: 'LOW',
            confidence: 0.94,
            trafficSignal: 'GREEN',
            trafficSignalDist: 85,
            maneuver: 'STRAIGHT',
            dominantHazardId: null,
            dominantHazardSector: null,
            evidence: []
        };

        // Sensor distances derived from getRelativePosition — NOT independently randomized
        this.sensorDistances = { front: 250, left: 80, right: 80, rear: 100 };

        // Hazard classifications (sector-correct)
        this.activeHazards = []; // { id, type, sector, distance, risk, ttc }

        this.telemetryHistory = {
            speed: [], risk: [], conf: [], timestamps: [], maxLen: 60
        };

        this.tripSummary = {
            timerSec: 0, distanceKm: 0.0,
            hazardsTracked: 0, alertsTriggered: 0, avgConfidence: 94
        };

        // Performance telemetry
        this.perfMetrics = { fps: 0, frameTime: 0, wsLatency: 0, entityCount: 0 };

        this.source = 'SIMULATOR';
        this.systemStatus = 'NOMINAL';
        this.lastWsTimestamp = 0;
        this.listeners = [];
    }

    subscribe(fn) { this.listeners.push(fn); }
    notify() { this.listeners.forEach(fn => fn(this)); }

    /**
     * Called by TelemetryReceiver on every 10Hz WebSocket frame.
     * Updates ego state and hazards from authoritative backend data.
     * Does NOT modify worldEntities positions — those are owned by simulation.js.
     */
    updateFromWebSocket(frame) {
        if (!frame) return;
        const now = performance.now();
        this.perfMetrics.wsLatency = now - this.lastWsTimestamp;
        this.lastWsTimestamp = now;

        // Update source badge
        if (frame.source) this.source = frame.source.toUpperCase();

        // Update ego speed from backend (if different from local physics)
        if (frame.vehicle_state) {
            const vs = frame.vehicle_state;
            // Backend speed informs the HUD, but local physics owns ego motion
            // Only sync if difference is large (prevents jitter fighting)
            if (vs.speed_mps !== undefined) {
                const backendMph = (vs.speed_mps * 3.6) / 1.609;
                if (Math.abs(backendMph - this.egoState.speedMph) > 15) {
                    this.egoState.speedMph = backendMph;
                    this.egoState.speedMps = vs.speed_mps;
                }
            }
        }

        // Update guidance from backend
        if (frame.guidance) {
            const g = frame.guidance;
            this.latestGuidance = {
                ...this.latestGuidance,
                action: g.action || this.latestGuidance.action,
                reason: g.reason || this.latestGuidance.reason,
                riskLevel: g.risk_level || this.latestGuidance.riskLevel,
                confidence: g.confidence || this.latestGuidance.confidence,
                evidence: g.evidence || [],
                dominantHazardId: g.dominant_hazard_id || null
            };
        }

        // System health
        if (frame.health) {
            const h = frame.health;
            if (h.sensor_gap_active) this.systemStatus = 'SENSOR_GAP';
            else if (h.conflicting_detections) this.systemStatus = 'CONFLICT';
            else this.systemStatus = 'NOMINAL';
        }

        // Telemetry history (for analytics charts)
        const riskNum = { LOW: 0.2, MEDIUM: 0.5, HIGH: 0.8, CRITICAL: 1.0 }[this.latestGuidance.riskLevel] || 0.2;
        this.addTelemetrySample(this.egoState.speedMph, riskNum, this.latestGuidance.confidence);
        this.notify();
    }

    setGuidance(guidance) {
        const actionChanged = guidance.action && guidance.action !== this.latestGuidance.action;
        this.latestGuidance = { ...this.latestGuidance, ...guidance };
        this.notify();
        
        // Dynamically log significant AI decisions to the Telemetry Diagnostic Log table
        if (actionChanged && window.telemetryReceiver && window.telemetryReceiver._appendLogRow) {
            window.telemetryReceiver._appendLogRow({
                frame_id: Math.floor(Math.random() * 9000 + 1000),
                source: 'Sim Logic',
                guidance: this.latestGuidance
            });
        }
    }

    /**
     * Update sensor distances from actual entity positions (via getRelativePosition).
     * Radar and sensor overlay must call this — NOT independently invent values.
     */
    updateSensorDistances(front, left, right, rear) {
        this.sensorDistances = { front, left, right, rear };
    }

    /**
     * Recompute active hazards from current worldEntities.
     * Uses getRelativePosition to correctly classify front vs rear.
     * Called once per simulation tick (not per render frame).
     */
    recomputeHazards() {
        const ego = this.egoState;
        this.activeHazards = [];
        let dominantDist = 999;
        let dominantId = null;
        let dominantSector = null;

        for (const [id, entity] of this.worldEntities.entries()) {
            if (typeof getRelativePosition !== 'function') break;
            const rel = getRelativePosition(ego, entity);

            // Risk classification based on distance + sector
            let risk = 'LOW';
            if (rel.distance < 8) risk = 'CRITICAL';
            else if (rel.distance < 15) risk = 'HIGH';
            else if (rel.distance < 30) risk = 'MEDIUM';

            const ttc = entity.speedMph > ego.speedMph && rel.isFront
                ? rel.distance / Math.max(0.1, ((entity.speedMph - ego.speedMph) * 1.609 / 3.6))
                : 999;

            this.activeHazards.push({
                id, type: entity.type,
                sector: rel.sector, distance: rel.distance,
                longitudinal: rel.longitudinal, lateral: rel.lateral,
                risk, ttc,
                isRear: rel.isRear, isFront: rel.isFront
            });

            if (rel.distance < dominantDist) {
                dominantDist = rel.distance;
                dominantId = id;
                dominantSector = rel.sector;
            }
        }

        // Sort by distance
        this.activeHazards.sort((a, b) => a.distance - b.distance);

        if (dominantId) {
            this.latestGuidance.dominantHazardId = dominantId;
            this.latestGuidance.dominantHazardSector = dominantSector;
        }
    }

    updateEgoSpeed(newSpeedMph) {
        this.egoState.speedMph = newSpeedMph;
        this.egoState.speedMps = (newSpeedMph * 1.609) / 3.6;
        this.notify();
    }

    addTelemetrySample(speed, risk, conf) {
        const h = this.telemetryHistory;
        const now = new Date();
        const ts = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
        h.speed.push(Math.round(speed));
        h.risk.push(risk);
        h.conf.push(conf);
        h.timestamps.push(ts);
        if (h.speed.length > h.maxLen) {
            h.speed.shift(); h.risk.shift(); h.conf.shift(); h.timestamps.shift();
        }
    }
}

window.AVState = new StateManager();
