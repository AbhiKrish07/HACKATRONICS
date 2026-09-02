import re

with open('static/app.js', 'r') as f:
    js = f.read()

# Replace wheel traversal logic to target the exact node names from Car.jsx:
# HCR2_HC2_FL_Wheel_10, HCR2_HC2_FR_Wheel_11, HCR2_HC2_RL_Wheel_21, HCR2_HC2_RR_Wheel_23
wheel_patch = """
        const carWheelRefs = {};
        gltfLoader.load('/static/models/car.glb', (gltf) => {
            gltf.scene.scale.set(1.0, 1.0, 1.0);
            gltf.scene.rotation.y = Math.PI;
            models.ego = gltf.scene;

            // Traverse exact wheel names from Car-Game-ThreeJS-main Car.jsx
            gltf.scene.traverse((child) => {
                if (child.name.includes('FL_Wheel')) carWheelRefs.fl = child;
                if (child.name.includes('FR_Wheel')) carWheelRefs.fr = child;
                if (child.name.includes('RL_Wheel')) carWheelRefs.rl = child;
                if (child.name.includes('RR_Wheel')) carWheelRefs.rr = child;
            });
        });
"""

# Replace models.ego preloader block
js = re.sub(r'gltfLoader\.load\(\'/static/models/car\.glb\'.*?\n\s*\}\);', wheel_patch.strip(), js, flags=re.DOTALL)

# Add road barriers & center lines from Scene.jsx into the 3D scene setup
scene_barriers = """
        // -------------------------------------------------------------
        // Car-Game-ThreeJS-main Track Barriers & Terrain
        // -------------------------------------------------------------
        const barrierGroup = new THREE.Group();
        const postGeo = new THREE.BoxGeometry(0.2, 1, 0.2);
        const postMat = new THREE.MeshStandardMaterial({ color: 0x666666, metalness: 0.4, roughness: 0.6 });
        const railGeo = new THREE.BoxGeometry(0.1, 0.3, 4.0);
        const railMat = new THREE.MeshStandardMaterial({ color: 0xff3333, metalness: 0.4, roughness: 0.6, emissive: 0xff0000, emissiveIntensity: 0.3 });
        const reflectorGeo = new THREE.BoxGeometry(0.05, 0.1, 0.1);
        const reflectorMat = new THREE.MeshStandardMaterial({ color: 0xffaa00, emissive: 0xffaa00, emissiveIntensity: 0.8 });

        for (let z = -100; z < 100; z += 4) {
            [-11, 11].forEach(x => {
                const post = new THREE.Mesh(postGeo, postMat);
                post.position.set(x, 0.5, z);
                barrierGroup.add(post);

                const rail = new THREE.Mesh(railGeo, railMat);
                rail.position.set(x, 0.8, z);
                barrierGroup.add(rail);

                const refl = new THREE.Mesh(reflectorGeo, reflectorMat);
                refl.position.set(x + (x > 0 ? -0.1 : 0.1), 0.8, z);
                barrierGroup.add(refl);
            });
        }
        scene.add(barrierGroup);
"""

# Add scene_barriers after scene creation
js = js.replace('const scene = new THREE.Scene();', 'const scene = new THREE.Scene();\n' + scene_barriers)

# In gameEngineLoop, animate the exact car wheels from Car.jsx
game_loop_patch = """
            // Animate Car.jsx Wheel Steer & Suspension
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
"""

js = js.replace('// Wheel rotation logic removed for GLTF model stability', game_loop_patch)

with open('static/app.js', 'w') as f:
    f.write(js)
print("Successfully integrated Car-Game-ThreeJS-main 3D mechanics and barriers!")
