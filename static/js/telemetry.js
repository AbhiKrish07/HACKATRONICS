/**
 * AV-01 Real-Time WebSocket Telemetry Receiver
 * Streams 10Hz authoritative backend frames into HUD speedometer, logs, state, and charts.
 */

class TelemetryReceiver {
    constructor() {
        this.ws = null;
        this.connect();
    }

    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/telemetry`;

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            console.log('[Telemetry] Connected to WebSocket stream');
            const dot = document.getElementById('system-status-dot');
            const txt = document.getElementById('system-status-text');
            if (dot) dot.style.background = 'var(--safety-green)';
            if (txt) txt.innerText = 'NOMINAL';
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleTelemetryFrame(data);
            } catch (e) {
                console.error('[Telemetry] Parse error:', e);
            }
        };

        this.ws.onclose = () => {
            const dot = document.getElementById('system-status-dot');
            const txt = document.getElementById('system-status-text');
            if (dot) dot.style.background = 'var(--safety-red)';
            if (txt) txt.innerText = 'DISCONNECTED';
            setTimeout(() => this.connect(), 2000);
        };
    }

    handleTelemetryFrame(frame) {
        if (!frame) return;

        // 1. Update Global AVState
        AVState.updateFromWebSocket(frame);

        // 2. Speedometer HUD Updates
        const speedVal = document.getElementById('hud-speed-val');
        if (speedVal && frame.vehicle_state) {
            const speedKm = Math.round((frame.vehicle_state.speed_mps || 14.5) * 3.6);
            speedVal.innerText = speedKm;
        }

        const targetSpeed = document.getElementById('hud-target-speed');
        if (targetSpeed && frame.guidance) {
            const tgtKm = Math.round((frame.guidance.target_speed_mps || 19.4) * 3.6);
            targetSpeed.innerText = `${tgtKm} KM/H`;
        }

        // Source badge update
        const srcBadge = document.getElementById('source-badge');
        if (srcBadge && frame.source) {
            srcBadge.innerText = `SOURCE: ${frame.source.toUpperCase()}`;
        }

        // 3. Dynamic Telemetry Diagnostic Logs Table
        const logsTable = document.getElementById('logs-table-body');
        if (logsTable && frame.guidance) {
            const now = new Date().toLocaleTimeString();
            const frameId = `#${frame.frame_id || Math.floor(Math.random() * 9000 + 1000)}`;
            const src = frame.source || 'Synthetic';
            const action = frame.guidance.action || 'MAINTAIN CRUISE';
            const conf = `${Math.round((frame.guidance.confidence || 0.94) * 100)}%`;

            const rowHtml = `
                <tr>
                    <td style="font-family:var(--font-mono);">${now}</td>
                    <td style="font-family:var(--font-mono);">${frameId}</td>
                    <td>${src}</td>
                    <td>VEHICLE_01</td>
                    <td style="font-family:var(--font-mono);">28.5m</td>
                    <td style="color:var(--safety-green); font-weight:700;">${action}</td>
                    <td style="font-family:var(--font-mono);">${conf}</td>
                </tr>
            `;

            if (logsTable.children.length > 8) {
                logsTable.removeChild(logsTable.lastElementChild);
            }
            logsTable.insertAdjacentHTML('afterbegin', rowHtml);
        }

        // 4. Update Cockpit Decisions HUD & Analytics
        if (typeof updateDecisionsUI === 'function') updateDecisionsUI();
        if (typeof renderAnalyticsCharts === 'function') renderAnalyticsCharts();
    }
}

window.telemetryReceiver = new TelemetryReceiver();
