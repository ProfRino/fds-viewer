/**
 * FDS 3D Viewer using Three.js
 * Renders FDS geometry: meshes, obstructions, vents, holes
 */

/**
 * Ear-clipping triangulation for a simple (possibly concave) polygon.
 * Takes 3D vertices and a normal vector, projects to 2D, triangulates,
 * and returns an array of triangle index triplets.
 */
function triangulatePolygon(polyVerts3D, normal) {
    // Build a 2D coordinate system on the polygon plane
    // Pick the axis most aligned with normal to drop
    const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
    let project;
    if (az >= ax && az >= ay) {
        project = v => [v.x, v.y]; // drop Z
    } else if (ay >= ax) {
        project = v => [v.x, v.z]; // drop Y
    } else {
        project = v => [v.y, v.z]; // drop X
    }

    const pts2D = polyVerts3D.map(project);
    const n = pts2D.length;
    if (n < 3) return [];

    // Ensure CCW winding in 2D
    let area = 0;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area += pts2D[i][0] * pts2D[j][1];
        area -= pts2D[j][0] * pts2D[i][1];
    }
    const ccw = area > 0;

    // Build index list
    const idx = [];
    for (let i = 0; i < n; i++) idx.push(i);

    function cross2D(o, a, b) {
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    }

    function pointInTriangle(p, a, b, c) {
        const d1 = cross2D(p, a, b);
        const d2 = cross2D(p, b, c);
        const d3 = cross2D(p, c, a);
        const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
        const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
        return !(hasNeg && hasPos);
    }

    function isEar(prev, cur, next) {
        const a = pts2D[idx[prev]], b = pts2D[idx[cur]], c = pts2D[idx[next]];
        const cp = cross2D(a, b, c);
        if (ccw ? cp <= 0 : cp >= 0) return false; // reflex vertex
        for (let k = 0; k < idx.length; k++) {
            if (k === prev || k === cur || k === next) continue;
            if (pointInTriangle(pts2D[idx[k]], a, b, c)) return false;
        }
        return true;
    }

    const triangles = [];
    let safety = n * n;
    while (idx.length > 3 && safety-- > 0) {
        let earFound = false;
        for (let i = 0; i < idx.length; i++) {
            const prev = (i + idx.length - 1) % idx.length;
            const next = (i + 1) % idx.length;
            if (isEar(prev, i, next)) {
                triangles.push(idx[prev], idx[i], idx[next]);
                idx.splice(i, 1);
                earFound = true;
                break;
            }
        }
        if (!earFound) break; // degenerate
    }
    if (idx.length === 3) {
        triangles.push(idx[0], idx[1], idx[2]);
    }
    return triangles;
}

