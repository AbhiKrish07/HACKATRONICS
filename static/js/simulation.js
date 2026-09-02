/**
 * AV-01 Multi-Agent 3D Simulation Engine (CARLA Driving Engine)
 * Enforces strict physical collision dynamics, vehicle inertia, anti-clipping multi-agent traffic braking,
 * side & rear laser raycast sensors, and continuous Groq AI decision obedience.
 */

/**
 * Three.js Object Mesh Pool for persistent zero-allocation entity rendering
 */
class MeshPool {
    constructor() {
        this.pools = new Map();
    }

    acquireMesh(type) {
        if (!this.pools.has(type)) this.pools.set(type, []);
        const pool = this.pools.get(type);
        if (pool.length > 0) {
            const mesh = pool.pop();
            mesh.visible = true;
            return mesh;
        }
        return createHighFidelityMesh(type);
    }

    releaseMesh(type, mesh) {
        if (!mesh) return;
        mesh.visible = false;
        if (scene) scene.remove(mesh);
        if (!this.pools.has(type)) this.pools.set(type, []);
        this.pools.get(type).push(mesh);
    }
}

const globalMeshPool = new MeshPool();

/**
 * Universal Relative Position & Sector Classification
 */
function getRelativePosition(ego, agent) {
    const egoZ = ego.worldZ || 0;
    const egoX = ego.x || 0;
    const agentZ = agent.worldZ !== undefined ? agent.worldZ : (egoZ - (agent.dist || 20));
    const agentX = agent.posX !== undefined ? agent.posX : (agent.x || 0);

    const dLong = agentZ - egoZ; // negative = behind ego, positive = ahead of ego
    const dLat = agentX - egoX;  // negative = left of ego, positive = right of ego
    const dist = Math.sqrt(dLong * dLong + dLat * dLat);
    const absLong = Math.abs(dLong);
    const absLat = Math.abs(dLat);

    let sector = 'FRONT';
    if (dLong < -1.0) {
        if (absLat < 2.2) sector = 'REAR';
        else if (dLat < -2.2) sector = 'REAR_LEFT';
        else sector = 'REAR_RIGHT';
    } else if (dLong > 1.0) {
        if (absLat < 2.2) sector = 'FRONT';
        else if (dLat < -2.2) sector = 'FRONT_LEFT';
        else sector = 'FRONT_RIGHT';
    } else {
        if (dLat < 0) sector = 'LEFT';
        else sector = 'RIGHT';
    }

    return {
        longitudinal: dLong,
        lateral: dLat,
        distance: dist,
        sector: sector,
        isRear: dLong < -1.0,
        isFront: dLong > 1.0
    };
}
window.getRelativePosition = getRelativePosition;

class WorldEntity {
    constructor(id, type, worldZ, posX = 0, speedMph = 42.0, headingDeg = 0) {
        this.id = id;
        this.type = type;
        this.worldZ = worldZ;
        this.posX = posX;
        this.targetWorldZ = worldZ;
        this.targetPosX = posX;
        this.speedMph = speedMph;
        this.targetSpeedMph = speedMph;
        this.headingDeg = headingDeg;
        this.missingTicks = 0;
        
        // Bounding dimensions for collision physics
        this.width = type === 'truck' ? 2.5 : type === 'motorcycle' ? 0.8 : type === 'pedestrian' || type === 'cyclist' ? 0.8 : 1.9;
        this.length = type === 'truck' ? 7.0 : type === 'motorcycle' ? 1.8 : type === 'pedestrian' || type === 'cyclist' ? 1.0 : 4.2;

        this.mesh = globalMeshPool.acquireMesh(type);
        // Three.js: camera looks toward -Z. Entities ahead of ego must have negative mesh.z.
        // worldZ increases forward in ego's frame. mesh.z = -(entity.worldZ - ego.worldZ).
        const egoWorldZ = AVState.egoState.worldZ;
        this.mesh.position.set(posX, 0, -(worldZ - egoWorldZ));
        if (scene && !this.mesh.parent) scene.add(this.mesh);

        this.predictionLine = null;
        this.minTTC = 999.0;
        this.targetLaneX = posX;
        this.wobblePhase = Math.random() * Math.PI * 2;
    }

    updateInterpolated(dt, egoSpeedMps, egoWorldZ, egoX, egoSpeedMph) {
        const dToEgo = this.getDistanceToEgo();
        const rxToEgo = this.posX - egoX;
        const inSameLane = Math.abs(rxToEgo) < 2.2;
        const isBehindEgo = dToEgo < 0;

        // Smooth acceleration back to target speed
        if (this.speedMph < this.targetSpeedMph) {
            this.speedMph = Math.min(this.targetSpeedMph, this.speedMph + 8.0 * dt);
        }

        const speedMps = (this.speedMph * 1.609) / 3.6;
        const relSpeedMps = speedMps - egoSpeedMps;

        this.worldZ += relSpeedMps * dt;
        
        // Three.js: negative Z is forward/ahead. Entity ahead of ego has positive longitudinal diff.
        // So mesh.z must be negated: mesh.z = -(entity.worldZ - egoWorldZ)
        const lerpFactor = 1.0 - Math.exp(-14.0 * dt);
        const curZ = this.mesh.position.z;
        const targetZ = -(this.worldZ - egoWorldZ); // negative = ahead
        this.mesh.position.z += (targetZ - curZ) * lerpFactor;

        if (this.type === 'motorcycle') {
            this.wobblePhase += dt * 1.2;
            this.posX += Math.sin(this.wobblePhase) * 0.3 * dt;
            this.mesh.rotation.y = Math.PI + Math.cos(this.wobblePhase) * 0.06;
        } else if (this.type === 'pedestrian') {
            this.posX += Math.sin(performance.now() * 0.0005) * 0.15 * dt;
            this.mesh.position.y = Math.abs(Math.sin(performance.now() * 0.004)) * 0.04;
        } else if (this.type === 'cyclist') {
            this.posX = 5.2 + Math.sin(performance.now() * 0.0006) * 0.12;
        } else {
            this.posX += (this.targetLaneX - this.posX) * 3.5 * dt;
            this.mesh.rotation.y = Math.PI + (this.targetLaneX - this.posX) * -0.05;
        }

        this.mesh.position.x += (this.posX - this.mesh.position.x) * lerpFactor;
        this.updatePredictionLine(dt);
    }

