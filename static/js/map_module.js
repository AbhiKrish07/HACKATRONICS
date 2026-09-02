/**
 * AV-01 MapLibre Satellite Navigation Map
 * Extracted from maplibre-test/src/main.js — adapted for inline browser use.
 * Initializes on #maplibre-container when the map page is first shown.
 * Vehicle position syncs with ego vehicle physics from AVState.
 */

(function () {
    let mapInstance = null;
    let vehicleMarker = null;
    let mapInitialized = false;

    // Vehicle state mirroring the ego vehicle GPS position (Delhi, India)
    const mapVehicle = {
        longitude: 77.2090,
        latitude: 28.6139,
        heading: 0,
        speed: 0
    };

    // Conversion: 1 degree latitude ≈ 111320m
    const DEG_PER_METER_LAT = 1 / 111320;

    function initMapLibreMap() {
        if (mapInitialized) return;
        const container = document.getElementById('maplibre-container');
        if (!container || typeof maplibregl === 'undefined') return;

        mapInitialized = true;

        mapInstance = new maplibregl.Map({
            container: 'maplibre-container',
            style: {
                version: 8,
                light: {
                    anchor: 'map',
                    color: '#fff4df',
                    intensity: 0.55,
                    position: [1.5, 210, 35]
                },
                sources: {
                    satellite: {
                        type: 'raster',
                        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                        tileSize: 256,
                        maxzoom: 19
                    },
                    openmaptiles: {
                        type: 'vector',
                        url: 'https://tiles.openfreemap.org/planet'
                    }
                },
                layers: [
                    {
                        id: 'satellite',
                        type: 'raster',
                        source: 'satellite'
                    },
                    {
                        id: 'autonav-roads',
                        type: 'line',
                        source: 'openmaptiles',
                        'source-layer': 'transportation',
                        minzoom: 14,
                        paint: {
                            'line-color': 'rgba(255,255,255,0.75)',
                            'line-width': [
                                'interpolate', ['linear'], ['zoom'],
                                14, 1, 16, 2, 18, 5, 20, 9
                            ]
                        }
                    }
                ]
            },
            center: [mapVehicle.longitude, mapVehicle.latitude],
            zoom: 16.5,
            pitch: 65,
            bearing: mapVehicle.heading,
            maxPitch: 82,
            minZoom: 13,
            maxZoom: 20,
            canvasContextAttributes: { antialias: true }
        });

        mapInstance.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

        // Build ego vehicle marker element
        const el = document.createElement('div');
        el.style.cssText = `
            width: 22px; height: 36px;
            display: flex; flex-direction: column;
            align-items: center;
            filter: drop-shadow(0 0 6px rgba(2,136,209,0.9));
        `;
        el.innerHTML = `
            <div style="width:0; height:0; border-left:7px solid transparent; border-right:7px solid transparent; border-bottom:12px solid #0288d1; margin-bottom:-2px;"></div>
            <div style="width:18px; height:24px; background:#0288d1; border-radius:4px 4px 2px 2px; position:relative;">
                <div style="position:absolute; top:3px; left:2px; right:2px; height:8px; background:rgba(255,255,255,0.25); border-radius:2px;"></div>
                <div style="position:absolute; bottom:3px; left:1px; width:5px; height:5px; background:#1a1d26; border-radius:50%;"></div>
                <div style="position:absolute; bottom:3px; right:1px; width:5px; height:5px; background:#1a1d26; border-radius:50%;"></div>
            </div>
        `;

        vehicleMarker = new maplibregl.Marker({
            element: el,
            anchor: 'center',
            rotationAlignment: 'map',
            pitchAlignment: 'map'
        })
        .setLngLat([mapVehicle.longitude, mapVehicle.latitude])
        .addTo(mapInstance);

        mapInstance.on('load', () => {
            // Set sky atmosphere
            mapInstance.setSky({
                'sky-color': '#0d1320',
                'sky-horizon-blend': 0.4,
                'horizon-color': '#1a2438',
                'horizon-fog-blend': 0.3,
                'fog-color': '#0a0d18',
                'fog-ground-blend': 0.2,
                'sky-opacity': 1
            });

            // Add 3D buildings
            const layers = mapInstance.getStyle().layers;
            let labelLayerId;
            for (const layer of layers) {
                if (layer.type === 'symbol' && layer.layout && layer.layout['text-field']) {
                    labelLayerId = layer.id;
                    break;
                }
            }

            if (!mapInstance.getSource('autonav-buildings')) {
                mapInstance.addSource('autonav-buildings', {
                    type: 'vector',
                    url: 'https://tiles.openfreemap.org/planet'
                });
            }

            if (!mapInstance.getLayer('autonav-3d-buildings')) {
                mapInstance.addLayer({
                    id: 'autonav-3d-buildings',
                    type: 'fill-extrusion',
                    source: 'autonav-buildings',
                    'source-layer': 'building',
                    minzoom: 14,
                    filter: ['!=', ['get', 'hide_3d'], true],
                    paint: {
                        'fill-extrusion-color': [
                            'interpolate', ['linear'], ['get', 'render_height'],
                            0, '#1a1d2e', 10, '#161926', 30, '#12151f',
                            60, '#0e1018', 100, '#0a0c14'
                        ],
                        'fill-extrusion-height': [
                            'interpolate', ['linear'], ['zoom'],
                            14, 0,
                            15, ['coalesce', ['get', 'render_height'], 10],
                            16, ['coalesce', ['get', 'render_height'], 10]
                        ],
                        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
                        'fill-extrusion-opacity': 0.85,
                        'fill-extrusion-vertical-gradient': true
                    }
                }, labelLayerId);
            }

            console.log('[MapModule] MapLibre map loaded with satellite + 3D buildings.');
        });

        mapInstance.on('error', (e) => {
            console.error('[MapModule] MapLibre error:', e);
        });

        // Use setInterval at 10Hz — completely decoupled from Three.js 60fps rAF
        setInterval(updateMapVehicle, 100);
    }


    function updateMapVehicle() {
        if (!mapInstance || !vehicleMarker) return;

        const dt = 0.1; // fixed 100ms interval
        const ego = AVState.egoState;

        // Heading: ego.yaw is a small radian value (steering angle, not global bearing).
        // Accumulate it as a slow-turning bearing. Start facing north (heading=0).
        mapVehicle.heading = (mapVehicle.heading + ego.yaw * 25 * dt) % 360;
        if (mapVehicle.heading < 0) mapVehicle.heading += 360;

        mapVehicle.speed = ego.speedMph * 1.609; // km/h display

        // Map movement: use a scaled-down speed to match real-world distances.
        // 3D sim runs at exaggerated scale; realistic street speed ~50 km/h = 13.9 m/s on map
        const mapSpeedMps = Math.min(ego.speedMps, 18) * 0.15; // scale down for map realism
        const headRad = mapVehicle.heading * Math.PI / 180;
        const distM = mapSpeedMps * dt;
        const latPerDegLon = 111320 * Math.cos(mapVehicle.latitude * Math.PI / 180);

        mapVehicle.latitude += (Math.cos(headRad) * distM) / 111320;
        mapVehicle.longitude += (Math.sin(headRad) * distM) / latPerDegLon;

        vehicleMarker.setLngLat([mapVehicle.longitude, mapVehicle.latitude]);
        vehicleMarker.setRotation(mapVehicle.heading);

        // Smooth camera follow — easeTo with duration=0 is non-janky unlike jumpTo
        mapInstance.easeTo({
            center: [mapVehicle.longitude, mapVehicle.latitude],
            bearing: mapVehicle.heading,
            pitch: 65,
            zoom: 17.5,
            duration: 0,
            easing: (t) => t
        });

        // Update speed display
        const speedEl = document.getElementById('map-speed-val');
        if (speedEl) speedEl.textContent = `${Math.round(mapVehicle.speed)} km/h`;
    }

    // Initialize map when map page becomes active
    // Hook into the page router (pages.js calls window.onMapPageActivated)
    window.onMapPageActivated = function () {
        setTimeout(initMapLibreMap, 100); // slight delay to ensure container is visible
    };

    // Also try init if the map page is already active on load
    document.addEventListener('DOMContentLoaded', () => {
        const mapPane = document.getElementById('map');
        if (mapPane && mapPane.classList.contains('active')) {
            setTimeout(initMapLibreMap, 200);
        }
    });
})();
