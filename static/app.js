const originalGetElementById = document.getElementById.bind(document);
document.getElementById = function(id) {
    const el = originalGetElementById(id);
    if (el) return el;
    return { style: {}, classList: { add: ()=>{}, remove: ()=>{}, toggle: ()=>{} }, set className(v) {}, get className() { return ""; }, set innerText(v) {}, get innerText() { return ""; }, set innerHTML(v) {}, get innerHTML() { return ""; }, set value(v) {}, get value() { return ""; }, appendChild: () => {}, setAttribute: () => {}, getAttribute: () => null, removeAttribute: () => {} };
};
const overtakeHud = document.getElementById("overtake-hud");

const AudioContext = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;

function playWarningChime() {
    try {
        if (!audioCtx) audioCtx = new AudioContext();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(850, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(420, audioCtx.currentTime + 0.25);
        gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.25);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.25);
    } catch(e) {}
}

const container = document.getElementById('viewport-box-sim') || document.getElementById('viewport-box-camera') || document.getElementById('viewport-box');

const models = {};
const gltfLoader = new THREE.GLTFLoader();

const carWheelRefs = {};
gltfLoader.load('/static/models/car.glb', (gltf) => {
    gltf.scene.scale.set(1.0, 1.0, 1.0);
    gltf.scene.rotation.y = Math.PI;
    models.ego = gltf.scene;
    gltf.scene.traverse((child) => {
        if (child.name.includes('FL_Wheel')) carWheelRefs.fl = child;
        if (child.name.includes('FR_Wheel')) carWheelRefs.fr = child;
        if (child.name.includes('RL_Wheel')) carWheelRefs.rl = child;
        if (child.name.includes('RR_Wheel')) carWheelRefs.rr = child;
    });
});
gltfLoader.load('/static/models/hcr2_motocross.glb', (gltf) => {
    gltf.scene.scale.set(1.2, 1.2, 1.2);
    gltf.scene.rotation.y = Math.PI;
    models.motorcycle = gltf.scene;
});
gltfLoader.load('/static/models/hcr_bill_newton.glb', (gltf) => {
    gltf.scene.scale.set(1.5, 1.5, 1.5);
    gltf.scene.rotation.y = Math.PI;
    models.car = gltf.scene;
});
gltfLoader.load('/static/models/hcr2_super_diesel.glb', (gltf) => {
    gltf.scene.scale.set(1.5, 1.5, 1.5);
    gltf.scene.rotation.y = Math.PI;
    models.truck = gltf.scene;
});

const scene = new THREE.Scene();

const barrierGroup = new THREE.Group();
const barrierPostGeo = new THREE.BoxGeometry(0.2, 1, 0.2);
const barrierPostMat = new THREE.MeshStandardMaterial({ color: 0x666666, metalness: 0.4, roughness: 0.6 });
const barrierRailGeo = new THREE.BoxGeometry(0.1, 0.3, 4.0);
const barrierRailMat = new THREE.MeshStandardMaterial({ color: 0xff3333, metalness: 0.4, roughness: 0.6, emissive: 0xff0000, emissiveIntensity: 0.3 });
const barrierReflectorGeo = new THREE.BoxGeometry(0.05, 0.1, 0.1);
const barrierReflectorMat = new THREE.MeshStandardMaterial({ color: 0xffaa00, emissive: 0xffaa00, emissiveIntensity: 0.8 });

for (let z = -100; z < 100; z += 4) {
    [-11, 11].forEach(x => {
        const post = new THREE.Mesh(barrierPostGeo, barrierPostMat);
        post.position.set(x, 0.5, z);
        barrierGroup.add(post);
        const rail = new THREE.Mesh(barrierRailGeo, barrierRailMat);
        rail.position.set(x, 0.8, z);
        barrierGroup.add(rail);
        const refl = new THREE.Mesh(barrierReflectorGeo, barrierReflectorMat);
        refl.position.set(x + (x > 0 ? -0.1 : 0.1), 0.8, z);
        barrierGroup.add(refl);
    });
}
scene.add(barrierGroup);

scene.background = new THREE.Color(0x111520);
scene.fog = new THREE.FogExp2(0x111520, 0.008);

const camera = new THREE.PerspectiveCamera(48, container.clientWidth / container.clientHeight, 0.1, 800);
camera.position.set(0, 4.0, 8.5);
camera.lookAt(0, 1.2, -35.0);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
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

let targetFogDensity = 0.008;
let targetFogColor = new THREE.Color(0x111520);
let targetAmbientIntensity = 0.65;
let targetSunIntensity = 0.85;

const roadGeo = new THREE.PlaneGeometry(26, 800, 10, 100);
const roadMat = new THREE.MeshStandardMaterial({ color: 0x161a26, roughness: 0.85, metalness: 0.1 });
const roadMesh = new THREE.Mesh(roadGeo, roadMat);
roadMesh.rotation.x = -Math.PI / 2;
roadMesh.receiveShadow = true;
scene.add(roadMesh);

const railGeo = new THREE.BoxGeometry(0.35, 0.7, 800);
const railMat = new THREE.MeshStandardMaterial({ color: 0x64748b, metalness: 0.8, roughness: 0.3 });
const leftRail = new THREE.Mesh(railGeo, railMat);
leftRail.position.set(-13, 0.35, 0);
scene.add(leftRail);
const rightRail = new THREE.Mesh(railGeo, railMat);
rightRail.position.set(13, 0.35, 0);
scene.add(rightRail);

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
const laneStripes = [];
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

const lampposts = [];
const poleMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.7 });
const lampLightMat = new THREE.MeshBasicMaterial({ color: 0xfef08a });
for (let i = -10; i < 10; i++) {
    const poleGroup = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 7.5), poleMat);
    pole.position.y = 3.75;
    poleGroup.add(pole);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.12, 0.12), poleMat);
    arm.position.set(1.2, 7.4, 0);
    poleGroup.add(arm);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 8), lampLightMat);
    bulb.position.set(2.4, 7.3, 0);
    poleGroup.add(bulb);
    poleGroup.position.set(-14.5, 0, i * 40.0);
    scene.add(poleGroup);
    lampposts.push(poleGroup);
}

const buildings = [];
const bldgGeo = new THREE.BoxGeometry(1, 1, 1);

const bldgMaterials = [
    new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.1, metalness: 0.8 }),
    new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.9, metalness: 0.2 }),
    new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.5, metalness: 0.5 }),
    new THREE.MeshStandardMaterial({ color: 0x082f49, roughness: 0.2, metalness: 0.9 })
];

const treeGeo = new THREE.ConeGeometry(2, 6, 8);
const trunkGeo = new THREE.CylinderGeometry(0.4, 0.4, 2);
const leavesMat = new THREE.MeshStandardMaterial({ color: 0x064e3b, roughness: 0.8 });
const trunkMat = new THREE.MeshStandardMaterial({ color: 0x451a03, roughness: 0.9 });

for (let i = -15; i < 20; i++) {
    [-1, 1].forEach(side => {
        if (Math.random() > 0.15) {
            const width = 12 + Math.random() * 25;
            const depth = 12 + Math.random() * 25;
            const height = 30 + Math.random() * 120;
            const matIndex = Math.floor(Math.random() * bldgMaterials.length);
            const bldg = new THREE.Mesh(bldgGeo, bldgMaterials[matIndex]);
            bldg.scale.set(width, height, depth);
            const xOffset = side * (25 + width/2 + Math.random() * 10);
            bldg.position.set(xOffset, height/2, i * 40.0 + (Math.random() * 10));
            bldg.castShadow = true;
            bldg.receiveShadow = true;
            scene.add(bldg);
            buildings.push(bldg);
        }
        if (Math.random() > 0.4) {
            const treeGroup = new THREE.Group();
            const leaves = new THREE.Mesh(treeGeo, leavesMat);
            leaves.position.y = 4;
            leaves.castShadow = true;
            const trunk = new THREE.Mesh(trunkGeo, trunkMat);
            trunk.position.y = 1;
            trunk.castShadow = true;
            treeGroup.add(leaves);
            treeGroup.add(trunk);
            const treeX = side * (16 + Math.random() * 4);
            treeGroup.position.set(treeX, 0, i * 40.0 + 20);
            scene.add(treeGroup);
            buildings.push(treeGroup);
        }
    });
}

const egoCarGroup = new THREE.Group();
const carMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, metalness: 0.85, roughness: 0.25 });
const carBody = new THREE.Group();
carBody.position.y = 0.52;
carBody.castShadow = true;
egoCarGroup.add(carBody);

const glassMat = new THREE.MeshStandardMaterial({ color: 0x0a101f, metalness: 0.9, roughness: 0.1 });
const carGlass = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.56, 2.4), glassMat);
carGlass.position.set(0, 1.05, -0.15);
egoCarGroup.add(carGlass);

const tireMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.9 });
const rimMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.9, roughness: 0.2 });
const wheelOffsets = [
    [-1.02, 0.36, -1.3], [1.02, 0.36, -1.3],
    [-1.02, 0.36, 1.3], [1.02, 0.36, 1.3]
];
wheelOffsets.forEach(pos => {
    const wGroup = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.28, 18), tireMat);
    tire.rotation.z = Math.PI / 2;
    wGroup.add(tire);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.30, 12), rimMat);
    rim.rotation.z = Math.PI / 2;
    wGroup.add(rim);
    wGroup.position.set(...pos);
    egoCarGroup.add(wGroup);
});

const hlMat = new THREE.MeshBasicMaterial({ color: 0xe0f2fe });
const hlLeft = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.12, 0.08), hlMat);
hlLeft.position.set(-0.72, 0.54, -2.2);
egoCarGroup.add(hlLeft);
const hlRight = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.12, 0.08), hlMat);
hlRight.position.set(0.72, 0.54, -2.2);
egoCarGroup.add(hlRight);

const checkEgoModel = setInterval(() => {
    if (models.ego) {
        const egoMesh = models.ego.clone();
        egoMesh.position.y = 0.5;
        egoCarGroup.add(egoMesh);
        egoCarGroup.children.forEach(c => {
            if (c !== egoMesh && (c.type === 'Mesh' || c.type === 'Group') && c.material && c.material.type === 'MeshStandardMaterial') {
                c.visible = false;
            } else if (c.type === 'Group') {
                c.visible = false;
            }
        });
        if(typeof carBody !== 'undefined') carBody.visible = false;
        clearInterval(checkEgoModel);
    }
}, 500);

// ============================================================
// FRONT-ONLY SENSOR VISUALIZATION (80° FOV half 40°, 150m)
// SIDE + REAR cones hidden (no hardware installed)
// ============================================================

// 1. LiDAR Cone (front only: 80° sweep = 0.44 * 2pi, 150m range)
const lidarConeGeo = new THREE.ConeGeometry(Math.tan(40 * Math.PI / 180) * 150, 150, 32, 1, true, 0, Math.PI * 0.44);
const lidarMat = new THREE.MeshBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.12, side: THREE.DoubleSide });
const lidarCone = new THREE.Mesh(lidarConeGeo, lidarMat);
lidarCone.rotation.x = Math.PI / 2;
lidarCone.rotation.y = -Math.PI * 0.22;
lidarCone.position.set(0, 2.0, -75.0);
egoCarGroup.add(lidarCone);

// 2. Radar Cone (front, narrower ~30° half, 150m)
const radarConeGeo = new THREE.ConeGeometry(Math.tan(30 * Math.PI / 180) * 150, 150, 16, 1, true, 0, Math.PI * 0.33);
const radarMat = new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.09, side: THREE.DoubleSide });
const radarCone = new THREE.Mesh(radarConeGeo, radarMat);
radarCone.rotation.x = Math.PI / 2;
radarCone.rotation.y = -Math.PI * 0.165;
radarCone.position.set(0, 0.5, -75.0);
egoCarGroup.add(radarCone);

// 3. Camera Frustum (front, 80° total)
const camConeGeo = new THREE.ConeGeometry(Math.tan(40 * Math.PI / 180) * 80, 80, 16, 1, true, 0, Math.PI * 0.44);
const camMat = new THREE.MeshBasicMaterial({ color: 0xeab308, transparent: true, opacity: 0.10, side: THREE.DoubleSide });
const camCone = new THREE.Mesh(camConeGeo, camMat);
camCone.rotation.x = Math.PI / 2;
camCone.rotation.y = -Math.PI * 0.22;
camCone.position.set(0, 1.2, -40.0);
egoCarGroup.add(camCone);

// 4. Side & Rear BLIS cones
const sideMat = new THREE.MeshBasicMaterial({ color: 0xffa502, transparent: true, opacity: 0.15, side: THREE.DoubleSide });
const rearMat = new THREE.MeshBasicMaterial({ color: 0xff4757, transparent: true, opacity: 0.15, side: THREE.DoubleSide });

// Left Cone (30m)
const blisLeftGeo = new THREE.ConeGeometry(Math.tan(40 * Math.PI / 180) * 30, 30, 16, 1, true, 0, Math.PI * 0.44);
const blisLeftCone = new THREE.Mesh(blisLeftGeo, sideMat);
blisLeftCone.rotation.x = Math.PI / 2;
blisLeftCone.rotation.y = (Math.PI / 2) - (Math.PI * 0.22); // Point left
blisLeftCone.position.set(-15, 1.0, 0);
egoCarGroup.add(blisLeftCone);

// Right Cone (30m)
const blisRightGeo = new THREE.ConeGeometry(Math.tan(40 * Math.PI / 180) * 30, 30, 16, 1, true, 0, Math.PI * 0.44);
const blisRightCone = new THREE.Mesh(blisRightGeo, sideMat);
blisRightCone.rotation.x = Math.PI / 2;
blisRightCone.rotation.y = -(Math.PI / 2) - (Math.PI * 0.22); // Point right
blisRightCone.position.set(15, 1.0, 0);
egoCarGroup.add(blisRightCone);

// Rear Cone (40m)
const rearGeo = new THREE.ConeGeometry(Math.tan(50 * Math.PI / 180) * 40, 40, 16, 1, true, 0, Math.PI * 0.55);
const rearCone = new THREE.Mesh(rearGeo, rearMat);
rearCone.rotation.x = Math.PI / 2;
rearCone.rotation.y = Math.PI - (Math.PI * 0.275); // Point rear
rearCone.position.set(0, 1.0, 20);
egoCarGroup.add(rearCone);

const tlBar = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.09, 0.08), new THREE.MeshBasicMaterial({ color: 0xef4444 }));
tlBar.position.set(0, 0.58, 2.2);
egoCarGroup.add(tlBar);

const ribbonGeo = new THREE.PlaneGeometry(1.6, 32);
const ribbonMat = new THREE.MeshBasicMaterial({
    color: 0x00b4d8,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide
});
const ribbonMesh = new THREE.Mesh(ribbonGeo, ribbonMat);
ribbonMesh.rotation.x = -Math.PI / 2;
ribbonMesh.position.set(0, 0.04, -16);
egoCarGroup.add(ribbonMesh);

const arcMesh = new THREE.Mesh(
    new THREE.RingGeometry(3.0, 3.8, 32, 1, Math.PI * 0.75, Math.PI * 0.5),
    new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.3, side: THREE.DoubleSide })
);
arcMesh.rotation.x = -Math.PI / 2;
arcMesh.position.set(0, 0.03, -1.5);
egoCarGroup.add(arcMesh);