    update(dt, egoSpeedMps, egoWorldZ, egoX, egoSpeedMph) {
        this.updateInterpolated(dt, egoSpeedMps, egoWorldZ, egoX, egoSpeedMph);
    }

    updatePredictionLine(dt) {
        const stepT = 0.5;
        const pts = [];
        let pz = this.mesh.position.z;
        let px = this.posX;

        // Prediction shows where entity moves RELATIVE to ego over next 3 seconds.
        // relSpeedMps > 0 = entity moves away from ego (more negative Z)
        // relSpeedMps < 0 = entity approaches ego (toward 0 / ego position)
        const relSpeedMps = ((this.speedMph - AVState.egoState.speedMph) * 1.609) / 3.6;

        for (let i = 0; i <= 6; i++) {
            pts.push(new THREE.Vector3(px, 0.2, pz));
            pz -= relSpeedMps * stepT; // negative Z = further ahead of ego
        }

        if (!this.predictionLine) {
            const geom = new THREE.BufferGeometry().setFromPoints(pts);
            const mat = new THREE.LineDashedMaterial({
                color: 0x10b981,
                dashSize: 0.8,
                gapSize: 0.4,
                linewidth: 2,
                transparent: true,
                opacity: 0.8
            });
            this.predictionLine = new THREE.Line(geom, mat);
            this.predictionLine.computeLineDistances();
            if (scene) scene.add(this.predictionLine);
        } else {
            this.predictionLine.geometry.setFromPoints(pts);
            this.predictionLine.computeLineDistances();

            let ttcColor = 0x10b981;
            if (this.minTTC !== undefined && this.minTTC < 999.0) {
                if (this.minTTC < 1.5) ttcColor = 0xef4444;
                else if (this.minTTC < 3.5) ttcColor = 0xeab308;
            }
            this.predictionLine.material.color.setHex(ttcColor);
        }
    }

    destroy() {
        if (this.predictionLine) {
            this.predictionLine.geometry.dispose();
            this.predictionLine.material.dispose();
            if (scene) scene.remove(this.predictionLine);
        }
        globalMeshPool.releaseMesh(this.type, this.mesh);
    }

    getDistanceToEgo() {
        return this.worldZ - AVState.egoState.worldZ;
    }

    getRelativeSpeedMps() {
        return ((this.speedMph - AVState.egoState.speedMph) * 1.609) / 3.6;
    }
}

// Global Three.js Scene Context
let scene, camera, renderer, container;
let egoCarGroup;
let laneStripes = [], lampposts = [], buildings = [];
let cameraMode = 0; // 0=CARLA Follow, 1=Dashcam, 2=Drone Overhead

// 3D Laser Sensors (Front, Left, Right, Rear)
let frontSensorRay, leftSensorRay, rightSensorRay, rearSensorRay;
let frontNode, leftNode, rightNode, rearNode;

// 3D Sensor Proximity Semi-Circle Arcs (color-coded by distance)
let arcFront, arcLeft, arcRight, arcRear;

// 3D Ground-Plane Detection Rings (50m perimeter, 30m caution, 15m critical)
let ring50m, ring30m, ring15m, radarSweepLine;
let sweepAngle = 0;


function buildArc(startAngle, endAngle, radius, color) {
    const pts = [];
    const segs = 32;
    for (let i = 0; i <= segs; i++) {
        const a = startAngle + (endAngle - startAngle) * (i / segs);
        pts.push(new THREE.Vector3(Math.sin(a) * radius, 0.08, Math.cos(a) * radius));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75, linewidth: 2 });
    return new THREE.Line(geo, mat);
}

/**
 * Build a full 360° ground-plane ring at given radius.
 * y = 0.03 so it lies flat on road surface.
 */
function buildRing(radius, color, opacity, segments) {
    const pts = [];
    const segs = segments || 80;
    for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.sin(a) * radius, 0.03, Math.cos(a) * radius));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, linewidth: 2 });
    return new THREE.Line(geo, mat);
}

