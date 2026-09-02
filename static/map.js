// static/map.js — MapLibre GL 3D Map View
// - Dark base style (Liberty), pitch 45°, bearing -18°, 3D buildings layer
// - Live ego marker synced from window.AV_MAP_BRIDGE.vehicle state
// - Color-coded hazard markers (low = green, med = amber, high = orange, crit = red)
// - Predicted path dotted lines from each hazard

import * as maplibregl from 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.mjs';

const BASE_LNG = -74.0060;
const BASE_LAT = 40.7128;

window.__mapLibreLoaded = (window.__mapLibreLoaded || 0) + 1;

const map = new maplibregl.Map({
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [BASE_LNG, BASE_LAT],
    zoom: 15.8,
    pitch: 45,
    bearing: -18,
    container: 'map',
    antialias: true,
    canvasContextAttributes: { antialias: true, alpha: false }
});

// Full MapLibre Controls
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showZoom: true, showCompass: true }), 'top-right');
map.addControl(new maplibregl.FullscreenControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

let followEgo = true;
window.__followEgoToggle = () => {
    followEgo = !followEgo;
    return followEgo;
};

const riskColor = {
    low:      '#00D66F', // tesla green
    medium:   '#FFB300', // amber
    high:     '#FF7A3D', // orange
    critical: '#E82127'  // tesla red
};

const riskGlow = {
    low:      'rgba(0, 214, 111, 0.45)',
    medium:   'rgba(255, 179, 0, 0.5)',
    high:     'rgba(255, 122, 61, 0.55)',
    critical: 'rgba(232, 33, 39, 0.65)'
};

// --- Ego marker (car + halo) -------------------------------------------------
const egoEl = document.createElement('div');
egoEl.className = 'ego-marker';
egoEl.innerHTML = `
  <div class="ego-halo"></div>
  <div class="ego-body">
    <svg viewBox="0 0 48 48" width="36" height="36">
      <defs>
        <linearGradient id="egog" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stop-color="#5FA8FF"/>
          <stop offset="1" stop-color="#1F6FEB"/>
        </linearGradient>
      </defs>
      <rect x="10" y="14" width="28" height="20" rx="6" fill="url(#egog)" stroke="#ffffff" stroke-width="1.2"/>
      <rect x="14" y="18" width="20" height="8" rx="2" fill="#0A101C" opacity="0.75"/>
    </svg>
  </div>`;

const egoMarker = new maplibregl.Marker({ element: egoEl, anchor: 'center', rotationAlignment: 'map' })
    .setLngLat([BASE_LNG, BASE_LAT])
    .addTo(map);

// --- Store of hazard markers keyed by hazard_event.id ------------------------
const hazardMarkers = new Map(); // id -> { marker, level, expiresAt }

function elideHazard(elapsedSec = 6.0) {
    const cutoff = performance.now() - elapsedSec * 1000;
    for (const [id, m] of hazardMarkers) {
        if (m.expiresAt < cutoff) {
            m.marker.remove();
            hazardMarkers.delete(id);
        }
    }
}

function upsertHazardMarker(h) {
    const level = (h.risk_level || 'low').toLowerCase();
    const color = riskColor[level] || riskColor.low;
    const glow  = riskGlow[level]  || riskGlow.low;

    let entry = hazardMarkers.get(h.id);
    if (!entry) {
        const el = document.createElement('div');
        el.className = `hz-marker hz-${level}`;
        el.innerHTML = `
          <div class="hz-pulse" style="background:${glow};"></div>
          <div class="hz-dot" style="background:${color}; box-shadow:0 0 0 2px rgba(255,255,255,0.08), 0 0 12px ${glow};"></div>
          <div class="hz-line" style="background:${color};"></div>`;
        const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
            .setLngLat([h.lng, h.lat])
            .addTo(map);
        entry = { marker, level };
        hazardMarkers.set(h.id, entry);
    } else if (entry.level !== level) {
        // update dot/pulse color inline for existing markers
        const dot = entry.marker.getElement().querySelector('.hz-dot');
        const pulse = entry.marker.getElement().querySelector('.hz-pulse');
        const line = entry.marker.getElement().querySelector('.hz-line');
        if (dot)   dot.style.cssText   = `background:${color}; box-shadow:0 0 0 2px rgba(255,255,255,0.08), 0 0 12px ${glow};`;
        if (pulse) pulse.style.cssText = `background:${glow};`;
        if (line)  line.style.background = color;
        entry.marker.getElement().className = `hz-marker hz-${level}`;
        entry.level = level;
    }
    entry.marker.setLngLat([h.lng, h.lat]);
    entry.expiresAt = performance.now() + 6000;
}

// --- Predicted path dotted lines --------------------------------------------
const predictedLineLayers = new Map(); // id -> sourceId

function ensurePredictedSource(id) {
    const srcId = `pred-src-${id}`;
    const lyrId = `pred-line-${id}`;
    if (!map.getSource(srcId)) {
        map.addSource(srcId, {
            type: 'geojson',
            data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } }
        });
        map.addLayer({
            id: lyrId, type: 'line', source: srcId,
            paint: {
                'line-color': [
                    'match', ['get', 'level'],
                    'low',      riskColor.low,
                    'medium',   riskColor.medium,
                    'high',     riskColor.high,
                    'critical', riskColor.critical,
                    riskColor.low
                ],
                'line-width': 3,
                'line-dasharray': [2, 1.5],
                'line-opacity': 0.85
            },
            layout: { 'line-cap': 'round', 'line-join': 'round' }
        });
        predictedLineLayers.set(id, { srcId, lyrId });
    }
    return { srcId, lyrId };
}