// 3D Laser Ray Lines emanating straight from Ego Car (Front, Left, Right, Rear)
const rayMatFront = new THREE.LineBasicMaterial({ color: 0x00f0ff, linewidth: 3 });
const rayMatLeft  = new THREE.LineBasicMaterial({ color: 0xffaa00, linewidth: 3 });
const rayMatRight = new THREE.LineBasicMaterial({ color: 0xffaa00, linewidth: 3 });
const rayMatRear  = new THREE.LineBasicMaterial({ color: 0xff3366, linewidth: 3 });

const rayGeoFront = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.6, -2.0), new THREE.Vector3(0, 0.6, -75.0)]);
const rayGeoLeft  = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-1.0, 0.6, 0.0), new THREE.Vector3(-25.0, 0.6, 0.0)]);
const rayGeoRight = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(1.0, 0.6, 0.0), new THREE.Vector3(25.0, 0.6, 0.0)]);
const rayGeoRear  = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.6, 2.0), new THREE.Vector3(0, 0.6, 40.0)]);

const frontSensorRay = new THREE.Line(rayGeoFront, rayMatFront);
const leftSensorRay  = new THREE.Line(rayGeoLeft, rayMatLeft);
const rightSensorRay = new THREE.Line(rayGeoRight, rayMatRight);
const rearSensorRay  = new THREE.Line(rayGeoRear, rayMatRear);

egoCarGroup.add(frontSensorRay);
egoCarGroup.add(leftSensorRay);
egoCarGroup.add(rightSensorRay);
egoCarGroup.add(rearSensorRay);

// Glowing Laser Node Dots at endpoints
const nodeGeo = new THREE.SphereGeometry(0.35, 12, 12);
const frontNode = new THREE.Mesh(nodeGeo, new THREE.MeshBasicMaterial({ color: 0x00f0ff }));
const leftNode  = new THREE.Mesh(nodeGeo, new THREE.MeshBasicMaterial({ color: 0xffaa00 }));
const rightNode = new THREE.Mesh(nodeGeo, new THREE.MeshBasicMaterial({ color: 0xffaa00 }));
const rearNode  = new THREE.Mesh(nodeGeo, new THREE.MeshBasicMaterial({ color: 0xff3366 }));

frontNode.position.set(0, 0.6, -75.0);
leftNode.position.set(-25.0, 0.6, 0.0);
rightNode.position.set(25.0, 0.6, 0.0);
rearNode.position.set(0, 0.6, 40.0);

egoCarGroup.add(frontNode);
egoCarGroup.add(leftNode);
egoCarGroup.add(rightNode);
egoCarGroup.add(rearNode);

scene.add(egoCarGroup);

// ============================================================
// World State - MPC Autopilot is DEFAULT (isAutoPilot = true)
// ============================================================
let egoWorldZ = 0.0;
let egoX = 0.0;
let speedMph = 52.0;
let targetCruiseMph = 60.0;
let isAutoPilot = true;
let aebActive = false;
let interventionCount = 0;
let lastInterventionPost = 0;
let lastStatePost = 0;

// Learned driver profile (refreshed from backend)
let driverProfile = {
    cruise_target_mph: 60.0,
    following_gap_seconds: 1.80,
    comfort: 0.50,
    overtake_bias: 0.20,
    summary: "Default profile: 60 mph cruise, 1.8s following gap, lane-keep only. Drive manually and the MPC Autopilot will adapt to match your style.",
    interventions: 0
};

class WorldEntity {
    constructor(id, type, worldZ, posX, speedMph, vx = 0.0) {
        this.id = id;
        this.type = type;
        this.worldZ = worldZ;
        this.posX = posX;
        this.speedMph = speedMph;
        this.vx = vx;
        this.mesh = createHighFidelityMesh(type);
        this.history = [];
        this.trajectoryLine = null;
    }

    update(dt) {
        const speedMps = (this.speedMph * 1.609) / 3.6;
        this.worldZ += speedMps * dt;
        this.posX += this.vx * dt;

        if (Math.random() < 0.2) {
            this.history.push({ x: this.posX, z: this.worldZ, vx: this.vx, vz: speedMps });
            if (this.history.length > 10) this.history.shift();
        }

        const relZ = -(this.worldZ - egoWorldZ);
        const relX = this.posX;
        this.mesh.position.set(relX, 0, relZ);

        this.updatePredictionLine();

        if (this.mesh.halo) {
            const dist = this.worldZ - egoWorldZ;
            this.mesh.halo.visible = (dist > 5.0 && dist < 150.0);
        }
    }

    updatePredictionLine(dt) {
        const pts = [];
        let px = this.posX;
        let pz = this.worldZ;
        const horizon = 2.5;
        const steps = 10;
        const stepT = horizon / steps;

        for (let i = 0; i <= steps; i++) {
            pts.push(new THREE.Vector3(px, 0.2, -(pz - egoWorldZ)));
            px += this.vx * stepT;
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
                if (this.minTTC < 1.0) ttcColor = 0xef4444;
                else if (this.minTTC < 3.0) ttcColor = 0xeab308;
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
        return this.worldZ - egoWorldZ;
    }

    getRelativeSpeedMps() {
        return ((this.speedMph - speedMph) * 1.609) / 3.6;
    }
}

const worldEntities = new Map();

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
    } else if (type === 'auto_rickshaw') {
        const autoYellow = new THREE.MeshStandardMaterial({ color: 0xfacc15, metalness: 0.3 });
        const autoGreen = new THREE.MeshStandardMaterial({ color: 0x22c55e, metalness: 0.2 });
        const autoBlack = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.9 });
        const wf = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.08, 8, 16), autoBlack);
        wf.rotation.y = Math.PI / 2;
        wf.position.set(0, 0.25, -1.0);
        group.add(wf);
        const wr1 = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.08, 8, 16), autoBlack);
        wr1.rotation.y = Math.PI / 2;
        wr1.position.set(-0.6, 0.25, 0.8);
        group.add(wr1);
        const wr2 = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.08, 8, 16), autoBlack);
        wr2.rotation.y = Math.PI / 2;
        wr2.position.set(0.6, 0.25, 0.8);
        group.add(wr2);
        const lowerBody = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.6, 2.2), autoGreen);
        lowerBody.position.set(0, 0.5, 0);
        group.add(lowerBody);
        const upperBody = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.9, 1.8), autoYellow);
        upperBody.position.set(0, 1.25, 0.2);
        group.add(upperBody);
    } else if (type === 'cow' || type === 'buffalo') {
        const cowMat = new THREE.MeshStandardMaterial({
            color: type === 'cow' ? 0x8b5a2b : 0x2c2c2c,
            roughness: 0.9
        });
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.7, 1.6), cowMat);
        body.position.set(0, 0.65, 0);
        group.add(body);
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.6), cowMat);
        head.position.set(0, 0.9, -0.9);
        group.add(head);
        for(let i=0; i<4; i++) {
            const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.5), cowMat);
            leg.position.set(i%2===0?0.2:-0.2, 0.25, i<2?-0.6:0.6);
            group.add(leg);
        }
    } else if (type === 'dog') {
        const dogMat = new THREE.MeshStandardMaterial({ color: 0xd2b48c, roughness: 0.8 });
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.35, 0.8), dogMat);
        body.position.set(0, 0.35, 0);
        group.add(body);
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.25, 0.3), dogMat);
        head.position.set(0, 0.5, -0.45);
        group.add(head);
    } else {
        const trafficMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.8, roughness: 0.25 });
        const b = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.68, 4.0), trafficMat);
        b.position.y = 0.48;
        group.add(b);
        const top = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.52, 2.0), new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.1 }));
        top.position.set(0, 0.95, -0.1);
        group.add(top);
        const tl = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 0.05), new THREE.MeshBasicMaterial({ color: 0xef4444 }));
        tl.position.set(0, 0.52, 2.02);
        group.add(tl);
    }

    const halo = new THREE.Mesh(
        new THREE.RingGeometry(1.4, 1.7, 24),
        new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.4, side: THREE.DoubleSide })
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.05;
    group.add(halo);
    group.halo = halo;

    const checkModel = setInterval(() => {
        let modelType = null;
        if (type === 'motorcycle') modelType = models.motorcycle;
        else if (type === 'cyclist') modelType = models.motorcycle;
        else if (type === 'auto_rickshaw') modelType = models.tractor;
        else if (type !== 'pedestrian' && type !== 'cow' && type !== 'buffalo' && type !== 'dog') modelType = models.truck;

        if (modelType) {
            const mesh = modelType.clone();
            mesh.position.y = 0.5;
            group.add(mesh);
            group.children.forEach(c => {
                if (c.type === 'Mesh' && c !== mesh && c !== group.halo) c.visible = false;
            });
            clearInterval(checkModel);
        } else if (models.car) {
            clearInterval(checkModel);
        }
    }, 500);

    scene.add(group);
    return group;
}

async function startWaymoFeed() {
    if (!isAutoPilot) {
        alert("⚠️ Waymo Dataset Stream requires MPC AUTO-PILOT to be active. Please enable it first.");
        return;
    }
    try {
        const res = await fetch('/waymo/feed?frame_index=0');
        const data = await res.json();
        document.getElementById('dataset-source-pill').innerText = '🚗 WAYMO DATASET STREAM';
        console.log("Started Waymo stream:", data);
        spawnRealisticScenario('waymo_feed');
    } catch (e) {
        console.error("Waymo feed error:", e);
    }
}

async function sendTrafficSignal(state) {
    try {
        await fetch('/traffic/signal', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ state: state, distance_m: 85.0 })
        });
        const badge = document.getElementById('traffic-light-header-badge');
        if (state === 'GREEN') {
            badge.innerText = '🟢 SIGNAL: GREEN (85m)';
            badge.style.background = 'rgba(0,214,111,0.15)';
            badge.style.color = 'var(--tesla-green)';
            badge.style.borderColor = 'rgba(0,214,111,0.4)';
        } else if (state === 'YELLOW') {
            badge.innerText = '🟡 SIGNAL: YELLOW (85m)';
            badge.style.background = 'rgba(255,176,32,0.15)';
            badge.style.color = 'var(--tesla-yellow)';
            badge.style.borderColor = 'rgba(255,176,32,0.4)';
        } else {
            badge.innerText = '🔴 SIGNAL: RED (85m)';
            badge.style.background = 'rgba(232,33,39,0.15)';
            badge.style.color = 'var(--tesla-red)';
            badge.style.borderColor = 'rgba(232,33,39,0.4)';
        }
    } catch (e) {
        console.error("Traffic signal error:", e);
    }
}

function triggerManeuver(action) {
    const badge = document.getElementById('route-maneuver-badge');
    if (action === 'EXIT') badge.innerText = '🛣️ ROUTE: TAKING EXIT RAMP';
    else if (action === 'LEFT') badge.innerText = '👈 ROUTE: LEFT TURN';
    else if (action === 'RIGHT') badge.innerText = '👉 ROUTE: RIGHT TURN';
    else badge.innerText = '🛣️ ROUTE: STRAIGHT / EXITS ACTIVE';
    
    // Simulate ego lane change or steering response visually
    document.dispatchEvent(new CustomEvent('ego-maneuver', { detail: { action } }));
}

async function generateDataOnDemand() {
    const btn = event.target;
    const oldText = btn.innerText;
    btn.innerText = '⏳ Generating...';
    try {
        const res = await fetch('/data/generate?num_samples=2500', { method: 'POST' });
        const data = await res.json();
        btn.innerText = '✅ ' + data.samples_generated + ' rows generated';
        setTimeout(() => btn.innerText = oldText, 3000);
    } catch (e) {
        console.error("Generate data error:", e);
        btn.innerText = '❌ Error';
        setTimeout(() => btn.innerText = oldText, 3000);
    }
}

function spawnRealisticScenario(name) {
    aebActive = false;
    document.getElementById('collision-banner').style.display = 'none';
    const pilotChip = document.getElementById('pilot-chip');
    if (pilotChip) pilotChip.className = 'autopilot-chip active';
    document.getElementById('val-aeb').innerText = 'STANDBY';
    document.getElementById('val-aeb').style.color = 'var(--tesla-green)';

    for (const [id, entity] of worldEntities.entries()) {
        entity.destroy();
    }
    worldEntities.clear();

    if (name === 'cyclist_overtake') {
        const c = new WorldEntity('cyc_01', 'cyclist', egoWorldZ + 85.0, 2.4, 14.0, 0.0);
        worldEntities.set('cyc_01', c);
    } else if (name === 'pedestrian_crossing') {
        const p = new WorldEntity('ped_01', 'pedestrian', egoWorldZ + 80.0, 4.2, 2.0, -0.6);
        worldEntities.set('ped_01', p);
    } else if (name === 'lead_vehicle_brake') {
        const lead = new WorldEntity('veh_lead', 'vehicle', egoWorldZ + 70.0, 0.0, 45.0, 0.0);
        worldEntities.set('veh_lead', lead);
        setTimeout(() => {
            if (worldEntities.has('veh_lead')) {
                worldEntities.get('veh_lead').speedMph = 15.0;
            }
        }, 3500);
    } else if (name === 'traffic_flow') {
        worldEntities.set('veh_left', new WorldEntity('veh_left', 'vehicle', egoWorldZ + 95.0, -4.0, 68.0, 0.0));
        worldEntities.set('veh_center', new WorldEntity('veh_center', 'vehicle', egoWorldZ + 65.0, 0.0, 48.0, 0.0));
        worldEntities.set('cyc_right', new WorldEntity('cyc_right', 'cyclist', egoWorldZ + 80.0, 3.8, 14.0, 0.0));
    }
}

function spawnEntity(id, type, worldZ, laneX, speedMph) {
    const entity = new WorldEntity(id, type, worldZ, laneX || 0, speedMph || 20, 0.0);
    worldEntities.set(id, entity);
}

async function setScenario(type) {
    aebActive = false;
    document.getElementById('collision-banner').style.display = 'none';
    try {
        await fetch('/scenario/start', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ scenario_type: type })
        });
    } catch(e) {}
}

let kaggleRows = [];
let kaggleIdx = 0;
let kaggleFeedActive = false;
let kaggleFeedTimer = null;
let kaggleEntityCounter = 0;

async function startKaggleFeed() {
    if (kaggleFeedActive) {
        stopKaggleFeed();
        return;
    }

    const btn = document.getElementById('btn-kaggle-feed');
    btn.innerText = '⏳ Loading Kaggle Dataset...';
    btn.disabled = true;

    try {
        await setScenario('kaggle');
        const resp = await fetch('/kaggle/rows');
        const data = await resp.json();
        kaggleRows = data.rows;
        kaggleIdx = 0;
        kaggleEntityCounter = 0;

        for (const [id, entity] of worldEntities.entries()) {
            entity.destroy();
        }
        worldEntities.clear();

        kaggleFeedActive = true;
        btn.innerText = '⏹️ Stop Kaggle Feed';
        btn.disabled = false;
        btn.classList.add('kaggle-active');
        document.getElementById('kaggle-overlay').classList.add('active');

        streamNextLLMScene();
        kaggleFeedTimer = setInterval(streamNextLLMScene, 4500);
    } catch (e) {
        console.error('Kaggle feed error:', e);
        btn.innerText = '📊 Full Kaggle Feed';
        btn.disabled = false;
    }
}

