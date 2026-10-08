"""Reference results of fdsvismap for tests/vismap.test.mjs.

The scenes below are evaluated with the Python package and written to
vismap-golden.json, where the test replays them with js/vismap.js and expects
the same maps, cell by cell. Run it with the fdsvismap release that
js/vismap.js is a port of:

    python tests/fixtures/make-vismap-golden.py

None of the scenes needs an FDS simulation. The smoke of a scene is either
uniform (set_uniform_extco) or a field given by a formula of the cell indices
whose values are sums of powers of two, so that Python and JavaScript get
exactly the same numbers without storing them. Maps are written as hex digits
with run lengths, see pack() and runs().
"""

import itertools
import json
import zlib
from pathlib import Path

import numpy as np
from skimage.draw import line, line_aa

from fdsvismap import VisMap

FDSVISMAP_VERSION = "0.3.2"


def field_value(i, j, t, a, b):
    """Extinction coefficient of cell (i, j) at time index t, mirrored by fieldValue() in the test."""
    return t * ((a * i + b * j) % 32) / 256 + ((7 * i + 13 * j + 3 * t) % 11) / 64


class FieldVisMap(VisMap):
    """A VisMap whose extinction field is given per time point instead of read from a slice."""

    _field_frames = None

    def set_field(self, times, a, b, nan_block=None):
        nx, ny = self.fds_grid_shape
        self._field_times = np.asarray(times, dtype=float)
        self._field_frames = []
        for t in range(len(times)):
            frame = np.array([[field_value(i, j, t, a, b) for j in range(ny)] for i in range(nx)], dtype=float)
            if nan_block:
                i0, i1, j0, j1 = nan_block
                frame[i0:i1, j0:j1] = np.nan
            self._field_frames.append(frame)

    def get_extco_array_at_time(self, time):
        if self._field_frames is None:
            return super().get_extco_array_at_time(time)
        return self._field_frames[int(np.abs(self._field_times - time).argmin())]


def axis(first, step, count):
    """Cell centres of one axis, mirrored by axis() in the test."""
    return [first + index * step for index in range(count)]