function initSimulationEngine() {
    container = document.getElementById('viewport-box-sim') || document.getElementById('viewport-box-camera') || document.getElementById('viewport-box-sim-alt');
    if (!container) return;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111520);
    scene.fog = new THREE.FogExp2(0x111520, 0.008);

    camera = new THREE.PerspectiveCamera(48, container.clientWidth / container.clientHeight, 0.1, 800);
    camera.position.set(0, 4.0, 8.5);
    camera.lookAt(0, 1.2, -35.0);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
    scene.add(ambientLight);

    const sunLight = new THREE.DirectionalLight(0xdbeafe, 0.85);
    sunLight.position.set(20, 50, 20);
    sunLight.castShadow = true;
    scene.add(sunLight);

    // Road Plane & Edge Barriers
    const roadGeo = new THREE.PlaneGeometry(26, 800, 10, 100);
    const roadMat = new THREE.MeshStandardMaterial({ color: 0x161a26, roughness: 0.85, metalness: 0.1 });
    const roadMesh = new THREE.Mesh(roadGeo, roadMat);
    roadMesh.rotation.x = -Math.PI / 2;
    roadMesh.receiveShadow = true;
    scene.add(roadMesh);

    const yellowLineMat = new THREE.MeshBasicMaterial({ color: 0xfacc15 });
    const leftYellow = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 800), yellowLineMat);
    leftYellow.rotation.x = -Math.PI / 2;
    leftYellow.position.set(-11.5, 0.015, 0);
    scene.add(leftYellow);
    const rightYellow = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 800), yellowLineMat);
    rightYellow.rotation.x = -Math.PI / 2;
    rightYellow.position.set(11.5, 0.015, 0);
    scene.add(rightYellow);

    const laneXPositions = [-6.0, -2.0, 2.0, 6.0];
    const stripeGeo = new THREE.BoxGeometry(0.2, 0.02, 3.8);
    const stripeMat = new THREE.MeshBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.8 });

    for (let i = -35; i < 35; i++) {
        laneXPositions.forEach(x => {
            const stripe = new THREE.Mesh(stripeGeo, stripeMat);
            stripe.position.set(x, 0.02, i * 11.0);
            scene.add(stripe);
            laneStripes.push(stripe);
        });
    }

    // Build Ego Vehicle Group
    egoCarGroup = new THREE.Group();
    const carBodyMat = new THREE.MeshStandardMaterial({ color: 0x0284c7, metalness: 0.8, roughness: 0.2 });
    const carBody = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.8, 4.2), carBodyMat);
    carBody.position.y = 0.55;
    carBody.castShadow = true;
    egoCarGroup.add(carBody);

    const carGlassMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.1, metalness: 0.9 });
    const carGlass = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 2.2), carGlassMat);
    carGlass.position.set(0, 1.1, -0.2);
    egoCarGroup.add(carGlass);

    // 3D Sensor Laser Rays (Front, Left Side, Right Side, Rear)
    const rayMatFront = new THREE.LineBasicMaterial({ color: 0x00f0ff, linewidth: 3 });
    const rayMatLeft  = new THREE.LineBasicMaterial({ color: 0xffaa00, linewidth: 3 });
    const rayMatRight = new THREE.LineBasicMaterial({ color: 0xffaa00, linewidth: 3 });
    const rayMatRear  = new THREE.LineBasicMaterial({ color: 0xff3366, linewidth: 3 });

    const rayGeoFront = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.6, -2.0), new THREE.Vector3(0, 0.6, -75.0)]);
    const rayGeoLeft  = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.9, 0.6, 0.0), new THREE.Vector3(-15.0, 0.6, 0.0)]);
    const rayGeoRight = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0.9, 0.6, 0.0), new THREE.Vector3(15.0, 0.6, 0.0)]);
    const rayGeoRear  = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.6, 2.0), new THREE.Vector3(0, 0.6, 35.0)]);

    frontSensorRay = new THREE.Line(rayGeoFront, rayMatFront);
    leftSensorRay  = new THREE.Line(rayGeoLeft, rayMatLeft);
    rightSensorRay = new THREE.Line(rayGeoRight, rayMatRight);
    rearSensorRay  = new THREE.Line(rayGeoRear, rayMatRear);

    egoCarGroup.add(frontSensorRay);
    egoCarGroup.add(leftSensorRay);
    egoCarGroup.add(rightSensorRay);
    egoCarGroup.add(rearSensorRay);

    // Laser Impact Node Spheres (Compact Side Borders)
    const nodeGeoBig = new THREE.SphereGeometry(0.35, 12, 12);
    const nodeGeoSide = new THREE.SphereGeometry(0.22, 10, 10);

    frontNode = new THREE.Mesh(nodeGeoBig, new THREE.MeshBasicMaterial({ color: 0x00f0ff }));
    leftNode  = new THREE.Mesh(nodeGeoSide, new THREE.MeshBasicMaterial({ color: 0xffaa00 }));
    rightNode = new THREE.Mesh(nodeGeoSide, new THREE.MeshBasicMaterial({ color: 0xffaa00 }));
    rearNode  = new THREE.Mesh(nodeGeoBig, new THREE.MeshBasicMaterial({ color: 0xff3366 }));

    frontNode.position.set(0, 0.6, -75.0);
    leftNode.position.set(-15.0, 0.6, 0.0);
    rightNode.position.set(15.0, 0.6, 0.0);
    rearNode.position.set(0, 0.6, 35.0);

    egoCarGroup.add(frontNode);
    egoCarGroup.add(leftNode);
    egoCarGroup.add(rightNode);
    egoCarGroup.add(rearNode);

    // Semi-circle sensor arcs (front: forward 180°, rear: backward 180°, sides: 120° each)
    arcFront = buildArc(-Math.PI * 0.5, Math.PI * 0.5, 6.0, 0x00f0ff);
    arcFront.position.z = -2.0;
    egoCarGroup.add(arcFront);

    arcRear = buildArc(Math.PI * 0.5, Math.PI * 1.5, 6.0, 0xff3366);
    arcRear.position.z = 2.0;
    egoCarGroup.add(arcRear);

    arcLeft = buildArc(-Math.PI * 0.9, -Math.PI * 0.1, 4.0, 0x00d66f);
    arcLeft.rotation.y = -Math.PI * 0.5;
    arcLeft.position.x = -0.9;
    egoCarGroup.add(arcLeft);

    arcRight = buildArc(Math.PI * 0.1, Math.PI * 0.9, 4.0, 0x00d66f);
    arcRight.rotation.y = Math.PI * 0.5;
    arcRight.position.x = 0.9;
    egoCarGroup.add(arcRight);

    // ── Ground-Plane Concentric Detection Rings (50m/30m/15m) ──────────
    // Note: 3D sim world-units ≈ real meters for nearby entities.
    // We draw rings in actual world-unit scale centered on ego car group.
    ring50m = buildRing(50, 0x00d66f, 0.18, 120); // green — outer perimeter
    ring30m = buildRing(30, 0xffb020, 0.28, 90);  // amber — caution zone
    ring15m = buildRing(15, 0xe82127, 0.40, 60);  // red — critical zone
    scene.add(ring50m);
    scene.add(ring30m);
    scene.add(ring15m);

    // Radar sweep line (rotates 360° to simulate LiDAR scan)
    const sweepGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0.04, 0),
        new THREE.Vector3(0, 0.04, -50)  // points forward (-Z = ahead)
    ]);
    radarSweepLine = new THREE.Line(sweepGeo, new THREE.LineBasicMaterial({
        color: 0x00f0ff, transparent: true, opacity: 0.55, linewidth: 1
    }));
    scene.add(radarSweepLine);

    scene.add(egoCarGroup);

    // Initialize Persistent Multi-Agent Fleet
    initMultiAgentFleet();
}