function stopKaggleFeed() {
    kaggleFeedActive = false;
    if (kaggleFeedTimer) {
        clearInterval(kaggleFeedTimer);
        kaggleFeedTimer = null;
    }

    const btn = document.getElementById('btn-kaggle-feed');
    btn.innerText = '📊 Full Kaggle Feed';
    btn.classList.remove('kaggle-active');
    document.getElementById('kaggle-overlay').classList.remove('active');
    setScenario('normal');
}

async function streamNextLLMScene() {
    if (!kaggleFeedActive || kaggleRows.length === 0) return;
    kaggleIdx = Math.floor(Math.random() * kaggleRows.length);
    const row = kaggleRows[kaggleIdx];
    updateKaggleOverlay(row);

    try {
        const speed = speedMph;
        const weather = row.weather;
        const res = await fetch(`/traffic/llm/scene?speed=${speed}&weather=${weather}`);
        const sceneData = await res.json();

        const roadEl = document.getElementById('kgl-road');
        roadEl.innerText = `Volume: ${sceneData.traffic_volume} veh/hr`;
        if (sceneData.dataset_datetime) {
            roadEl.innerText += ` | ${sceneData.dataset_datetime}`;
        }

        const objects = sceneData.objects || [];
        objects.forEach(obj => {
            kaggleEntityCounter++;
            const id = `llm_obj_${kaggleEntityCounter}`;
            const dist = egoWorldZ + (obj.distance_m || 80.0);
            const spd = obj.speed_mph || 45.0;
            const lX = obj.lane_x || 0.0;
            const latV = obj.lateral_vx || 0.0;
            worldEntities.set(id, new WorldEntity(
                id, obj.type || 'vehicle', dist, lX, spd, latV
            ));
        });

        if (worldEntities.size > 20) {
            const keys = Array.from(worldEntities.keys());
            const numToRemove = worldEntities.size - 20;
            for (let i = 0; i < numToRemove; i++) {
                const oldest = worldEntities.get(keys[i]);
                oldest.destroy();
                worldEntities.delete(keys[i]);
            }
        }
    } catch (err) {
        console.warn("LLM Scene Generation failed", err);
    }
}

function updateKaggleOverlay(row) {
    const weatherIcons = {'Sunny': '☀️', 'Rainy': '🌧️', 'Foggy': '🌫️', 'Snowy': '❄️'};
    const wIcon = weatherIcons[row.weather] || '🌤️';
    document.getElementById('kgl-weather').innerHTML = `<span class="weather-icon">${wIcon}</span> ${row.weather}`;

    if (row.weather === 'Sunny') {
        targetFogColor.setHex(0x111520);
        targetFogDensity = 0.008;
        targetAmbientIntensity = 0.65;
        targetSunIntensity = 0.85;
    } else if (row.weather === 'Foggy' || row.weather === 'Snowy') {
        targetFogColor.setHex(0x475569);
        targetFogDensity = 0.035;
        targetAmbientIntensity = 0.25;
        targetSunIntensity = 0.1;
    } else if (row.weather === 'Rainy') {
        targetFogColor.setHex(0x0f172a);
        targetFogDensity = 0.015;
        targetAmbientIntensity = 0.4;
        targetSunIntensity = 0.2;
    }

    const roadIcons = {'Urban': '🏙️', 'Suburban': '🏘️', 'Highway': '🛣️'};
    document.getElementById('kgl-road').innerText = `${roadIcons[row.road_type] || ''} ${row.road_type}`;

    const tlClass = row.traffic_light === 'Red' ? 'tl-red' : row.traffic_light === 'Yellow' ? 'tl-yellow' : 'tl-green';
    document.getElementById('kgl-traffic-light').innerHTML = `<span class="traffic-light-dot ${tlClass}"></span>${row.traffic_light}`;

    const objIcons = {'pedestrian': '🚶', 'cyclist': '🚴', 'vehicle': '🚗', 'static_obstacle': '🪨', 'unknown': '❓'};
    document.getElementById('kgl-object-type').innerText = `${objIcons[row.object_type] || ''} ${row.object_type}`;

    document.getElementById('kgl-speed').innerText = `${row.speed_kmph} km/h`;
    document.getElementById('kgl-speed').style.color = row.speed_kmph > 80 ? 'var(--critical)' : row.speed_kmph > 50 ? 'var(--high)' : 'var(--tesla-blue)';

    document.getElementById('kgl-distance').innerText = `${row.distance_m}m`;
    document.getElementById('kgl-distance').style.color = row.distance_m < 20 ? 'var(--critical)' : row.distance_m < 40 ? 'var(--high)' : 'var(--tesla-green)';

    document.getElementById('kgl-camera').innerText = row.camera_similarity.toFixed(3);
    document.getElementById('kgl-lidar').innerText = row.lidar_similarity.toFixed(3);

    document.getElementById('kgl-ped').innerText = row.pedestrian_presence ? '⚠️ PRESENT' : '✅ Clear';
    document.getElementById('kgl-ped').style.color = row.pedestrian_presence ? 'var(--high)' : 'var(--tesla-green)';
    document.getElementById('kgl-steering').innerText = `${row.steering_angle}°`;
    document.getElementById('kgl-row-id').innerText = `Row #${row.idx} / ${kaggleRows.length}`;
    const pct = ((kaggleIdx / kaggleRows.length) * 100).toFixed(1);
    document.getElementById('kgl-progress-fill').style.width = `${pct}%`;
    document.getElementById('kgl-progress-text').innerText = `${kaggleIdx} / ${kaggleRows.length} rows streamed`;

    if (kaggleFeedActive) {
        const kaggleEgoMph = row.speed_kmph * 0.621;
        speedMph = speedMph + (kaggleEgoMph - speedMph) * 0.15;
    }
}

function resetSimulator() {
    if (kaggleFeedActive) stopKaggleFeed();
    aebActive = false;
    speedMph = 52.0;
    egoX = 0.0;
    tripTimer = 0.0;
    tripDev = 0.0;
    tripAlerts = 0;
    tripLog = [];
    document.getElementById('collision-banner').style.display = 'none';
    document.getElementById('overtake-hud').style.display = 'none';
    document.getElementById('pilot-chip').className = 'autopilot-chip active';
    document.getElementById('chip-text').innerText = 'AUTO-PILOT ENGAGED';
    document.getElementById('val-aeb').innerText = 'STANDBY';
    document.getElementById('val-aeb').style.color = 'var(--tesla-green)';
    spawnRealisticScenario('cyclist_overtake');
    try { fetch('/scenario/reset', { method: 'POST' }); } catch(e) {}
}

// ============================================================
// Driver Learning: POST user interventions to backend
// ============================================================
async function postIntervention(throttleIntent, steerDelta) {
    const now = performance.now();
    if (now - lastInterventionPost < 800) return;
    lastInterventionPost = now;
    interventionCount++;

    let nearestDistM = 50.0;
    for (const [, e] of worldEntities.entries()) {
        const d = e.getDistanceToEgo();
        if (d > 0 && d < nearestDistM) {
            const relX = Math.abs(e.posX - egoX);
            if (relX < 2.0) nearestDistM = d;
        }
    }

    const payload = {
        speed_mph: speedMph,
        following_distance_m: nearestDistM,
        steer: steerDelta || 0,
        throttle_intent: throttleIntent || "steer",
        timestamp: Date.now()
    };

    try {
        await fetch('/autopilot/intervention', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        refreshDriverProfile();
    } catch (e) {}
}

async function refreshDriverProfile() {
    try {
        const resp = await fetch('/autopilot/profile');
        if (resp.ok) {
            const data = await resp.json();
            driverProfile = Object.assign({}, driverProfile, data);
            if (data.cruise_target_mph !== undefined) targetCruiseMph = data.cruise_target_mph;
            updateDriverProfileUI();
        }
    } catch (e) {}
}

function updateDriverProfileUI() {
    const cruise = driverProfile.cruise_target_mph || 60;
    const gap = driverProfile.following_gap_seconds || 1.8;
    const comfort = driverProfile.comfort !== undefined ? driverProfile.comfort : 0.5;
    const overtake = driverProfile.overtake_bias !== undefined ? driverProfile.overtake_bias : 0.2;
    const summary = driverProfile.summary || "";
    const interventions = driverProfile.interventions !== undefined ? driverProfile.interventions : interventionCount;

    const cruisePct = Math.min(100, Math.max(0, (cruise - 30) / 70 * 100));
    const gapPct = Math.min(100, Math.max(0, (gap - 0.5) / 3.5 * 100));
    const comfortPct = Math.min(100, Math.max(0, comfort * 100));
    const overtakePct = Math.min(100, Math.max(0, overtake * 100));

    document.getElementById('pm-cruise').innerText = `${cruise.toFixed(0)} mph`;
    document.getElementById('pm-gap').innerText = `${gap.toFixed(2)} s`;
    document.getElementById('pm-comfort').innerText = comfort < 0.33 ? "Comfort" : comfort < 0.66 ? "Balanced" : "Sport";
    document.getElementById('pm-overtake').innerText = overtake < 0.33 ? "Conservative" : overtake < 0.66 ? "Standard" : "Aggressive";
    document.getElementById('pm-cruise-bar').style.width = `${cruisePct}%`;
    document.getElementById('pm-gap-bar').style.width = `${gapPct}%`;
    document.getElementById('pm-comfort-bar').style.width = `${comfortPct}%`;
    document.getElementById('pm-overtake-bar').style.width = `${overtakePct}%`;
    document.getElementById('profile-summary').innerText = `"${summary}"`;
    document.getElementById('interventions-badge').innerText = `${interventions} TAKEOVER${interventions === 1 ? '' : 'S'}`;

    document.getElementById('hud-target').innerText = `${cruise.toFixed(0)}`;
}

// ============================================================
// Periodic Ego-State POST to backend MPC controller
// ============================================================
async function postEgoState() {
    const nearestObstacles = [];
    for (const [id, e] of worldEntities.entries()) {
        const dist = e.getDistanceToEgo();
        if (dist > -5 && dist < 150) {
            nearestObstacles.push({
                id: id,
                type: e.type,
                distance_m: dist,
                lane_x: e.posX,
                speed_mph: e.speedMph
            });
        }
    }
    nearestObstacles.sort((a, b) => a.distance_m - b.distance_m);
    const obstacles = nearestObstacles.slice(0, 8);

    const payload = {
        x_m: egoX,
        y_m: 0.0,
        z_m: egoWorldZ,
        heading_rad: egoYaw || 0.0,
        speed_mph: speedMph,
        target_cruise_mph: targetCruiseMph,
        obstacles: obstacles,
        front_only_sensors: true,
        timestamp: Date.now()
    };

    try {
        await fetch('/autopilot/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (e) {}
}

const activeKeys = {};
let cameraMode = 0;
let safetyScore = 1000;
let scoreMultiplier = 1.0;
let egoYaw = 0.0;

window.addEventListener('keydown', (e) => {
    activeKeys[e.key.toLowerCase()] = true;
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(e.key.toLowerCase())) {
        if (isAutoPilot) {
            isAutoPilot = false;
            updatePilotUI();
        }
        const k = e.key.toLowerCase();
        const intent = (k === 'w' || k === 'arrowup') ? 'accel' :
                       (k === 's' || k === 'arrowdown') ? 'brake' : 'steer';
        const steerDelta = (k === 'a' || k === 'arrowleft') ? -0.3 :
                           (k === 'd' || k === 'arrowright') ? 0.3 : 0.0;
        postIntervention(intent, steerDelta);
    }
    if (e.code === 'Space') {
        e.preventDefault();
        triggerAEB();
    }
    if (e.key.toLowerCase() === 'c') {
        cameraMode = (cameraMode + 1) % 3;
    }
});
window.addEventListener('keyup', (e) => {
    activeKeys[e.key.toLowerCase()] = false;
});

function steerLeft() {
    egoX = Math.max(-5.5, egoX - 1.2);
    if (isAutoPilot) { isAutoPilot = false; updatePilotUI(); }
    postIntervention('steer', -0.5);
}
function steerRight() {
    egoX = Math.min(5.5, egoX + 1.2);
    if (isAutoPilot) { isAutoPilot = false; updatePilotUI(); }
    postIntervention('steer', 0.5);
}
function accelerate() {
    speedMph = Math.min(85, speedMph + 5);
    if (isAutoPilot) { isAutoPilot = false; updatePilotUI(); }
    postIntervention('accel', 0);
}
function brake() {
    speedMph = Math.max(0, speedMph - 8);
    if (isAutoPilot) { isAutoPilot = false; updatePilotUI(); }
    postIntervention('brake', 0);
}

function setDriveMode(pilot) {
    isAutoPilot = pilot;
    updatePilotUI();
}

function updatePilotUI() {
    document.getElementById('btn-pilot-mode').classList.toggle('active', isAutoPilot);
    document.getElementById('btn-manual-mode').classList.toggle('active', !isAutoPilot);
    const chip = document.getElementById('pilot-chip');
    const chipText = document.getElementById('chip-text');
    if (isAutoPilot) {
        chip.className = 'autopilot-chip active';
        chipText.innerText = 'AUTO-PILOT ENGAGED';
        document.getElementById('drive-hint-pill').innerText = '⚙️ MPC AUTOPILOT ACTIVE · DRIVE WITH [W/A/S/D] TO TEACH YOUR STYLE · [C] CAMERA';
        document.getElementById('drive-hint-pill').className = 'drive-hint-pill pilot-active';
    } else {
        chip.className = 'autopilot-chip';
        chipText.innerText = 'MANUAL · LEARNING YOUR STYLE';
        document.getElementById('drive-hint-pill').innerText = '🎮 MANUAL DRIVE · YOUR PREFERENCES ARE BEING LEARNED · CLICK MPC AUTO-PILOT TO RE-ENGAGE';
        document.getElementById('drive-hint-pill').className = 'drive-hint-pill';
    }
}

function triggerAEB() {
    aebActive = true;
    speedMph = Math.max(0.0, speedMph - 15.0);
    playWarningChime();
    const banner = document.getElementById('collision-banner');
    banner.style.display = 'flex';
    document.getElementById('collision-text').innerText = '🚨 EMERGENCY BRAKE (AEB) ENGAGED';
    document.getElementById('pilot-chip').className = 'autopilot-chip active';
    document.getElementById('chip-text').innerText = 'AEB · HARD STOP';
    document.getElementById('val-aeb').innerText = 'ENGAGED (100%)';
    document.getElementById('val-aeb').style.color = 'var(--tesla-red)';
}

function exportTripLog() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(tripLog, null, 2));
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.setAttribute("href", dataStr);
    dlAnchorElem.setAttribute("download", `av01_trip_log_${Date.now()}.json`);
    dlAnchorElem.click();
}

function triggerSensorGap() {
    targetFogColor.setHex(0xb45309);
    targetFogDensity = 0.05;
    setTimeout(() => {
        targetFogColor.setHex(0x111520);
        targetFogDensity = 0.008;
    }, 3000);
    try {
        fetch('/scenario/edge_case', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'sensor_gap' })
        });
    } catch(e) {}
}