SCENES = [
    {
        "name": "room in clear air",
        "x": [0.25, 0.5, 40],
        "y": [0.25, 0.5, 20],
        "visual": [["obstruction", 9.5, 10.5, 0.0, 4.0], ["obstruction", 2.0, 6.0, 6.0, 6.5], ["hole", 3.0, 4.0, 6.0, 6.5]],
        "signs": [["omni", 18.0, 5.0, 3, None], [1, 10.0, 9.0, 3, 180], [2, 0.5, 2.25, 8, 90], ["tilted", 14.0, 1.0, 3, 322.5]],
        "routes": [["west", [[1, 9], [4, 8], [8, 5], [12, 5]], [1, 2]], ["east", [[19, 1], [15, 3], [15, 3], [12, 5]], None]],
        "extco": 0.0,
        "times": [0.0],
    },
    {
        "name": "uniform smoke, visibility bounds, plain lines",
        "x": [0.25, 0.5, 40],
        "y": [0.25, 0.5, 20],
        "visual": [["obstruction", 9.5, 10.5, 0.0, 4.0]],
        "signs": [[1, 18.0, 5.0, 3, None], [2, 3.0, 8.0, 8, 135]],
        "routes": [["r", [[1, 1], [8, 8], [19, 9]], None]],
        "extco": 0.3,
        "times": [20.0, 0.0, 10.0, 10.0],
        "bounds": [2.0, 20.0],
        "compute": {"aa": False},
    },
    {
        "name": "smoke field over time, part of the time points",
        "x": [0.1, 0.2, 60],
        "y": [0.1, 0.2, 40],
        "height": 1.5,
        "visual": [["obstruction", 4.0, 4.2, 0.0, 5.0], ["obstruction", 4.0, 9.0, 5.0, 5.2], ["hole", 6.0, 7.0, 5.0, 5.2]],
        "signs": [["A", 2.0, 2.0, 3, 45], ["B", 8.4, 4.8, 3, 0], ["C", 11.0, 7.0, 8, 225], ["D", 6.5, 6.9, 3, "omni"]],
        "routes": [["lower", [[0.5, 0.5], [3.5, 6.0], [6.5, 6.0]], ["A", "D"]], ["upper", [[11.5, 0.5], [6.5, 4.0], [6.5, 7.5]], ["B", "C", "D"]]],
        "field": {"a": 3, "b": 5},
        "times": [0.0, 37.5, 75.0, 112.5, 150.0],
        "compute": {"t_max": 112.5},
        "limits": [75.0],
    },
    {
        "name": "smoke field with cells outside of every mesh, no view angle",
        "x": [0.1, 0.2, 60],
        "y": [0.1, 0.2, 40],
        "visual": [["obstruction", 4.0, 4.2, 0.0, 5.0]],
        "signs": [[10, 2.0, 2.0, 3, 45], [20, 9.0, 6.0, 3, 180]],
        "routes": [["r", [[0.5, 7.5], [11.5, 0.5]], None]],
        "field": {"a": 1, "b": 2, "nan_block": [40, 60, 0, 12]},
        "times": [0.0, 60.0, 120.0],
        "compute": {"view_angle": False},
    },
    {
        "name": "smoke field without obstructions",
        "x": [0.1, 0.2, 60],
        "y": [0.1, 0.2, 40],
        "visual": [["obstruction", 4.0, 4.2, 0.0, 5.0]],
        "signs": [[1, 2.0, 2.0, 3, 45], [2, 9.0, 6.0, 3, 180]],
        "routes": [],
        "field": {"a": 2, "b": 3},
        "times": [0.0, 60.0],
        "compute": {"obstructions": False},
    },
    {
        "name": "long sight lines",
        "x": [0.05, 0.1, 300],
        "y": [0.05, 0.1, 20],
        "visual": [["obstruction", 10.0, 10.2, 0.0, 1.2], ["obstruction", 20.0, 20.2, 0.8, 2.0]],
        "signs": [[1, 0.35, 1.05, 8, 90], [2, 29.5, 1.5, 8, None]],
        "routes": [["corridor", [[29.0, 0.4], [15.0, 1.0], [1.0, 1.0]], None]],
        "field": {"a": 1, "b": 1},
        "times": [0.0, 30.0],
        "bounds": [0.0, 60.0],
    },
    {
        "name": "coordinates in single precision, as fdsreader hands them over",
        "x": [0.1, 0.2, 100],
        "y": [0.1, 0.2, 50],
        "single": True,
        "visual": [["obstruction", 0.0, 9.8, 4.6, 4.8], ["hole", 8.0, 8.8, 4.6, 4.8], ["obstruction", 9.8, 10.0, 0.0, 10.0], ["hole", 9.8, 10.0, 3.4, 4.4], ["obstruction", 8.1, 8.5, 4.5, 4.9]],
        # On the faces between cells, where the closest cell is a tie in exact arithmetic. Without a viewing
        # direction: its factor is the one place where numpy 1 and numpy 2 round single precision differently.
        "signs": [[1, 8.4, 4.8, 3, None], [2, 9.8, 4.0, 3, None], [3, 17.0, 10.0, 8, None]],
        "routes": [["exit route", [[1, 9], [4, 7], [7, 5.5], [9.5, 4.2], [11, 4.2], [15, 6], [17, 9.5]], None]],
        "field": {"a": 3, "b": 1},
        "times": [0.0, 50.0, 100.0],
    },
]


def runs(text):
    """Write four or more equal characters in a row as the character and their number in braces."""
    return "".join(
        f"{char}{{{count}}}" if count > 3 else char * count
        for char, count in ((char, len(list(group))) for char, group in itertools.groupby(text))
    )


