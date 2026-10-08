/**
 * Visibility maps (Vismap) for the Output page — 3D overlay.
 *
 * Draws what fdsvismap plots with matplotlib into the scene, on the plane at
 * the evaluation height: the map (plot_vismap, plot_time_agg_vismap,
 * plot_aset_map) and the routes of egress (plot_routes) in the colors of a
 * VisMapStyle, and the safety signs as evacuation signs. The maps themselves
 * come from VisMap in vismap.js; this file holds no visibility calculation.
 *
 * Exposes (on window):
 *   VisMapOverlay  — THREE objects: map plane, signs, routes and manual
 *                    obstructions
 *
 * FDS-to-Three coordinate convention matches slice-renderer.js:
 *   FDS X -> Three X,  FDS Z -> Three Y (up),  FDS Y -> Three -Z
 */

(function (global) {
    'use strict';

    function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }

    function fdsToScene(x, y, z) { return new THREE.Vector3(x, z, -y); }

    function rgbOf(color) {
        const c = new THREE.Color(color);
        return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
    }

    function mix(a, b, t) {
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }

    // ISO 7010 E002 "Emergency exit (right)" pictogram — running man and door.
    // Path taken verbatim from the public-domain Wikimedia Commons file
    // ISO_7010_E002.svg (viewBox 0…105.833 after the group offset below).
    const ISO_E002_PATH = 'm 88.897663,80.709657 v 60.715533 c -6.316373,0.48241 -10.5308,5.63536 -10.5308,10.31517 v 2.4687 l 2.468698,-0.006 8.062102,-0.0182 v 12.73893 l -6.082136,5.9854 h 40.129013 l 7.43227,-7.11934 h 9.2387 l -7.43284,7.11934 h 11.45592 l 6.08214,-5.98542 V 125.1738 h -10.66451 c -0.0833,5.9e-4 -0.16247,0.004 -0.24579,0.004 -0.0556,0 -0.0832,-0.007 -0.13598,-0.008 -0.0349,-5.8e-4 -0.0686,-0.002 -0.10294,-0.004 -1.43847,-0.0274 -1.75019,-0.28172 -2.77878,-1.31031 l -6.24145,-7.37766 c -1.73064,3.78552 -3.36138,7.00437 -5.08475,10.65995 -0.19459,0.37374 -0.65441,1.21334 -0.30951,1.86731 l 17.15286,34.63575 -6.29263,-0.021 c -3.29001,0.0726 -4.66137,-2.19803 -5.81814,-4.23075 -4.63991,-9.35178 -9.30161,-18.69659 -13.94909,-28.04895 l -0.87733,16.64253 c -0.22955,2.88042 -2.17565,3.61243 -4.72575,3.69137 l -28.817027,0.0659 c 0,-3.31243 3.281927,-7.68712 8.626505,-7.89482 0,0 10.292026,0.11556 15.673012,0.13711 0.68225,0 0.86922,-0.38098 0.94846,-0.94845 0.24993,-4.28189 0.48763,-8.59103 0.7533,-12.87205 0.16632,-2.12536 0.3528,-3.59821 0.96949,-5.20708 2.0106,-4.31016 4.02228,-8.59953 6.03491,-12.89424 l -7.36399,-0.0859 c -0.19342,-0.007 -0.34356,0.0358 -0.44435,0.20823 l -5.32998,9.33771 c -2.198192,4.00865 -8.138332,1.08508 -6.148138,-3.16681 l 6.536168,-10.93249 c 1.14949,-1.70937 1.6747,-2.29896 4.66145,-2.39188 0,0 13.95626,-0.0222 20.94497,-0.0222 v -5.8e-4 c 2.27014,-0.0504 2.52919,0.66163 3.61401,1.81782 2.91625,3.5982 6.10478,7.43502 8.94966,10.7891 0.3953,0.47396 0.61745,0.67583 1.55836,0.66796 1.74231,-0.0292 3.27034,0.002 4.6188,0.0808 h 4.28821 V 80.709277 Z m 38.649157,8.33748 c 4.00109,0 7.06757,3.07482 7.06757,7.09658 0,4.029633 -3.06678,7.103983 -7.06757,7.103983 -4.00049,0 -7.07496,-3.07435 -7.07496,-7.103983 0,-4.02205 3.07447,-7.09658 7.07496,-7.09658 z';
    const ISO_E002_OFFSET = [-65.616667, -71.966666];
    const ISO_E002_SIZE = 105.833333;
    const ISO_GREEN = '#237f52';

    /**
     * Canvas texture of a rectangular evacuation sign (2:1): the genuine
     * ISO 7010 E002 pictogram (running man + door) in the left square and an
     * equally sized direction arrow in the right square, so the arrow always
     * leads the way the sign faces. Small sign ID badge top-left.
     */
    function drawEvacuationSign(id) {
        const panel = 256;
        const canvas = document.createElement('canvas');
        canvas.width = panel * 2;
        canvas.height = panel;
        const ctx = canvas.getContext('2d');

        // White rim + green face, proportions like the ISO sign (rim = 2.5 %)
        const rim = panel * 0.025;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = ISO_GREEN;
        ctx.fillRect(rim, rim, canvas.width - 2 * rim, canvas.height - 2 * rim);

        // Left square: E002 pictogram at its authentic position in the panel
        ctx.save();
        ctx.scale(panel / ISO_E002_SIZE, panel / ISO_E002_SIZE);
        ctx.translate(ISO_E002_OFFSET[0], ISO_E002_OFFSET[1]);
        ctx.fillStyle = '#ffffff';
        ctx.fill(new Path2D(ISO_E002_PATH));
        ctx.restore();

        // Right square: block arrow pointing up, sized like the pictogram square
        ctx.save();
        ctx.translate(panel, 0);
        const u = panel / 100;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(38 * u, 86 * u);
        ctx.lineTo(38 * u, 46 * u);
        ctx.lineTo(20 * u, 46 * u);
        ctx.lineTo(50 * u, 12 * u);
        ctx.lineTo(80 * u, 46 * u);
        ctx.lineTo(62 * u, 46 * u);
        ctx.lineTo(62 * u, 86 * u);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        // Sign ID badge (top-left corner), as wide as the ID needs
        const b = panel / 100;
        const text = String(id);
        ctx.font = 'bold ' + 10 * b + 'px sans-serif';
        const width = Math.max(15 * b, ctx.measureText(text).width + 5 * b);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(rim, rim, width, 13 * b);
        ctx.fillStyle = ISO_GREEN;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, rim + width / 2, rim + 6.5 * b);

        return canvas;
    }

    /** Canvas of the name of a route, on a white, translucent box. */
    function drawLabel(text, color) {
        const height = 96, pad = 16, radius = 14;
        const canvas = document.createElement('canvas');
        let ctx = canvas.getContext('2d');
        const font = '600 50px sans-serif';
        ctx.font = font;
        canvas.width = Math.max(height, Math.ceil(ctx.measureText(text).width) + 2 * pad);
        canvas.height = height;
        ctx = canvas.getContext('2d');
        ctx.beginPath();
        ctx.moveTo(radius, 0);
        ctx.arcTo(canvas.width, 0, canvas.width, height, radius);
        ctx.arcTo(canvas.width, height, 0, height, radius);
        ctx.arcTo(0, height, 0, 0, radius);
        ctx.arcTo(0, 0, canvas.width, 0, radius);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.fill();
        ctx.font = font;
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, canvas.width / 2, height / 2 + 3);
        return canvas;
    }

    class VisMapOverlay {
        constructor(scene) {
            this.scene = scene;
            this.style = new VisMapStyle();
            this.opacity = this.style.mapAlpha;
            /** Size of the route markers in m, see setMarkerSize(). */
            this.markerSize = 0.6;
            /** Height of the plane everything is drawn on, the evaluation height. */
            this.height = 2.0;
            // Signs lie flat on the map plane for the top-down/orbit view;
            // in walk mode they stand upright like real exit signs.
            this.signsUpright = false;

            // One group per kind of object. The root group follows the Vismap
            // mode; the objects in it follow the "Slices" layer, like the
            // other data overlays.
            this.root = new THREE.Group();
            this.root.name = 'vismap';
            this.root.visible = false;
            this.mapGroup = new THREE.Group();
            this.regionGroup = new THREE.Group();
            this.routeGroup = new THREE.Group();
            this.signGroup = new THREE.Group();
            this.root.add(this.mapGroup, this.regionGroup, this.routeGroup, this.signGroup);
            scene.add(this.root);

            this.mapMesh = null;
            this.mapCanvas = null;
            this._signs = [];
            this._signPositions = [];
        }

        /** Show the overlay while the Vismap mode is active. */
        setVisible(visible) { this.root.visible = !!visible; }

        setStyle(style) { this.style = style; }

        /** Opacity of the map over the scene (MapStyle.map_alpha). */
        setOpacity(opacity) {
            this.opacity = opacity;
            if (this.mapMesh) this.mapMesh.material.opacity = opacity;
        }

        /** Scale the lines and markers of the routes to the size of the domain
         *  [x_min, x_max, y_min, y_max], as fdsvismap draws them in points. */
        setMarkerSize(domain) {
            this.markerSize = clamp(0.028 * Math.hypot(domain[1] - domain[0], domain[3] - domain[2]), 0.25, 2.5);
        }

        dispose() {
            this.clearMap();
            for (const group of [this.regionGroup, this.routeGroup, this.signGroup]) this._clear(group);
            this.scene.remove(this.root);
        }

        _clear(group) {
            while (group.children.length) {
                const node = group.children[0];
                if (node.material) {
                    if (node.material.map) node.material.map.dispose();
                    node.material.dispose();
                }
                if (node.geometry) node.geometry.dispose();
                group.remove(node);
            }
        }

        // Objects of the overlay keep their colors in the grayscale scene
        // and follow the "Slices" layer toggle.
        _add(group, node, renderOrder) {
            node.renderOrder = renderOrder;
            node._isSliceOverlay = true;
            node.visible = !this.scene.userData || this.scene.userData.slicesVisible !== false;
            group.add(node);
            return node;
        }

        // ── Map ───────────────────────────────────────────────────────────
        /**
         * Draw a map on the plane at the evaluation height.
         * @param {object} map
         * @param {number[]} map.extent  [x_min, x_max, y_min, y_max] of the cells, VisMap.getDomainExtent()
         * @param {number[]} map.shape   [nx, ny]
         * @param {number}   map.height  evaluation height
         * @param {Uint8Array} [map.vismap]  boolean vismap, drawn in the colors visible / not visible
         * @param {Float64Array} [map.aset]  ASET map, drawn in viridis from 0 to map.maxTime
         * @param {Uint8Array} [map.neverVisible]  cells of the ASET map without a sign at any time
         * @param {number}   [map.maxTime]
         * @param {Uint8Array} [map.obstructions]  obstructed cells, drawn over the map
         * Without vismap and aset only the obstructions are drawn (plot_routes).
         */
        showMap(map) {
            const [nx, ny] = map.shape;
            if (!this.mapCanvas || this.mapCanvas.width !== nx || this.mapCanvas.height !== ny ||
                !this._sameExtent(map)) {
                this.clearMap();
                this._buildMapMesh(map);
            }
            const style = this.style;
            const visible = rgbOf(style.visible), notVisible = rgbOf(style.notVisible);
            const never = rgbOf(style.neverVisible), obstruction = rgbOf(style.obstruction);
            const ctx = this.mapCanvas.getContext('2d');
            const image = ctx.createImageData(nx, ny);
            const data = image.data;
            for (let idx = 0; idx < nx * ny; idx++) {
                let color = null;
                if (map.vismap) color = map.vismap[idx] ? visible : notVisible;
                else if (map.aset) {
                    color = map.neverVisible && map.neverVisible[idx] ? never
                        : VisMapUtil.viridis(map.maxTime > 0 ? map.aset[idx] / map.maxTime : 0);
                }
                let alpha = color ? 255 : 0;
                if (map.obstructions && map.obstructions[idx]) {
                    // The obstructions lie over the map with their own opacity
                    color = color ? mix(color, obstruction, style.obstructionAlpha) : obstruction;
                    alpha = Math.max(alpha, 255 * style.obstructionAlpha);
                }
                if (!color) continue;
                data[4 * idx] = color[0];
                data[4 * idx + 1] = color[1];
                data[4 * idx + 2] = color[2];
                data[4 * idx + 3] = alpha;
            }
            ctx.putImageData(image, 0, 0);
            this.mapMesh.material.map.needsUpdate = true;
        }

        _sameExtent(map) {
            const key = map.extent.join(',') + ',' + map.height;
            return this.mapMesh && this.mapMesh._extentKey === key;
        }

        _buildMapMesh(map) {
            const [nx, ny] = map.shape;
            const [x0, x1, y0, y1] = map.extent;
            this.mapCanvas = document.createElement('canvas');
            this.mapCanvas.width = nx;
            this.mapCanvas.height = ny;
            // Row j of the canvas is row j of the grid, one texel per cell:
            // the extent reaches half a cell beyond the outermost cell centres.
            const positions = [];
            for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
                const v = fdsToScene(x, y, map.height);
                positions.push(v.x, v.y, v.z);
            }
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
            geometry.setIndex([0, 1, 2, 0, 2, 3]);
            const texture = new THREE.CanvasTexture(this.mapCanvas);
            texture.minFilter = THREE.LinearFilter;
            texture.magFilter = THREE.NearestFilter;
            texture.generateMipmaps = false;
            texture.flipY = false;
            const material = new THREE.MeshBasicMaterial({
                map: texture, color: 0xffffff, transparent: true, opacity: this.opacity,
                side: THREE.DoubleSide, depthWrite: false, depthTest: false,
            });
            this.mapMesh = this._add(this.mapGroup, new THREE.Mesh(geometry, material), 90);
            this.mapMesh._extentKey = map.extent.join(',') + ',' + map.height;
        }

        clearMap() {
            this._clear(this.mapGroup);
            this.mapMesh = null;
            this.mapCanvas = null;
        }

        // ── Flat shapes on the plane ──────────────────────────────────────
        // Triangles in FDS (x, y) at the evaluation height, with one color each.
        _flatMesh(group, triangles, renderOrder) {
            const positions = [], colors = [];
            for (const { points, color } of triangles) {
                const c = new THREE.Color(color);
                for (const [x, y] of points) {
                    positions.push(x, this.height, -y);
                    colors.push(c.r, c.g, c.b);
                }
            }
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
            const material = new THREE.MeshBasicMaterial({
                vertexColors: true, side: THREE.DoubleSide, depthTest: false, transparent: true,
            });
            return this._add(group, new THREE.Mesh(geometry, material), renderOrder);
        }

        // A straight band from p to q as two triangles.
        static _band(p, q, width, color) {
            const dx = q[0] - p[0], dy = q[1] - p[1], length = Math.hypot(dx, dy);
            if (!(length > 0)) return [];
            const nx = -dy / length * width / 2, ny = dx / length * width / 2;
            const a = [p[0] + nx, p[1] + ny], b = [p[0] - nx, p[1] - ny];
            const c = [q[0] - nx, q[1] - ny], d = [q[0] + nx, q[1] + ny];
            return [{ points: [a, b, c], color }, { points: [a, c, d], color }];
        }

        static _disc(center, radius, color, inner) {
            const triangles = [], steps = 28;
            for (let k = 0; k < steps; k++) {
                const a0 = 2 * Math.PI * k / steps, a1 = 2 * Math.PI * (k + 1) / steps;
                const at = (r, a) => [center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)];
                if (inner) {
                    triangles.push({ points: [at(inner, a0), at(radius, a0), at(radius, a1)], color },
                        { points: [at(inner, a0), at(radius, a1), at(inner, a1)], color });
                } else {
                    triangles.push({ points: [center, at(radius, a0), at(radius, a1)], color });
                }
            }
            return triangles;
        }

        _label(group, text, color, position, size) {
            const canvas = drawLabel(String(text), color);
            const texture = new THREE.CanvasTexture(canvas);
            texture.minFilter = THREE.LinearFilter;
            const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
            sprite.scale.set(size * canvas.width / canvas.height, size, 1);
            sprite.position.copy(fdsToScene(position[0], position[1], this.height + 0.01));
            return this._add(group, sprite, 120);
        }

        // ── Signs ─────────────────────────────────────────────────────────
        /** Upright signs (walk mode) vs flat markers on the map (orbit view). */
        setSignsUpright(upright) {
            if (this.signsUpright === !!upright) return;
            this.signsUpright = !!upright;
            this.setSigns(this._signs, this.height);
        }

        /**
         * Draw the signs as evacuation signs: flat on the map in the orbit
         * view, upright in walk mode.
         * @param {Array} signs [{ id, x, y, alpha }], alpha null for all directions
         * @param {number} height evaluation height
         */
        setSigns(signs, height) {
            this._clear(this.signGroup);
            this._signs = signs;
            this.height = height;
            this._signPositions = signs.map(sign => [sign.x, sign.y]);
            // Rectangular sign, 2:1 like the drawn texture (pictogram + arrow)
            const signW = 0.9, signH = 0.45;
            for (const sign of signs) {
                const directed = sign.alpha !== null && sign.alpha !== undefined;
                const texture = new THREE.CanvasTexture(drawEvacuationSign(sign.id));
                let mesh;
                if (this.signsUpright && !directed) {
                    // Upright without orientation: camera-facing billboard.
                    mesh = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
                    mesh.scale.set(signW, signH, 1);
                    mesh.position.copy(fdsToScene(sign.x, sign.y, height));
                } else {
                    const material = new THREE.MeshBasicMaterial({
                        map: texture, side: THREE.DoubleSide, transparent: true, depthTest: false,
                    });
                    mesh = new THREE.Mesh(new THREE.PlaneGeometry(signW, signH), material);
                    if (this.signsUpright) {
                        // Plane's default normal is scene +Z (= FDS -Y);
                        // rotating around the vertical axis by 180° - alpha
                        // makes the face normal point along (sin α, cos α) in
                        // FDS coordinates — the direction the view-angle
                        // factor favours.
                        mesh.rotation.y = Math.PI - sign.alpha * Math.PI / 180;
                        mesh.position.copy(fdsToScene(sign.x, sign.y, height));
                    } else {
                        // Flat floor marker, readable from above, centered on
                        // the sign. The arrow shows the escape direction:
                        // opposite the sign's facing normal (sin α, cos α), so
                        // the visibility lobe lies on the approach side behind
                        // the arrow — you see the sign while walking towards
                        // it, then continue in the arrow's direction.
                        mesh.quaternion.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
                        if (directed) {
                            mesh.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), Math.PI - sign.alpha * Math.PI / 180);
                        }
                        const pos = fdsToScene(sign.x, sign.y, height);
                        pos.y += 0.02; // float just above the map plane
                        mesh.position.copy(pos);
                    }
                }
                this._add(this.signGroup, mesh, 120);
            }
        }

        // ── Routes ────────────────────────────────────────────────────────
        /**
         * Draw the routes with their starting point and an arrow head at
         * their end. A route with a coverage is drawn section by section in
         * the colors of covered and uncovered sections, any other as a dashed
         * line in the color of the signs with its name along its longest
         * section.
         * @param {Array} routes [{ id, waypoints, points, coverage }]: points
         *        and coverage as VisMap.getRoutePoints() and getRouteCoverage()
         * @param {number} height evaluation height
         */
        setRoutes(routes, height) {
            this._clear(this.routeGroup);
            this.height = height;
            const u = this.markerSize, style = this.style;
            const lines = [], markers = [];
            const occupied = this._signPositions.slice();
            for (const route of routes) {
                const waypoints = route.waypoints;
                if (!waypoints || waypoints.length < 2) continue;
                let endColor = style.sign;
                if (route.coverage) {
                    // A section is covered if a sign is visible from both of its ends
                    for (let k = 0; k + 1 < route.points.length; k++) {
                        endColor = route.coverage[k] && route.coverage[k + 1] ? style.routeCovered : style.routeUncovered;
                        lines.push(...VisMapOverlay._band(route.points[k], route.points[k + 1], 0.17 * u, endColor));
                    }
                } else {
                    lines.push(...VisMapOverlay._dashes(waypoints, 0.45 * u, 0.3 * u, 0.09 * u, style.sign));
                }
                const start = waypoints[0], end = waypoints[waypoints.length - 1];
                markers.push(...VisMapOverlay._disc(start, 0.24 * u, style.startPointFace));
                markers.push(...VisMapOverlay._disc(start, 0.24 * u, style.startPointEdge, 0.19 * u));
                markers.push(VisMapOverlay._head(waypoints[waypoints.length - 2], end, 0.34 * u, endColor));
                if (!route.coverage) {
                    const at = this._namePosition(waypoints, occupied);
                    occupied.push(at);
                    this._label(this.routeGroup, route.id, style.sign, at, 0.62 * u);
                }
            }
            if (lines.length) this._flatMesh(this.routeGroup, lines, 105);
            if (markers.length) this._flatMesh(this.routeGroup, markers, 110);
        }

        // An arrow head centred on the end of a route, pointing along its last section.
        static _head(from, to, size, color) {
            const dx = to[0] - from[0], dy = to[1] - from[1], length = Math.hypot(dx, dy) || 1;
            const ax = dx / length, ay = dy / length;
            const at = (a, b) => [to[0] + a * ax - b * ay, to[1] + a * ay + b * ax];
            return { points: [at(size, 0), at(-size / 2, size * 0.8), at(-size / 2, -size * 0.8)], color };
        }

        // A dashed line along the waypoints; the dashes run on across the corners.
        static _dashes(waypoints, dash, gap, width, color) {
            const triangles = [], period = dash + gap;
            let travelled = 0;  // length of the route before the current section
            for (let k = 0; k + 1 < waypoints.length; k++) {
                const p = waypoints[k], q = waypoints[k + 1];
                const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
                if (!(length > 0)) continue;
                const at = s => [p[0] + (q[0] - p[0]) * s / length, p[1] + (q[1] - p[1]) * s / length];
                // The dashes from n * period on that reach into this section
                for (let n = Math.floor(travelled / period); n * period < travelled + length; n++) {
                    const from = Math.max(n * period - travelled, 0);
                    const to = Math.min(n * period + dash - travelled, length);
                    if (to > from) triangles.push(...VisMapOverlay._band(at(from), at(to), width, color));
                }
                travelled += length;
            }
            return triangles;
        }

        // Where the name of a route is written: along its sections, the
        // longest one first, at the first place that keeps clear of the
        // signs and of the names placed before.
        _namePosition(waypoints, occupied) {
            const sections = [];
            for (let k = 0; k + 1 < waypoints.length; k++) {
                sections.push({ k, length: Math.hypot(waypoints[k + 1][0] - waypoints[k][0], waypoints[k + 1][1] - waypoints[k][1]) });
            }
            sections.sort((a, b) => b.length - a.length);
            const clearance = Math.max(1.3 * this.markerSize, 0.6);
            let first = null;
            for (const { k } of sections) {
                for (const share of [0.5, 0.25, 0.75]) {
                    const at = [waypoints[k][0] + (waypoints[k + 1][0] - waypoints[k][0]) * share,
                        waypoints[k][1] + (waypoints[k + 1][1] - waypoints[k][1]) * share];
                    if (!first) first = at;
                    if (occupied.every(o => Math.hypot(o[0] - at[0], o[1] - at[1]) > clearance)) return at;
                }
            }
            return first;
        }

        // ── Manual obstructions and holes ─────────────────────────────────
        /** Show the rectangles of add_visual_obstruction / add_visual_hole as
         *  3D markers: obstructions as amber boxes rising from the floor to
         *  the evaluation height, holes as cyan outline slabs around it.
         *  Toggleable via the "Visual obst." layer checkbox (viewer layer
         *  'vismapRegions'). `regions` is [{ type: 'obstruction'|'hole',
         *  x1, x2, y1, y2 }] in FDS coordinates. */
        setRegions(regions, height) {
            this._clear(this.regionGroup);
            const layerOn = !this.scene.userData || this.scene.userData.vismapRegionsVisible !== false;
            for (const r of regions || []) {
                const w = Math.abs(r.x2 - r.x1), d = Math.abs(r.y2 - r.y1);
                if (!(w > 0) || !(d > 0)) continue;
                let mesh;
                if (r.type === 'hole') {
                    const box = new THREE.BoxGeometry(w, 0.5, d);
                    mesh = new THREE.LineSegments(new THREE.EdgesGeometry(box),
                        new THREE.LineBasicMaterial({ color: 0x27c3ff, depthTest: false }));
                    box.dispose();
                    mesh.position.y = height;
                } else {
                    // Amber, so manual obstructions stand apart from the gray FDS OBST geometry
                    const boxHeight = height + 0.05;
                    mesh = new THREE.Mesh(new THREE.BoxGeometry(w, boxHeight, d),
                        new THREE.MeshBasicMaterial({ color: 0xd98e2b, transparent: true, opacity: 0.6 }));
                    mesh.position.y = boxHeight / 2;
                }
                mesh.position.x = (r.x1 + r.x2) / 2;
                mesh.position.z = -(r.y1 + r.y2) / 2;
                mesh.renderOrder = 95;
                mesh._isVisualRegion = true;
                mesh.visible = layerOn;
                this.regionGroup.add(mesh);
            }
        }
    }

    // ── Public API ────────────────────────────────────────────────────────
    global.VisMapOverlay = VisMapOverlay;
})(window);
