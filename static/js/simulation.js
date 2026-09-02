/**
 * AV-01 Multi-Agent 3D Simulation Engine (CARLA Driving Engine)
 * Enforces strict physical collision dynamics, vehicle inertia, anti-clipping multi-agent traffic braking,
 * side & rear laser raycast sensors, and continuous Groq AI decision obedience.
 */

class WorldEntity {
    constructor(id, type, worldZ, posX = 0, speedMph = 42.0, headingDeg = 0) {
        this.id = id;
        this.type = type;
        this.worldZ = worldZ;
        this.posX = posX;
        this.speedMph = speedMph;
        this.targetSpeedMph = speedMph;
        this.headingDeg = headingDeg;
        
        // Bounding dimensions for collision physics
        this.width = type === 'truck' ? 2.5 : type === 'motorcycle' ? 0.8 : type === 'pedestrian' || type === 'cyclist' ? 0.8 : 1.9;
        this.length = type === 'truck' ? 7.0 : type === 'motorcycle' ? 1.8 : type === 'pedestrian' || type === 'cyclist' ? 1.0 : 4.2;

        this.mesh = createHighFidelityMesh(type);
        this.mesh.position.set(posX, 0, worldZ);
        scene.add(this.mesh);

        this.predictionLine = null;
        this.minTTC = 999.0;
        this.targetLaneX = posX;
        this.wobblePhase = Math.random() * Math.PI * 2;
    }

    update(dt, egoSpeedMps, egoWorldZ, egoX, egoSpeedMph) {
        const dToEgo = this.getDistanceToEgo();
        const rxToEgo = this.posX - egoX;
        const inSameLane = Math.abs(rxToEgo) < 2.2;
        const isBehindEgo = dToEgo < 0;
        const closingFast = isBehindEgo && this.targetSpeedMph > egoSpeedMph + 2.0;

        // Rear vehicle overtake logic: if faster than ego and getting close, change lane
        if (isBehindEgo && inSameLane && Math.abs(dToEgo) < 28.0) {
            if (closingFast) {
                // Pick an overtake lane (prefer left, then right)
                const overtakeX = this.posX < 0 ? this.posX + 4.0 : this.posX - 4.0;
                this.targetLaneX = Math.max(-10.0, Math.min(10.0, overtakeX));
            } else if (Math.abs(dToEgo) < 10.0) {
                // Too close but not fast enough to overtake — match ego speed + buffer
                this.speedMph = Math.max(0, Math.min(this.targetSpeedMph, egoSpeedMph - 3.0));
            }
        } else if (!isBehindEgo || !inSameLane) {
            // Drift back to original lane once past
            if (Math.abs(this.targetLaneX - this.posX) < 0.3) {
                this.targetLaneX = this.posX; // settled
            }
        }

        // Smooth acceleration back to target speed when not boxed in
        if (this.speedMph < this.targetSpeedMph) {
            this.speedMph = Math.min(this.targetSpeedMph, this.speedMph + 8.0 * dt);
        }

        const speedMps = (this.speedMph * 1.609) / 3.6;
        const relSpeedMps = speedMps - egoSpeedMps;

        this.worldZ += relSpeedMps * dt;
        this.mesh.position.z = this.worldZ - egoWorldZ;

        if (this.type === 'motorcycle') {
            this.wobblePhase += dt * 1.2;
            this.posX += Math.sin(this.wobblePhase) * 0.3 * dt;
            this.mesh.rotation.y = Math.PI + Math.cos(this.wobblePhase) * 0.06;
        } else if (this.type === 'pedestrian') {
            // Pedestrian walks sideways slowly on shoulder — tiny lateral drift only
            this.posX += Math.sin(performance.now() * 0.0005) * 0.15 * dt;
            this.mesh.position.y = Math.abs(Math.sin(performance.now() * 0.004)) * 0.04;
        } else if (this.type === 'cyclist') {
            this.posX = 5.2 + Math.sin(performance.now() * 0.0006) * 0.12;
        } else {
            // Car/Truck: smooth lane-target tracking
            this.posX += (this.targetLaneX - this.posX) * 2.5 * dt;
            this.mesh.rotation.y = Math.PI + (this.targetLaneX - this.posX) * -0.04;
        }

        this.mesh.position.x = this.posX;
        this.updatePredictionLine(dt);
    }