class FDSViewer {
    constructor(container) {
        this.container = container;
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

        // Keyboard state for continuous movement.
        this._keysPressed = {};
        this._onKeyDown = (e) => {
            // Ignore keystrokes that originate from a text-entry element so
            // panel search boxes don't drive the camera. Recording the key
            // would be harmless on its own, but the per-frame keyboard handler
            // also reads modifier-less letters here -- safest to drop them.
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
                      || t.tagName === 'SELECT' || t.isContentEditable)) return;
            this._keysPressed[e.key] = true;
        };
        // keyup is NOT gated -- always release the key state, otherwise a key
        // pressed in the viewport then released after focusing an input would
        // stick "pressed" forever and the camera would drift.
        this._onKeyUp = (e) => {
            this._keysPressed[e.key] = false;
        };
        // Also drop all pressed keys when focus moves to an input (covers
        // mouse-click focus changes that bypass keydown entirely).
        this._onFocusIn = (e) => {
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
                      || t.tagName === 'SELECT' || t.isContentEditable)) {
                this._keysPressed = {};
            }
        };
        document.addEventListener('keydown', this._onKeyDown);
        document.addEventListener('keyup', this._onKeyUp);
        document.addEventListener('focusin', this._onFocusIn);

        // Group containers
        this.meshGroup = new THREE.Group();
        this.obstGroup = new THREE.Group();
        this.ventGroup = new THREE.Group();
        this.holeGroup = new THREE.Group();
        this.devcGroup = new THREE.Group();
        this.initGroup = new THREE.Group();
        this.gridGroup = new THREE.Group();
        this.geomGroup = new THREE.Group();
        this.hvacGroup = new THREE.Group();
        this.zoneGroup = new THREE.Group();
        this.slcfGroup = new THREE.Group();
        this.fireGroup = new THREE.Group();

        // Visibility state
        this.visibility = {
            meshes: true,
            obsts: true,
            vents: true,
            holes: true,
            devcs: true,
            inits: true,
            grid: true,
            geoms: true,
            hvacs: true,
            zones: true,
            slcfs: true,
            fires: true,
        };

        // Data
        this.fdsData = null;
        this.boundingBox = null;

        // Clipping planes (initialised in _init once THREE is ready)
        this.clipPlanes = null;

        // Selection
        this.selectedObject = null;
        this.highlightMaterial = new THREE.MeshPhongMaterial({
            color: 0xffff00,
            transparent: true,
            opacity: 0.8,
            emissive: 0x444400,
        });

        // OBST edge wireframe overlay — hidden by default so seams between
        // adjacent OBSTs (used to construct walls with cutouts) don't show.
        // Toggled via setShowObstEdges().
        this.showObstEdges = false;

        // Smoke volume rendering mode — false = legacy single-pass (smoke
        // always wins, can bleed through walls); true = two-pass with scene
        // depth occlusion so OBSTs correctly hide smoke behind them. Toggled
        // via setSmokeDepthEnabled() from the Output smoke "Rendering"
        // dropdown. Default OFF (Basic) — faster and never loses smoke
        // behind solids in the single-pass back-face approximation.
        this.smokeDepthEnabled = false;
        this._depthTarget = null;

        // FPS tracker — updated once per second from the _animate loop.
        // Read via this.fps; UI panels can poll on a setInterval.
        this.fps = 0;
        this._fpsFrameCount = 0;
        this._fpsLastUpdate = (typeof performance !== 'undefined') ? performance.now() : 0;

        // ── Walk mode (FPS) ───────────────────────────────────────────────
        this.walkMode = false;       // true once user enters walk mode
        this.walkPlaced = false;     // true after user has clicked a surface
        this.walkControls = null;    // PointerLockControls (lazy)
        this.walkKeys = {};          // currently-pressed keys (lowercase)
        this.walkVelocityY = 0;      // vertical velocity (m/s, gravity)
        this.walkEyeHeight = 1.7;    // metres above floor
        this.walkSpeed = 1.8;        // m/s base walk speed
        this.walkRunMult = 2.5;      // shift multiplier
        this.walkRadius = 0.3;       // horizontal collision radius (m)
        this.walkJumpVel = 4.0;      // m/s (≈0.8 m jump height)
        this.walkGravity = 9.81;
        this.walkRaycaster = new THREE.Raycaster();
        this.walkRaycaster.firstHitOnly = false;
        this.walkPrevTime = 0;       // for dt in animate loop
        this.walkSavedCamera = null; // restore on exit
        this._walkOnKeyDown = null;  // listener refs so we can remove
        this._walkOnKeyUp = null;

        this._init();
    }

    _init() {
        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x1a1a2e);

        // Renderer — request WebGL2 for DataTexture3D / volume rendering support
        const _canvas2 = document.createElement('canvas');
        const _ctx2 = _canvas2.getContext('webgl2', { antialias: true });
        this.renderer = _ctx2
            ? new THREE.WebGLRenderer({ canvas: _canvas2, context: _ctx2, antialias: true })
            : new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        // Shadow mapping is disabled. With thin coplanar OBSTs (the typical
        // way FDS walls with door/window cutouts are authored), the directional
        // light's shadow projects each wall onto its perpendicular neighbour,
        // producing visible dark triangles at every interior corner. The
        // ambient + hemi + two directional lights below give a perfectly readable
        // shaded scene without those artefacts.
        this.renderer.shadowMap.enabled = false;
        this.container.appendChild(this.renderer.domElement);

        // Camera — perspective by default; setProjection() swaps to/from ortho.
        this.camera = new THREE.PerspectiveCamera(
            50,
            this.container.clientWidth / this.container.clientHeight,
            0.01,
            1000
        );
        this.camera.position.set(5, 5, 5);
        this.projectionMode = 'perspective';

        // Controls (OrbitControls)
        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.1;
        this.controls.screenSpacePanning = true;

        // Lighting
        this._setupLights();

        // Add groups to scene
        this.meshGroup.name = 'meshes';
        this.obstGroup.name = 'obsts';
        this.ventGroup.name = 'vents';
        this.holeGroup.name = 'holes';
        this.devcGroup.name = 'devcs';
        this.initGroup.name = 'inits';
        this.gridGroup.name = 'grid';
        this.geomGroup.name = 'geoms';
        this.hvacGroup.name = 'hvacs';
        this.zoneGroup.name = 'zones';
        this.slcfGroup.name = 'slcfs';
        this.fireGroup.name = 'fires';

        this.scene.add(this.meshGroup);
        this.scene.add(this.obstGroup);
        this.scene.add(this.ventGroup);
        this.scene.add(this.holeGroup);
        this.scene.add(this.devcGroup);
        this.scene.add(this.initGroup);
        this.scene.add(this.gridGroup);
        this.scene.add(this.geomGroup);
        this.scene.add(this.hvacGroup);
        this.scene.add(this.zoneGroup);
        this.scene.add(this.slcfGroup);
        this.scene.add(this.fireGroup);

        // Axes helper
        this.axesHelper = new THREE.AxesHelper(1);
        this.scene.add(this.axesHelper);

        // Events
        window.addEventListener('resize', () => this._onResize());
        this.renderer.domElement.addEventListener('click', (e) => this._onClick(e));

        // Clipping planes: xmin, xmax, ymin(FDS Y=ThreeZ), ymax, zmin(FDS Z=ThreeY), zmax
        this.clipPlanes = [
            new THREE.Plane(new THREE.Vector3(1, 0, 0), 0),
            new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0),
            new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
            new THREE.Plane(new THREE.Vector3(0, 0, -1), 0),
            new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
            new THREE.Plane(new THREE.Vector3(0, -1, 0), 0),
        ];
        this.renderer.clippingPlanes = [];

        // Animation loop
        this._animate();
    }

    _setupLights() {
        // Ambient
        const ambient = new THREE.AmbientLight(0xffffff, 0.4);
        this.scene.add(ambient);

        // Directional light 1 (no shadow casting — see _init for rationale)
        const dir1 = new THREE.DirectionalLight(0xffffff, 0.6);
        dir1.position.set(10, 20, 10);
        dir1.castShadow = false;
        this.scene.add(dir1);

        // Directional light 2
        const dir2 = new THREE.DirectionalLight(0xffffff, 0.3);
        dir2.position.set(-10, 10, -10);
        this.scene.add(dir2);

        // Hemisphere
        const hemi = new THREE.HemisphereLight(0x87ceeb, 0x362d1b, 0.3);
        this.scene.add(hemi);
    }

    _animate() {
        requestAnimationFrame(() => this._animate());
        if (this.walkMode) {
            const now = performance.now();
            const dt = Math.min(0.1, (now - (this.walkPrevTime || now)) / 1000);
            this.walkPrevTime = now;
            this._walkUpdate(dt);
        } else {
            this.walkPrevTime = 0;
            this._handleKeyboardMovement();
            this.controls.update();
        }
        this._renderScene();

        // FPS — count frames in a rolling 1 s window. The UI polls this.fps.
        this._fpsFrameCount++;
        const nowFps = performance.now();
        const elapsed = nowFps - this._fpsLastUpdate;
        if (elapsed >= 1000) {
            this.fps = Math.round((this._fpsFrameCount * 1000) / elapsed);
            this._fpsFrameCount = 0;
            this._fpsLastUpdate = nowFps;
        }
    }

    /**
     * Single- vs two-pass renderer. When smokeDepthEnabled is true AND smoke
     * volumes exist, render the scene WITHOUT smoke to an off-screen depth
     * target first, bind that depth texture to every smoke material, then
     * render the full scene to the canvas. The smoke ray-march reads the
     * scene depth and stops at solids — the "depth-aware" mode.
     */
    _renderScene() {
        const smokeNodes = [];
        if (this.smokeDepthEnabled) {
            this.scene.traverse(n => { if (n._isSmokeVolume) smokeNodes.push(n); });
        }

        if (smokeNodes.length > 0) {
            this._ensureDepthTarget();
            // Pass 1 — depth-only (smoke hidden)
            const wasVisible = smokeNodes.map(n => n.visible);
            smokeNodes.forEach(n => { n.visible = false; });
            this.renderer.setRenderTarget(this._depthTarget);
            this.renderer.clear(true, true, false);
            this.renderer.render(this.scene, this.camera);
            // Restore visibility and re-bind depth uniform on each smoke material
            for (let i = 0; i < smokeNodes.length; i++) {
                smokeNodes[i].visible = wasVisible[i];
                const m = smokeNodes[i].material;
                if (m && m.uniforms) {
                    if (m.uniforms.sceneDepth)   m.uniforms.sceneDepth.value   = this._depthTarget.depthTexture;
                    if (m.uniforms.uResolution)  m.uniforms.uResolution.value.set(this._depthTarget.width, this._depthTarget.height);
                    if (m.uniforms.depthEnabled) m.uniforms.depthEnabled.value = 1;
                }
            }
            // Pass 2 — full scene to canvas
            this.renderer.setRenderTarget(null);
            this.renderer.render(this.scene, this.camera);
        } else {
            // Single pass: make sure any leftover smoke materials report
            // depthEnabled=0 so they don't try to sample a stale texture.
            this.scene.traverse(n => {
                if (n._isSmokeVolume && n.material && n.material.uniforms && n.material.uniforms.depthEnabled) {
                    n.material.uniforms.depthEnabled.value = 0;
                }
            });
            this.renderer.setRenderTarget(null);
            this.renderer.render(this.scene, this.camera);
        }
    }

    /** Lazy-create and resize the depth render target to match the canvas. */
    _ensureDepthTarget() {
        const dpr = this.renderer.getPixelRatio();
        const w = Math.max(1, Math.floor(this.container.clientWidth * dpr));
        const h = Math.max(1, Math.floor(this.container.clientHeight * dpr));
        if (!this._depthTarget) {
            this._depthTarget = new THREE.WebGLRenderTarget(w, h);
            // 24-bit packed depth — kills the visible "comb"/stair-step at OBST
            // edges that the 16-bit UnsignedShortType produced when the ray
            // marched onto a wall surface.
            this._depthTarget.depthTexture = new THREE.DepthTexture(w, h);
            this._depthTarget.depthTexture.type = THREE.UnsignedInt248Type;
            this._depthTarget.depthTexture.format = THREE.DepthStencilFormat;
        } else if (this._depthTarget.width !== w || this._depthTarget.height !== h) {
            this._depthTarget.setSize(w, h);
        }
    }

    /** Public setter for the Solid-aware rendering mode (driven by the Output
     *  page's smoke "Rendering" dropdown). */
    setSmokeDepthEnabled(enabled) {
        this.smokeDepthEnabled = !!enabled;
    }

    _handleKeyboardMovement() {
        const keys = this._keysPressed;
        const panSpeed = 0.05;
        const rotSpeed = 0.02;

        // WASD: pan camera + target together
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();
        const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

        const delta = new THREE.Vector3();
        if (keys['w'] || keys['W']) delta.add(forward.clone().multiplyScalar(panSpeed));
        if (keys['s'] || keys['S']) delta.add(forward.clone().multiplyScalar(-panSpeed));
        if (keys['a'] || keys['A']) delta.add(right.clone().multiplyScalar(-panSpeed));
        if (keys['d'] || keys['D']) delta.add(right.clone().multiplyScalar(panSpeed));
        if (keys['q'] || keys['Q']) delta.y += panSpeed;
        if (keys['e'] || keys['E']) delta.y -= panSpeed;

        if (delta.lengthSq() > 0) {
            this.camera.position.add(delta);
            this.controls.target.add(delta);
        }

        // Arrow keys: orbit rotation by moving camera around target
        let hasRotation = false;
        const target = this.controls.target;
        const offset = this.camera.position.clone().sub(target);
        const spherical = new THREE.Spherical().setFromVector3(offset);

        if (keys['ArrowLeft'])  { spherical.theta -= rotSpeed; hasRotation = true; }
        if (keys['ArrowRight']) { spherical.theta += rotSpeed; hasRotation = true; }
        if (keys['ArrowUp'])    { spherical.phi = Math.max(0.01, spherical.phi - rotSpeed); hasRotation = true; }
        if (keys['ArrowDown'])  { spherical.phi = Math.min(Math.PI - 0.01, spherical.phi + rotSpeed); hasRotation = true; }

        if (hasRotation) {
            offset.setFromSpherical(spherical);
            this.camera.position.copy(target).add(offset);
            this.camera.lookAt(target);
        }
    }

    _onResize() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        if (this.camera.isOrthographicCamera) {
            // Preserve the orthographic view's vertical extent and rebuild the
            // horizontal extent from the new aspect, so resizing the window
            // doesn't squash the scene.
            const aspect = w / h;
            const halfH = (this.camera.top - this.camera.bottom) / 2;
            const halfW = halfH * aspect;
            this.camera.left = -halfW;
            this.camera.right = halfW;
            this.camera.updateProjectionMatrix();
        } else {
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
        }
        this.renderer.setSize(w, h);
    }

    /**
     * Swap between perspective and orthographic cameras while keeping the
     * eye, target and visible-area roughly the same. Re-binds OrbitControls
     * to the new camera so panning/orbiting keep working without a remount.
     */
    setProjection(mode) {
        const want = (mode === 'orthographic') ? 'orthographic' : 'perspective';
        if (this.projectionMode === want) return;
        const target   = this.controls.target.clone();
        const position = this.camera.position.clone();
        const aspect   = (this.container.clientWidth || 1) / (this.container.clientHeight || 1);

        if (want === 'orthographic') {
            // Match the perspective frustum at the focal point so the model
            // appears the same size at the moment of switching.
            const dist = position.distanceTo(target);
            const fov  = THREE.MathUtils.degToRad(50);
            const halfH = Math.tan(fov / 2) * dist;
            const halfW = halfH * aspect;
            this.camera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.01, 1000);
        } else {
            this.camera = new THREE.PerspectiveCamera(50, aspect, 0.01, 1000);
        }
        this.camera.position.copy(position);
        this.camera.lookAt(target);

        if (this.controls) this.controls.dispose();
        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.1;
        this.controls.screenSpacePanning = true;
        this.controls.target.copy(target);

        this.projectionMode = want;
        this._onResize();
    }
    getProjection() { return this.projectionMode || 'perspective'; }

    _onClick(event) {
        // Swallow clicks while the pointer is locked — PointerLockControls
        // owns the re-lock behaviour after Esc.
        if (this.walkMode && this.walkPlaced && this.walkControls && this.walkControls.isLocked) {
            return;
        }
        // Walk-mode placement: first click teleports the walker to that point.
        // Subsequent clicks in walk mode are swallowed (PointerLockControls owns
        // the click → re-lock behaviour handled by the browser itself).
        if (this.walkMode && !this.walkPlaced) {
            const rect = this.renderer.domElement.getBoundingClientRect();
            this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
            this.raycaster.setFromCamera(this.mouse, this.camera);
            const targets = [];
            this.obstGroup.traverse(c => { if (c.isMesh) targets.push(c); });
            this.geomGroup.traverse(c => { if (c.isMesh) targets.push(c); });
            // Mesh wireframes are LineSegments — skip them; ground is handled by domain floor.
            const hits = this.raycaster.intersectObjects(targets, false);
            if (hits.length) {
                this._walkPlaceAt(hits[0]);
            } else {
                // No OBST hit — drop the user onto the FDS-domain bottom (z=zmin)
                // at the camera's current XZ ray hit with the plane.
                const dir = new THREE.Vector3();
                this.raycaster.ray.direction.clone().normalize();
                const o = this.raycaster.ray.origin;
                dir.copy(this.raycaster.ray.direction);
                const floorY = this._walkDomainFloor();
                if (dir.y < -1e-6) {
                    const t = (floorY - o.y) / dir.y;
                    if (t > 0) {
                        const p = new THREE.Vector3(o.x + dir.x * t, floorY, o.z + dir.z * t);
                        this._walkPlaceAt({ point: p });
                        return;
                    }
                }
                const status = document.getElementById((this.walkHudId || 'walk-hud') + '-status');
                if (status) status.textContent = 'No surface there — try clicking on an obstruction or the floor.';
            }
            return;
        }
        // Standard pick (orbit mode)
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);

        const intersectObjects = [];
        this.obstGroup.traverse(c => { if (c.isMesh) intersectObjects.push(c); });
        this.ventGroup.traverse(c => { if (c.isMesh) intersectObjects.push(c); });
        this.initGroup.traverse(c => { if (c.isMesh) intersectObjects.push(c); });
        this.devcGroup.traverse(c => { if (c.isMesh) intersectObjects.push(c); });
        this.geomGroup.traverse(c => { if (c.isMesh) intersectObjects.push(c); });
        this.hvacGroup.traverse(c => { if (c.isMesh) intersectObjects.push(c); });
        this.zoneGroup.traverse(c => { if (c.isMesh) intersectObjects.push(c); });
        this.fireGroup.traverse(c => { if (c.isMesh) intersectObjects.push(c); });

        const allIntersects = this.raycaster.intersectObjects(intersectObjects);

        // Discard hits that lie on the clipped-away side of any active plane
        const intersects = this.renderer.clippingPlanes.length > 0
            ? allIntersects.filter(hit =>
                this.renderer.clippingPlanes.every(plane => plane.distanceToPoint(hit.point) >= -1e-6)
              )
            : allIntersects;

        // Restore previous selection
        if (this.selectedObject && this.selectedObject._originalMaterial) {
            this.selectedObject.material = this.selectedObject._originalMaterial;
        }
        this.selectedObject = null;

        if (intersects.length > 0) {
            const obj = intersects[0].object;
            obj._originalMaterial = obj.material;
            obj.material = this.highlightMaterial;
            this.selectedObject = obj;

            // Fire event for info panel
            const detail = obj.userData;
            this.container.dispatchEvent(new CustomEvent('objectSelected', { detail }));
        } else {
            this.container.dispatchEvent(new CustomEvent('objectSelected', { detail: null }));
        }
    }

    /**
     * Load and render FDS parsed data
     */
    loadData(fdsData) {
        this.clearScene();
        this.fdsData = fdsData;
        this._computeBoundingBox();
        this._renderMeshes();
        this._renderObsts();
        this._renderVents();
        this._renderHoles();
        this._renderDevcs();
        this._renderInits();
        this._renderGeoms();
        this._renderHvacs();
        this._renderZones();
        this._renderSlcfs();
        this._renderFires();
        this._renderGrid();
        this._fitCamera();
        this._updateAxes();
    }

    clearScene() {
        // Bail out of walk mode before tearing down — colliders go away and
        // gravity would push the camera through empty space.
        if (this.walkMode) this.exitWalkMode();
        // Restore the highlighted object's original material before disposal
        // walks. highlightMaterial is shared across selections, so disposing
        // it here would corrupt every future click.
        if (this.selectedObject && this.selectedObject._originalMaterial) {
            this.selectedObject.material = this.selectedObject._originalMaterial;
        }
        this.selectedObject = null;

        this._clearGroup(this.meshGroup);
        this._clearGroup(this.obstGroup);
        this._clearGroup(this.ventGroup);
        this._clearGroup(this.holeGroup);
        this._clearGroup(this.devcGroup);
        this._clearGroup(this.initGroup);
        this._clearGroup(this.gridGroup);
        this._clearGroup(this.geomGroup);
        this._clearGroup(this.hvacGroup);
        this._clearGroup(this.zoneGroup);
        this._clearGroup(this.slcfGroup);
        this._clearGroup(this.fireGroup);
        // Drop the parsed data so getStats() reports zeros and downstream
        // panels don't render stale info after a failed/cancelled load.
        this.fdsData = null;
        this.boundingBox = null;
    }

    _clearGroup(group) {
        // Walk the whole subtree -- many renderers attach wireframes/sub-meshes
        // as children, and disposing only the top child leaks those.
        const shared = this.highlightMaterial;
        const disposeNode = (node) => {
            if (node.geometry) node.geometry.dispose();
            if (node.material) {
                if (Array.isArray(node.material)) {
                    node.material.forEach(m => { if (m !== shared) m.dispose(); });
                } else if (node.material !== shared) {
                    node.material.dispose();
                }
            }
        };
        while (group.children.length > 0) {
            const child = group.children[0];
            child.traverse(disposeNode);
            group.remove(child);
        }
    }

    _computeBoundingBox() {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        const allXBs = [
            ...this.fdsData.meshes.map(m => m.xb),
            ...this.fdsData.obsts.map(o => o.xb),
            ...this.fdsData.vents.filter(v => v.xb).map(v => v.xb),
        ].filter(xb => xb);

        for (const xb of allXBs) {
            minX = Math.min(minX, xb[0], xb[1]);
            maxX = Math.max(maxX, xb[0], xb[1]);
            minY = Math.min(minY, xb[2], xb[3]);
            maxY = Math.max(maxY, xb[2], xb[3]);
            minZ = Math.min(minZ, xb[4], xb[5]);
            maxZ = Math.max(maxZ, xb[4], xb[5]);
        }

        this.boundingBox = {
            min: new THREE.Vector3(minX, minZ, minY),
            max: new THREE.Vector3(maxX, maxZ, maxY),
            center: new THREE.Vector3(
                (minX + maxX) / 2,
                (minZ + maxZ) / 2,
                (minY + maxY) / 2
            ),
            size: new THREE.Vector3(
                maxX - minX,
                maxZ - minZ,
                maxY - minY
            ),
        };
    }

    /**
     * Convert FDS XB [x1,x2,y1,y2,z1,z2] to Three.js position/size
     * FDS: X=right, Y=forward, Z=up
     * Three.js: X=right, Y=up, Z=forward(towards camera)
     */
    _xbToBox(xb) {
        const x1 = xb[0], x2 = xb[1];
        const y1 = xb[2], y2 = xb[3];
        const z1 = xb[4], z2 = xb[5];

        const width = Math.abs(x2 - x1);
        const depth = Math.abs(y2 - y1);
        const height = Math.abs(z2 - z1);

        // Center position (FDS Y -> Three Z, FDS Z -> Three Y)
        const cx = (x1 + x2) / 2;
        const cy = (z1 + z2) / 2; // FDS Z -> Three.js Y
        const cz = (y1 + y2) / 2; // FDS Y -> Three.js Z

        // size is clamped >0 so BoxGeometry doesn't degenerate; rawSize is the
        // original FDS extents, used by callers that need to detect a true
        // zero-thickness (planar) element. Don't read size.x < 0.001 for that
        // check — it's clamped, use rawSize.x instead.
        return {
            position: new THREE.Vector3(cx, cy, cz),
            size: new THREE.Vector3(
                Math.max(width, 0.001),
                Math.max(height, 0.001),
                Math.max(depth, 0.001)
            ),
            rawSize: new THREE.Vector3(width, height, depth),
        };
    }

    /**
     * Resolve transparency for an element, checking its surface if needed
     */
    _resolveTransparency(item) {
        if (item.transparency != null) return item.transparency;
        const surfName = item.surf_id
            ? (Array.isArray(item.surf_id) ? item.surf_id[0] : item.surf_id)
            : (item.surf_ids
                ? (Array.isArray(item.surf_ids) ? item.surf_ids[0] : item.surf_ids)
                : null);
        if (surfName && this.fdsData.surfs) {
            const surf = this.fdsData.surfs[surfName];
            if (surf && surf.transparency != null) return surf.transparency;
        }
        return 1.0;
    }

    _renderMeshes() {
        for (const mesh of this.fdsData.meshes) {
            if (!mesh.xb) continue;
            const { position, size } = this._xbToBox(mesh.xb);

            // Wireframe box outline
            const boxGeo = new THREE.BoxGeometry(size.x, size.y, size.z);
            const edges = new THREE.EdgesGeometry(boxGeo);
            const line = new THREE.LineSegments(
                edges,
                new THREE.LineBasicMaterial({ color: 0x4488ff, linewidth: 2 })
            );
            line.position.copy(position);
            line.userData = { type: 'MESH', id: mesh.id, xb: mesh.xb, ijk: mesh.ijk };
            this.meshGroup.add(line);

            // Semi-transparent fill so mesh volumes are visible
            const fillMat = new THREE.MeshBasicMaterial({
                color: 0x4488ff,
                transparent: true,
                opacity: 0.03,
                side: THREE.DoubleSide,
                depthWrite: false,
            });
            const fillBox = new THREE.Mesh(boxGeo, fillMat);
            fillBox.position.copy(position);
            fillBox.userData = line.userData;
            this.meshGroup.add(fillBox);
        }
    }

    _renderObsts() {
        for (let i = 0; i < this.fdsData.obsts.length; i++) {
            const obst = this.fdsData.obsts[i];
            if (!obst.xb) continue;

            const { position, size, rawSize } = this._xbToBox(obst.xb);
            const rgb = resolveFDSColor(obst, this.fdsData.surfs, [180, 180, 180]);
            const color = new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);

            // Detect thin (planar) obstructions from the raw (unclamped) extents
            // and give them visible thickness. Using size.x would always be
            // false because _xbToBox clamps to 0.001.
            const minThick = 0.02;
            const thinX = rawSize.x < 1e-6;
            const thinY = rawSize.y < 1e-6;
            const thinZ = rawSize.z < 1e-6;
            const sx = thinX ? minThick : size.x;
            const sy = thinY ? minThick : size.y;
            const sz = thinZ ? minThick : size.z;

            const opacity = this._resolveTransparency(obst);
            const isTransparent = opacity < 1;

            const geometry = new THREE.BoxGeometry(sx, sy, sz);
            const material = new THREE.MeshPhongMaterial({
                color: color,
                transparent: isTransparent,
                opacity: opacity,
                // FrontSide on opaque kills the worst Z-fight: two adjacent OBSTs
                // each draw a back face into the shared interior — coincident
                // depth = stipple/triangle artefacts. Transparent stays DoubleSide
                // so you can still see the back wall through a window.
                side: isTransparent ? THREE.DoubleSide : THREE.FrontSide,
                depthWrite: !isTransparent,
                // Negative offset on opaque OBST faces pulls them slightly toward
                // the camera in the depth buffer, so coplanar MESH grid lines and
                // adjacent thin OBST faces render *behind* and stop fighting.
                polygonOffset: true,
                polygonOffsetFactor: isTransparent ? -2 : -1,
                polygonOffsetUnits: isTransparent ? -2 : -1,
            });

            const box = new THREE.Mesh(geometry, material);

            // Offset transparent thin OBSTs slightly outward to avoid z-fighting
            // with opaque OBSTs on the same plane
            if (isTransparent && (thinX || thinY || thinZ)) {
                const off = 0.01;
                if (thinX) position.x += off;
                if (thinY) position.y += off;
                if (thinZ) position.z += off;
            }

            box.position.copy(position);
            box.renderOrder = isTransparent ? 1 : 0;
            box.castShadow = true;
            box.receiveShadow = true;
            box.userData = {
                type: 'OBST',
                index: i,
                id: obst.id,
                xb: obst.xb,
                surf_id: obst.surf_id,
                color: obst.color,
            };

            // Wireframe overlay (toggle via the "OBST edges" checkbox in the
            // sidebar — useful for authoring, hides the seams between OBSTs
            // that make up a single visual wall).
            const edgeMat = new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 1 });
            const edgeGeo = new THREE.EdgesGeometry(geometry);
            const wireframe = new THREE.LineSegments(edgeGeo, edgeMat);
            wireframe.visible = this.showObstEdges !== false;
            wireframe._isObstEdge = true;
            box.add(wireframe);

            this.obstGroup.add(box);
        }
    }

    _renderVents() {
        // Derive overall domain extent from MESH list once for MB= vents below.
        let dx0=Infinity, dx1=-Infinity, dy0=Infinity, dy1=-Infinity, dz0=Infinity, dz1=-Infinity;
        for (const m of this.fdsData.meshes) {
            if (!m.xb) continue;
            dx0 = Math.min(dx0, m.xb[0]); dx1 = Math.max(dx1, m.xb[1]);
            dy0 = Math.min(dy0, m.xb[2]); dy1 = Math.max(dy1, m.xb[3]);
            dz0 = Math.min(dz0, m.xb[4]); dz1 = Math.max(dz1, m.xb[5]);
        }
        const haveDomain = isFinite(dx0);

        for (let i = 0; i < this.fdsData.vents.length; i++) {
            const vent = this.fdsData.vents[i];
            let xb = vent.xb;
            if (!xb && vent.mb && haveDomain) {
                // Convert MB face label to a degenerate XB on that domain face.
                switch (String(vent.mb).toUpperCase()) {
                    case 'XMIN': xb = [dx0, dx0, dy0, dy1, dz0, dz1]; break;
                    case 'XMAX': xb = [dx1, dx1, dy0, dy1, dz0, dz1]; break;
                    case 'YMIN': xb = [dx0, dx1, dy0, dy0, dz0, dz1]; break;
                    case 'YMAX': xb = [dx0, dx1, dy1, dy1, dz0, dz1]; break;
                    case 'ZMIN': xb = [dx0, dx1, dy0, dy1, dz0, dz0]; break;
                    case 'ZMAX': xb = [dx0, dx1, dy0, dy1, dz1, dz1]; break;
                }
            }
            if (!xb) continue;

            const { position, size, rawSize } = this._xbToBox(xb);
            const rgb = resolveFDSColor(vent, this.fdsData.surfs, [255, 100, 50]);
            const color = new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);

            // Vents are often planar (one dimension is 0). Detect from raw
            // extents — size.x has been clamped to 0.001 in _xbToBox.
            const minDim = 0.015; // render thin vents as visible thin slabs
            const thinX = rawSize.x < 1e-6;
            const thinY = rawSize.y < 1e-6;
            const thinZ = rawSize.z < 1e-6;
            const sx = thinX ? minDim : size.x;
            const sy = thinY ? minDim : size.y;
            const sz = thinZ ? minDim : size.z;

            const geometry = new THREE.BoxGeometry(sx, sy, sz);
            const material = new THREE.MeshPhongMaterial({
                color: color,
                transparent: true,
                opacity: vent.transparency != null ? vent.transparency : 0.7,
                side: THREE.DoubleSide,
                polygonOffset: true,
                polygonOffsetFactor: -1,
                polygonOffsetUnits: -1,
            });

            const box = new THREE.Mesh(geometry, material);
            // Offset thin vents slightly so they don't z-fight with coplanar OBSTs
            // size: Three.js (X=FDS X, Y=FDS Z, Z=FDS Y)
            const offset = 0.008;
            if (thinX) position.x += offset;
            if (thinY) position.y += offset;
            if (thinZ) position.z += offset;
            box.position.copy(position);
            box.userData = {
                type: 'VENT',
                index: i,
                id: vent.id,
                xb: xb,
                mb: vent.mb || null,
                surf_id: vent.surf_id,
            };

            // Edge
            const edgeMat = new THREE.LineBasicMaterial({ color: 0xff4400 });
            const edgeGeo = new THREE.EdgesGeometry(geometry);
            const wireframe = new THREE.LineSegments(edgeGeo, edgeMat);
            box.add(wireframe);

            this.ventGroup.add(box);
        }
    }

    _renderHoles() {
        for (let i = 0; i < this.fdsData.holes.length; i++) {
            const hole = this.fdsData.holes[i];
            if (!hole.xb) continue;

            const { position, size } = this._xbToBox(hole.xb);

            const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
            const material = new THREE.MeshPhongMaterial({
                color: 0x00e5ff,
                transparent: true,
                opacity: 0.25,
                side: THREE.DoubleSide,
            });

            const box = new THREE.Mesh(geometry, material);
            box.position.copy(position);
            box.userData = {
                type: 'HOLE',
                index: i,
                id: hole.id,
                xb: hole.xb,
            };

            // Dashed edge
            const edgeMat = new THREE.LineDashedMaterial({
                color: 0x00b8d4,
                dashSize: 0.05,
                gapSize: 0.03,
            });
            const edgeGeo = new THREE.EdgesGeometry(geometry);
            const wireframe = new THREE.LineSegments(edgeGeo, edgeMat);
            wireframe.computeLineDistances();
            box.add(wireframe);

            this.holeGroup.add(box);
        }
    }

    _renderDevcs() {
        for (const devc of this.fdsData.devcs) {
            // XB-based DEVCs (line, plane, or volume integrals such as LAYER
            // HEIGHT, MASS FLOW) -- render as a magenta wireframe box. Thin
            // dimensions are inflated to a visible slab so planar devices
            // (e.g. flow through a duct cross-section) actually appear.
            if (!devc.xyz && devc.xb) {
                const { position, size } = this._xbToBox(devc.xb);
                const minDim = 0.02;
                const sx = Math.max(size.x, minDim);
                const sy = Math.max(size.y, minDim);
                const sz = Math.max(size.z, minDim);
                const boxGeo = new THREE.BoxGeometry(sx, sy, sz);
                const boxMat = new THREE.MeshBasicMaterial({
                    color: 0xe040fb, transparent: true, opacity: 0.15,
                    side: THREE.DoubleSide, depthWrite: false,
                });
                const box = new THREE.Mesh(boxGeo, boxMat);
                box.position.copy(position);
                const edgeMat = new THREE.LineBasicMaterial({ color: 0xe040fb });
                const edgeGeo = new THREE.EdgesGeometry(boxGeo);
                box.add(new THREE.LineSegments(edgeGeo, edgeMat));
                box.userData = {
                    type: 'DEVC',
                    subtype: 'XB',
                    id: devc.id,
                    xb: devc.xb,
                    quantity: devc.quantity,
                };
                this.devcGroup.add(box);
                continue;
            }
            if (!devc.xyz) continue;
            const x = devc.xyz[0];
            const y = devc.xyz[2]; // FDS Z -> Three Y
            const z = devc.xyz[1]; // FDS Y -> Three Z

            // Determine if this is a sprinkler (has PROP_ID referencing a sprinkler prop)
            const isSprinkler = this._isSprinklerDevc(devc);

            if (isSprinkler) {
                // Render sprinkler as a downward-pointing cone + sphere
                const group = new THREE.Group();
                group.position.set(x, y, z);

                // Deflector plate (small flat cylinder)
                const plateGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.01, 12);
                const plateMat = new THREE.MeshPhongMaterial({ color: 0xcc4444, emissive: 0x331111 });
                const plate = new THREE.Mesh(plateGeo, plateMat);
                group.add(plate);

                // Frame body (small cylinder going up)
                const frameGeo = new THREE.CylinderGeometry(0.01, 0.01, 0.08, 6);
                const frameMat = new THREE.MeshPhongMaterial({ color: 0x888888 });
                const frame = new THREE.Mesh(frameGeo, frameMat);
                frame.position.y = 0.04;
                group.add(frame);

                // Bulb (small sphere)
                const bulbGeo = new THREE.SphereGeometry(0.015, 8, 8);
                const bulbMat = new THREE.MeshPhongMaterial({ color: 0xff3333, emissive: 0x440000, transparent: true, opacity: 0.8 });
                const bulb = new THREE.Mesh(bulbGeo, bulbMat);
                bulb.position.y = -0.02;
                group.add(bulb);

                group.userData = {
                    type: 'DEVC',
                    subtype: 'SPRINKLER',
                    id: devc.id,
                    xyz: devc.xyz,
                    quantity: devc.quantity,
                    prop_id: devc.prop_id,
                };

                // Make children carry userData for raycasting
                group.traverse(child => {
                    if (child.isMesh) child.userData = group.userData;
                });

                this.devcGroup.add(group);
            } else {
                const geometry = new THREE.SphereGeometry(0.03, 8, 8);
                const material = new THREE.MeshPhongMaterial({ color: 0xe040fb, emissive: 0x3a0040 });
                const sphere = new THREE.Mesh(geometry, material);
                sphere.position.set(x, y, z);
                sphere.userData = {
                    type: 'DEVC',
                    id: devc.id,
                    xyz: devc.xyz,
                    quantity: devc.quantity,
                    prop_id: devc.prop_id,
                };

                this.devcGroup.add(sphere);
            }
        }
    }

    _isSprinklerDevc(devc) {
        // Check if the device references a sprinkler PROP
        if (devc.prop_id && this.fdsData.props) {
            const prop = this.fdsData.props[devc.prop_id];
            if (prop) {
                const q = (prop.quantity || '').toUpperCase();
                if (q.includes('SPRINKLER')) return true;
                // Check PROP ID name for sprinkler-ish keywords
                const pid = (prop.id || '').toUpperCase();
                if (pid.includes('SPRINKLER') || pid.includes('SPRK')) return true;
            }
        }
        // Check quantity directly
        const q = (devc.quantity || '').toUpperCase();
        if (q.includes('SPRINKLER')) return true;
        // Check ID
        const did = (devc.id || '').toUpperCase();
        if (did.includes('SPRINKLER') || did.includes('SPRK')) return true;
        return false;
    }

    _renderInits() {
        if (!this.fdsData.inits) return;

        for (let i = 0; i < this.fdsData.inits.length; i++) {
            const init = this.fdsData.inits[i];

            // Determine label based on PART_ID / SURF_ID
            const partId = init.part_id;
            let partInfo = null;
            let surfInfo = null;
            if (partId && this.fdsData.parts) {
                partInfo = this.fdsData.parts[partId];
                if (partInfo && partInfo.surf_id) {
                    surfInfo = this.fdsData.surfs[partInfo.surf_id];
                }
            }

            // Consistent orange for all INIT regions (matches UI icon/legend)
            const color = 0xff8800;

            if (init.xb) {
                // Volume region
                const { position, size } = this._xbToBox(init.xb);
                const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
                const material = new THREE.MeshPhongMaterial({
                    color: color,
                    transparent: true,
                    opacity: 0.4,
                    side: THREE.DoubleSide,
                });
                const box = new THREE.Mesh(geometry, material);
                box.position.copy(position);
                box.userData = {
                    type: 'INIT',
                    index: i,
                    id: init.id,
                    xb: init.xb,
                    part_id: init.part_id,
                };

                // Dashed wireframe
                const edgeMat = new THREE.LineDashedMaterial({
                    color: color,
                    dashSize: 0.04,
                    gapSize: 0.02,
                });
                const edgeGeo = new THREE.EdgesGeometry(geometry);
                const wireframe = new THREE.LineSegments(edgeGeo, edgeMat);
                wireframe.computeLineDistances();
                box.add(wireframe);

                this.initGroup.add(box);
            } else if (init.xyz) {
                // Point source
                const x = init.xyz[0];
                const y = init.xyz[2]; // FDS Z -> Three Y
                const z = init.xyz[1]; // FDS Y -> Three Z

                const geometry = new THREE.SphereGeometry(0.04, 8, 8);
                const material = new THREE.MeshPhongMaterial({ color: color, emissive: 0x221100 });
                const sphere = new THREE.Mesh(geometry, material);
                sphere.position.set(x, y, z);
                sphere.userData = {
                    type: 'INIT',
                    index: i,
                    id: init.id,
                    xyz: init.xyz,
                    part_id: init.part_id,
                };
                this.initGroup.add(sphere);
            }
        }
    }

    _renderGeoms() {
        if (!this.fdsData.geoms) return;

        for (let i = 0; i < this.fdsData.geoms.length; i++) {
            const geom = this.fdsData.geoms[i];
            const rgb = resolveFDSColor(geom, this.fdsData.surfs, [100, 200, 255]);
            const color = new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);

            if (geom.sphere_origin && geom.sphere_radius) {
                // Sphere geometry
                const o = geom.sphere_origin;
                const r = geom.sphere_radius;
                const geometry = new THREE.SphereGeometry(r, 24, 16);
                const material = new THREE.MeshPhongMaterial({
                    color: color,
                    transparent: false,
                    opacity: 1.0,
                    side: THREE.DoubleSide,
                });
                const sphere = new THREE.Mesh(geometry, material);
                sphere.position.set(o[0], o[2], o[1]); // FDS Y→Three Z, FDS Z→Three Y
                sphere.userData = {
                    type: 'GEOM',
                    subtype: 'SPHERE',
                    id: geom.id,
                    sphere_origin: geom.sphere_origin,
                    sphere_radius: geom.sphere_radius,
                    surf_id: geom.surf_id,
                };

                // Wireframe overlay
                const wireMat = new THREE.MeshBasicMaterial({ color: color, wireframe: true, transparent: true, opacity: 0.3 });
                const wireframe = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), wireMat);
                sphere.add(wireframe);

                this.geomGroup.add(sphere);

            } else if (geom.cylinder_origin && geom.cylinder_radius && geom.cylinder_length) {
                // Cylinder primitive (FDS UG Sec. 7.3.6)
                // Three.js CylinderGeometry default axis is Y; we rotate it
                // to match CYLINDER_AXIS, which is given in FDS coords.
                const o = geom.cylinder_origin;
                const r = geom.cylinder_radius;
                const L = geom.cylinder_length;
                const axisFDS = (geom.cylinder_axis && geom.cylinder_axis.length === 3)
                    ? geom.cylinder_axis
                    : [0, 0, 1]; // safe default: axis along FDS Z
                const nTheta = geom.cylinder_nseg_theta || 24;
                const nAxis  = geom.cylinder_nseg_axis  || 1;

                const geometry = new THREE.CylinderGeometry(r, r, L, nTheta, nAxis, false);
                const material = new THREE.MeshPhongMaterial({
                    color: color,
                    transparent: false,
                    opacity: 1.0,
                    side: THREE.DoubleSide,
                });
                const cyl = new THREE.Mesh(geometry, material);

                // Map FDS axis (xf, yf, zf) -> Three axis (xf, zf, yf)
                const axisThree = new THREE.Vector3(axisFDS[0], axisFDS[2], axisFDS[1]).normalize();
                const defaultAxis = new THREE.Vector3(0, 1, 0);
                if (axisThree.lengthSq() > 0 && Math.abs(1 - axisThree.dot(defaultAxis)) > 1e-9) {
                    const quat = new THREE.Quaternion().setFromUnitVectors(defaultAxis, axisThree);
                    cyl.setRotationFromQuaternion(quat);
                }

                cyl.position.set(o[0], o[2], o[1]); // FDS Y->Three Z, FDS Z->Three Y
                cyl.userData = {
                    type: 'GEOM',
                    subtype: 'CYLINDER',
                    id: geom.id,
                    cylinder_origin: geom.cylinder_origin,
                    cylinder_axis: axisFDS,
                    cylinder_radius: r,
                    cylinder_length: L,
                    surf_id: geom.surf_id,
                };

                const wireMat = new THREE.LineBasicMaterial({ color: 0x64c8ff, transparent: true, opacity: 0.4 });
                const wireGeo = new THREE.WireframeGeometry(geometry);
                const wireframe = new THREE.LineSegments(wireGeo, wireMat);
                cyl.add(wireframe);

                this.geomGroup.add(cyl);

            } else if (geom.zvals && geom.ijk && geom.xb) {
                // Terrain heightmap: ZVALS with IJK=[NI,NJ] and XB=[x1,x2,y1,y2]
                const zvals = Array.isArray(geom.zvals) ? geom.zvals : [];
                const ni = geom.ijk[0]; // number of X points
                const nj = geom.ijk[1]; // number of Y points
                const xb = geom.xb;
                const x1 = xb[0], x2 = xb[1], y1 = xb[2], y2 = xb[3];

                if (zvals.length >= ni * nj && ni >= 2 && nj >= 2) {
                    const geometry = new THREE.BufferGeometry();
                    const positions = [];
                    const indices = [];

                    // Build vertex grid: ZVALS are stored row by row (j varies, then i)
                    // FDS convention: ZVALS(i,j) with j=1..NJ for each i=1..NI
                    for (let j = 0; j < nj; j++) {
                        for (let k = 0; k < ni; k++) {
                            const x = x1 + (x2 - x1) * k / (ni - 1);
                            const y = y1 + (y2 - y1) * j / (nj - 1);
                            const z = zvals[j * ni + k];
                            positions.push(x, z, y); // FDS Y→Three Z, FDS Z→Three Y
                        }
                    }

                    // Build triangle indices
                    for (let j = 0; j < nj - 1; j++) {
                        for (let k = 0; k < ni - 1; k++) {
                            const a = j * ni + k;
                            const b = a + 1;
                            const c = a + ni;
                            const d = c + 1;
                            indices.push(a, c, b);
                            indices.push(b, c, d);
                        }
                    }

                    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
                    geometry.setIndex(indices);
                    geometry.computeVertexNormals();

                    // Terrain stays DoubleSide because it's an open surface
                    // and may be viewed from below in some scenes.
                    const material = new THREE.MeshPhongMaterial({
                        color: color,
                        transparent: false,
                        opacity: 1.0,
                        side: THREE.DoubleSide,
                    });
                    const mesh = new THREE.Mesh(geometry, material);
                    mesh.userData = {
                        type: 'GEOM',
                        subtype: 'TERRAIN',
                        id: geom.id,
                        surf_id: geom.surf_id,
                        ijk: geom.ijk,
                    };

                    const wireMat = new THREE.LineBasicMaterial({ color: 0x64c8ff, transparent: true, opacity: 0.3 });
                    const wireGeo = new THREE.WireframeGeometry(geometry);
                    const wireframe = new THREE.LineSegments(wireGeo, wireMat);
                    mesh.add(wireframe);

                    this.geomGroup.add(mesh);
                }

            } else if (geom.xb && geom.xb.length >= 6) {
                // Block geometry (same as OBST but for GEOM)
                const { position, size } = this._xbToBox(geom.xb);
                const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
                const material = new THREE.MeshPhongMaterial({
                    color: color,
                    transparent: false,
                    opacity: 1.0,
                    side: THREE.DoubleSide,
                });
                const box = new THREE.Mesh(geometry, material);
                box.position.copy(position);
                box.userData = {
                    type: 'GEOM',
                    subtype: 'BLOCK',
                    id: geom.id,
                    xb: geom.xb,
                    surf_id: geom.surf_id,
                };

                const edgeMat = new THREE.LineBasicMaterial({ color: 0x64c8ff });
                const edgeGeo = new THREE.EdgesGeometry(geometry);
                const wireframe = new THREE.LineSegments(edgeGeo, edgeMat);
                box.add(wireframe);

                this.geomGroup.add(box);

            } else if (geom.verts && geom.faces) {
                // Triangulated mesh
                const verts = Array.isArray(geom.verts) ? geom.verts : [];
                const faces = Array.isArray(geom.faces) ? geom.faces : [];

                // FDS User Guide Sec. 7.3.2 mandates 4 ints per face
                // (v1, v2, v3, surf_id_index), so default to stride 4 whenever
                // the integer count divides evenly. Only fall back to stride 3
                // if the length is divisible by 3 but not by 4 (a stride-3
                // file is technically invalid FDS, but we still render it on
                // a best-effort basis).
                let stride = 4;
                if (faces.length % 4 !== 0) {
                    stride = (faces.length % 3 === 0) ? 3 : 4;
                }

                if (verts.length >= 9 && faces.length >= stride) {
                    const geometry = new THREE.BufferGeometry();
                    const vertices = [];
                    const indices = [];

                    for (let v = 0; v < verts.length; v += 3) {
                        vertices.push(verts[v], verts[v + 2], verts[v + 1]);
                    }

                    for (let f = 0; f < faces.length; f += stride) {
                        indices.push(faces[f] - 1, faces[f + 1] - 1, faces[f + 2] - 1);
                    }

                    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
                    geometry.setIndex(indices);
                    geometry.computeVertexNormals();

                    // Trimesh keeps DoubleSide — externally-authored meshes
                    // sometimes have inconsistent winding, and FrontSide alone
                    // would make patches of the object disappear.
                    const material = new THREE.MeshPhongMaterial({
                        color: color,
                        transparent: false,
                        opacity: 1.0,
                        side: THREE.DoubleSide,
                    });
                    const mesh = new THREE.Mesh(geometry, material);
                    mesh.userData = {
                        type: 'GEOM',
                        subtype: 'TRIMESH',
                        id: geom.id,
                        surf_id: geom.surf_id,
                    };
                    // No wireframe overlay on dense external meshes — drawing
                    // every triangle edge buries the actual shape under noise.
                    // EdgesGeometry with a crease threshold could be used to
                    // show only sharp seams, but for car / mannequin / CAD
                    // imports a clean solid render reads better.

                    this.geomGroup.add(mesh);
                }

            } else if (geom.verts && geom.poly && geom.extrude) {
                // Extruded polygon: VERTS defines 2D outline points (x,y,z), POLY is vertex order, EXTRUDE is thickness
                const verts = Array.isArray(geom.verts) ? geom.verts : [];
                const poly = Array.isArray(geom.poly) ? geom.poly : [];
                const extrudeDist = geom.extrude;

                if (verts.length >= 9 && poly.length >= 3 && extrudeDist) {
                    // Get polygon vertices in order
                    const polyVerts = [];
                    for (const idx of poly) {
                        const vi = (idx - 1) * 3; // 1-based
                        if (vi + 2 < verts.length) {
                            polyVerts.push({ x: verts[vi], y: verts[vi + 1], z: verts[vi + 2] });
                        }
                    }

                    if (polyVerts.length >= 3) {
                        // Compute extrude direction: use polygon normal
                        // Cross product of first two edges
                        const e1 = { x: polyVerts[1].x - polyVerts[0].x, y: polyVerts[1].y - polyVerts[0].y, z: polyVerts[1].z - polyVerts[0].z };
                        const e2 = { x: polyVerts[2].x - polyVerts[0].x, y: polyVerts[2].y - polyVerts[0].y, z: polyVerts[2].z - polyVerts[0].z };
                        let nx = e1.y * e2.z - e1.z * e2.y;
                        let ny = e1.z * e2.x - e1.x * e2.z;
                        let nz = e1.x * e2.y - e1.y * e2.x;
                        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
                        if (len > 0) { nx /= len; ny /= len; nz /= len; }

                        const dx = nx * extrudeDist;
                        const dy = ny * extrudeDist;
                        const dz = nz * extrudeDist;

                        const geometry = new THREE.BufferGeometry();
                        const positions = [];
                        const indices = [];
                        const n = polyVerts.length;

                        // Bottom face vertices (0..n-1)
                        for (const v of polyVerts) {
                            positions.push(v.x, v.z, v.y); // FDS Y→Three Z, FDS Z→Three Y
                        }
                        // Top face vertices (n..2n-1)
                        for (const v of polyVerts) {
                            positions.push(v.x + dx, v.z + dz, v.y + dy);
                        }

                        // Triangulate bottom face using ear-clipping (handles concave polygons)
                        const normal = { x: nx, y: ny, z: nz };
                        const triIdx = triangulatePolygon(polyVerts, normal);
                        for (let t = 0; t < triIdx.length; t += 3) {
                            indices.push(triIdx[t], triIdx[t + 1], triIdx[t + 2]);
                        }
                        // Triangulate top face (reverse winding)
                        for (let t = 0; t < triIdx.length; t += 3) {
                            indices.push(n + triIdx[t], n + triIdx[t + 2], n + triIdx[t + 1]);
                        }
                        // Side faces
                        for (let j = 0; j < n; j++) {
                            const j2 = (j + 1) % n;
                            indices.push(j, j2, n + j2);
                            indices.push(j, n + j2, n + j);
                        }

                        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
                        geometry.setIndex(indices);
                        geometry.computeVertexNormals();

                        const material = new THREE.MeshPhongMaterial({
                            color: color,
                            transparent: false,
                            opacity: 1.0,
                            side: THREE.DoubleSide,
                        });
                        const mesh = new THREE.Mesh(geometry, material);
                        mesh.userData = {
                            type: 'GEOM',
                            subtype: 'EXTRUDED_POLY',
                            id: geom.id,
                            surf_id: geom.surf_id,
                            extrude: geom.extrude,
                        };
                        // Show only crease edges (faces with > ~30° dihedral)
                        // — outlines the polygon shape cleanly without
                        // overlaying every triangulated face.
                        const edgeMat = new THREE.LineBasicMaterial({ color: 0x64c8ff, transparent: true, opacity: 0.55 });
                        const edgeGeo = new THREE.EdgesGeometry(geometry, 30);
                        const edges = new THREE.LineSegments(edgeGeo, edgeMat);
                        mesh.add(edges);

                        this.geomGroup.add(mesh);
                    }
                }
            }
        }
    }

    _renderHvacs() {
        if (!this.fdsData.hvacs) return;

        // Build a vent lookup by ID to resolve node positions from VENT_ID
        const ventLookup = {};
        for (const vent of this.fdsData.vents) {
            if (vent.id && vent.xb) {
                // Center of the vent
                ventLookup[vent.id] = [
                    (vent.xb[0] + vent.xb[1]) / 2,
                    (vent.xb[2] + vent.xb[3]) / 2,
                    (vent.xb[4] + vent.xb[5]) / 2,
                ];
            }
        }

        // Collect nodes and ducts
        const nodes = {};
        const ducts = [];

        for (const hvac of this.fdsData.hvacs) {
            const type = (hvac.type_id || '').toUpperCase();

            if (type === 'NODE') {
                // Resolve XYZ: explicit XYZ, or from VENT_ID center
                let xyz = hvac.xyz;
                if (!xyz && hvac.vent_id && ventLookup[hvac.vent_id]) {
                    xyz = ventLookup[hvac.vent_id];
                }

                const nodeEntry = { ...hvac, xyz };
                nodes[hvac.id] = nodeEntry;

                if (xyz) {
                    const x = xyz[0];
                    const y = xyz[2]; // FDS Z → Three Y
                    const z = xyz[1]; // FDS Y → Three Z

                    const nodeColor = 0xffaa00;
                    const geometry = new THREE.SphereGeometry(0.08, 12, 8);
                    const material = new THREE.MeshPhongMaterial({
                        color: nodeColor,
                        emissive: hvac.ambient ? 0x114422 : 0x442200,
                    });
                    const sphere = new THREE.Mesh(geometry, material);
                    sphere.position.set(x, y, z);
                    sphere.userData = {
                        type: 'HVAC',
                        subtype: 'NODE',
                        id: hvac.id,
                        xyz: xyz,
                        ambient: hvac.ambient,
                        vent_id: hvac.vent_id,
                    };
                    this.hvacGroup.add(sphere);
                }

            } else if (type === 'DUCT') {
                ducts.push(hvac);
            }
        }

        // Render duct connections
        for (const duct of ducts) {
            const nodeIds = duct.node_id;
            if (!nodeIds) continue;

            const nids = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
            if (nids.length < 2) continue;

            const n1 = nodes[nids[0]];
            const n2 = nodes[nids[1]];
            if (!n1 || !n1.xyz || !n2 || !n2.xyz) continue;

            const points = [];
            points.push(new THREE.Vector3(n1.xyz[0], n1.xyz[2], n1.xyz[1]));

            // Add waypoints if present
            if (duct.waypoints) {
                const wp = Array.isArray(duct.waypoints) ? duct.waypoints : [];
                for (let w = 0; w < wp.length; w += 3) {
                    if (w + 2 < wp.length) {
                        points.push(new THREE.Vector3(wp[w], wp[w + 2], wp[w + 1]));
                    }
                }
            }

            points.push(new THREE.Vector3(n2.xyz[0], n2.xyz[2], n2.xyz[1]));

            // Draw duct as a thick line
            const linePath = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints(points),
                new THREE.LineBasicMaterial({ color: 0xffaa00, linewidth: 2 })
            );
            linePath.userData = {
                type: 'HVAC',
                subtype: 'DUCT',
                id: duct.id,
                node_id: nids,
            };
            this.hvacGroup.add(linePath);

            // Render duct as tube for better visibility
            if (points.length >= 2) {
                const radius = duct.diameter ? duct.diameter / 2 : (duct.area ? Math.sqrt(duct.area / Math.PI) : 0.05);
                const tubeRadius = Math.min(radius, 0.3);
                const curve = new THREE.CatmullRomCurve3(points);
                const tubeGeo = new THREE.TubeGeometry(curve, Math.max(points.length * 4, 8), tubeRadius, 8, false);
                const tubeMat = new THREE.MeshPhongMaterial({
                    color: 0xffaa00,
                    transparent: true,
                    opacity: 0.35,
                    side: THREE.DoubleSide,
                });
                const tube = new THREE.Mesh(tubeGeo, tubeMat);
                tube.userData = linePath.userData;
                this.hvacGroup.add(tube);
            }
        }
    }

    _renderZones() {
        if (!this.fdsData.zones) return;

        const zoneColors = [0x8866ff, 0x66ff88, 0xff6688, 0x88ffff, 0xffff66];

        for (let i = 0; i < this.fdsData.zones.length; i++) {
            const zone = this.fdsData.zones[i];
            if (!zone.xb) continue;

            const { position, size } = this._xbToBox(zone.xb);
            const zoneColor = zoneColors[i % zoneColors.length];

            const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
            const material = new THREE.MeshPhongMaterial({
                color: zoneColor,
                transparent: true,
                opacity: 0.12,
                side: THREE.DoubleSide,
                depthWrite: false,
            });
            const box = new THREE.Mesh(geometry, material);
            box.position.copy(position);
            box.userData = {
                type: 'ZONE',
                id: zone.id,
                xb: zone.xb,
            };

            // Dashed edge
            const edgeMat = new THREE.LineDashedMaterial({
                color: zoneColor,
                dashSize: 0.1,
                gapSize: 0.05,
                linewidth: 2,
            });
            const edgeGeo = new THREE.EdgesGeometry(geometry);
            const wireframe = new THREE.LineSegments(edgeGeo, edgeMat);
            wireframe.computeLineDistances();
            box.add(wireframe);

            this.zoneGroup.add(box);
        }
    }

    _renderSlcfs() {
        if (!this.fdsData.slcfs) return;

        // We need mesh extents for PBX/PBY/PBZ planes
        let domainXB = null;
        if (this.fdsData.meshes.length > 0) {
            let x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity, z1 = Infinity, z2 = -Infinity;
            for (const m of this.fdsData.meshes) {
                if (!m.xb) continue;
                x1 = Math.min(x1, m.xb[0]); x2 = Math.max(x2, m.xb[1]);
                y1 = Math.min(y1, m.xb[2]); y2 = Math.max(y2, m.xb[3]);
                z1 = Math.min(z1, m.xb[4]); z2 = Math.max(z2, m.xb[5]);
            }
            domainXB = [x1, x2, y1, y2, z1, z2];
        }

        const slcfColor = 0x22dd88;

        for (let i = 0; i < this.fdsData.slcfs.length; i++) {
            const slcf = this.fdsData.slcfs[i];

            let planeXB = null;

            if (slcf.pbx != null && domainXB) {
                // YZ plane at x = pbx
                planeXB = [slcf.pbx, slcf.pbx, domainXB[2], domainXB[3], domainXB[4], domainXB[5]];
            } else if (slcf.pby != null && domainXB) {
                // XZ plane at y = pby
                planeXB = [domainXB[0], domainXB[1], slcf.pby, slcf.pby, domainXB[4], domainXB[5]];
            } else if (slcf.pbz != null && domainXB) {
                // XY plane at z = pbz
                planeXB = [domainXB[0], domainXB[1], domainXB[2], domainXB[3], slcf.pbz, slcf.pbz];
            } else if (slcf.xb) {
                planeXB = slcf.xb;
            }

            if (!planeXB) continue;

            const { position, size } = this._xbToBox(planeXB);

            // Give zero-thickness planes a small thickness for visibility
            const minDim = 0.008;
            const sx = size.x < 0.001 ? minDim : size.x;
            const sy = size.y < 0.001 ? minDim : size.y;
            const sz = size.z < 0.001 ? minDim : size.z;

            const geometry = new THREE.BoxGeometry(sx, sy, sz);
            const material = new THREE.MeshBasicMaterial({
                color: slcfColor,
                transparent: true,
                opacity: 0.1,
                side: THREE.DoubleSide,
                depthWrite: false,
            });
            const plane = new THREE.Mesh(geometry, material);
            plane.position.copy(position);
            plane.userData = {
                type: 'SLCF',
                id: slcf.id,
                quantity: slcf.quantity,
                pbx: slcf.pbx,
                pby: slcf.pby,
                pbz: slcf.pbz,
                xb: planeXB,
            };

            // Edge
            const edgeMat = new THREE.LineBasicMaterial({
                color: slcfColor,
                transparent: true,
                opacity: 0.4,
            });
            const edgeGeo = new THREE.EdgesGeometry(geometry);
            const wireframe = new THREE.LineSegments(edgeGeo, edgeMat);
            plane.add(wireframe);

            this.slcfGroup.add(plane);
        }
    }

    _renderFires() {
        // Identify and highlight all fire sources in the model
        // Fire types:
        // 1. VENTs with SURF_ID pointing to a SURF with HRRPUA > 0
        // 2. VENTs with SURF_ID pointing to a SURF with MLRPUA > 0
        // 3. OBSTs with SURF_ID that has HRRPUA > 0
        // 4. INITs with HRRPUV > 0 (volumetric fire)
        // 5. INITs with PART_ID → PART → SURF with TMP_FRONT > threshold (ignitor)
        // 6. SURFs with E_COEFFICIENT (exponential fire)

        const fireSurfs = new Set();
        const ignitorSurfs = new Set();

        // Identify fire surfaces
        if (this.fdsData.surfs) {
            for (const [surfId, surf] of Object.entries(this.fdsData.surfs)) {
                const p = surf._params || {};
                if (p.HRRPUA > 0 || p.MLRPUA > 0) {
                    fireSurfs.add(surfId);
                }
                if (p.TMP_FRONT > 100) {
                    ignitorSurfs.add(surfId);
                }
                if (p.E_COEFFICIENT > 0) {
                    fireSurfs.add(surfId);
                }
            }
        }

        // Fire VENTs
        for (const vent of this.fdsData.vents) {
            if (!vent.xb) continue;
            const surfName = Array.isArray(vent.surf_id) ? vent.surf_id[0] : vent.surf_id;
            if (!surfName || !fireSurfs.has(surfName)) continue;

            const { position, size } = this._xbToBox(vent.xb);
            this._addFireMarker(position, size, {
                type: 'FIRE',
                subtype: 'VENT_HRRPUA',
                id: vent.id,
                xb: vent.xb,
                surf_id: vent.surf_id,
            });
        }

        // Fire OBSTs
        for (const obst of this.fdsData.obsts) {
            if (!obst.xb) continue;
            const surfName = Array.isArray(obst.surf_id) ? obst.surf_id[0] : obst.surf_id;
            if (!surfName || !fireSurfs.has(surfName)) continue;

            const { position, size } = this._xbToBox(obst.xb);
            this._addFireMarker(position, size, {
                type: 'FIRE',
                subtype: 'OBST_BURNING',
                id: obst.id,
                xb: obst.xb,
                surf_id: obst.surf_id,
            });
        }

        // Volumetric fire (INIT with HRRPUV)
        if (this.fdsData.inits) {
            for (const init of this.fdsData.inits) {
                const p = init._params || {};
                if (p.HRRPUV > 0 && init.xb) {
                    const { position, size } = this._xbToBox(init.xb);
                    this._addFireMarker(position, size, {
                        type: 'FIRE',
                        subtype: 'INIT_HRRPUV',
                        id: init.id,
                        xb: init.xb,
                        hrrpuv: p.HRRPUV,
                    });
                }
            }
        }
    }

    _addFireMarker(position, size, userData) {
        // Add a pulsing fire-colored overlay
        const minDim = 0.02;
        const sx = Math.max(size.x, minDim);
        const sy = Math.max(size.y, minDim);
        const sz = Math.max(size.z, minDim);

        const geometry = new THREE.BoxGeometry(sx * 1.02, sy * 1.02, sz * 1.02);

        // Orange-red glow
        const material = new THREE.MeshPhongMaterial({
            color: 0xff4400,
            emissive: 0xff2200,
            emissiveIntensity: 0.5,
            transparent: true,
            opacity: 0.45,
            side: THREE.DoubleSide,
            depthWrite: false,
        });

        const box = new THREE.Mesh(geometry, material);
        box.position.copy(position);
        box.userData = userData;

        // Fire icon wireframe
        const edgeMat = new THREE.LineBasicMaterial({ color: 0xff6600 });
        const edgeGeo = new THREE.EdgesGeometry(geometry);
        const wireframe = new THREE.LineSegments(edgeGeo, edgeMat);
        box.add(wireframe);

        this.fireGroup.add(box);
    }

    _renderGrid() {
        // Render 3D grid lines on all faces for each mesh
        if (this.fdsData.meshes.length === 0) return;

        const gridColor = 0x444466;
        // polygonOffset is documented for triangles only and most drivers
        // ignore it for lines, so we offset the grid GEOMETRICALLY instead:
        // each line is shifted ~0.03 m outward along the mesh face's outward
        // normal. That's larger than the thin-OBST 0.02 m inflation, so the
        // grid sits just outside any flush wall — visible from outside the
        // box, properly hidden behind the wall from inside the room.
        const EPS = 0.03;
        const material = new THREE.LineBasicMaterial({ color: gridColor });

        for (const mesh of this.fdsData.meshes) {
            const xb = mesh.xb;
            if (!xb) continue;
            // Skip grid rendering when IJK was synthesised — drawing a default
            // 10×10×10 lattice would be a visual lie about the cell count.
            if (mesh.ijk_explicit === false) continue;

            const x1 = xb[0], x2 = xb[1];
            const y1 = xb[2], y2 = xb[3];
            const z1 = xb[4], z2 = xb[5];

            const ni = mesh.ijk[0], nj = mesh.ijk[1], nk = mesh.ijk[2];
            const stepX = (x2 - x1) / ni;
            const stepY = (y2 - y1) / nj;
            const stepZ = (z2 - z1) / nk;

            // Limit grid lines per mesh for performance
            const maxLines = 200;
            const skipI = Math.max(1, Math.ceil(ni / maxLines));
            const skipJ = Math.max(1, Math.ceil(nj / maxLines));
            const skipK = Math.max(1, Math.ceil(nk / maxLines));

            const points = [];

            // ── XY plane (floor at z1 and ceiling at z2) ──
            // FDS X→Three X, FDS Y→Three Z, FDS Z→Three Y.
            // zOff pushes the grid outward (down for floor, up for ceiling)
            // so coplanar OBST walls don't bury it.
            for (const zVal of [z1, z2]) {
                const zOff = zVal === z1 ? -EPS : EPS;
                const zG = zVal + zOff;
                for (let j = 0; j <= nj; j += skipJ) {
                    const yy = y1 + j * stepY;
                    points.push(new THREE.Vector3(x1, zG, yy));
                    points.push(new THREE.Vector3(x2, zG, yy));
                }
                for (let i = 0; i <= ni; i += skipI) {
                    const xx = x1 + i * stepX;
                    points.push(new THREE.Vector3(xx, zG, y1));
                    points.push(new THREE.Vector3(xx, zG, y2));
                }
            }

            // ── XZ plane (front at y1 and back at y2) ──
            for (const yVal of [y1, y2]) {
                const yOff = yVal === y1 ? -EPS : EPS;
                const yG = yVal + yOff;
                for (let k = 0; k <= nk; k += skipK) {
                    const zz = z1 + k * stepZ;
                    points.push(new THREE.Vector3(x1, zz, yG));
                    points.push(new THREE.Vector3(x2, zz, yG));
                }
                for (let i = 0; i <= ni; i += skipI) {
                    const xx = x1 + i * stepX;
                    points.push(new THREE.Vector3(xx, z1, yG));
                    points.push(new THREE.Vector3(xx, z2, yG));
                }
            }

            // ── YZ plane (left at x1 and right at x2) ──
            for (const xVal of [x1, x2]) {
                const xOff = xVal === x1 ? -EPS : EPS;
                const xG = xVal + xOff;
                for (let k = 0; k <= nk; k += skipK) {
                    const zz = z1 + k * stepZ;
                    points.push(new THREE.Vector3(xG, zz, y1));
                    points.push(new THREE.Vector3(xG, zz, y2));
                }
                for (let j = 0; j <= nj; j += skipJ) {
                    const yy = y1 + j * stepY;
                    points.push(new THREE.Vector3(xG, z1, yy));
                    points.push(new THREE.Vector3(xG, z2, yy));
                }
            }

            const geometry = new THREE.BufferGeometry().setFromPoints(points);
            const lines = new THREE.LineSegments(geometry, material);
            this.gridGroup.add(lines);
        }
    }

    _fitCamera() {
        if (!this.boundingBox) return;

        const center = this.boundingBox.center;
        const size = this.boundingBox.size;
        const maxDim = Math.max(size.x, size.y, size.z);

        this.controls.target.copy(center);

        const distance = maxDim * 1.8;
        this.camera.position.set(
            center.x + distance * 0.7,
            center.y + distance * 0.5,
            center.z + distance * 0.7
        );

        this.camera.near = maxDim * 0.001;
        this.camera.far = maxDim * 100;
        this.camera.updateProjectionMatrix();

        this.controls.update();
    }

    _updateAxes() {
        if (!this.boundingBox) {
            // No model: keep the axes visible at a small default size so the
            // user gets a sense of orientation in the empty scene.
            this.axesHelper.visible = true;
            this.axesHelper.scale.setScalar(1);
            return;
        }
        // Model is loaded — hide the origin axes so they don't distract from
        // the geometry. Camera-view buttons and walk-mode already convey
        // orientation; the axes are only useful when the scene is empty.
        this.axesHelper.visible = false;
    }

    /**
     * Toggle visibility of a layer
     */
    setVisibility(layer, visible) {
        this.visibility[layer] = visible;
        switch (layer) {
            case 'meshes': this.meshGroup.visible = visible; break;
            case 'obsts': this.obstGroup.visible = visible; break;
            case 'vents': this.ventGroup.visible = visible; break;
            case 'holes': this.holeGroup.visible = visible; break;
            case 'devcs': this.devcGroup.visible = visible; break;
            case 'inits': this.initGroup.visible = visible; break;
            case 'grid': this.gridGroup.visible = visible; break;
            case 'geoms': this.geomGroup.visible = visible; break;
            case 'hvacs': this.hvacGroup.visible = visible; break;
            case 'zones': this.zoneGroup.visible = visible; break;
            case 'fires': this.fireGroup.visible = visible; break;
            // Unified "Slices" toggle. In FDS terminology an &SLCF declaration
            // and the .sf data file it produces are the SAME slice — the
            // declaration is the recipe, the data is the cooked output. So
            // this single switch governs both:
            //   - slcfGroup: the transparent &SLCF rectangles parsed from .fds
            //   - _isSliceOverlay nodes: the coloured .sf data overlays
            // The scene.userData flag is read by slice-renderer.js so a fresh
            // .sf load while the toggle is off doesn't pop a stale overlay in.
            // 'slcfs' kept as a legacy alias for any code that still calls it.
            case 'slices':
            case 'slcfs':
                this.scene.userData.slicesVisible = visible;
                this.slcfGroup.visible = visible;
                this.scene.traverse(n => {
                    if (n._isSliceOverlay) n.visible = visible;
                });
                break;
            // Vismap's manual visual obstruction / hole markers. The overlay
            // additionally tracks whether its Output mode is active via
            // _vismapModeVisible, so re-ticking the layer in another mode
            // doesn't pop the markers back in.
            case 'vismapRegions':
                this.scene.userData.vismapRegionsVisible = visible;
                this.scene.traverse(n => {
                    if (n._isVisualRegion) n.visible = visible && n._vismapModeVisible !== false;
                });
                break;
        }
    }

    /**
     * Set obstruction opacity
     */
    setObstOpacity(opacity) {
        this.obstGroup.traverse(child => {
            if (child.isMesh && child.material) {
                child.material.opacity = opacity;
                child.material.transparent = opacity < 1;
            }
        });
    }

    /**
     * Show/hide the black edge wireframe on every OBST. Default is hidden so
     * the seams between adjacent OBSTs that compose a wall don't read as
     * visible lines in walk mode.
     */
    setShowObstEdges(show) {
        this.showObstEdges = !!show;
        this.obstGroup.traverse(child => {
            if (child._isObstEdge) child.visible = !!show;
        });
    }

    /**
     * Set opacity across every geometry group (meshes, obsts, vents, holes,
     * devices, inits, geoms, hvac, zones, fires, grid). Slice and smoke
     * overlays are flagged with `_isSliceOverlay` and are skipped.
     */
    setSceneOpacity(opacity) {
        const groups = [
            this.meshGroup, this.obstGroup, this.ventGroup, this.holeGroup,
            this.devcGroup, this.initGroup, this.geomGroup, this.hvacGroup,
            this.zoneGroup, this.fireGroup, this.gridGroup, this.slcfGroup,
        ];
        const transparent = opacity < 1;
        for (const group of groups) {
            if (!group) continue;
            group.traverse(node => {
                if (node._isSliceOverlay) return;
                if (!node.material) return;
                const mats = Array.isArray(node.material) ? node.material : [node.material];
                for (const m of mats) {
                    if (!m) continue;
                    m.opacity = opacity;
                    m.transparent = transparent;
                }
            });
        }
    }

    /**
     * Set background color
     */
    setBackground(color) {
        this.scene.background = new THREE.Color(color);
    }

    setGrayscale(enabled) {
        this._grayscale = enabled;
        this.scene.traverse(node => {
            if (node._isSliceOverlay || node._isVisualRegion) return; // never desaturate overlay colors
            if (!node.isMesh && !node.isLine && !node.isLineSegments) return;
            const mats = Array.isArray(node.material) ? node.material : [node.material];
            for (const m of mats) {
                if (!m || !m.color) continue;
                if (enabled) {
                    if (!m._origColor) m._origColor = m.color.getHex();
                    const c = new THREE.Color(m._origColor);
                    const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
                    m.color.setRGB(lum, lum, lum);
                    if (m.emissive && m.emissive.getHex() > 0) {
                        if (!m._origEmissive) m._origEmissive = m.emissive.getHex();
                        const e = new THREE.Color(m._origEmissive);
                        const elum = 0.299 * e.r + 0.587 * e.g + 0.114 * e.b;
                        m.emissive.setRGB(elum, elum, elum);
                    }
                } else if (m._origColor !== undefined) {
                    m.color.setHex(m._origColor);
                    if (m._origEmissive !== undefined && m.emissive) m.emissive.setHex(m._origEmissive);
                }
            }
        });
    }