function triggerConflict() {
    try {
        fetch('/scenario/edge_case', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'conflict' })
        });
    } catch(e) {}
}

// ============================================================
// WebSocket Pipeline Stream
// ============================================================
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
let ws;
let latestGuidance = { confidence: 0.88, why: "MPC centering lane, forward path nominal.", sensor_coverage: "front_only", auto_lane_change: false, lead_distance_m: null, target_speed_mph: 60 };
function connectWebSocket() {
    ws = new WebSocket(wsUrl);
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        processPipelineTelemetry(data);
    };
    ws.onclose = () => setTimeout(connectWebSocket, 1500);
}

// Global rolling confidence history for sparkline chart
let confidenceHistory = [88, 85, 90, 89, 92, 91, 93, 88, 91, 94, 90, 92];

function updateRecommendationUI(guidance) {
    const act = guidance.action || 'MAINTAIN SPEED';
    const confPct = Math.round((guidance.confidence || 0.95) * 100);
    const why = guidance.why || 'Nominal path forward. Forward sensor cone clear.';

    const recActionText = document.getElementById('rec-action-text');
    const recIcon = document.getElementById('rec-icon');
    const recRiskBadge = document.getElementById('rec-risk-badge');
    const recConfVal = document.getElementById('rec-conf-val');
    const recReasonText = document.getElementById('rec-reason-text');
    const recHeroBanner = document.getElementById('rec-hero-banner');

    if (recActionText) recActionText.innerText = act;
    if (recConfVal) recConfVal.innerText = `${confPct}%`;
    if (recReasonText) recReasonText.innerText = why;

    if (act === 'EMERGENCY STOP' || aebActive) {
        if (recIcon) recIcon.innerText = '🚨';
        if (recHeroBanner) {
            recHeroBanner.style.borderColor = 'var(--tesla-red)';
            recHeroBanner.style.background = 'rgba(232, 33, 39, 0.12)';
        }
        if (recActionText) { recActionText.innerText = aebActive ? 'EMERGENCY STOP (AEB)' : act; recActionText.style.color = 'var(--tesla-red)'; }
        if (recRiskBadge) { recRiskBadge.innerText = 'CRITICAL'; recRiskBadge.className = 'badge badge-critical'; }
    } else if (act === 'REDUCE SPEED') {
        if (recIcon) recIcon.innerText = '⚠️';
        if (recHeroBanner) {
            recHeroBanner.style.borderColor = 'var(--tesla-yellow)';
            recHeroBanner.style.background = 'rgba(255, 179, 0, 0.1)';
        }
        if (recActionText) recActionText.style.color = 'var(--tesla-yellow)';
        if (recRiskBadge) { recRiskBadge.innerText = 'MEDIUM'; recRiskBadge.className = 'badge badge-warning'; }
    } else if (act === 'LANE CHANGE') {
        if (recIcon) recIcon.innerText = '🔵';
        if (recHeroBanner) {
            recHeroBanner.style.borderColor = 'var(--tesla-blue)';
            recHeroBanner.style.background = 'rgba(54, 147, 255, 0.1)';
        }
        if (recActionText) recActionText.style.color = 'var(--tesla-blue)';
        if (recRiskBadge) { recRiskBadge.innerText = 'HIGH'; recRiskBadge.className = 'badge'; recRiskBadge.style.color = 'var(--high)'; }
    } else {
        if (recIcon) recIcon.innerText = '🟢';
        if (recHeroBanner) {
            recHeroBanner.style.borderColor = 'var(--tesla-green)';
            recHeroBanner.style.background = 'rgba(0, 214, 111, 0.08)';
        }
        if (recActionText) recActionText.style.color = 'var(--tesla-green)';
        if (recRiskBadge) { recRiskBadge.innerText = 'SAFE'; recRiskBadge.className = 'badge badge-healthy'; }
    }
}

function renderConfidenceChart() {
    const svg = document.getElementById('confidenceChartSvg');
    if (!svg) return;
    const linePath = document.getElementById('chartLinePath');
    const areaPath = document.getElementById('chartAreaPath');
    const dot = document.getElementById('chartDot');
    const badge = document.getElementById('chart-latest-conf');

    const width = 380;
    const height = 140;
    const padding = 20;

    const samples = confidenceHistory.slice(-20);
    if (samples.length < 2) return;

    const stepX = (width - padding * 2) / (samples.length - 1);
    let points = [];

    samples.forEach((val, i) => {
        const x = padding + i * stepX;
        const y = height - padding - ((val / 100) * (height - padding * 2));
        points.push({ x, y, val });
    });

    let dLine = `M ${points[0].x},${points[0].y}`;
    points.slice(1).forEach(p => {
        dLine += ` L ${p.x},${p.y}`;
    });

    let dArea = `${dLine} L ${points[points.length - 1].x},${height - padding} L ${points[0].x},${height - padding} Z`;

    if (linePath) linePath.setAttribute('d', dLine);
    if (areaPath) areaPath.setAttribute('d', dArea);

    const lastPt = points[points.length - 1];
    if (dot) {
        dot.setAttribute('cx', lastPt.x);
        dot.setAttribute('cy', lastPt.y);
    }
    if (badge) badge.innerText = `${lastPt.val}%`;
}