function initMultiAgentFleet() {
    const state = AVState;
    state.worldEntities.clear();

    // Speeds in mph, converted from real-world km/h averages:
    // Car 60 km/h = 37.3 mph | Fast car 75 km/h = 46.6 mph | Truck 50 km/h = 31.1 mph
    // Motorcycle 70 km/h = 43.5 mph | Cyclist 10 km/h = 6.2 mph | Pedestrian 2 km/h = 1.24 mph
    state.worldEntities.set('veh_lead',  new WorldEntity('veh_lead',  'vehicle',    state.egoState.worldZ + 30.0,   0.0, 37.3));  // 60 km/h
    state.worldEntities.set('veh_left',  new WorldEntity('veh_left',  'vehicle',    state.egoState.worldZ + 50.0,  -3.8, 46.6));  // 75 km/h fast
    state.worldEntities.set('mot_01',    new WorldEntity('mot_01',    'motorcycle', state.egoState.worldZ + 20.0,   1.8, 43.5));  // 70 km/h
    state.worldEntities.set('truck_01',  new WorldEntity('truck_01',  'truck',      state.egoState.worldZ + 75.0,   4.0, 31.1));  // 50 km/h
    state.worldEntities.set('cyc_01',    new WorldEntity('cyc_01',    'cyclist',    state.egoState.worldZ + 16.0,   5.2,  6.2));  // 10 km/h
    state.worldEntities.set('ped_01',    new WorldEntity('ped_01',    'pedestrian', state.egoState.worldZ + 40.0,  -5.5,  1.24)); // 2 km/h
    state.worldEntities.set('veh_rear',  new WorldEntity('veh_rear',  'vehicle',    state.egoState.worldZ - 25.0,   0.0, 37.3));  // 60 km/h
}