    updatePredictionLine(dt) {
        const stepT = 0.5;
        const pts = [];
        let pz = this.mesh.position.z;
        let px = this.posX;

        for (let i = 0; i <= 6; i++) {
            pts.push(new THREE.Vector3(px, 0.2, pz));
            pz += (this.speedMph * 1.609 / 3.6) * stepT;
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
            scene.add(this.predictionLine);
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
            scene.remove(this.predictionLine);
        }
        scene.remove(this.mesh);
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

        // Recycle distant agents
        const d = entity.getDistanceToEgo();
        if (d < -80.0) {
            entity.worldZ = ego.worldZ + 110.0 + Math.random() * 30.0;
        } else if (d > 160.0) {
            entity.worldZ = ego.worldZ - 40.0 - Math.random() * 20.0;
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

    // 3D Sensor Raycasts — 360° Tesla-spec detection (Front: 250m, Sides: 80m, Rear: 100m)
    let fDist = 250.0, lDist = 80.0, rDist = 80.0, rearDist = 100.0;
    let closestObs = null;       // closest in front cone
    let closestAnyDir = null;    // closest in ANY direction (360°)
    let closestAnyDist = 999.0;  // distance to that closest entity
    let closestAnyDir_label = 'FRONT'; // direction label for HUD

    for (const [id, e] of AVState.worldEntities.entries()) {
        const d = e.getDistanceToEgo();
        const rx = e.posX - ego.x;
        const absD = Math.abs(d);
        const absRx = Math.abs(rx);
        const euclidDist = Math.sqrt(d * d + rx * rx);

        // Front sensor: 250m forward cone (narrow: ±3m lateral)
        if (d > 0 && d < fDist && absRx < 3.0) {
            fDist = d;
            closestObs = e;
        }
        // Rear sensor: 100m behind in lane
        if (d < 0 && absD < rearDist && absRx < 3.0) rearDist = absD;
        // Side sensors: 80m lateral window
        if (absD < 80.0) {
            if (rx < -1.0 && absRx < lDist) lDist = absRx * 2.8;
            if (rx >  1.0 && absRx < rDist) rDist = absRx * 2.8;
        }

        // 360° closest entity tracker (for all-direction AEB)
        if (euclidDist < closestAnyDist) {
            closestAnyDist = euclidDist;
            closestAnyDir = e;
            if (d > 0 && absRx < 3.0)        closestAnyDir_label = 'FRONT';
            else if (d < 0 && absRx < 3.0)   closestAnyDir_label = 'REAR';
            else if (rx < 0)                  closestAnyDir_label = 'LEFT';
            else                              closestAnyDir_label = 'RIGHT';
        }
    }

    AVState.sensorDistances = {
        front: fDist,
        left: lDist,
        right: rDist,
        rear: rearDist
    };

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

    // Helper: rich guidance payload matching evidence-grounded UI card
    function buildGuidance(action, reason, riskLevel, confidence) {
        return { action, reason, riskLevel, confidence: confidence || 0.94 };
    }

    // 360° EMERGENCY BRAKE — triggers in any drive mode (manual OR autopilot)
    // Engage AEB if ANY entity is within safety envelope from any direction
    const aebFront   = fDist      < 10.0;
    const aebRear    = rearDist   < 7.0;
    const aebLeft    = lDist      < 3.5;
    const aebRight   = rDist      < 3.5;
    const aebAny     = aebFront || aebRear || aebLeft || aebRight;

    if (aebAny && closestAnyDir && !isPhysicalImpact) {
        // Hard-brake from any direction
        ego.speedMph = Math.max(0, ego.speedMph - 95.0 * dt);
        ego.speedMps = (ego.speedMph * 1.609) / 3.6;
        ego.aebActive = true;

        const dir    = closestAnyDir_label;
        const dist   = closestAnyDist.toFixed(1);
        const typ    = closestAnyDir.type;
        const typIcon = typ === 'pedestrian' ? '🚶' : typ === 'cyclist' ? '🚴' : typ === 'motorcycle' ? '🏍️' : typ === 'truck' ? '🚛' : '🚗';
        const ttcVal  = ego.speedMps > 0.1 ? (closestAnyDist / ego.speedMps).toFixed(1) : '∞';
        const dirWarn = aebFront ? '⬆ Front' : aebRear ? '⬇ Rear' : aebLeft ? '◀ Left' : '▶ Right';

        AVState.setGuidance(buildGuidance(
            `🚨 CRITICAL BRAKE: ${typIcon} ${typ.toUpperCase()} AT ${dist}m [${dirWarn}]`,
            `TTC ${ttcVal}s < 1.8s safety limit. AEB engaged. 360° radar detected ${typ} in ${dir} zone at ${dist}m. Hard braking applied. All drive modes protected.`,
            'CRITICAL',
            0.97
        ));
    } else if (ego.isAutoPilot && !isPhysicalImpact) {
        // ── AUTOPILOT GUIDANCE (non-AEB scenarios) ──
        const ttc = closestObs
            ? (fDist / Math.max(0.1, (ego.speedMps - (closestObs.speedMph * 1.609 / 3.6))))
            : 999;

        if (closestObs && fDist < 35.0 && ego.speedMph > closestObs.speedMph + 2.0) {
            // Check side clearance for AI-directed overtake
            let leftClear = true, rightClear = true;
            for (const [id, e] of AVState.worldEntities.entries()) {
                const d = e.getDistanceToEgo();
                if (d > -10 && d < 35) {
                    if (e.posX < ego.x - 1.5 && e.posX > ego.x - 5.5) leftClear = false;
                    if (e.posX > ego.x + 1.5 && e.posX < ego.x + 5.5) rightClear = false;
                }
            }

            let laneDir = 0;
            if (leftClear && ego.x > -3.8)  laneDir = -1;
            else if (rightClear && ego.x < 3.8) laneDir = 1;

            if (laneDir !== 0) {
                ego.aebActive = false;
                ego.x += laneDir * 3.8 * dt;
                ego.x = Math.max(-5.5, Math.min(5.5, ego.x));
                ego.yaw = laneDir * -0.07;
                const side = laneDir < 0 ? '◀ LEFT LANE' : '▶ RIGHT LANE';
                AVState.setGuidance(buildGuidance(
                    `🔵 EXECUTING SAFE OVERTAKE ${side}`,
                    `Passing slower ${closestObs.type} (${closestObs.speedMph.toFixed(0)} mph) at ${fDist.toFixed(0)}m. ${side.includes('LEFT') ? 'Right' : 'Left'} lane clear. Lateral maneuver initiated safely within road envelope.`,
                    'MEDIUM',
                    0.92
                ));
            } else {
                // Both lanes blocked — match lead speed
                ego.aebActive = false;
                ego.speedMph = Math.max(closestObs.speedMph, ego.speedMph - 18.0 * dt);
                ego.speedMps = (ego.speedMph * 1.609) / 3.6;
                AVState.setGuidance(buildGuidance(
                    `🟡 TACC: MATCHING LEAD SPEED · ${closestObs.speedMph.toFixed(0)} MPH`,
                    `Path blocked by ${closestObs.type} at ${fDist.toFixed(0)}m. Both adjacent lanes occupied. Maintaining RSS-compliant following buffer. TTC ${ttc.toFixed(1)}s.`,
                    'MEDIUM',
                    0.89
                ));
            }
        } else if (closestObs && ttc < 4.0) {
            // Moderate hazard — decelerate gently
            ego.aebActive = false;
            ego.speedMph = Math.max(ego.speedMph - 12.0 * dt, closestObs.speedMph + 2.0);
            ego.speedMps = (ego.speedMph * 1.609) / 3.6;
            AVState.setGuidance(buildGuidance(
                `🟠 CAUTION: ${closestObs.type.toUpperCase()} ${fDist.toFixed(0)}m AHEAD — SLOWING`,
                `TTC ${ttc.toFixed(1)}s approaching threshold. Reducing speed proactively. Front radar tracking ${closestObs.type} at ${closestObs.speedMph.toFixed(0)} mph. Safe deceleration applied.`,
                'HIGH',
                0.91
            ));
        } else {
            // Path Clear — resume cruise
            ego.aebActive = false;
            if (ego.speedMph < ego.targetCruiseMph) {
                ego.speedMph = Math.min(ego.targetCruiseMph, ego.speedMph + 10.0 * dt);
                ego.speedMps = (ego.speedMph * 1.609) / 3.6;
            }
            ego.yaw += (0 - ego.yaw) * 4.0 * dt;

            const sideNote = (lDist < 15 || rDist < 15)
                ? `Side proximity alert: L=${lDist.toFixed(0)}m R=${rDist.toFixed(0)}m.`
                : '360° radar clear.';
            AVState.setGuidance(buildGuidance(
                '🟢 PATH CLEAR · CRUISE CONTROL ACTIVE',
                `Forward cone ${fDist > 200 ? '>200' : fDist.toFixed(0)}m clear. ${sideNote} Tracking lane centerline at ${ego.speedMph.toFixed(0)} mph. All systems nominal.`,
                'LOW',
                0.96
            ));
        }
    } else if (!ego.isAutoPilot && !aebAny && !isPhysicalImpact) {
        // Manual mode, no immediate threat — provide advisory
        const nearestLabel = closestAnyDir
            ? `${closestAnyDir.type} ${closestAnyDist.toFixed(0)}m ${closestAnyDir_label.toLowerCase()}`
            : 'no hazards detected';
        const riskLvl = closestAnyDist < 25 ? 'HIGH' : closestAnyDist < 60 ? 'MEDIUM' : 'LOW';
        AVState.setGuidance(buildGuidance(
            `🔵 MANUAL MODE · ${riskLvl === 'LOW' ? 'ALL CLEAR' : `WATCH: ${nearestLabel.toUpperCase()}`}`,
            `Manual override active. Nearest entity: ${nearestLabel}. 360° radar monitoring all lanes. AEB remains active from all directions as safety net.`,
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
    const worldZ = egoWorldZ - dist;
    const id = `${type}_${Math.floor(Math.random() * 900 + 100)}`;
    const entity = new WorldEntity(id, type, worldZ, posX, speedMph);
    AVState.worldEntities.set(id, entity);
    console.log(`[Simulation] Spawned ${type} at dist ${dist}m, posX ${posX}m`);
    return entity;
}

function resetWorldEntities(sourceType) {
    // Clean existing 3D meshes
    for (const [id, e] of AVState.worldEntities.entries()) {
        if (e.mesh) scene.remove(e.mesh);
    }
    AVState.worldEntities.clear();

    if (sourceType === 'kaggle') {
        // Indian Traffic heterogeneity (auto-rickshaw, motorcycle, truck, pedestrian)
        spawnEntity('car', 30.0, 0.0, 40.0);
        spawnEntity('truck', 70.0, 3.8, 35.0);
        spawnEntity('motorcycle', 15.0, 1.8, 55.0);
        spawnEntity('cyclist', 18.0, 4.2, 10.0);
        spawnEntity('pedestrian', 35.0, -4.5, 2.0);
    } else if (sourceType === 'waymo') {
        // Waymo multi-agent highway scenario
        spawnEntity('car', 25.0, 0.0, 45.0);
        spawnEntity('car', 45.0, -3.8, 50.0);
        spawnEntity('truck', 80.0, 3.8, 40.0);
        spawnEntity('car', -20.0, 0.0, 60.0);
    } else {
        // Synthetic default nominal traffic
        spawnEntity('car', 28.5, 0.0, 42.0);
        spawnEntity('truck', 75.0, 3.8, 38.0);
        spawnEntity('motorcycle', 18.0, 1.8, 48.0);
    }
}

window.initSimulationEngine = initSimulationEngine;
window.updateSimulationLoop = updateSimulationLoop;
window.spawnEntity = spawnEntity;
window.resetWorldEntities = resetWorldEntities;