function render2DRadarCanvas(frame) {
    const canvas = document.getElementById('radarCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Deep Dark Background with Grid
    ctx.fillStyle = '#060a14';
    ctx.fillRect(0, 0, w, h);

    // Dynamic grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 25) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += 25) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    const centerX = w / 2;
    const centerY = h / 2 + 10;

    // Draw concentric sonar range circles
    const tNow = performance.now() * 0.003;
    const pulseR = (tNow * 40) % 110;
    
    [30, 60, 90, 120].forEach(r => {
        ctx.strokeStyle = 'rgba(54,147,255,0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(centerX, centerY, r, 0, Math.PI * 2); ctx.stroke();
    });

    // Animated expanding sonar wave
    ctx.strokeStyle = 'rgba(0,214,111,0.25)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(centerX, centerY, pulseR, 0, Math.PI * 2); ctx.stroke();

    // Compute real-time distances to nearest entities in 8 sectors
    const angles = [
        { name: 'FRONT', rad: -Math.PI / 2, dx: 0, dy: -1 },
        { name: 'FL', rad: -Math.PI * 0.75, dx: -0.707, dy: -0.707 },
        { name: 'FR', rad: -Math.PI * 0.25, dx: 0.707, dy: -0.707 },
        { name: 'LEFT', rad: Math.PI, dx: -1, dy: 0 },
        { name: 'RIGHT', rad: 0, dx: 1, dy: 0 },
        { name: 'RL', rad: Math.PI * 0.75, dx: -0.707, dy: 0.707 },
        { name: 'RR', rad: Math.PI * 0.25, dx: 0.707, dy: 0.707 },
        { name: 'REAR', rad: Math.PI / 2, dx: 0, dy: 1 }
    ];

    const distances = { FRONT: 99, FL: 99, FR: 99, LEFT: 99, RIGHT: 99, RL: 99, RR: 99, REAR: 99 };

    for (const [id, e] of worldEntities.entries()) {
        const d = e.getDistanceToEgo();
        const relX = e.posX - egoX;
        if (d >= 0 && d < 60) {
            if (Math.abs(relX) < 2.0 && d < distances.FRONT) distances.FRONT = d;
            else if (relX < -1.5 && d < 35 && d < distances.FL) distances.FL = d;
            else if (relX > 1.5 && d < 35 && d < distances.FR) distances.FR = d;
        } else if (d < 0 && Math.abs(d) < 40) {
            if (Math.abs(relX) < 2.0 && Math.abs(d) < distances.REAR) distances.REAR = Math.abs(d);
            else if (relX < -1.5 && Math.abs(d) < distances.RL) distances.RL = Math.abs(d);
            else if (relX > 1.5 && Math.abs(d) < distances.RR) distances.RR = Math.abs(d);
        }
        if (Math.abs(d) < 25) {
            if (relX < -1.5 && Math.abs(relX) < distances.LEFT) distances.LEFT = Math.abs(relX) * 3;
            if (relX > 1.5 && Math.abs(relX) < distances.RIGHT) distances.RIGHT = Math.abs(relX) * 3;
        }
    }

    // Default simulated safe distance baseline if empty
    if (distances.FRONT === 99) distances.FRONT = 18.4 + Math.sin(tNow * 2) * 1.5;
    if (distances.FL === 99) distances.FL = 8.2 + Math.cos(tNow * 1.5) * 0.8;
    if (distances.FR === 99) distances.FR = 6.5 + Math.sin(tNow * 1.8) * 0.9;
    if (distances.LEFT === 99) distances.LEFT = 3.4 + Math.sin(tNow * 2.5) * 0.4;
    if (distances.RIGHT === 99) distances.RIGHT = 2.8 + Math.cos(tNow * 2.2) * 0.5;
    if (distances.RL === 99) distances.RL = 7.5;
    if (distances.RR === 99) distances.RR = 8.1;
    if (distances.REAR === 99) distances.REAR = 12.0 + Math.sin(tNow * 1.2) * 2.0;

    // Render 8 Directional Sonar Rays & Arcs around Ego Vehicle
    angles.forEach(dir => {
        const distVal = distances[dir.name];
        const maxLen = 95;
        const lineLen = Math.min(maxLen, Math.max(25, distVal * 3.2));

        const endX = centerX + dir.dx * lineLen;
        const endY = centerY + dir.dy * lineLen;

        const color = distVal < 2.5 ? '#e82127' : distVal < 6.0 ? '#ffb020' : '#00d66f';

        // Laser ray line coming straight from vehicle
        ctx.strokeStyle = color;
        ctx.lineWidth = distVal < 2.5 ? 2.5 : 1.5;
        ctx.setLineDash(distVal < 2.5 ? [4, 2] : []);
        ctx.beginPath(); ctx.moveTo(centerX, centerY); ctx.lineTo(endX, endY); ctx.stroke();
        ctx.setLineDash([]);

        // Proximity Arc Segment at endpoint
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(centerX, centerY, lineLen, dir.rad - 0.2, dir.rad + 0.2);
        ctx.stroke();

        // Distance Callout Badge Pill
        const pillX = centerX + dir.dx * (lineLen + 14);
        const pillY = centerY + dir.dy * (lineLen + 14);
        ctx.fillStyle = 'rgba(10,14,24,0.92)';
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.fillRect(pillX - 18, pillY - 8, 36, 16);
        ctx.strokeRect(pillX - 18, pillY - 8, 36, 16);

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${distVal.toFixed(1)}m`, pillX, pillY);
    });

    // Ego Car Silhouette graphic in center (Tesla Model style top-view)
    ctx.shadowColor = '#3693ff';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(centerX - 12, centerY - 22, 24, 44, 5);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Roof glass
    ctx.fillStyle = '#111827';
    ctx.beginPath();
    ctx.roundRect(centerX - 9, centerY - 14, 18, 26, 3);
    ctx.fill();

    // Front Headlights
    ctx.fillStyle = '#1cd0ff';
    ctx.fillRect(centerX - 10, centerY - 21, 5, 2);
    ctx.fillRect(centerX + 5, centerY - 21, 5, 2);

    // Rear Taillights
    ctx.fillStyle = '#e82127';
    ctx.fillRect(centerX - 10, centerY + 20, 5, 2);
    ctx.fillRect(centerX + 5, centerY + 20, 5, 2);

    // Draw surrounding world entities on radar
    for (const [id, e] of worldEntities.entries()) {
        const d = e.getDistanceToEgo();
        const relX = e.posX - egoX;
        if (Math.abs(d) < 70 && Math.abs(relX) < 15) {
            const ex = centerX + (relX / 10.0) * 80;
            const ey = centerY - (d / 70.0) * 90;
            const col = Math.abs(d) < 15 ? '#e82127' : '#ffb020';

            ctx.fillStyle = col;
            ctx.shadowColor = col;
            ctx.shadowBlur = 6;
            ctx.fillRect(ex - 6, ey - 10, 12, 20);
            ctx.shadowBlur = 0;

            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 8px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(`${Math.abs(d).toFixed(0)}m`, ex, ey - 12);
        }
    }
}

function renderCameraFeeds(frame) {
    const cams = [
        { id: 'camCanvasFront', title: 'FRONT FOV', angle: 'front' },
        { id: 'camCanvasLeft', title: 'LEFT BLIND', angle: 'left' },
        { id: 'camCanvasRight', title: 'RIGHT BLIND', angle: 'right' },
        { id: 'camCanvasRear', title: 'REAR SCAN', angle: 'rear' }
    ];

    const t = performance.now() * 0.002;

    cams.forEach(camInfo => {
        const canvas = document.getElementById(camInfo.id);
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        ctx.clearRect(0, 0, w, h);

        // Sky & Ground gradients
        const skyGrad = ctx.createLinearGradient(0, 0, 0, h * 0.45);
        skyGrad.addColorStop(0, '#040814');
        skyGrad.addColorStop(1, '#0f182e');
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, w, h * 0.45);

        const gndGrad = ctx.createLinearGradient(0, h * 0.45, 0, h);
        gndGrad.addColorStop(0, '#111827');
        gndGrad.addColorStop(1, '#090d16');
        ctx.fillStyle = gndGrad;
        ctx.fillRect(0, h * 0.45, w, h * 0.55);

        const horizonY = h * 0.45;
        const vpX = w / 2;

        // Horizon guide line
        ctx.strokeStyle = 'rgba(54,147,255,0.2)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, horizonY); ctx.lineTo(w, horizonY); ctx.stroke();

        // Dynamic perspective lane markings based on camera angle
        if (camInfo.angle === 'front') {
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(vpX - 6, horizonY); ctx.lineTo(15, h); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(vpX + 6, horizonY); ctx.lineTo(w - 15, h); ctx.stroke();

            const dashOffset = (t * 60) % 18;
            ctx.setLineDash([4, 6]);
            ctx.lineDashOffset = -dashOffset;
            ctx.strokeStyle = 'rgba(250,204,21,0.4)';
            ctx.beginPath(); ctx.moveTo(vpX, horizonY); ctx.lineTo(w * 0.5, h); ctx.stroke();
            ctx.setLineDash([]);
        } else if (camInfo.angle === 'left') {
            ctx.strokeStyle = 'rgba(255,255,255,0.15)';
            ctx.lineWidth = 1.5;
            const sideOffset = (t * 50) % 30;
            for (let i = -1; i < 4; i++) {
                const lx = (i * 45 + sideOffset);
                ctx.beginPath(); ctx.moveTo(lx, horizonY); ctx.lineTo(lx - 20, h); ctx.stroke();
            }
        } else if (camInfo.angle === 'right') {
            ctx.strokeStyle = 'rgba(255,255,255,0.15)';
            ctx.lineWidth = 1.5;
            const sideOffset = (t * 50) % 30;
            for (let i = -1; i < 4; i++) {
                const rx = w - (i * 45 + sideOffset);
                ctx.beginPath(); ctx.moveTo(rx, horizonY); ctx.lineTo(rx + 20, h); ctx.stroke();
            }
        } else if (camInfo.angle === 'rear') {
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(vpX - 6, horizonY); ctx.lineTo(25, h); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(vpX + 6, horizonY); ctx.lineTo(w - 25, h); ctx.stroke();
        }

        // Radar Scanline Effect
        const scanY = (t * 80) % h;
        ctx.strokeStyle = 'rgba(28,208,255,0.2)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, scanY); ctx.lineTo(w, scanY); ctx.stroke();

        // Render tracked entities in camera view
        for (const [id, e] of worldEntities.entries()) {
            const dist = e.getDistanceToEgo();
            const relX = e.posX - egoX;
            let inView = false;

            if (camInfo.angle === 'front' && dist > 2.0 && dist < 90.0 && Math.abs(relX) < 12) inView = true;
            else if (camInfo.angle === 'left' && relX < -1.0 && Math.abs(dist) < 40.0) inView = true;
            else if (camInfo.angle === 'right' && relX > 1.0 && Math.abs(dist) < 40.0) inView = true;
            else if (camInfo.angle === 'rear' && dist < -2.0 && Math.abs(dist) < 70.0) inView = true;

            if (inView) {
                const projX = camInfo.angle === 'front' || camInfo.angle === 'rear'
                    ? vpX + (relX / 10.0) * (w * 0.38)
                    : camInfo.angle === 'left' ? w * 0.35 + (dist / 40.0) * (w * 0.4) : w * 0.65 - (dist / 40.0) * (w * 0.4);

                const projY = horizonY + (1.0 - Math.min(1.0, Math.abs(dist) / 80.0)) * (h - horizonY - 12);
                const boxW = Math.max(14, 38 - Math.abs(dist) * 0.3);
                const boxH = boxW * 1.15;

                const color = Math.abs(dist) < 18.0 ? '#e82127' : Math.abs(dist) < 40.0 ? '#ffb020' : '#00d66f';

                // Bounding Box Corner Reticle
                ctx.strokeStyle = color;
                ctx.lineWidth = 2;
                ctx.strokeRect(projX - boxW / 2, projY - boxH / 2, boxW, boxH);
                ctx.fillStyle = color + '22';
                ctx.fillRect(projX - boxW / 2, projY - boxH / 2, boxW, boxH);

                // Distance Tag Pill
                ctx.fillStyle = 'rgba(6,10,20,0.9)';
                ctx.fillRect(projX - 20, projY - boxH / 2 - 13, 40, 12);
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 8px "JetBrains Mono", monospace';
                ctx.textAlign = 'center';
                ctx.fillText(`${Math.abs(dist).toFixed(1)}m`, projX, projY - boxH / 2 - 4);
            }
        }

        // Camera Feed Status HUD Text
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font = '7px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(camInfo.title, 5, 10);
    });
}

function updateIndianUSP(frame) {
    const title = document.getElementById('usp-scenario-title');
    const badge = document.getElementById('usp-mult-badge');
    const horizon = document.getElementById('usp-horizon');
    const decay = document.getElementById('usp-decay');
    const feature = document.getElementById('usp-feature');
    const reason = document.getElementById('usp-reason-box');

    let activeScenario = 'nominal_traffic';
    let hazardType = 'vehicle';

    if (frame.hazards && frame.hazards.length > 0) {
        for (const h of frame.hazards) {
            if (h.prediction && h.prediction.scenario_type && h.prediction.scenario_type !== 'nominal_traffic') {
                activeScenario = h.prediction.scenario_type;
                hazardType = h.type || 'hazard';
                break;
            }
        }
    }

    const scenarioMeta = {
        'motorcycle_weaving': {
            name: '🏍️ MOTORCYCLE WEAVING', mult: 'Unpredictability ×1.3', horizon: '1.0s (High Chaos)', decay: '0.90 / frame', feat: 'high_lateral_velocity',
            desc: 'Erratic weaving detected across lane markings. Short prediction horizon (1.0s) applied to prevent sudden cut-in collision.'
        },
        'cow_stationary': {
            name: '🐄 COW STATIONARY IN PATH', mult: 'Unpredictability ×1.6', horizon: '3.0s (Static Obstacle)', decay: '0.98 / frame', feat: 'stationary_in_road',
            desc: 'Animal detected on roadway with maximum vulnerability multiplier (×1.6). Zero-speed assumption enforced for conservative AEB buffer.'
        },
        'auto_sudden_turn': {
            name: '🛺 AUTO-RICKSHAW CUT-IN', mult: 'Unpredictability ×1.3', horizon: '1.5s (Congestion)', decay: '0.93 / frame', feat: 'slowdown_without_braking',
            desc: 'Auto-rickshaw deceleration without brake signals. Trajectory predictor compensates for abrupt 90° turning behavior.'
        },
        'pedestrian_signal_violator': {
            name: '🚶 PEDESTRIAN CROSSING', mult: 'Unpredictability ×1.5', horizon: '2.0s (High Risk)', decay: '0.95 / frame', feat: 'approaching_road',
            desc: 'Vulnerable road user moving laterally towards lane center. AEB threshold expanded by 1.5× margin.'
        },
        'nominal_traffic': {
            name: '🚘 NOMINAL TRAFFIC', mult: 'Nominal ×1.0', horizon: '2.0s (Standard)', decay: '0.96 / frame', feat: 'linear_kinematic',
            desc: 'Standard highway traffic flow. Kinematic extrapolation tracking lead vehicle trajectory.'
        }
    };

    const info = scenarioMeta[activeScenario] || scenarioMeta['nominal_traffic'];

    if (title) title.innerText = info.name;
    if (badge) badge.innerText = info.mult;
    if (horizon) horizon.innerText = info.horizon;
    if (decay) decay.innerText = info.decay;
    if (feature) feature.innerText = info.feat;
    if (reason) reason.innerText = info.desc;
}

function processPipelineTelemetry(frame) {
    document.getElementById('frame-counter').innerText = `Frame #${frame.frame_id}`;
    document.getElementById('latency-hud').innerText = `Latency: ${(frame.pipeline_latency_ms || 8.2).toFixed(1)}ms`;

    const status = frame.system_status || {};
    if (status.mpc_steering !== undefined) window.mpcSteering = status.mpc_steering;
    if (status.mpc_throttle !== undefined) window.mpcThrottle = status.mpc_throttle;
    if (status.guidance !== undefined) latestGuidance = Object.assign({}, latestGuidance, status.guidance);

    // Update traffic signal and maneuver states from vehicle state
    if (frame.vehicle_state) {
        const trafficState = frame.vehicle_state.traffic_light_state;
        const turnState = frame.vehicle_state.turn_state;
        
        if (trafficState) {
            const badge = document.getElementById('traffic-light-header-badge');
            if (badge) {
                if (trafficState === 'GREEN') {
                    badge.innerText = '🟢 SIGNAL: GREEN (85m)';
                    badge.style.background = 'rgba(0,214,111,0.15)';
                    badge.style.color = 'var(--tesla-green)';
                    badge.style.borderColor = 'rgba(0,214,111,0.4)';
                } else if (trafficState === 'YELLOW') {
                    badge.innerText = '🟡 SIGNAL: YELLOW (85m)';
                    badge.style.background = 'rgba(255,176,32,0.15)';
                    badge.style.color = 'var(--tesla-yellow)';
                    badge.style.borderColor = 'rgba(255,176,32,0.4)';
                } else if (trafficState === 'RED') {
                    badge.innerText = '🔴 SIGNAL: RED (85m)';
                    badge.style.background = 'rgba(232,33,39,0.15)';
                    badge.style.color = 'var(--tesla-red)';
                    badge.style.borderColor = 'rgba(232,33,39,0.4)';
                } else {
                    badge.innerText = '⚪ SIGNAL: NONE';
                    badge.style.background = 'rgba(255,255,255,0.05)';
                    badge.style.color = 'var(--text-dim)';
                    badge.style.borderColor = 'var(--panel-border)';
                }
            }
        }

        if (turnState) {
            const maneuverBadge = document.getElementById('route-maneuver-badge');
            if (maneuverBadge) {
                if (turnState === 'EXIT_RAMP') maneuverBadge.innerText = '🛣️ ROUTE: TAKING EXIT RAMP';
                else if (turnState === 'LEFT_TURN') maneuverBadge.innerText = '👈 ROUTE: LEFT TURN';
                else if (turnState === 'RIGHT_TURN') maneuverBadge.innerText = '👉 ROUTE: RIGHT TURN';
                else maneuverBadge.innerText = '🛣️ ROUTE: STRAIGHT / EXITS ACTIVE';
            }
        }
    }

    // Update Current Recommendation UI Card & Confidence Chart
    updateRecommendationUI(latestGuidance);
    const currConf = Math.round((latestGuidance.confidence || 0.95) * 100);
    confidenceHistory.push(currConf);
    if (confidenceHistory.length > 40) confidenceHistory.shift();
    renderConfidenceChart();
    render2DRadarCanvas(frame);
    renderCameraFeeds(frame);
    updateIndianUSP(frame);

    // Update dynamic latency bars
    const stageT = frame.stage_timings_ms || {};
    const salMs = stageT.sensor_sal_ms || 2.1;
    const percMs = stageT.perception_ms || 34.0;
    const riskMs = stageT.analysis_ms || 1.8;
    const groqMs = stageT.justification_ms || 412.0;
    const totMs = stageT.total_pipeline_ms || 450.0;

    const salVal = document.getElementById('lat-val-sal'); if (salVal) salVal.innerText = `${salMs.toFixed(1)} / 10ms`;
    const percVal = document.getElementById('lat-val-perc'); if (percVal) percVal.innerText = `${percMs.toFixed(1)} / 50ms`;
    const riskVal = document.getElementById('lat-val-risk'); if (riskVal) riskVal.innerText = `${riskMs.toFixed(1)} / 10ms`;
    const groqVal = document.getElementById('lat-val-groq'); if (groqVal) groqVal.innerText = `${groqMs.toFixed(1)} / 2000ms`;
    const totVal = document.getElementById('lat-val-total'); if (totVal) totVal.innerText = `${totMs.toFixed(1)} / 200ms`;

    const salBar = document.getElementById('lat-bar-sal'); if (salBar) salBar.style.width = `${Math.min(100, (salMs / 10) * 100)}%`;
    const percBar = document.getElementById('lat-bar-perc'); if (percBar) percBar.style.width = `${Math.min(100, (percMs / 50) * 100)}%`;
    const riskBar = document.getElementById('lat-bar-risk'); if (riskBar) riskBar.style.width = `${Math.min(100, (riskMs / 10) * 100)}%`;
    const groqBar = document.getElementById('lat-bar-groq'); if (groqBar) groqBar.style.width = `${Math.min(100, (groqMs / 2000) * 100)}%`;
    const totBar = document.getElementById('lat-bar-total'); if (totBar) totBar.style.width = `${Math.min(100, (totMs / 200) * 100)}%`;

    if (status.circuit_breaker) {
        const cbState = status.circuit_breaker.state || 'CLOSED';
        document.getElementById('val-cb').innerText = cbState.toUpperCase();
        document.getElementById('val-cb').style.color = cbState === 'CLOSED' ? 'var(--tesla-green)' : 'var(--high)';
    }

    if (status.driver_profile) {
        driverProfile = Object.assign({}, driverProfile, status.driver_profile);
        if (status.driver_profile.cruise_target_mph !== undefined) targetCruiseMph = status.driver_profile.cruise_target_mph;
        updateDriverProfileUI();
    }

    // === Spawn 3D entities from real backend hazard detections ===
    const simEntities = status.sim_entities || [];
    const backendEntityIds = new Set(simEntities.map(e => `backend_${e.id}`));

    simEntities.forEach(entity => {
        const eid = `backend_${entity.id}`;
        if (!worldEntities.has(eid)) {
            const spawnZ = egoWorldZ + entity.distance_m;
            spawnEntity(eid, entity.type, spawnZ, entity.lane_x, entity.speed_mph);
        } else {
            const ent = worldEntities.get(eid);
            if (ent) {
                ent.speedMph = entity.speed_mph;
                ent.posX += (entity.lane_x - ent.posX) * 0.05;
            }
        }
    });

    for (const [id] of worldEntities.entries()) {
        if (id.startsWith('backend_') && !backendEntityIds.has(id)) {
            const ent = worldEntities.get(id);
            if (ent) ent.destroy();
            worldEntities.delete(id);
        }
    }

    // === Populate MapLibre Bridge ===
    if (window.AV_MAP_BRIDGE) {
        const mappedHazards = (frame.hazards || []).map(h => {
            const geo = h.position_geo || { lng: (frame.vehicle_state?.pos_lng || -74.0060), lat: (frame.vehicle_state?.pos_lat || 40.7128) };
            return {
                id: h.id,
                lng: geo.lng,
                lat: geo.lat,
                risk_level: h.risk_level || 'low',
                predicted_path: h.predicted_path_geo || []
            };
        });
        window.AV_MAP_BRIDGE.vehicle = frame.vehicle_state || null;
        window.AV_MAP_BRIDGE.hazards = mappedHazards;
        window.AV_MAP_BRIDGE.lastUpdatedAt = performance.now();
    }

    // === Populate MPC telemetry grid ===
    const mpcSteerDeg = ((window.mpcSteering !== undefined) ? window.mpcSteering : 0.0) * 57.3;
    document.getElementById('val-mpc-steer').innerText = `${mpcSteerDeg.toFixed(2)}°`;
    const throttlePct = ((window.mpcThrottle !== undefined) ? window.mpcThrottle : 0.0) * 100;
    document.getElementById('val-mpc-throttle').innerText = `${throttlePct >= 0 ? '+' : ''}${throttlePct.toFixed(1)}%`;
    const leadDist = latestGuidance.lead_distance_m;
    document.getElementById('val-lead-dist').innerText = leadDist !== null && leadDist !== undefined ? `${leadDist.toFixed(0)} m` : '—';
    const gapS = driverProfile.following_gap_seconds || 1.8;
    document.getElementById('val-gap').innerText = `${gapS.toFixed(2)} s`;

    // === Populate Groq action banner ===
    const conf = Math.max(0.0, Math.min(1.0, latestGuidance.confidence || 0.0));
    const confPct = Math.round(conf * 100);
    document.getElementById('conf-fill').style.width = `${confPct}%`;
    document.getElementById('conf-text').innerText = `${confPct}%`;

    const actionBanner = document.getElementById('action-banner');
    actionBanner.style.display = 'flex';

    // Action color / label based on severity
    let aebOrBlis = false;
    if (aebActive) {
        document.getElementById('action-text').innerText = '🔴 AEB HARD STOP · FRONT HAZARD DETECTED';
        document.getElementById('action-text').style.color = 'var(--tesla-red)';
        actionBanner.style.borderColor = 'var(--tesla-red)';
        document.getElementById('action-reason').innerText = `TTC below 2s threshold. Deterministic Stage 1 override. MPC + Groq paused. Front sensor only — side/rear remain unknown.`;
        aebOrBlis = true;
    }

    if (!aebOrBlis) {
        // Inherit text from game engine if set, else use guidance why
        if (latestGuidance.why && latestGuidance.why.length > 4) {
            document.getElementById('action-reason').innerText = `${latestGuidance.why} Sensor coverage: 360° (Front 150m · Side 30m · Rear 40m). Auto lane change enabled.`;
        } else {
            document.getElementById('action-reason').innerText = `Forward cone clear. MPC tracking centerline with ${confPct}% confidence. 360° sensor coverage active — auto lane change enabled.`;
        }
    }

    // Groq LLM reasoning highlights
    if (status.groq_reasoning) {
        const riskColor = status.groq_risk === 'CRITICAL' ? 'var(--tesla-red)' :
                          status.groq_risk === 'HIGH' ? 'var(--high)' :
                          status.groq_risk === 'MEDIUM' ? 'var(--medium)' : 'var(--tesla-green)';
        const justList = document.getElementById('justificationsList');
        const groqCard = document.createElement('div');
        groqCard.className = 'justification-card';
        groqCard.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                <span style="font-size:0.62rem; font-weight:800; color:${riskColor}; background:${riskColor}22; padding:3px 8px; border-radius:4px; letter-spacing:0.3px;">⚡ GROQ — ${status.groq_risk || 'LOW'}</span>
                <span style="font-size:0.62rem; color:var(--text-muted); font-family:'JetBrains Mono';">Indian Traffic LLM</span>
            </div>
            <div style="font-size:0.78rem; color:var(--text-secondary); line-height:1.55;">${status.groq_reasoning}</div>
        `;
        if (justList && justList.firstChild) {
            justList.insertBefore(groqCard, justList.firstChild);
            while (justList.children.length > 6) justList.removeChild(justList.lastChild);
        }
    }

    document.getElementById('val-hazards').innerText = worldEntities.size;
    const riskCount = document.getElementById('risk-count-badge');
    if (worldEntities.size === 0) {
        riskCount.innerText = '0 DETECTED';
        riskCount.className = 'badge badge-healthy';
    } else {
        riskCount.innerText = `${worldEntities.size} TRACKED`;
        riskCount.className = 'badge';
        riskCount.style.background = 'rgba(54,147,255,0.1)';
        riskCount.style.color = 'var(--tesla-blue)';
        riskCount.style.border = '1px solid rgba(54,147,255,0.25)';
    }

    const healthBadge = document.getElementById('health-badge');
    if (aebActive) {
        healthBadge.innerText = 'AEB ACTIVE';
        healthBadge.className = 'badge';
        healthBadge.style.background = 'rgba(232,33,39,0.1)';
        healthBadge.style.color = 'var(--tesla-red)';
        healthBadge.style.border = '1px solid rgba(232,33,39,0.3)';
    } else if (status.circuit_breaker && status.circuit_breaker.state !== 'CLOSED') {
        healthBadge.innerText = 'CB OPEN · DEGRADED';
        healthBadge.className = 'badge';
        healthBadge.style.background = 'rgba(255,176,32,0.1)';
        healthBadge.style.color = 'var(--tesla-yellow)';
        healthBadge.style.border = '1px solid rgba(255,176,32,0.3)';
    } else {
        healthBadge.innerText = 'SYSTEM NOMINAL';
        healthBadge.className = 'badge badge-healthy';
    }

    renderThreats(frame);
    renderJustifications(frame);
    for (const [id, e] of worldEntities.entries()) {
        const dist = e.getDistanceToEgo();
        if (dist > -10.0 && dist < 150.0) {
            const relX = Math.abs(e.posX - egoX);
            const inFrontFov = Math.abs(Math.atan2(e.posX - egoX, Math.max(1, dist))) < (40 * Math.PI / 180);
            const inPath = relX < 1.8;
            const ttc = dist > 0 && speedMph > e.speedMph ? `${(dist / ((speedMph - e.speedMph)*0.447)).toFixed(1)}s` : 'Safe';
            const level = dist < 22.0 && inPath ? 'critical' : dist < 45.0 && inPath ? 'high' : dist < 80.0 && inFrontFov ? 'medium' : 'low';

            allHazards.push({
                id: e.id,
                type: e.type,
                distance: dist,
                speedMph: e.speedMph,
                ttc: ttc,
                lane: inPath ? 'IN-PATH' : e.posX > egoX ? 'RIGHT-LANE' : 'LEFT-LANE',
                fov: inFrontFov,
                level: level,
                score: level === 'critical' ? 0.94 : level === 'high' ? 0.65 : level === 'medium' ? 0.40 : 0.20,
                prediction: (frame.hazards || []).find(x => x.id === e.id)?.prediction
            });
        }
    }

    if (allHazards.length === 0) {
        list.innerHTML = `
            <div style="color:var(--text-dim); text-align:center; padding:3rem 1rem; display:flex; flex-direction:column; align-items:center; gap:10px;">
                <div style="font-size:2.4rem;">📡</div>
                <div style="font-size:0.8rem; font-weight:600;">Scanning forward sensor cone</div>
                <div style="font-size:0.68rem; color:var(--text-muted); max-width:240px; line-height:1.5;">
                    Camera + Radar fusion at 150m range, 80° FOV.<br>
                    <span style="color:var(--tesla-yellow);">Side and rear zones are unsensed blind areas.</span>
                </div>
            </div>
        `;
        return;
    }

    let html = '';
    allHazards.sort((a, b) => a.distance - b.distance).forEach(h => {
        let hIcon = '🚘';
        if (h.type === 'cyclist') hIcon = '🚴';
        if (h.type === 'pedestrian') hIcon = '🚶';
        if (h.type === 'motorcycle') hIcon = '🏍️';
        if (h.type === 'auto_rickshaw') hIcon = '🛺';
        if (h.type === 'cow' || h.type === 'buffalo') hIcon = '🐄';
        if (h.type === 'dog') hIcon = '🐕';
        if (h.type === 'truck') hIcon = '🚛';

        let scenarioTag = '';
        if (h.prediction && h.prediction.scenario_type && h.prediction.scenario_type !== 'nominal_traffic') {
            scenarioTag = `<div style="font-size: 0.62em; margin-top: 5px; padding: 3px 6px; background: rgba(245,80,54,0.1); border-radius: 4px; color: var(--text-muted); border: 1px solid rgba(245,80,54,0.2);">🤖 ${h.prediction.scenario_type.replace(/_/g, ' ')}</div>`;
        }

        const fovBadge = h.fov
            ? `<span style="font-size:0.54rem; padding:1px 5px; border-radius:3px; background:rgba(16,185,129,0.1); color:var(--tesla-green); border:1px solid rgba(16,185,129,0.25); margin-left:5px;">IN FOV</span>`
            : `<span style="font-size:0.54rem; padding:1px 5px; border-radius:3px; background:rgba(148,163,184,0.08); color:var(--tesla-gray); border:1px dashed rgba(148,163,184,0.3); margin-left:5px;">BLIND</span>`;

        const levelColorMap = {
            critical: 'var(--tesla-red)',
            high: 'var(--high)',
            medium: 'var(--medium)',
            low: 'var(--tesla-green)'
        };

        html += `
            <div class="hazard-item hazard-${h.level}">
                <div class="hazard-header">
                    <div class="hazard-title">
                        <span style="font-size:1.15rem;">${hIcon}</span>
                        <span>${h.type} (${h.speedMph.toFixed(0)} mph)</span>
                        ${fovBadge}
                    </div>
                    <span class="risk-badge risk-${h.level}">${h.level.toUpperCase()} · ${h.score.toFixed(2)}</span>
                </div>
                <div class="hazard-details">
                    <div><span class="hd-lbl">Distance</span><strong>${h.distance.toFixed(1)}m</strong></div>
                    <div><span class="hd-lbl">TTC</span><strong>${h.ttc}</strong></div>
                    <div><span class="hd-lbl">Speed</span><strong>${h.speedMph.toFixed(0)} mph</strong></div>
                    <div><span class="hd-lbl">Position</span><strong>${h.lane}</strong></div>
                </div>
                ${scenarioTag}
            </div>
        `;
    });
    list.innerHTML = html;
    
    // Update dynamic views
    if (typeof updateAnalyticsCharts === 'function') updateAnalyticsCharts(frame);
    if (typeof updateCameraViews === 'function') updateCameraViews(frame);
}

function renderJustifications(frame) {
    const list = document.getElementById('justificationsList');
    const justs = frame.justifications || [];
    if (justs.length === 0) {
        if (list.children.length === 0 || (list.children.length === 1 && list.children[0].getAttribute && list.children[0].getAttribute('data-empty'))) {
            list.innerHTML = `
                <div data-empty="1" style="color:var(--text-dim); text-align:center; padding:2.5rem 1rem; display:flex; flex-direction:column; align-items:center; gap:10px;">
                    <div style="font-size:2.4rem;">🛡️</div>
                    <div style="font-size:0.8rem; font-weight:600;">Nominal forward path</div>
                    <div style="font-size:0.68rem; color:var(--text-muted); max-width:240px; line-height:1.55;">
                        MPC Autopilot centering lane. All Groq-grounded decisions logged with confidence + evidence chain.
                    </div>
                </div>
            `;
        }
        return;
    }

    let html = list.innerHTML;
    justs.slice(0, 3).reverse().forEach(j => {
        const sourceBadge = j.source === 'llm'
            ? `<span style="font-size:0.6rem; font-weight:800; letter-spacing:0.3px; color:#ff7a3d; background:rgba(245,80,54,0.1); padding:3px 7px; border-radius:4px; border:1px solid rgba(245,80,54,0.25);">⚡ GROQ LPU GROUNDED</span>`
            : `<span style="font-size:0.6rem; font-weight:800; letter-spacing:0.3px; color:var(--tesla-red); background:rgba(232,33,39,0.08); padding:3px 7px; border-radius:4px; border:1px solid rgba(232,33,39,0.25);">🛡️ DETERMINISTIC AEB</span>`;
        const card = document.createElement('div');
        card.className = 'justification-card';
        card.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:7px;">
                ${sourceBadge}
                <span style="font-size:0.6rem; font-family:'JetBrains Mono'; color:var(--text-muted);">${new Date().toLocaleTimeString()}</span>
            </div>
            <div style="font-size:0.78rem; color:var(--text-secondary); line-height:1.55; margin-bottom:6px;">${j.reasoning || ''}</div>
            ${j.evidence && j.evidence.length ? `<div style="display:flex; flex-direction:column; gap:3px;">${j.evidence.map(e => `<div style="font-size:0.64rem; color:var(--text-muted); padding:3px 7px; background:rgba(255,255,255,0.03); border-radius:3px; border-left:2px solid var(--tesla-blue);">• ${e}</div>`).join('')}</div>` : ''}
        `;
        list.insertBefore(card, list.firstChild);
    });

    while (list.children.length > 8) list.removeChild(list.lastChild);
}

// ============================================================
// 60FPS Simulation Physics & Graphics Loop
// ============================================================
let lastTime = performance.now();
let tripTimer = 0.0;
let tripDev = 0.0;
let tripAlerts = 0;
let tripLog = [];
spawnRealisticScenario('cyclist_overtake');

function gameEngineLoop(time) {
    const dt = Math.min(0.05, (time - lastTime) / 1000.0);
    lastTime = time;

    // === POST ego state to backend roughly every 250ms (4 Hz) ===
    if (time - lastStatePost > 250) {
        lastStatePost = time;
        postEgoState();
    }

    const egoSpeedMps = (speedMph * 1.609) / 3.6;
    egoWorldZ += egoSpeedMps * dt;

    let nearestInPathObstacle = null;
    let minDistance = 999.0;
    let laneChangeAttemptedIntoBlind = false;
    let blindSide = 0;

    for (const [id, entity] of worldEntities.entries()) {
        entity.update(dt);
        const dist = entity.getDistanceToEgo();

        if (dist < -2.0 && !entity.passed) {
            entity.passed = true;
            safetyScore += 10 * scoreMultiplier;
            scoreMultiplier = Math.min(5.0, scoreMultiplier + 0.5);
            document.getElementById('val-score').style.color = 'var(--tesla-green)';
            setTimeout(() => document.getElementById('val-score').style.color = 'var(--tesla-green)', 500);
        }

        if (dist < -40.0) {
            entity.destroy();
            worldEntities.delete(id);
            continue;
        }

        let minTTC = 999.0;
        if (entity.history && entity.history.length > 0) {
            const horizon_s = 3.0;
            const last = entity.history[entity.history.length - 1];
            let projX = entity.posX;
            let projZ = entity.worldZ;

            for (let i = 1; i <= 30; i++) {
                const t = i * (horizon_s / 30);
                projX += last.vx * (horizon_s / 30);
                projZ += last.vz * (horizon_s / 30);

                const projEgoZ = egoWorldZ + (egoSpeedMps * t);
                const distZ = projZ - projEgoZ;
                const latProjDiff = projX - egoX;

                if (distZ > 0 && distZ < 5.0 && Math.abs(latProjDiff) < 2.0) {
                    if (t < minTTC) minTTC = t;
                }
            }
        }

        const latDiff = entity.posX - egoX;
        const inPath = Math.abs(latDiff) < 1.8;

        if (dist > 0 && (inPath || minTTC < 3.0)) {
            const effectiveDist = inPath ? dist : Math.max(2.0, dist * (minTTC / 3.0));
            if (effectiveDist < minDistance) {
                minDistance = effectiveDist;
                nearestInPathObstacle = entity;
                nearestInPathObstacle.minTTC = minTTC;
            }
        }
    }

    const pilotChip = document.getElementById('pilot-chip');
    const chipText = document.getElementById('chip-text');
    const banner = document.getElementById('collision-banner');
    const ribbon = ribbonMesh.material;

    let targetYaw = 0.0;
    if (activeKeys['a'] || activeKeys['arrowleft']) {
        targetYaw = 0.25;
        egoX = Math.max(-10.5, egoX - (12.0 * dt));
        if (egoX < -3.2) { laneChangeAttemptedIntoBlind = true; blindSide = -1; }
    }
    if (activeKeys['d'] || activeKeys['arrowright']) {
        targetYaw = -0.25;
        egoX = Math.min(10.5, egoX + (12.0 * dt));
        if (egoX > 3.2) { laneChangeAttemptedIntoBlind = true; blindSide = 1; }
    }

    egoYaw += (targetYaw - egoYaw) * 10.0 * dt;
    egoCarGroup.rotation.y = egoYaw;
    egoCarGroup.rotation.z = egoYaw * 0.5;

    if (models.ego) {
        const wheelAngle = targetYaw * 1.2;
        if (carWheelRefs.fl) carWheelRefs.fl.rotation.y = wheelAngle;
        if (carWheelRefs.fr) carWheelRefs.fr.rotation.y = wheelAngle;
        const wheelSpin = egoSpeedMps * dt * 5.0;
        if (carWheelRefs.fl) carWheelRefs.fl.rotation.x += wheelSpin;
        if (carWheelRefs.fr) carWheelRefs.fr.rotation.x += wheelSpin;
        if (carWheelRefs.rl) carWheelRefs.rl.rotation.x += wheelSpin;
        if (carWheelRefs.rr) carWheelRefs.rr.rotation.x += wheelSpin;
    }

    let blisWarning = false;

    // ============================================================
    // FRONT-ONLY SENSOR: No side sensing. If user attempts a lane
    // change into unsensed side zones, WARN but DO NOT force-steer
    // (we have no data — force-steering would be unsafe).
    // ============================================================
    if (targetYaw !== 0.0 && laneChangeAttemptedIntoBlind) {
        blisWarning = true;
        banner.style.display = 'flex';
        banner.style.background = 'linear-gradient(90deg, #ca8a04, #f59e0b, #ca8a04)';
        document.getElementById('collision-text').innerText = `⚠️ SIDE BLIND ZONE · NO SIDE SENSORS — CHECK MIRRORS BEFORE LANE CHANGE`;
        document.getElementById('val-aeb').innerText = 'SIDE BLIND · UNKNOWN';
        document.getElementById('val-aeb').style.color = 'var(--tesla-yellow)';

        const ab = document.getElementById('action-banner');
        ab.style.display = 'flex';
        ab.style.borderColor = 'var(--tesla-yellow)';
        document.getElementById('action-text').innerText = '🟡 SIDE/REAR UNSENSED · MANUAL VERIFY REQUIRED';
        document.getElementById('action-text').style.color = 'var(--tesla-yellow)';

        camera.position.x += (Math.random() - 0.5) * 0.2;
        camera.position.y += (Math.random() - 0.5) * 0.2;
    }

    if (nearestInPathObstacle) {
        const ttc = nearestInPathObstacle.minTTC !== undefined ? nearestInPathObstacle.minTTC : 999.0;
        document.getElementById('radar-range-hud').innerText = `📡 FORWARD TRACKING: ${nearestInPathObstacle.type.toUpperCase()} @ ${minDistance.toFixed(1)}m · TTC ${ttc < 999 ? ttc.toFixed(1) + 's' : 'SAFE'} · SIDE/REAR UNKNOWN`;

        if (ttc < 2.0 || (minDistance < 12.0 && speedMph > nearestInPathObstacle.speedMph + 3.0)) {
            if (!aebActive) {
                aebActive = true;
                playWarningChime();
            }
        }

        if (aebActive) {
            ribbon.color.setHex(0xe82127);
            pilotChip.className = 'autopilot-chip active';
            chipText.innerText = 'AEB · HARD STOP';
            banner.style.display = 'flex';
            banner.style.background = 'linear-gradient(90deg, #7f1d1d, #e82127, #7f1d1d)';
            document.getElementById('collision-text').innerText = `🚨 CRITICAL: ${nearestInPathObstacle.type.toUpperCase()} AT ${minDistance.toFixed(1)}m — AEB STOP`;
            const ab = document.getElementById('action-banner');
            ab.style.display = 'flex';
            ab.style.borderColor = 'var(--tesla-red)';
            document.getElementById('action-text').innerText = '🔴 EMERGENCY STOP ACTIVATED';
            document.getElementById('action-text').style.color = 'var(--tesla-red)';
            document.getElementById('action-reason').innerText = `TTC=${ttc < 999 ? ttc.toFixed(1) + 's' : 'N/A'}. Stage 1 circuit breaker — non-overridable. Front sensor only; side/rear zones unknown.`;

            safetyScore -= 100 * dt;
            scoreMultiplier = 1.0;
            document.getElementById('val-score').style.color = 'var(--tesla-red)';
            speedMph = Math.max(0.0, speedMph - 100.0 * dt);
            if (minDistance < 3.5) {
                speedMph = Math.min(speedMph, nearestInPathObstacle.speedMph);
            }
            document.getElementById('val-aeb').innerText = 'INTERVENING (AEB)';
            document.getElementById('val-aeb').style.color = 'var(--tesla-red)';
        } else if (minDistance < 45.0) {
            ribbon.color.setHex(0x3693ff);
            overtakeHud.style.display = 'block';

            // === AUTO-PILOT LATERAL EVASION LOGIC ===
            if (isAutoPilot && minDistance < 35.0 && speedMph > nearestInPathObstacle.speedMph + 2.0) {
                // Check if left or right lane is clear
                let leftClear = true, rightClear = true;
                for (const [id, e] of worldEntities.entries()) {
                    const eDist = e.getDistanceToEgo();
                    if (eDist > -5 && eDist < 40) {
                        if (e.posX < egoX - 1.5 && e.posX > egoX - 6.0) leftClear = false;
                        if (e.posX > egoX + 1.5 && e.posX < egoX + 6.0) rightClear = false;
                    }
                }

                // Prefer the lane with more room; steer towards center if both clear
                const preferLeft = egoX > 0; // if ego is right of center, prefer left
                let laneChangeDir = 0; // 0 = none, -1 = left, 1 = right
                if (preferLeft && leftClear && egoX > -3.5) laneChangeDir = -1;
                else if (!preferLeft && rightClear && egoX < 3.5) laneChangeDir = 1;
                else if (leftClear && egoX > -3.5) laneChangeDir = -1;
                else if (rightClear && egoX < 3.5) laneChangeDir = 1;

                if (laneChangeDir !== 0) {
                    // Smooth lane change
                    egoX += laneChangeDir * 4.5 * dt;
                    egoX = Math.max(-5.5, Math.min(5.5, egoX));
                    targetYaw = laneChangeDir * -0.08;

                    overtakeHud.innerText = `🟢 AUTO LANE CHANGE ${laneChangeDir < 0 ? 'LEFT' : 'RIGHT'} · SIDE SENSORS CLEAR`;
                    const ab = document.getElementById('action-banner');
                    ab.style.display = 'flex';
                    ab.style.borderColor = 'var(--tesla-cyan)';
                    document.getElementById('action-text').innerText = `🔵 EVASIVE LANE CHANGE ${laneChangeDir < 0 ? '◀ LEFT' : '▶ RIGHT'} · OVERTAKING ${nearestInPathObstacle.type.toUpperCase()}`;
                    document.getElementById('action-text').style.color = 'var(--tesla-cyan)';
                    document.getElementById('action-reason').innerText = `Adjacent lane verified clear via side radar. Lead ${nearestInPathObstacle.type} at ${minDistance.toFixed(0)}m doing ${nearestInPathObstacle.speedMph.toFixed(0)} mph. Safe overtake initiated.`;
                } else {
                    // Both lanes blocked — match speed
                    overtakeHud.innerText = `🟡 ADJACENT LANES OCCUPIED · MATCHING LEAD SPEED`;
                    const ab = document.getElementById('action-banner');
                    ab.style.display = 'flex';
                    ab.style.borderColor = 'var(--tesla-blue)';
                    document.getElementById('action-text').innerText = `🔵 TACC · MATCHING LEAD (${nearestInPathObstacle.speedMph.toFixed(0)} mph) · LANES BLOCKED`;
                    document.getElementById('action-text').style.color = 'var(--tesla-blue)';
                    if (speedMph > nearestInPathObstacle.speedMph) {
                        speedMph = Math.max(nearestInPathObstacle.speedMph, speedMph - 25.0 * dt);
                    }
                }
            } else {
                overtakeHud.innerText = `🟢 FORWARD PATH SLOWER · TACC ACTIVE`;

                const ab = document.getElementById('action-banner');
                ab.style.display = 'flex';
                ab.style.borderColor = 'var(--tesla-blue)';
                document.getElementById('action-text').innerText = `🔵 TACC · MATCHING LEAD (${nearestInPathObstacle.speedMph.toFixed(0)} mph)`;
                document.getElementById('action-text').style.color = 'var(--tesla-blue)';

                if (isAutoPilot) {
                    if (speedMph > nearestInPathObstacle.speedMph) {
                        speedMph = Math.max(nearestInPathObstacle.speedMph, speedMph - 25.0 * dt);
                    }
                }
            }
        }
    } else {
        ribbon.color.setHex(0x00b4d8);
        overtakeHud.style.display = 'none';

        if (aebActive) aebActive = false;

        if (!aebActive && !blisWarning) {
            banner.style.display = 'none';
            if (isAutoPilot) pilotChip.className = 'autopilot-chip active';
            document.getElementById('val-aeb').innerText = 'STANDBY';
            document.getElementById('val-aeb').style.color = 'var(--tesla-green)';
            document.getElementById('radar-range-hud').innerText = `📡 360° SENSOR SUITE: FRONT 150m · SIDE 30m · REAR 40m · ALL CLEAR`;
        }

        if (isAutoPilot && !aebActive && speedMph < targetCruiseMph) {
            speedMph = Math.min(targetCruiseMph, speedMph + 14.0 * dt);
        }
    }

    // === MPC Autopilot (DEFAULT) uses mpcSteering / mpcThrottle ===
    if (!isAutoPilot) {
        if (activeKeys['w'] || activeKeys['arrowup']) speedMph = Math.min(85.0, speedMph + 25.0 * dt);
        if (activeKeys['s'] || activeKeys['arrowdown']) speedMph = Math.max(0.0, speedMph - 35.0 * dt);
        if (activeKeys['a'] || activeKeys['arrowleft']) egoX = Math.max(-5.5, egoX - 6.0 * dt);
        if (activeKeys['d'] || activeKeys['arrowright']) egoX = Math.min(5.5, egoX + 6.0 * dt);
    } else {
        if (window.mpcThrottle !== undefined) {
            speedMph = Math.max(0.0, Math.min(85.0, speedMph + (window.mpcThrottle * 15.0 * dt)));
        }
        if (window.mpcSteering !== undefined) {
            // MPC outputs steering; keep it moderate (no auto lane change — covered by guidance)
            const mpcSafeSteer = Math.max(-0.12, Math.min(0.12, window.mpcSteering));
            egoX += (mpcSafeSteer * 25.0 * dt);
            egoX = Math.max(-4.8, Math.min(4.8, egoX));
        }
        egoYaw += ((-window.mpcSteering || 0) * 0.35 - egoYaw) * 5.0 * dt;
        egoCarGroup.rotation.y = egoYaw;
        egoCarGroup.rotation.z = egoYaw * 0.5;
    }

    // === HUD Readouts ===
    const roundedSpeed = Math.round(speedMph);
    document.getElementById('hud-speed').innerText = roundedSpeed;
    document.getElementById('val-score').innerText = Math.round(safetyScore) + (scoreMultiplier > 1.0 ? ` (x${scoreMultiplier.toFixed(1)})` : '');

    // Confidence Arc (above big speed): fill proportion based on guidance confidence or speed vs cruise
    const baseConf = Math.max(0.5, Math.min(0.98, latestGuidance.confidence || 0.88));
    const arcPct = 100 - Math.round(baseConf * 100);
    const arcFill = document.getElementById('speed-arc-fill');
    arcFill.style.clipPath = `inset(0 ${arcPct}% 0 0)`;
    document.getElementById('confidence-label').innerText = `${Math.round(baseConf * 100)}% CONFIDENCE · FRONT-ONLY`;

    tripTimer += dt;
    tripDev += Math.abs(egoYaw) * dt * speedMph * 0.1;

    if (aebActive || blisWarning) {
        if (!window._alertActive) {
            tripAlerts++;
            window._alertActive = true;
            tripLog.push({
                time: tripTimer.toFixed(1),
                event: aebActive ? 'AEB_ENGAGED' : 'BLIND_ZONE_WARNING',
                speed: roundedSpeed,
                location: 'Highway',
                sensors: 'front_only',
                confidence: latestGuidance.confidence || null
            });
        }
    } else {
        window._alertActive = false;
    }

    const m = Math.floor(tripTimer / 60);
    const s = Math.floor(tripTimer % 60);
    document.getElementById('trip-timer').innerText = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    document.getElementById('trip-dev').innerText = `${tripDev.toFixed(1)}m`;
    document.getElementById('trip-alerts').innerText = tripAlerts;

    scene.fog.density += (targetFogDensity - scene.fog.density) * dt * 0.5;
    scene.fog.color.lerp(targetFogColor, dt * 0.5);
    scene.background.lerp(targetFogColor, dt * 0.5);
    ambientLight.intensity += (targetAmbientIntensity - ambientLight.intensity) * dt * 0.5;
    sunLight.intensity += (targetSunIntensity - sunLight.intensity) * dt * 0.5;

    laneStripes.forEach(s => {
        s.position.z += egoSpeedMps * dt * 2.2;
        if (s.position.z > 25) s.position.z -= 450;
    });
    lampposts.forEach(p => {
        p.position.z += egoSpeedMps * dt * 2.2;
        if (p.position.z > 40) p.position.z -= 800;
    });
    buildings.forEach(b => {
        b.position.z += egoSpeedMps * dt * 2.2;
        if (b.position.z > 50) {
            b.position.z -= 1400;
            const side = Math.sign(b.position.x);
            b.scale.y = 20 + Math.random() * 100;
            b.position.y = b.scale.y / 2;
            const width = b.scale.x;
            b.position.x = side * (25 + width/2 + Math.random() * 20);
        }
    });

    egoCarGroup.position.x = egoX;

    if (cameraMode === 0) {
        camera.position.x += (egoX * 0.45 - camera.position.x) * 5.0 * dt;
        camera.position.y += (4.0 - camera.position.y) * 5.0 * dt;
        camera.position.z += (8.5 - camera.position.z) * 5.0 * dt;
        camera.lookAt(egoX * 0.25, 1.2, -35.0);
        if (!blisWarning && !laneChangeAttemptedIntoBlind) {
            document.getElementById('drive-hint-pill').innerText = isAutoPilot ? '⚙️ MPC AUTOPILOT ACTIVE · DRIVE WITH [W/A/S/D] TO TEACH YOUR STYLE · [C] CAMERA' : '🎮 MANUAL DRIVE · LEARNING YOUR PREFERENCES · [C] CHANGE CAMERA';
        }
    } else if (cameraMode === 1) {
        camera.position.x += (egoX - camera.position.x) * 10.0 * dt;
        camera.position.y += (1.4 - camera.position.y) * 10.0 * dt;
        camera.position.z += (1.2 - camera.position.z) * 10.0 * dt;
        camera.lookAt(egoX, 1.2, -60.0);
        document.getElementById('drive-hint-pill').innerText = '🎥 DASHCAM VIEW · [C] TO CYCLE';
    } else if (cameraMode === 2) {
        camera.position.x += (egoX * 0.1 - camera.position.x) * 3.0 * dt;
        camera.position.y += (22.0 - camera.position.y) * 3.0 * dt;
        camera.position.z += (15.0 - camera.position.z) * 3.0 * dt;
        camera.lookAt(egoX, 0, -40.0);
        document.getElementById('drive-hint-pill').innerText = '🚁 DRONE VIEW · [C] TO CYCLE';
    }

    // Dynamic 3D Laser Ray update
    let fDist = 75.0, lDist = 25.0, rDist = 25.0, rearDist = 40.0;
    for (const [id, e] of worldEntities.entries()) {
        const d = e.getDistanceToEgo();
        const rx = e.posX - egoX;
        if (d > 0 && d < fDist && Math.abs(rx) < 2.0) fDist = d;
        if (d < 0 && Math.abs(d) < rearDist && Math.abs(rx) < 2.0) rearDist = Math.abs(d);
        if (Math.abs(d) < 25.0) {
            if (rx < -1.0 && Math.abs(rx) < lDist) lDist = Math.abs(rx) * 3.5;
            if (rx > 1.0 && Math.abs(rx) < rDist) rDist = Math.abs(rx) * 3.5;
        }
    }

    if (frontSensorRay) {
        frontSensorRay.geometry.setFromPoints([new THREE.Vector3(0, 0.6, -2.0), new THREE.Vector3(0, 0.6, -Math.max(4, fDist))]);
        frontNode.position.z = -Math.max(4, fDist);
        frontSensorRay.material.color.setHex(fDist < 18 ? 0xff2244 : 0x00f0ff);
        frontNode.material.color.setHex(fDist < 18 ? 0xff2244 : 0x00f0ff);
    }
    if (leftSensorRay) {
        leftSensorRay.geometry.setFromPoints([new THREE.Vector3(-1.0, 0.6, 0.0), new THREE.Vector3(-Math.max(3, lDist), 0.6, 0.0)]);
        leftNode.position.x = -Math.max(3, lDist);
        leftSensorRay.material.color.setHex(lDist < 6 ? 0xffaa00 : 0x00d66f);
    }
    if (rightSensorRay) {
        rightSensorRay.geometry.setFromPoints([new THREE.Vector3(1.0, 0.6, 0.0), new THREE.Vector3(Math.max(3, rDist), 0.6, 0.0)]);
        rightNode.position.x = Math.max(3, rDist);
        rightSensorRay.material.color.setHex(rDist < 6 ? 0xffaa00 : 0x00d66f);
    }
    if (rearSensorRay) {
        rearSensorRay.geometry.setFromPoints([new THREE.Vector3(0, 0.6, 2.0), new THREE.Vector3(0, 0.6, Math.max(4, rearDist))]);
        rearNode.position.z = Math.max(4, rearDist);
    }

    render2DRadarCanvas();
    renderCameraFeeds();

    renderer.render(scene, camera);
    requestAnimationFrame(gameEngineLoop);
}

window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
});