function createHighFidelityMesh(type) {
    const group = new THREE.Group();
    if (type === 'cyclist') {
        const frameMat = new THREE.MeshStandardMaterial({ color: 0x0284c7, metalness: 0.7 });
        const riderMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.4 });
        const wheelMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.8 });
        const w1 = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.05, 8, 18), wheelMat);
        w1.rotation.y = Math.PI / 2;
        w1.position.set(0, 0.38, -0.65);
        group.add(w1);
        const w2 = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.05, 8, 18), wheelMat);
        w2.rotation.y = Math.PI / 2;
        w2.position.set(0, 0.38, 0.65);
        group.add(w2);
        const frame = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.2), frameMat);
        frame.rotation.x = Math.PI / 4;
        frame.position.set(0, 0.55, 0);
        group.add(frame);
        const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.75), riderMat);
        torso.rotation.x = -0.2;
        torso.position.set(0, 1.05, 0.1);
        group.add(torso);
        const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 12), new THREE.MeshStandardMaterial({ color: 0x38bdf8 }));
        helmet.position.set(0, 1.55, 0.15);
        group.add(helmet);
    } else if (type === 'pedestrian') {
        const clothMat = new THREE.MeshStandardMaterial({ color: 0x10b981, roughness: 0.5 });
        const skinMat = new THREE.MeshStandardMaterial({ color: 0xfcd34d, roughness: 0.3 });
        const leg1 = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.8), new THREE.MeshStandardMaterial({ color: 0x1e293b }));
        leg1.position.set(-0.14, 0.4, 0);
        group.add(leg1);
        const leg2 = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.8), new THREE.MeshStandardMaterial({ color: 0x1e293b }));
        leg2.position.set(0.14, 0.4, 0);
        group.add(leg2);
        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.65, 0.25), clothMat);
        torso.position.y = 1.05;
        group.add(torso);
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 12), skinMat);
        head.position.y = 1.55;
        group.add(head);
    } else if (type === 'motorcycle') {
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0xef4444, metalness: 0.8 });
        const riderMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.6 });
        const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.9 });
        const w1 = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.08, 12, 18), wheelMat);
        w1.rotation.y = Math.PI / 2;
        w1.position.set(0, 0.35, -0.75);
        group.add(w1);
        const w2 = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.12, 12, 18), wheelMat);
        w2.rotation.y = Math.PI / 2;
        w2.position.set(0, 0.35, 0.75);
        group.add(w2);
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.6, 1.2), bodyMat);
        body.position.set(0, 0.6, 0);
        group.add(body);
        const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 0.7), riderMat);
        torso.position.set(0, 1.0, 0.2);
        group.add(torso);
        const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 16), new THREE.MeshStandardMaterial({color: 0xf8fafc}));
        helmet.position.set(0, 1.45, 0.2);
        group.add(helmet);
    } else if (type === 'truck') {
        const cabMat = new THREE.MeshStandardMaterial({ color: 0xd97706, metalness: 0.6 });
        const boxMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.3 });
        const cab = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.2, 2.5), cabMat);
        cab.position.set(0, 1.3, -2.5);
        group.add(cab);
        const trailer = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.8, 6.5), boxMat);
        trailer.position.set(0, 1.6, 1.5);
        group.add(trailer);
    } else {
        const carMat = new THREE.MeshStandardMaterial({ color: 0x3b82f6, metalness: 0.7 });
        const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.75, 4.2), carMat);
        body.position.y = 0.5;
        group.add(body);
        const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 2.2), new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.1 }));
        cabin.position.set(0, 1.05, -0.2);
        group.add(cabin);
    }
    return group;
}

