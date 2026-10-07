/* Persistent 3D overlay of JuPedSim agents, coloured by FED or speed and
 * driven by simulation time (setTime) so it stays in lockstep with the smoke
 * clock. Mirrors the Smoke3DOverlay interface (group, setVisible, currentTime,
 * dispose). Three.js r128 globals.
 *
 * The colormap helpers are top-level (not IIFE-private) so they can be
 * unit-tested without a THREE stub.
 */

const QUANTITY_RANGE = { fed: [0, 1], speed: [0, 1.5] };
// Display units for the colorbar scale. FED is a dimensionless dose (1 = incapacitation).
const QUANTITY_UNIT = { fed: '', speed: 'm/s' };

function normalizeQuantity(value, quantity) {
    const range = QUANTITY_RANGE[quantity] || [0, 1];
    const lo = range[0];
    const hi = range[1];
    if (hi <= lo) return 0;
    const t = (value - lo) / (hi - lo);
    return t < 0 ? 0 : t > 1 ? 1 : t;
}

// green (low) -> yellow -> red (high). Returns {r,g,b} in 0..1.
function colorForValue(value, quantity) {
    const t = normalizeQuantity(value, quantity);
    const r = 0.2 + t * 0.7;
    let g = t < 0.5 ? 0.8 + t * 0.2 : 0.9 - (t - 0.5) * 1.5;
    let b = 0.2 - t * 0.05;
    if (g < 0) g = 0;
    if (b < 0) b = 0;
    return { r, g, b };
}

(function (global) {
    'use strict';

    function fdsToScene(x, y, z) { return new THREE.Vector3(x, z, -y); }

    class AgentOverlay {
        constructor(scene) {
            this.scene = scene;
            this.group = new THREE.Group();
            this.group.name = 'agents';
            scene.add(this.group);
            this.dataset = null;
            this.mesh = null;
            this.frameIndex = 0;
            this.quantity = 'speed';
            this.height = 0.9;
            this.radius = 0.25;
            this._color = new THREE.Color();
            this._dummy = new THREE.Object3D();
        }

        get activeFrames() { return this.dataset ? this.dataset.frames : []; }

        load(dataset) {
            this._disposeMesh();
            this.dataset = dataset;
            if (dataset.quantities.indexOf(this.quantity) < 0) {
                this.quantity = dataset.quantities[0];
            }
            let maxCount = 0;
            for (const f of dataset.frames) if (f.count > maxCount) maxCount = f.count;
            const n = Math.max(maxCount, 1);
            const geo = new THREE.SphereGeometry(this.radius, 12, 8);
            const mat = new THREE.MeshLambertMaterial();
            this.mesh = new THREE.InstancedMesh(geo, mat, n);
            this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
            this.group.add(this.mesh);
            this.frameIndex = 0;
            this._renderFrame();
        }

        availableQuantities() { return this.dataset ? this.dataset.quantities : []; }

        setQuantity(q) {
            if (!this.dataset || this.dataset.quantities.indexOf(q) < 0) return;
            this.quantity = q;
            this._renderFrame();
        }

        setVisible(v) { this.group.visible = !!v; }

        setOpacity(a) {
            if (!this.mesh) return;
            this.mesh.material.transparent = a < 1;
            this.mesh.material.opacity = a;
        }

        setHeight(h) { this.height = h; this._renderFrame(); }

        currentTime() {
            const f = this.activeFrames[this.frameIndex];
            return f ? f.time : 0;
        }

        setTime(t) {
            if (!this.dataset) return;
            const idx = this.dataset.frameIndexAtTime(t);
            if (idx !== this.frameIndex) {
                this.frameIndex = idx;
                this._renderFrame();
            }
        }

        setFrame(idx) {
            if (!this.dataset) return;
            const n = this.dataset.frames.length;
            this.frameIndex = idx < 0 ? 0 : idx >= n ? n - 1 : idx;
            this._renderFrame();
        }

        _renderFrame() {
            if (!this.mesh || !this.dataset) return;
            const f = this.dataset.frames[this.frameIndex];
            if (!f) return;
            const dummy = this._dummy;
            const values = this.quantity === 'fed' ? f.fed : f.speed;
            for (let i = 0; i < f.count; i++) {
                dummy.position.copy(fdsToScene(f.x[i], f.y[i], this.height));
                dummy.scale.set(1, 1, 1);
                dummy.updateMatrix();
                this.mesh.setMatrixAt(i, dummy.matrix);
                const c = colorForValue(values ? values[i] : 0, this.quantity);
                this._color.setRGB(c.r, c.g, c.b);
                this.mesh.setColorAt(i, this._color);
            }
            // Only render the active agents; avoids the per-frame zero-fill loop.
            this.mesh.count = f.count;
            this.mesh.instanceMatrix.needsUpdate = true;
            if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
        }

        _disposeMesh() {
            if (!this.mesh) return;
            this.group.remove(this.mesh);
            this.mesh.geometry.dispose();
            this.mesh.material.dispose();
            this.mesh = null;
        }

        dispose() {
            this._disposeMesh();
            this.scene.remove(this.group);
            this.dataset = null;
        }
    }

    global.AgentOverlay = AgentOverlay;
    global.colorForValue = colorForValue;
    global.normalizeQuantity = normalizeQuantity;
    global.QUANTITY_RANGE = QUANTITY_RANGE;
    global.QUANTITY_UNIT = QUANTITY_UNIT;
})(typeof window !== 'undefined' ? window : globalThis);