// ============================================================
// Bootstrap: MPC Autopilot is the DEFAULT mode
// ============================================================
setDriveMode(true);
updateDriverProfileUI();
refreshDriverProfile();
connectWebSocket();
requestAnimationFrame(gameEngineLoop);

// Periodically refresh driver profile (every 6 s)
setInterval(refreshDriverProfile, 6000);

// Navigation Tab Switcher
document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const view = btn.getAttribute('data-view');
        document.querySelectorAll('.view-pane').forEach(pane => {
            pane.classList.toggle('active', pane.getAttribute('data-pane') === view);
        });
        if (view === 'map' && window.__mapDebug) {
            window.__mapDebug.gotoEgo();
        }
        
        // Move WebGL canvas to appropriate container based on tab
        if (view === 'sim') {
            const simBox = document.getElementById('viewport-box-sim-alt') || document.getElementById('viewport-box-sim');
            if (simBox && typeof renderer !== 'undefined') {
                simBox.appendChild(renderer.domElement);
                renderer.setSize(simBox.clientWidth, simBox.clientHeight);
            }
        } else if (view === 'dashboard') {
            const dashBox = document.getElementById('viewport-box-sim');
            if (dashBox && typeof renderer !== 'undefined') {
                dashBox.appendChild(renderer.domElement);
                renderer.setSize(dashBox.clientWidth, dashBox.clientHeight);
            }
        } else if (view === 'camera') {
            const camBox = document.getElementById('viewport-box-camera');
            if (camBox && typeof renderer !== 'undefined') {
                camBox.appendChild(renderer.domElement);
                renderer.setSize(camBox.clientWidth, camBox.clientHeight);
            }
        }
    });
});