function drawPredictedPath(h) {
    if (!h.predicted_path || h.predicted_path.length < 2) return;
    const coords = h.predicted_path.map(p => [p.lng, p.lat]);
    const { srcId } = ensurePredictedSource(h.id);
    const src = map.getSource(srcId);
    if (!src) return;
    src.setData({
        type: 'Feature',
        properties: { level: (h.risk_level || 'low').toLowerCase() },
        geometry: { type: 'LineString', coordinates: coords }
    });
}

// --- 3D buildings + dark paint overrides -----------------------------------
map.on('load', () => {
    // Dark-style paint overrides on Liberty to match AUTONAV theme
    try {
        map.setPaintProperty('background', 'background-color', '#060A14');
        for (const name of ['water', 'ocean']) {
            if (map.getLayer(name)) map.setPaintProperty(name, `${name}-color`, 'rgba(30,50,90,0.55)');
        }
    } catch (e) { /* style layer names differ; cosmetic only */ }

    try {
        // Insert 3D buildings beneath the first label layer
        const layers = map.getStyle().layers || [];
        let labelLayerId;
        for (let i = 0; i < layers.length; i++) {
            if (layers[i].type === 'symbol' &&
                layers[i].layout &&
                typeof layers[i].layout['text-field'] !== 'undefined') {
                labelLayerId = layers[i].id;
                break;
            }
        }

        if (!map.getSource('openfreemap-buildings')) {
            map.addSource('openfreemap-buildings', {
                url: 'https://tiles.openfreemap.org/planet',
                type: 'vector'
            });
        }
        if (!map.getLayer('3d-buildings')) {
            const layerDef = {
                id: '3d-buildings',
                source: 'openfreemap-buildings',
                'source-layer': 'building',
                type: 'fill-extrusion',
                minzoom: 14.5,
                filter: ['!=', ['get', 'hide_3d'], true],
                paint: {
                    'fill-extrusion-color': [
                        'interpolate', ['linear'],
                        ['get', 'render_height'],
                        0,   '#243049',
                        40,  '#2E4168',
                        120, '#3C64A8',
                        260, '#5FA8FF'
                    ],
                    'fill-extrusion-height': [
                        'interpolate', ['linear'], ['zoom'],
                        14.5, 0,
                        15.5, ['*', 0.9, ['get', 'render_height']]
                    ],
                    'fill-extrusion-base': [
                        'case',
                        ['>=', ['get', 'zoom'], 15.5],
                        ['get', 'render_min_height'],
                        0
                    ],
                    'fill-extrusion-opacity': 0.88
                }
            };
            if (labelLayerId) map.addLayer(layerDef, labelLayerId);
            else map.addLayer(layerDef);
        }
    } catch (e) {
        console.warn('[map.js] 3D buildings layer skipped:', e.message);
    }

    // Allow pitch/bearing mouse gestures
    map.dragRotate.enable();
    map.touchPitch.enable();
});

// --- Camera follow: offset the ego marker slightly so forward is visible ----
const camOffset = () => [1e-5, -4.5e-5]; // tiny bearing offset, pitch keeps view ahead

// --- Bridge from app.js (same window, no worker needed) --------------------
// app.js will write to window.AV_MAP_BRIDGE = { vehicle, hazards, lastUpdatedAt }
window.AV_MAP_BRIDGE = window.AV_MAP_BRIDGE || { vehicle: null, hazards: [], lastUpdatedAt: 0 };
const bridge = window.AV_MAP_BRIDGE;

let lastFrameApplied = -1;
function tick() {
    elideHazard(6.0);
    if (bridge.vehicle && (lastFrameApplied !== bridge.vehicle.frame_id)) {
        lastFrameApplied = bridge.vehicle.frame_id;
        const v = bridge.vehicle;
        const lng = v.pos_lng ?? BASE_LNG;
        const lat = v.pos_lat ?? BASE_LAT;
        egoMarker.setLngLat([lng, lat]);
        // Derive heading from bearing on VehicleState (0..360), fallback 0
        const head = (typeof v.heading_deg === 'number') ? v.heading_deg : 0;
        egoEl.style.setProperty('--head', `${head}deg`);
        egoMarker.setRotation(0); // body rotation via CSS transform inside

        // Center map softly on ego if followEgo is enabled
        const c = map.getCenter();
        const dLng = lng - c.lng, dLat = lat - c.lat;
        if (followEgo && Math.hypot(dLng, dLat) > 0.0006) {
            map.easeTo({
                center: [lng, lat],
                duration: 450,
                pitch: 45,
                bearing: -head - 18,
                easing: t => t * (2 - t)
            });
        }
    }
    if (Array.isArray(bridge.hazards)) {
        for (const h of bridge.hazards) {
            if (!h || h.lng == null || h.lat == null) continue;
            try {
                upsertHazardMarker(h);
                if (map.isStyleLoaded()) drawPredictedPath(h);
            } catch (e) { /* style still loading */ }
        }
    }
    requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// Expose helpers for debugging
window.__mapDebug = {
    gotoEgo() {
        if (bridge.vehicle) map.easeTo({ center: [bridge.vehicle.pos_lng ?? BASE_LNG, bridge.vehicle.pos_lat ?? BASE_LAT], zoom: 16, pitch: 45, duration: 350 });
    },
    resetView() { map.flyTo({ center: [BASE_LNG, BASE_LAT], zoom: 15.8, pitch: 45, bearing: -18, duration: 500 }); }
};