/**
     * Reset camera to fit all geometry
     */
    resetCamera() {
        this._fitCamera();
    }

    /**
     * Set view direction
     */
    setView(direction) {
        if (!this.boundingBox) return;
        const center = this.boundingBox.center;
        const maxDim = Math.max(this.boundingBox.size.x, this.boundingBox.size.y, this.boundingBox.size.z);
        const dist = maxDim * 2;

        this.controls.target.copy(center);

        switch (direction) {
            case 'front':
                this.camera.position.set(center.x, center.y, center.z + dist);
                break;
            case 'back':
                this.camera.position.set(center.x, center.y, center.z - dist);
                break;
            case 'left':
                this.camera.position.set(center.x - dist, center.y, center.z);
                break;
            case 'right':
                this.camera.position.set(center.x + dist, center.y, center.z);
                break;
            case 'top':
                this.camera.position.set(center.x, center.y + dist, center.z);
                break;
            case 'bottom':
                this.camera.position.set(center.x, center.y - dist, center.z);
                break;
            case 'iso':
                this.camera.position.set(
                    center.x + dist * 0.7,
                    center.y + dist * 0.5,
                    center.z + dist * 0.7
                );
                break;
        }

        this.camera.lookAt(center);
        this.controls.update();
    }

    /**
     * Apply 6-plane clipping in FDS coordinates.
     * FDS Y maps to Three.js Z; FDS Z maps to Three.js Y.
     *
     * PER-AXIS ACTIVATION: only enable a clip plane when the user has
     * actually pushed that slider off the model bound. The previous design
     * enabled all 6 planes whenever any one slider moved, which silently
     * clipped every edge element on the untouched axes:
     *   - thin OBSTs (walls/floors) at FDS X=0,0 render as 0.02 m slabs
     *     centered on the plane → cut in half by a clip at xmin=0
     *   - mesh grid lines are offset 0.03 m OUTWARD beyond each face → sit
     *     entirely outside a clip at the model bound and vanish
     *   - face-mounted VENTs follow the same slab-around-the-plane pattern
     * Symptom users saw: "X clipping also clips Y edge elements." Fix:
     * a plane at the model bound contributes nothing, so leaving any axis
     * untouched preserves its boundary geometry — and pushing a slider
     * inward still clips that axis exactly at the user's value.
     */
    setClipPlanes(xmin, xmax, ymin, ymax, zmin, zmax) {
        const bounds = this.getBoundsFDS();
        if (!bounds) {
            // Bounds unknown (no geometry yet) — apply all planes literally.
            this.clipPlanes[0].constant = -xmin;
            this.clipPlanes[1].constant = xmax;
            this.clipPlanes[2].constant = -ymin;
            this.clipPlanes[3].constant = ymax;
            this.clipPlanes[4].constant = -zmin;
            this.clipPlanes[5].constant = zmax;
            this.renderer.clippingPlanes = [...this.clipPlanes];
            return;
        }
        // TOL absorbs float-precision drift from slider→input round-tripping
        // (display shows .toFixed(2), value may differ from bound by ≤0.005).
        const TOL = 0.001;
        const active = [];
        if (xmin > bounds.xmin + TOL) {
            this.clipPlanes[0].constant = -xmin;
            active.push(this.clipPlanes[0]);
        }
        if (xmax < bounds.xmax - TOL) {
            this.clipPlanes[1].constant = xmax;
            active.push(this.clipPlanes[1]);
        }
        if (ymin > bounds.ymin + TOL) {
            this.clipPlanes[2].constant = -ymin;
            active.push(this.clipPlanes[2]);
        }
        if (ymax < bounds.ymax - TOL) {
            this.clipPlanes[3].constant = ymax;
            active.push(this.clipPlanes[3]);
        }
        if (zmin > bounds.zmin + TOL) {
            this.clipPlanes[4].constant = -zmin;
            active.push(this.clipPlanes[4]);
        }
        if (zmax < bounds.zmax - TOL) {
            this.clipPlanes[5].constant = zmax;
            active.push(this.clipPlanes[5]);
        }
        this.renderer.clippingPlanes = active;
    }

    resetClipPlanes() {
        this.renderer.clippingPlanes = [];
    }

    /**
     * Return the model bounding box in FDS coordinates.
     */
    getBoundsFDS() {
        if (!this.boundingBox) return null;
        return {
            xmin: this.boundingBox.min.x,
            xmax: this.boundingBox.max.x,
            ymin: this.boundingBox.min.z,
            ymax: this.boundingBox.max.z,
            zmin: this.boundingBox.min.y,
            zmax: this.boundingBox.max.y,
        };
    }

    /**
     * Set bounding box from FDS coordinates and fit camera.
     * Used when smoke-only data is loaded with no .fds geometry.
     */
    setBoundsFDSAndFit(xmin, xmax, ymin, ymax, zmin, zmax) {
        this.boundingBox = {
            min: new THREE.Vector3(xmin, zmin, ymin),
            max: new THREE.Vector3(xmax, zmax, ymax),
            center: new THREE.Vector3((xmin+xmax)/2, (zmin+zmax)/2, (ymin+ymax)/2),
            size: new THREE.Vector3(xmax-xmin, zmax-zmin, ymax-ymin),
        };
        this._fitCamera();
        this._updateAxes();
    }

    /**
     * Get scene statistics
     */
    getStats() {
        return {
            meshes: this.fdsData ? this.fdsData.meshes.length : 0,
            obsts: this.fdsData ? this.fdsData.obsts.length : 0,
            vents: this.fdsData ? this.fdsData.vents.length : 0,
            holes: this.fdsData ? this.fdsData.holes.length : 0,
            devcs: this.fdsData ? this.fdsData.devcs.length : 0,
            inits: this.fdsData && this.fdsData.inits ? this.fdsData.inits.length : 0,
            geoms: this.fdsData && this.fdsData.geoms ? this.fdsData.geoms.length : 0,
            hvacs: this.fdsData && this.fdsData.hvacs ? this.fdsData.hvacs.length : 0,
            zones: this.fdsData && this.fdsData.zones ? this.fdsData.zones.length : 0,
            slcfs: this.fdsData && this.fdsData.slcfs ? this.fdsData.slcfs.length : 0,
            fires: this.fireGroup ? this.fireGroup.children.length : 0,
        };
    }

    // ═══════════════════════════════════════════════════════════════════
    // ── Walk mode (FPS) ───────────────────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════

    /** Returns the list of meshes used for collision/floor raycasts. */
    _walkCollisionTargets() {
        const targets = [];
        const collect = group => {
            if (!group) return;
            group.traverse(c => { if (c.isMesh && c.visible) targets.push(c); });
        };
        // Solid obstructions + custom geom — these are what a walker bumps into.
        collect(this.obstGroup);
        collect(this.geomGroup);
        return targets;
    }

    /** Returns FDS-domain Z bottom (Three.Y) used as the implicit floor when
     *  no OBST is found below the player. Falls back to 0 if no MESH defined. */
    _walkDomainFloor() {
        if (!this.fdsData || !this.fdsData.meshes.length) return 0;
        let minZ = Infinity;
        for (const m of this.fdsData.meshes) {
            if (!m.xb) continue;
            if (m.xb[4] < minZ) minZ = m.xb[4]; // FDS zmin
        }
        return Number.isFinite(minZ) ? minZ : 0;
    }

    /** Cast a ray straight down from a point. Returns hit Three.Y or null. */
    _walkRaycastDown(threePos, fromY) {
        const origin = new THREE.Vector3(threePos.x, fromY, threePos.z);
        const dir = new THREE.Vector3(0, -1, 0);
        this.walkRaycaster.set(origin, dir);
        this.walkRaycaster.far = 200;
        const targets = this._walkCollisionTargets();
        const hits = this.walkRaycaster.intersectObjects(targets, false);
        if (hits.length) return hits[0].point.y;
        return null;
    }

    /** Try to move from `from` to `to` (Three coords, horizontal only). Returns
     *  the resolved position after sliding against walls. Uses a forward ray of
     *  length = step + walkRadius and stops just short of any hit. */
    _walkResolveHorizontal(from, toX, toZ) {
        const dx = toX - from.x;
        const dz = toZ - from.z;
        const stepLen = Math.hypot(dx, dz);
        if (stepLen < 1e-6) return { x: from.x, z: from.z };
        const dir = new THREE.Vector3(dx / stepLen, 0, dz / stepLen);
        const eyeY = from.y;
        // Cast at the eye height AND at half-height to catch low and tall walls
        const targets = this._walkCollisionTargets();
        const probeYs = [eyeY, eyeY - this.walkEyeHeight * 0.5, eyeY - this.walkEyeHeight + 0.1];
        let minHit = Infinity;
        for (const py of probeYs) {
            this.walkRaycaster.set(new THREE.Vector3(from.x, py, from.z), dir);
            this.walkRaycaster.far = stepLen + this.walkRadius;
            const hits = this.walkRaycaster.intersectObjects(targets, false);
            if (hits.length && hits[0].distance < minHit) minHit = hits[0].distance;
        }
        let allowed = stepLen;
        if (minHit < Infinity) allowed = Math.max(0, minHit - this.walkRadius);
        return { x: from.x + dir.x * allowed, z: from.z + dir.z * allowed };
    }

    /** Per-frame update while in walk mode. Applies look, movement, gravity,
     *  floor stick and wall collision. */
    _walkUpdate(dt) {
        if (!this.walkPlaced) return; // waiting for the user's first click

        // ── Build forward/right vectors from camera yaw (no pitch) ────────
        const fwd = new THREE.Vector3();
        this.camera.getWorldDirection(fwd);
        fwd.y = 0;
        if (fwd.lengthSq() < 1e-9) fwd.set(0, 0, -1);
        fwd.normalize();
        const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();

        // ── Horizontal velocity from WASD ─────────────────────────────────
        const move = new THREE.Vector3();
        const k = this.walkKeys;
        if (k['w'] || k['arrowup'])    move.add(fwd);
        if (k['s'] || k['arrowdown'])  move.sub(fwd);
        if (k['d'] || k['arrowright']) move.add(right);
        if (k['a'] || k['arrowleft'])  move.sub(right);
        if (move.lengthSq() > 0) {
            move.normalize();
            const speed = this.walkSpeed * (k['shift'] ? this.walkRunMult : 1);
            move.multiplyScalar(speed * dt);
        }

        const cam = this.camera.position;
        const next = this._walkResolveHorizontal(cam, cam.x + move.x, cam.z + move.z);

        // ── Vertical: gravity + floor stick ───────────────────────────────
        const eyeH = this.walkEyeHeight;
        const domainFloor = this._walkDomainFloor();
        // Raycast from slightly above the eye to robustly find what we're on.
        const floorY = this._walkRaycastDown({ x: next.x, z: next.z }, cam.y + 0.05);
        // Effective floor under the new XZ position
        const surfaceY = (floorY != null && floorY <= cam.y + 0.6) ? floorY : domainFloor;
        const targetEyeY = surfaceY + eyeH;

        // Apply gravity OR stick to the floor
        this.walkVelocityY -= this.walkGravity * dt;
        let newY = cam.y + this.walkVelocityY * dt;
        if (newY <= targetEyeY) {
            newY = targetEyeY;
            this.walkVelocityY = 0;
            this._walkGrounded = true;
        } else {
            this._walkGrounded = false;
        }
        // Jump (only when grounded)
        if (k[' '] && this._walkGrounded) {
            this.walkVelocityY = this.walkJumpVel;
            this._walkGrounded = false;
        }

        this.camera.position.set(next.x, newY, next.z);
    }

    /** Enter walk mode. Disables OrbitControls and primes the HUD until the
     *  user clicks a surface to be placed.
     *  @param {string} [hudId] DOM id of the HUD overlay to drive. Defaults
     *  to 'walk-hud' (3D Geometry page). The Output page passes its own id. */
    enterWalkMode(hudId) {
        if (this.walkMode) return;
        this.walkHudId = hudId || 'walk-hud';
        this.walkMode = true;
        this.walkPlaced = false;
        this.walkVelocityY = 0;
        this.walkSavedCamera = {
            position: this.camera.position.clone(),
            quaternion: this.camera.quaternion.clone(),
            target: this.controls.target.clone(),
        };
        this.controls.enabled = false;

        if (!this.walkControls) {
            this.walkControls = new THREE.PointerLockControls(this.camera, this.renderer.domElement);
            this.walkControls.addEventListener('lock',   () => this._walkSetHudLocked(true));
            this.walkControls.addEventListener('unlock', () => {
                this._walkSetHudLocked(false);
                // Standard FPS UX: Esc unlocks. We also exit the mode entirely.
                if (this.walkMode) this.exitWalkMode();
            });
        }

        // Key listeners — capture key state in walkKeys map.
        this._walkOnKeyDown = (e) => {
            if (!this.walkMode) return;
            const key = e.key === ' ' ? ' ' : e.key.toLowerCase();
            this.walkKeys[key] = true;
            if (key === 'shift') this.walkKeys.shift = true;
            // Swallow nav keys so the page doesn't scroll while walking
            if (['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright',' '].includes(key)) {
                e.preventDefault();
            }
        };
        this._walkOnKeyUp = (e) => {
            const key = e.key === ' ' ? ' ' : e.key.toLowerCase();
            this.walkKeys[key] = false;
            if (key === 'shift') this.walkKeys.shift = false;
        };
        window.addEventListener('keydown', this._walkOnKeyDown);
        window.addEventListener('keyup', this._walkOnKeyUp);

        // Show HUD
        const hud = document.getElementById(this.walkHudId);
        if (hud) {
            hud.style.display = 'flex';
            hud.classList.remove('locked');
            const status = document.getElementById(this.walkHudId + '-status');
            if (status) status.textContent = 'Click any horizontal surface to place yourself.';
        }
    }

    /** Exit walk mode. Restores OrbitControls and the camera state. */
    exitWalkMode() {
        if (!this.walkMode) return;
        this.walkMode = false;
        this.walkPlaced = false;
        this.walkKeys = {};
        this.walkVelocityY = 0;

        if (this.walkControls && this.walkControls.isLocked) {
            try { this.walkControls.unlock(); } catch (_) { /* noop */ }
        }
        if (this._walkOnKeyDown) window.removeEventListener('keydown', this._walkOnKeyDown);
        if (this._walkOnKeyUp)   window.removeEventListener('keyup', this._walkOnKeyUp);
        this._walkOnKeyDown = this._walkOnKeyUp = null;

        // Restore camera to where the user was before walk mode
        if (this.walkSavedCamera) {
            this.camera.position.copy(this.walkSavedCamera.position);
            this.camera.quaternion.copy(this.walkSavedCamera.quaternion);
            this.controls.target.copy(this.walkSavedCamera.target);
        }
        this.controls.enabled = true;

        const hud = document.getElementById(this.walkHudId || 'walk-hud');
        if (hud) { hud.style.display = 'none'; hud.classList.remove('locked'); }

        // Let the app re-sync the toggle button label.
        this.container.dispatchEvent(new CustomEvent('walkModeChanged', { detail: { active: false } }));
    }

    /** Place the walker at a clicked 3D point. Snaps to a horizontal surface
     *  whose normal points up, then locks the pointer for mouse-look. */
    _walkPlaceAt(hit) {
        // Eye position = hit point + eyeHeight on the up axis
        const eye = new THREE.Vector3(hit.point.x, hit.point.y + this.walkEyeHeight, hit.point.z);
        this.camera.position.copy(eye);
        // Look horizontally (preserve yaw, zero pitch)
        const dir = new THREE.Vector3();
        this.camera.getWorldDirection(dir);
        dir.y = 0;
        if (dir.lengthSq() < 1e-9) dir.set(0, 0, -1);
        dir.normalize();
        this.camera.lookAt(eye.x + dir.x, eye.y, eye.z + dir.z);
        this.walkPlaced = true;
        this.walkVelocityY = 0;

        if (this.walkControls && !this.walkControls.isLocked) {
            try { this.walkControls.lock(); } catch (_) { /* user gesture required — already in a click */ }
        }
    }

    _walkSetHudLocked(locked) {
        const hud = document.getElementById(this.walkHudId || 'walk-hud');
        if (!hud) return;
        if (locked) hud.classList.add('locked');
        else hud.classList.remove('locked');
    }
}