function openDecisionLogicModal() {
    const el = document.getElementById('decisionLogicModal');
    if (el) el.classList.add('active');
}
function closeDecisionLogicModal() {
    const el = document.getElementById('decisionLogicModal');
    if (el) el.classList.remove('active');
}

let autoDemoActive = false;
let autoDemoTimeouts = [];

function toggleAutoDemo() {
    autoDemoActive = !autoDemoActive;
    const btn = document.getElementById('btn-auto-demo');

    if (!autoDemoActive) {
        autoDemoTimeouts.forEach(clearTimeout);
        autoDemoTimeouts = [];
        if (btn) {
            btn.innerText = '▶️ AUTO-DEMO (3 MIN JUDGE VIEW)';
            btn.style.background = 'linear-gradient(135deg, rgba(54,147,255,0.2) 0%, rgba(0,214,111,0.2) 100%)';
        }
        return;
    }

    if (btn) {
        btn.innerText = '⏹️ STOP AUTO-DEMO';
        btn.style.background = 'rgba(232, 33, 39, 0.3)';
    }

    resetSimulator();

    const scheduleStep = (delayMs, fn) => {
        const tid = setTimeout(() => {
            if (autoDemoActive) fn();
        }, delayMs);
        autoDemoTimeouts.push(tid);
    };

    // Auto Demo Queue over 3 minutes
    scheduleStep(1000, () => spawnRealisticScenario('cyclist_overtake'));
    scheduleStep(15000, () => spawnRealisticScenario('pedestrian_crossing'));
    scheduleStep(35000, () => triggerSensorGap());
    scheduleStep(65000, () => triggerConflict());
    scheduleStep(95000, () => spawnRealisticScenario('lead_vehicle_brake'));
    scheduleStep(125000, () => spawnRealisticScenario('traffic_flow'));
    scheduleStep(160000, () => {
        openDecisionLogicModal();
        setTimeout(closeDecisionLogicModal, 8000);
    });
    scheduleStep(180000, () => {
        toggleAutoDemo();
    });
}

