/**
 * AV-01 Real-Time WebSocket Telemetry Receiver
 *
 * Architecture:
 *   WebSocket (10Hz) → AVState.updateFromWebSocket() → shared state
 *   DOM updates are throttled separately — NOT inside requestAnimationFrame
 */

class TelemetryReceiver {
    constructor() {
        this.ws = null;
        this._hudUpdateInterval = null;
        this.connect();
        // HUD updates at ~10 FPS (every 100ms) — decoupled from render loop
        this._hudUpdateInterval = setInterval(() => this._updateHUD(), 100);
    }

    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            console.log('[Telemetry] WebSocket connected');
            AVState.systemStatus = 'NOMINAL';
            this._setStatusDot('NOMINAL');
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                // Delegate ALL state updates to AVState — do NOT touch DOM here
                AVState.updateFromWebSocket(data);
                // Store last raw frame for log table (event-driven, not per-render)
                this._lastFrame = data;
                this._appendLogRow(data);
            } catch (e) {
                console.error('[Telemetry] Parse error:', e);
            }
        };

        this.ws.onclose = () => {
            AVState.systemStatus = 'DISCONNECTED';
            this._setStatusDot('DISCONNECTED');
            // Reconnect after 2s
            setTimeout(() => this.connect(), 2000);
        };

        this.ws.onerror = (err) => {
            console.warn('[Telemetry] WebSocket error', err);
        };
    }

    /**
     * Update HUD DOM elements — runs at 10 FPS via interval, NOT in rAF loop.
     */
    _updateHUD() {
        const ego = AVState.egoState;
        const guidance = AVState.latestGuidance;

        // Speed display
        const speedEl = document.getElementById('hud-speed-val');
        if (speedEl) {
            const displaySpeed = Math.round(ego.speedMph);
            if (speedEl.innerText !== String(displaySpeed)) speedEl.innerText = displaySpeed;
        }

        // Decision HUD
        const actionEl = document.getElementById('hud-action-title');
        if (actionEl) {
            const shortAction = (guidance.action || 'CRUISE').replace(/[🚨🟢🟡🟠🔵🇮🇳]/gu, '').trim().slice(0, 30);
            if (actionEl.innerText !== shortAction) actionEl.innerText = shortAction;
        }

        const confEl = document.getElementById('hud-conf-pill');
        if (confEl) {
            const confText = `${Math.round((guidance.confidence || 0.94) * 100)}%`;
            if (confEl.innerText !== confText) confEl.innerText = confText;
        }

        const reasonEl = document.getElementById('hud-reason-text');
        if (reasonEl) {
            const r = (guidance.reason || '').slice(0, 120);
            if (reasonEl.innerText !== r) reasonEl.innerText = r;
        }

        // Dominant hazard in HUD
        const hazardDistEl = document.getElementById('hud-hazard-dist');
        const hazardIdEl = document.getElementById('hud-hazard-id');
        if (hazardDistEl && hazardIdEl && AVState.activeHazards.length > 0) {
            const top = AVState.activeHazards[0];
            // Only show if it's in front — do NOT show rear hazards as front hazard
            if (top.isFront || Math.abs(top.longitudinal) < 3) {
                hazardDistEl.innerText = `${top.distance.toFixed(1)}m`;
                hazardIdEl.innerText = top.id || top.type;
            } else {
                hazardDistEl.innerText = `${top.distance.toFixed(1)}m`;
                hazardIdEl.innerText = `${top.sector}: ${top.id || top.type}`;
            }
        }

        // Source badge
        const srcBadge = document.getElementById('source-badge');
        if (srcBadge) {
            const srcText = `SOURCE: ${AVState.source}`;
            if (srcBadge.innerText !== srcText) srcBadge.innerText = srcText;
        }

        // System status dot
        this._setStatusDot(AVState.systemStatus);

        // Autopilot wheel icon color
        const wheelIcon = document.getElementById('tesla-wheel-icon');
        if (wheelIcon) {
            if (ego.isAutoPilot) {
                wheelIcon.style.background = '#0288d1';
                wheelIcon.style.boxShadow = '0 0 14px rgba(2,136,209,0.5)';
            } else {
                wheelIcon.style.background = '#555';
                wheelIcon.style.boxShadow = 'none';
            }
        }

        // Decisions page — update at lower rate
        if (typeof updateDecisionsUI === 'function') updateDecisionsUI();
    }

    _setStatusDot(status) {
        const dot = document.getElementById('system-status-dot');
        const txt = document.getElementById('system-status-text');
        if (!dot || !txt) return;

        const map = {
            NOMINAL: { color: 'var(--safety-green)', label: 'NOMINAL' },
            DEGRADED: { color: 'var(--safety-amber)', label: 'DEGRADED' },
            SENSOR_GAP: { color: 'var(--safety-amber)', label: 'SENSOR GAP' },
            CONFLICT: { color: '#9c27b0', label: 'CONFLICT' },
            CRITICAL: { color: 'var(--safety-red)', label: 'CRITICAL' },
            DISCONNECTED: { color: 'var(--safety-red)', label: 'DISCONNECTED' }
        };
        const s = map[status] || map.NOMINAL;
        dot.style.background = s.color;
        if (txt.innerText !== s.label) txt.innerText = s.label;
    }

    /**
     * Append a row to the logs table — event-driven, not per-frame.
     */
    _appendLogRow(frame) {
        const logsTable = document.getElementById('logs-table-body');
        if (!logsTable || !frame.guidance) return;

        const now = new Date().toLocaleTimeString();
        const frameId = `#${frame.frame_id || Math.floor(Math.random() * 9000 + 1000)}`;
        const src = frame.source || 'Simulator';
        const action = (frame.guidance.action || 'MAINTAIN CRUISE').replace(/[🚨🟢🟡🟠🔵🇮🇳]/gu, '').trim().slice(0, 30);
        const conf = `${Math.round((frame.guidance.confidence || 0.94) * 100)}%`;
        const risk = frame.guidance.risk_level || 'LOW';
        const riskColor = risk === 'CRITICAL' ? 'var(--safety-red)' : risk === 'HIGH' ? '#ff7043' : risk === 'MEDIUM' ? 'var(--safety-amber)' : 'var(--safety-green)';

        const row = document.createElement('tr');
        row.innerHTML = `
            <td style="font-family:var(--font-mono)">${now}</td>
            <td style="font-family:var(--font-mono)">${frameId}</td>
            <td>${src}</td>
            <td style="color:${riskColor}">${risk}</td>
            <td style="font-weight:600">${action}</td>
            <td style="font-family:var(--font-mono)">${conf}</td>
        `;

        if (logsTable.children.length >= 12) logsTable.removeChild(logsTable.lastElementChild);
        logsTable.insertBefore(row, logsTable.firstChild);
    }
}

window.telemetryReceiver = new TelemetryReceiver();