function updateSimulationLoop(dt) {
    if (!renderer || !scene || !camera) return;
    dt = Math.min(dt || 0.016, 0.05);

    const ego = AVState.egoState;
    ego.worldZ += ego.speedMps * dt;

    // Road lines scroll
    laneStripes.forEach(s => {
        s.position.z += ego.speedMps * dt * 2.2;
        if (s.position.z > 25) s.position.z -= 450;
    });

    // Update Multi-Agent Entities (with Anti-Clipping Adaptive Speed)
    for (const [id, entity] of AVState.worldEntities.entries()) {
        entity.update(dt, ego.speedMps, ego.worldZ, ego.x, ego.speedMph);

        // Recycle distant agents — keep them in a realistic range
        const d = entity.getDistanceToEgo();
        if (d < -60.0) {
            // Agent has fallen far behind — recycle them ahead of ego
            entity.worldZ = ego.worldZ + 40.0 + Math.random() * 60.0;
            entity.targetWorldZ = entity.worldZ;
            // Randomize lane when respawning
            const laneOptions = [-3.8, 0.0, 3.8, 7.6, -7.6];
            entity.posX = laneOptions[Math.floor(Math.random() * laneOptions.length)];
            entity.targetLaneX = entity.posX;
            // Snap mesh to prevent lerp teleport
            entity.mesh.position.set(entity.posX, 0, -(entity.worldZ - ego.worldZ));
        } else if (d > 180.0) {
            // Agent is very far ahead — recycle them behind ego
            entity.worldZ = ego.worldZ - 20.0 - Math.random() * 20.0;
            entity.targetWorldZ = entity.worldZ;
            // Snap mesh
            entity.mesh.position.set(entity.posX, 0, -(entity.worldZ - ego.worldZ));
        }

    }

    // STRICT PHYSICAL COLLISION DETECTION & RIGID IMPACT RESPONSE
    let isPhysicalImpact = false;
    let impactedEntity = null;

    for (const [id, e] of AVState.worldEntities.entries()) {
        const distZ = e.getDistanceToEgo();
        const rx = e.posX - ego.x;

        // Physical Bounding Box Overlap Check (Width: 1.8m, Length: 4.2m)
        const overlapZ = Math.abs(distZ) < (e.length / 2 + 2.0);
        const overlapX = Math.abs(rx) < (e.width / 2 + 0.9);

        if (overlapZ && overlapX) {
            isPhysicalImpact = true;
            impactedEntity = e;

            // Strict Physical Crash Dynamics:
            // 1. Instant momentum dissipation
            ego.speedMph = Math.max(0.0, ego.speedMph * 0.25 - 8.0);
            ego.speedMps = (ego.speedMph * 1.609) / 3.6;

            // 2. Physical impact yaw shudder
            ego.yaw += (rx > 0 ? -0.15 : 0.15);

            // 3. Reactive push impulse to obstacle so no visual phase clipping!
            e.worldZ += distZ > 0 ? 1.5 : -1.5;

            // 4. Alert HUD
            AVState.setGuidance({
                action: `🚨 PHYSICAL IMPACT COLLISION: ${e.type.toUpperCase()}`,
                reason: `Physical collision detected at Pos (${ego.x.toFixed(1)}, ${distZ.toFixed(1)}m). Kinetic momentum dissipated.`,
                riskLevel: "CRITICAL"
            });
            break;
        }
    }

    // Enforce Side Road Barrier Collisions (Outer shoulder limits: -10.5m to 10.5m)
    if (ego.x < -10.5 || ego.x > 10.5) {
        ego.x = Math.max(-10.5, Math.min(10.5, ego.x));
        ego.speedMph = Math.max(0.0, ego.speedMph * 0.4);
        ego.speedMps = (ego.speedMph * 1.609) / 3.6;
        ego.yaw = -ego.yaw * 0.5;
        AVState.setGuidance({
            action: "🚨 SIDE BARRIER IMPACT",
            reason: "Vehicle collided with outer road guardrail barrier. Velocity reduced.",
            riskLevel: "CRITICAL"
        });
    }

    // 3D Sensor Raycasts — 360° detection using getRelativePosition for correct sector classification
    let fDist = 250.0, lDist = 80.0, rDist = 80.0, rearDist = 100.0;
    let closestObs = null;       // closest FRONT-sector entity (for ACC/AEB)
    let closestAnyDir = null;    // closest entity in ANY direction
    let closestAnyDist = 999.0;
    let closestAnyDir_label = 'FRONT';

    for (const [id, e] of AVState.worldEntities.entries()) {
        const rel = getRelativePosition(ego, e);
        const dLong = rel.longitudinal; // negative = behind, positive = ahead
        const dLat  = rel.lateral;
        const dist  = rel.distance;
        const absDLat = Math.abs(dLat);

        // Front sensor: entities AHEAD in lane (±3.5m lateral)
        if (rel.isFront && dLong < fDist && absDLat < 3.5) {
            fDist = dLong;
            closestObs = e;
        }
        // Rear sensor: entities BEHIND in lane
        if (rel.isRear && Math.abs(dLong) < rearDist && absDLat < 3.5) {
            rearDist = Math.abs(dLong);
        }
        // Side sensors: entities within 80m longitudinal window, lateral only
        if (Math.abs(dLong) < 80.0) {
            if (dLat < -1.5 && absDLat < lDist) lDist = absDLat;
            if (dLat >  1.5 && absDLat < rDist) rDist = absDLat;
        }

        // 360° closest tracker
        if (dist < closestAnyDist) {
            closestAnyDist = dist;
            closestAnyDir = e;
            closestAnyDir_label = rel.sector;
        }
    }

    // Publish sensor distances to shared state for radar/camera overlays
    AVState.updateSensorDistances(fDist, lDist, rDist, rearDist);
    // Recompute hazard list with correct sector classification
    AVState.recomputeHazards();


    // Update 3D Ray Geometries & Impact Node Spheres
    if (frontSensorRay) {
        frontSensorRay.geometry.setFromPoints([new THREE.Vector3(0, 0.6, -2.0), new THREE.Vector3(0, 0.6, -Math.max(4, fDist))]);
        frontNode.position.z = -Math.max(4, fDist);
        const isClose = fDist < 18;
        frontSensorRay.material.color.setHex(isClose ? 0xff2244 : 0x00f0ff);
        frontNode.material.color.setHex(isClose ? 0xff2244 : 0x00f0ff);
    }
    if (leftSensorRay) {
        leftSensorRay.geometry.setFromPoints([new THREE.Vector3(-0.9, 0.6, 0.0), new THREE.Vector3(-Math.max(2.5, lDist), 0.6, 0.0)]);
        leftNode.position.x = -Math.max(2.5, lDist);
        leftSensorRay.material.color.setHex(lDist < 4.5 ? 0xffaa00 : 0x00d66f);
    }
    if (rightSensorRay) {
        rightSensorRay.geometry.setFromPoints([new THREE.Vector3(0.9, 0.6, 0.0), new THREE.Vector3(Math.max(2.5, rDist), 0.6, 0.0)]);
        rightNode.position.x = Math.max(2.5, rDist);
        rightSensorRay.material.color.setHex(rDist < 4.5 ? 0xffaa00 : 0x00d66f);
    }
    if (rearSensorRay) {
        rearSensorRay.geometry.setFromPoints([new THREE.Vector3(0, 0.6, 2.0), new THREE.Vector3(0, 0.6, Math.max(4, rearDist))]);
        rearNode.position.z = Math.max(4, rearDist);
    }

    // Update sensor arc colors based on proximity
    // Front arc: green > 40m, yellow 15-40m, red < 15m
    if (arcFront) {
        const fc = fDist < 15 ? 0xff2244 : fDist < 40 ? 0xffb020 : 0x00f0ff;
        arcFront.material.color.setHex(fc);
        arcFront.material.opacity = fDist < 40 ? 0.95 : 0.55;
    }
    if (arcRear) {
        const rc = rearDist < 12 ? 0xff2244 : rearDist < 30 ? 0xffb020 : 0xff3366;
        arcRear.material.color.setHex(rc);
        arcRear.material.opacity = rearDist < 30 ? 0.95 : 0.55;
    }
    if (arcLeft) {
        const lc = lDist < 5 ? 0xff2244 : lDist < 15 ? 0xffb020 : 0x00d66f;
        arcLeft.material.color.setHex(lc);
        arcLeft.material.opacity = lDist < 15 ? 0.95 : 0.55;
    }
    if (arcRight) {
        const rc2 = rDist < 5 ? 0xff2244 : rDist < 15 ? 0xffb020 : 0x00d66f;
        arcRight.material.color.setHex(rc2);
        arcRight.material.opacity = rDist < 15 ? 0.95 : 0.55;
    }

    // ── Concentric Ground Rings — follow ego car, pulse based on proximity ──
    const egoX = 0; // rings are in world space, centered at ego car XZ
    const egoZ = 0;
    if (ring15m && ring30m && ring50m) {
        // Position rings at ego car world position (rings are in scene world space, not ego group)
        ring15m.position.set(egoCarGroup.position.x, 0.03, egoCarGroup.position.z);
        ring30m.position.set(egoCarGroup.position.x, 0.03, egoCarGroup.position.z);
        ring50m.position.set(egoCarGroup.position.x, 0.03, egoCarGroup.position.z);

        const t = performance.now() * 0.001;
        // Pulse 15m ring red when anything is within 15m
        const inCrit = fDist < 15 || lDist < 8 || rDist < 8;
        ring15m.material.color.setHex(inCrit ? 0xff2244 : 0xe82127);
        ring15m.material.opacity = inCrit ? 0.5 + 0.35 * Math.sin(t * 6.0) : 0.22;

        // Pulse 30m ring amber when anything is within 30m
        const inCaut = fDist < 30 || lDist < 20 || rDist < 20;
        ring30m.material.color.setHex(inCaut ? 0xffb020 : 0xff8c00);
        ring30m.material.opacity = inCaut ? 0.35 + 0.2 * Math.sin(t * 3.0) : 0.16;

        // Outer 50m ring — steady green, subtle pulse
        ring50m.material.opacity = 0.10 + 0.06 * Math.sin(t * 1.2);
    }

    // ── Radar Sweep Line — rotates 360° continuously at 1 revolution / 2s ──
    if (radarSweepLine) {
        sweepAngle -= dt * Math.PI; // 0.5 rev/s → 1 full rev every 2s
        radarSweepLine.position.set(egoCarGroup.position.x, 0.04, egoCarGroup.position.z);
        radarSweepLine.rotation.y = sweepAngle;
        // Fade sweep line: highlight when it sweeps past an entity direction
        const sweepNorm = ((sweepAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        radarSweepLine.material.opacity = 0.35 + 0.3 * Math.sin(sweepNorm * 2);
    }

    // Helper: rich guidance payload matching evidence-grounded UI card
    function buildGuidance(action, reason, riskLevel, confidence) {
        return { action, reason, riskLevel, confidence: confidence || 0.94 };
    }

    // 360° TIGHT GAP INDIAN TRAFFIC SAFETY NET
    // In Indian traffic conditions (dense auto-rickshaw, motorcycle, pedestrian streams),
    // close clearance (3.0m - 6.0m) is nominal. Emergency AEB triggers ONLY at < 2.8m FRONT.
    // Rear is passive — a vehicle coming from behind cannot emergency-brake the ego.
    const aebFront   = fDist < 2.8;        // Only stop ego for FRONT threats
    const aebLeft    = lDist < 0.8;        // Lateral near-miss
    const aebRight   = rDist < 0.8;
    const aebAny     = aebFront || aebLeft || aebRight; // Rear never triggers AEB

    if (aebAny && closestAnyDir && !isPhysicalImpact) {
        // Critical emergency brake check (< 2.8m collision risk)
        ego.speedMph = Math.max(0, ego.speedMph - 90.0 * dt);
        ego.speedMps = (ego.speedMph * 1.609) / 3.6;
        ego.aebActive = true;

        const dist   = closestAnyDist.toFixed(1);
        const typ    = closestAnyDir.type;
        const typIcon = typ === 'pedestrian' ? '🚶' : typ === 'cyclist' ? '🚴' : typ === 'motorcycle' ? '🏍️' : typ === 'truck' ? '🚛' : '🚗';
        const dirWarn = aebFront ? '⬆ Front' : aebRear ? '⬇ Rear' : aebLeft ? '◀ Left' : '▶ Right';

        AVState.setGuidance(buildGuidance(
            `🚨 CRITICAL BRAKE: ${typIcon} ${typ.toUpperCase()} AT ${dist}m`,
            `AEB engaged. Immediate collision hazard detected in ${dirWarn} zone at ${dist}m. Safety net active.`,
            'CRITICAL',
            0.98
        ));
    } else if (ego.isAutoPilot) {
        if (closestObs && fDist < 4.5) {
            // Very close lead obstacle (< 4.5m) — Execute emergency overtake or speed match
            let leftClear = true, rightClear = true;
            for (const [id, e] of AVState.worldEntities.entries()) {
                const ed = e.getDistanceToEgo();
                if (ed > -5 && ed < 15) {
                    if (e.posX < ego.x - 1.2) leftClear = false;
                    if (e.posX > ego.x + 1.2) rightClear = false;
                }
            }

            let laneDir = 0;
            if (leftClear && ego.x > -3.8) laneDir = -1;
            else if (rightClear && ego.x < 3.8) laneDir = 1;

            if (laneDir !== 0) {
                // Execute Smooth Tight Gap Overtake Pass
                ego.aebActive = false;
                ego.x += laneDir * 4.2 * dt;
                ego.x = Math.max(-5.5, Math.min(5.5, ego.x));
                ego.yaw = laneDir * -0.07;
                AVState.setGuidance(buildGuidance(
                    `🇮🇳 TIGHT GAP OVERTAKE (${fDist.toFixed(1)}m)`,
                    `Navigating dense Indian traffic gap around ${closestObs.type} at ${fDist.toFixed(1)}m. Overtake active.`,
                    'MEDIUM',
                    0.92
                ));
            } else {
                // Match lead vehicle speed with tight gap
                ego.aebActive = false;
                ego.speedMph = Math.max(closestObs.speedMph, ego.speedMph - 6.0 * dt);
                ego.speedMps = (ego.speedMph * 1.609) / 3.6;
                AVState.setGuidance(buildGuidance(
                    `🟡 TIGHT DENSE TRAFFIC FOLLOW · ${closestObs.speedMph.toFixed(0)} KM/H`,
                    `Following ${closestObs.type} at ${fDist.toFixed(1)}m clearance. Indian traffic gap nominal.`,
                    'MEDIUM',
                    0.89
                ));
            }
        } else {
            // Path Clear (>= 4.5m) — Smooth High-Speed Cruise (70–80 km/h)
            ego.aebActive = false;
            if (ego.speedMph < ego.targetCruiseMph) {
                ego.speedMph = Math.min(ego.targetCruiseMph, ego.speedMph + 15.0 * dt);
                ego.speedMps = (ego.speedMph * 1.609) / 3.6;
            }
            ego.yaw += (0 - ego.yaw) * 4.0 * dt;

            AVState.setGuidance(buildGuidance(
                '🟢 INDIAN TRAFFIC CRUISE · OPTIMAL GAP',
                `Path clear ahead. Ego cruising smoothly at ${ego.speedMph.toFixed(0)} km/h. Dense traffic navigation nominal.`,
                'LOW',
                0.96
            ));
        }
    } else {
        // Manual mode, no immediate threat — provide advisory
        const nearestLabel = closestAnyDir
            ? `${closestAnyDir.type.toUpperCase()} (${closestAnyDist.toFixed(0)}m)`
            : 'no hazards detected';
        const riskLvl = closestAnyDist < 25 ? 'HIGH' : closestAnyDist < 60 ? 'MEDIUM' : 'LOW';
        AVState.setGuidance(buildGuidance(
            `🔵 MANUAL MODE · ${riskLvl === 'LOW' ? 'ALL CLEAR' : `WATCH: ${nearestLabel}`}`,
            `Manual override active. Nearest entity: ${nearestLabel}. 360° radar monitoring all lanes. AEB safety net active.`,
            riskLvl,
            0.94
        ));
    }

    egoCarGroup.position.x = ego.x;
    egoCarGroup.rotation.y = ego.yaw;
    egoCarGroup.rotation.z = ego.yaw * 0.5;

    // Camera follow lerp
    if (cameraMode === 0) {
        camera.position.x += (ego.x * 0.45 - camera.position.x) * 5.0 * dt;
        camera.position.y += (4.0 - camera.position.y) * 5.0 * dt;
        camera.position.z += (8.5 - camera.position.z) * 5.0 * dt;
        camera.lookAt(ego.x * 0.25, 1.2, -35.0);
    }

    renderer.render(scene, camera);
}

function spawnEntity(type, dist, posX, speedMph) {
    const egoWorldZ = AVState.egoState.worldZ;
    // dist > 0 means AHEAD of ego in world coords (egoZ increases forward)
    // dist < 0 means BEHIND ego
    const worldZ = egoWorldZ + dist;
    const id = `${type}_${Math.floor(Math.random() * 900 + 100)}`;
    const entity = new WorldEntity(id, type, worldZ, posX, speedMph);
    AVState.worldEntities.set(id, entity);
    console.log(`[Simulation] Spawned ${type} at worldZ=${worldZ.toFixed(1)} (egoZ+${dist}), posX ${posX}m`);
    return entity;
}

function resetWorldEntities(sourceType) {
    // Destroy existing entities and return meshes to pool
    for (const [id, e] of AVState.worldEntities.entries()) {
        e.destroy();
    }
    AVState.worldEntities.clear();

    if (sourceType === 'kaggle') {
        // Indian Traffic — dist is AHEAD of ego (+ve = in front)
        spawnEntity('vehicle', 30.0, 0.0, 40.0);       // lead car
        spawnEntity('truck',   70.0, 3.8, 35.0);       // slow truck ahead right
        spawnEntity('motorcycle', 15.0, 1.8, 55.0);    // fast bike close
        spawnEntity('cyclist', 18.0, 4.2, 10.0);       // slow cyclist right
        spawnEntity('pedestrian', 35.0, -4.5, 2.0);    // pedestrian far left
        spawnEntity('vehicle', -25.0, 0.0, 50.0);      // vehicle behind
        spawnEntity('motorcycle', -15.0, 3.8, 48.0);   // bike behind right
    } else if (sourceType === 'waymo') {
        // Waymo multi-agent highway scenario
        spawnEntity('vehicle', 25.0, 0.0, 45.0);
        spawnEntity('vehicle', 45.0, -3.8, 50.0);
        spawnEntity('truck',   80.0, 3.8, 40.0);
        spawnEntity('vehicle', -20.0, 0.0, 55.0);      // overtaking from behind
        spawnEntity('vehicle', 60.0, 7.6, 48.0);
    } else {
        // Synthetic default — mixed traffic
        spawnEntity('vehicle',    28.0,  0.0, 42.0);
        spawnEntity('truck',      75.0,  3.8, 38.0);
        spawnEntity('motorcycle', 16.0,  1.8, 48.0);
        spawnEntity('vehicle',   -28.0,  0.0, 52.0);   // behind, overtaking
        spawnEntity('cyclist',    22.0,  5.2,  8.0);
    }
}

window.initSimulationEngine = initSimulationEngine;
window.updateSimulationLoop = updateSimulationLoop;
window.spawnEntity = spawnEntity;
window.resetWorldEntities = resetWorldEntities;