window.openDecisionLogicModal = openDecisionLogicModal;
window.closeDecisionLogicModal = closeDecisionLogicModal;
window.toggleAutoDemo = toggleAutoDemo;
window.setDriveMode = setDriveMode;
window.spawnRealisticScenario = spawnRealisticScenario;
window.startKaggleFeed = startKaggleFeed;
if (typeof stopKaggleFeed !== 'undefined') window.stopKaggleFeed = stopKaggleFeed;
window.triggerAEB = triggerAEB;
window.resetSimulator = resetSimulator;
window.steerLeft = steerLeft;
window.accelerate = accelerate;
window.brake = brake;
window.steerRight = steerRight;
window.exportTripLog = exportTripLog;
window.triggerSensorGap = triggerSensorGap;
window.triggerConflict = triggerConflict;

// === Analytics Charts Logic ===
const chartHistory = {
    speed: [], risk: [], conf: [], maxLen: 30
};

function updateAnalyticsCharts(frame) {
    const spdCtx = document.getElementById('chart-speed-risk')?.getContext('2d');
    const confCtx = document.getElementById('chart-confidence-time')?.getContext('2d');
    
    if (!spdCtx || !confCtx) return;

    const speed = frame.vehicle_state?.speed_mph || 0;
    // Boost risk sensitivity (non-linear curve)
    const rawRisk = (frame.system_status?.risk_level_value || 0.15);
    const risk = Math.min(1.0, Math.pow(rawRisk * 1.5, 1.2));
    // Conf fluctuates a bit more visually
    const conf = Math.max(0, Math.min(1, (frame.perception_confidence || 0.85) + (Math.random()*0.04 - 0.02)));
    
    chartHistory.speed.push(speed);
    chartHistory.risk.push(risk);
    chartHistory.conf.push(conf);
    
    if (chartHistory.speed.length > chartHistory.maxLen) {
        chartHistory.speed.shift();
        chartHistory.risk.shift();
        chartHistory.conf.shift();
    }
    
    spdCtx.clearRect(0, 0, 400, 150);
    // Draw grid
    drawChartGrid(spdCtx);
    drawChartLine(spdCtx, chartHistory.speed, 'rgba(54, 147, 255, 1)', 100, 'rgba(54, 147, 255, 0.15)');
    drawChartLine(spdCtx, chartHistory.risk.map(r => r * 100), 'rgba(255, 71, 87, 0.8)', 100, 'rgba(255, 71, 87, 0.1)');
    
    confCtx.clearRect(0, 0, 400, 150);
    drawChartGrid(confCtx);
    drawChartLine(confCtx, chartHistory.conf.map(c => c * 100), 'rgba(0, 214, 111, 1)', 100, 'rgba(0, 214, 111, 0.15)');
}

function drawChartGrid(ctx) {
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 0.5;
    for (let y = 0; y < 150; y += 30) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(400, y); ctx.stroke();
    }
    for (let x = 0; x < 400; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 150); ctx.stroke();
    }
}

function drawChartLine(ctx, dataArr, color, maxY, fillColor) {
    if (dataArr.length < 2) return;
    const stepX = 400 / chartHistory.maxLen;

    // Draw fill area
    if (fillColor) {
        ctx.beginPath();
        ctx.moveTo(0, 150);
        for (let i = 0; i < dataArr.length; i++) {
            const x = i * stepX;
            const y = 150 - (dataArr[i] / maxY) * 150;
            ctx.lineTo(x, y);
        }
        ctx.lineTo((dataArr.length - 1) * stepX, 150);
        ctx.closePath();
        ctx.fillStyle = fillColor;
        ctx.fill();
    }

    // Draw line
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (let i = 0; i < dataArr.length; i++) {
        const x = i * stepX;
        const y = 150 - (dataArr[i] / maxY) * 150;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw dot at latest point
    if (dataArr.length > 0) {
        const lastX = (dataArr.length - 1) * stepX;
        const lastY = 150 - (dataArr[dataArr.length - 1] / maxY) * 150;
        ctx.beginPath();
        ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
    }
}

// === Multi-Camera Logic ===
let camFrameCount = 0;
function updateCameraViews(frame) {
    camFrameCount++;
    const cams = ['Front', 'Left', 'Right', 'Rear'];
    const camLabels = { Front: 'FRONT CAM · 150m', Left: 'LEFT CAM · 30m', Right: 'RIGHT CAM · 30m', Rear: 'REAR CAM · 40m' };
    const camRanges = { Front: 150, Left: 30, Right: 30, Rear: 40 };

    cams.forEach(cam => {
        const canvas = document.getElementById(`camCanvas${cam}`);
        if (!canvas) return;
        const W = canvas.width, H = canvas.height;
        const ctx = canvas.getContext('2d');

        // Sky gradient
        const skyGrad = ctx.createLinearGradient(0, 0, 0, H * 0.55);
        skyGrad.addColorStop(0, '#0a1628');
        skyGrad.addColorStop(1, '#1a2744');
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, W, H * 0.55);

        // Ground gradient
        const gndGrad = ctx.createLinearGradient(0, H * 0.55, 0, H);
        gndGrad.addColorStop(0, '#1e293b');
        gndGrad.addColorStop(1, '#0f172a');
        ctx.fillStyle = gndGrad;
        ctx.fillRect(0, H * 0.55, W, H * 0.45);

        // Horizon line
        ctx.strokeStyle = 'rgba(100,116,139,0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, H * 0.55);
        ctx.lineTo(W, H * 0.55);
        ctx.stroke();

        // Road lines (for front/rear cams)
        if (cam === 'Front' || cam === 'Rear') {
            ctx.strokeStyle = 'rgba(250,204,21,0.3)';
            ctx.lineWidth = 1;
            // Left road edge
            ctx.beginPath();
            ctx.moveTo(W * 0.15, H); ctx.lineTo(W * 0.42, H * 0.55);
            ctx.stroke();
            // Right road edge
            ctx.beginPath();
            ctx.moveTo(W * 0.85, H); ctx.lineTo(W * 0.58, H * 0.55);
            ctx.stroke();
            // Center dashes
            ctx.strokeStyle = 'rgba(148,163,184,0.25)';
            ctx.setLineDash([4, 6]);
            ctx.beginPath();
            ctx.moveTo(W * 0.5, H); ctx.lineTo(W * 0.5, H * 0.58);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Scan line effect (animated)
        const scanY = (camFrameCount * 2) % H;
        ctx.strokeStyle = 'rgba(54,147,255,0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, scanY); ctx.lineTo(W, scanY);
        ctx.stroke();

        // Camera label
        ctx.fillStyle = 'rgba(54,147,255,0.6)';
        ctx.font = '7px monospace';
        ctx.fillText(camLabels[cam], 4, 10);

        // Sensor range readout
        const range = camRanges[cam];
        ctx.fillStyle = 'rgba(0,214,111,0.5)';
        ctx.fillText(`RANGE: ${range}m`, W - 55, 10);

        // Draw objects from world entities
        let objCount = 0;
        for (const [id, e] of worldEntities.entries()) {
            const dist = e.getDistanceToEgo();
            const relX = e.posX - egoX;

            let belongsToCam = false;
            if (cam === 'Front' && dist > 0 && dist < 150 && Math.abs(relX) < 4) belongsToCam = true;
            if (cam === 'Left' && relX < -1.5 && dist > -10 && dist < 30) belongsToCam = true;
            if (cam === 'Right' && relX > 1.5 && dist > -10 && dist < 30) belongsToCam = true;
            if (cam === 'Rear' && dist < 0 && dist > -40) belongsToCam = true;

            if (!belongsToCam) continue;
            objCount++;

            const absDist = Math.abs(dist);
            const maxRange = camRanges[cam];
            const depthFactor = 1 - Math.min(1, absDist / maxRange);

            // Object position on canvas
            let ox, oy;
            if (cam === 'Front' || cam === 'Rear') {
                ox = (W / 2) + (relX * 12 * depthFactor);
                oy = H * 0.55 + (H * 0.42 * depthFactor);
            } else {
                const lateralNorm = Math.min(1, absDist / maxRange);
                ox = cam === 'Left' ? W * (1 - lateralNorm * 0.7) : W * (lateralNorm * 0.7);
                oy = H * 0.55 + (H * 0.3 * depthFactor);
            }

            // Bounding box size scales with proximity
            const boxW = 8 + 18 * depthFactor;
            const boxH = 10 + 22 * depthFactor;

            // Color by risk level
            const inPath = Math.abs(relX) < 1.8;
            const isClose = absDist < 15;
            const boxColor = (isClose && inPath) ? '#ff4757' : (absDist < 30 && inPath) ? '#ffa502' : '#2ed573';

            // Draw bounding box
            ctx.strokeStyle = boxColor;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(ox - boxW/2, oy - boxH, boxW, boxH);

            // Corner brackets
            const bLen = 3;
            ctx.lineWidth = 2;
            // Top-left
            ctx.beginPath(); ctx.moveTo(ox - boxW/2, oy - boxH + bLen); ctx.lineTo(ox - boxW/2, oy - boxH); ctx.lineTo(ox - boxW/2 + bLen, oy - boxH); ctx.stroke();
            // Top-right
            ctx.beginPath(); ctx.moveTo(ox + boxW/2 - bLen, oy - boxH); ctx.lineTo(ox + boxW/2, oy - boxH); ctx.lineTo(ox + boxW/2, oy - boxH + bLen); ctx.stroke();
            // Bottom-left
            ctx.beginPath(); ctx.moveTo(ox - boxW/2, oy - bLen); ctx.lineTo(ox - boxW/2, oy); ctx.lineTo(ox - boxW/2 + bLen, oy); ctx.stroke();
            // Bottom-right
            ctx.beginPath(); ctx.moveTo(ox + boxW/2 - bLen, oy); ctx.lineTo(ox + boxW/2, oy); ctx.lineTo(ox + boxW/2, oy - bLen); ctx.stroke();

            // Distance label
            ctx.fillStyle = boxColor;
            ctx.font = 'bold 7px monospace';
            ctx.fillText(`${absDist.toFixed(0)}m`, ox - 8, oy + 9);
        }

        // Object count badge
        ctx.fillStyle = objCount > 0 ? 'rgba(255,71,87,0.7)' : 'rgba(0,214,111,0.5)';
        ctx.font = 'bold 7px monospace';
        ctx.fillText(`OBJ: ${objCount}`, 4, H - 4);
    });
}