def pack(mask):
    """Boolean map as hex digits, four cells per digit, in the order of the (ny, nx) array."""
    bits = np.asarray(mask, dtype=bool).ravel()
    return runs(np.packbits(bits).tobytes().hex())


def floats(array):
    return [float(v) for v in np.asarray(array, dtype=float).ravel()]


def digits(times, time_points):
    """Times of an ASET evaluation as one base 36 digit per value, its position in the time points."""
    positions = {float(t): index for index, t in enumerate(time_points)}
    return runs("".join(np.base_repr(positions[float(t)], 36).lower() for t in np.asarray(times).ravel()))


def thinned(points):
    """Every k-th point of a route, so that a long route does not fill the file."""
    step = -(-len(points) // 40)
    return {"count": len(points), "every": step, "points": [[float(x), float(y)] for x, y in points[::step]]}


def build(scene):
    vis = FieldVisMap()
    vis.set_grid(axis(*scene["x"]), axis(*scene["y"]), scene.get("height", 2.0))
    if scene.get("single"):
        vis.all_x_coords = vis.all_x_coords.astype(np.float32)
        vis.all_y_coords = vis.all_y_coords.astype(np.float32)
    for kind, x1, x2, y1, y2 in scene["visual"]:
        (vis.add_visual_obstruction if kind == "obstruction" else vis.add_visual_hole)(x1, x2, y1, y2)
    for sign in scene["signs"]:
        vis.add_sign(*sign)
    for route_id, waypoints, signs in scene["routes"]:
        vis.add_route(route_id, waypoints, signs)
    if "field" in scene:
        vis.set_time_points(scene["times"])
        field = scene["field"]
        vis.set_field(list(vis.vismap_time_points), field["a"], field["b"], field.get("nan_block"))
    else:
        vis.set_uniform_extco(scene["extco"], scene["times"])
    if "bounds" in scene:
        vis.set_visibility_bounds(*scene["bounds"])
    return vis


def evaluate(scene):
    vis = build(scene)
    compute = scene.get("compute", {})
    vis.compute_all(**compute)
    t_max = compute.get("t_max")
    times = [float(t) for t in vis.vismap_time_points if t_max is None or t <= t_max]
    scopes = [None] + list(vis.all_route_dict)
    limits = [None] + scene.get("limits", [])
    nx, ny = vis.fds_grid_shape

    expected = {
        "timePoints": floats(vis.vismap_time_points),
        "computedTimes": times,
        "obstructions": pack(vis.obstructions_array),
        "signVismaps": [[pack(vis.get_sign_vismap(sign_id, t)) for sign_id in vis.all_sign_dict] for t in times],
        "aggVismaps": [[pack(vis.get_agg_vismap(t, scope)) for scope in scopes] for t in times],
        "timeAggVismaps": [[pack(vis.get_time_agg_vismap(limit, scope)) for scope in scopes] for limit in limits],
        "asetMaps": [[digits(vis.get_aset_map(limit, scope), vis.vismap_time_points) for scope in scopes] for limit in limits],
        "routes": {},
        "probes": [],
    }
    for route_id in vis.all_route_dict:
        expected["routes"][route_id] = {
            "length": vis.all_route_dict[route_id].length,
            "points": thinned(vis.get_route_points(route_id)),
            "coverage": [runs("".join("1" if c else "0" for c in vis.get_route_coverage(route_id, t))) for t in times],
            "aset": [digits(vis.get_route_aset(route_id, limit), vis.vismap_time_points) for limit in limits],
        }
    # Local evaluations on a coarse raster of positions, also outside of the grid:
    # [time, x, y, sign, sign_is_visible, distance, visibility to the sign, local visibility]
    x_min, x_max = vis.all_x_coords[0], vis.all_x_coords[-1]
    y_min, y_max = vis.all_y_coords[0], vis.all_y_coords[-1]
    for px in np.linspace(x_min - 0.3, x_max + 0.3, 4):
        for py in np.linspace(y_min - 0.3, y_max + 0.3, 3):
            for t in (times[0], times[-1]):
                for sign_id in list(vis.all_sign_dict)[:2]:
                    expected["probes"].append([
                        t, float(px), float(py), sign_id,
                        bool(vis.sign_is_visible(t, px, py, sign_id)),
                        float(vis.get_distance_to_sign(px, py, sign_id)),
                        json_number(vis.get_visibility_to_sign(t, px, py, sign_id)),
                        json_number(vis.get_local_visibility(t, px, py, vis.all_sign_dict[sign_id].c)),
                    ])
    return {**scene, "expected": expected}


def json_number(value):
    """NaN has no JSON number."""
    return None if np.isnan(value) else float(value)


def line_checksums(size):
    """Checksums of all lines between the cells of a size x size grid, in the order scikit-image emits their cells."""
    plain, anti_aliased = 0, 0
    for r0 in range(size):
        for c0 in range(size):
            for r1 in range(size):
                for c1 in range(size):
                    rr, cc = line(r0, c0, r1, c1)
                    plain = zlib.crc32(np.stack([rr, cc], axis=1).astype("<i4").tobytes(), plain)
                    rr, cc, _ = line_aa(r0, c0, r1, c1)
                    anti_aliased = zlib.crc32(np.stack([rr, cc], axis=1).astype("<i4").tobytes(), anti_aliased)
    return {"size": size, "line": plain, "lineAA": anti_aliased}


def long_lines(count, size, seed):
    """A sample of long lines, where the single precision of scikit-image's anti-aliasing matters."""
    rng = np.random.default_rng(seed)
    ends = rng.integers(0, size, size=(count, 4))
    # Slopes just beside a full pixel per step, the hardest ones to rasterise
    ends[: count // 4, 2] = ends[: count // 4, 0] + rng.integers(-2, 3, size=count // 4)
    ends[: count // 4, 3] = (ends[: count // 4, 1] + size // 2) % size
    plain, anti_aliased = 0, 0
    for r0, c0, r1, c1 in ends.tolist():
        rr, cc = line(r0, c0, r1, c1)
        plain = zlib.crc32(np.stack([rr, cc], axis=1).astype("<i4").tobytes(), plain)
        rr, cc, _ = line_aa(r0, c0, r1, c1)
        anti_aliased = zlib.crc32(np.stack([rr, cc], axis=1).astype("<i4").tobytes(), anti_aliased)
    return {"ends": ends.tolist(), "line": plain, "lineAA": anti_aliased}


def reduceat_value(index):
    """A float that is exact in both languages and uses all of its bits, mirrored by reduceatValue() in the test."""
    return ((index * 2654435761) % 2**32) / 2**20 + ((index * 40503) % 2**16) / 2**36


def reduceat_sums():
    """np.add.reduceat over runs of every length up to 300, the way the extinction along the sight lines is summed."""
    lengths = list(range(1, 301))
    values = np.array([reduceat_value(index) for index in range(sum(lengths))])
    starts = np.concatenate([[0], np.cumsum(lengths)[:-1]])
    return {"lengths": lengths, "sums": floats(np.add.reduceat(values, starts))}


def main():
    golden = {
        "fdsvismap": FDSVISMAP_VERSION,
        "lines": line_checksums(11),
        "longLines": long_lines(400, 6000, seed=1),
        "reduceat": reduceat_sums(),
        "scenes": [evaluate(scene) for scene in SCENES],
    }
    target = Path(__file__).with_name("vismap-golden.json")
    target.write_text(json.dumps(golden, separators=(",", ":")) + "\n")
    print(f"{target}: {target.stat().st_size} bytes, {len(golden['scenes'])} scenes")


if __name__ == "__main__":
    main()
