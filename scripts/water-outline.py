#!/usr/bin/env python3
"""Make web/ui/tiles/se-water.json: the lakes and the coastline the MAP tile draws faintly under
the county outlines (W-23c). Natural Earth 1:10m (public domain), clipped to Sweden (a lake with a
point inside a county of se-lan.json, a coast within about 10 km of one), simplified to about
200 m (W-30, W-33f; se-lan.json 250 m), small lakes dropped, coordinates to 3 decimals. Natural Earth
1:10m is the limit: unsimplified it is 8070 points (128 KB), so finer needs another source.

    curl -LO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_lakes.geojson
    curl -LO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_coastline.geojson
    python3 -I scripts/water-outline.py ne_10m_lakes.geojson ne_10m_coastline.geojson \
        web/ui/tiles/se-lan.json > web/ui/tiles/se-water.json
"""
import json
import sys

BOX = (10.0, 55.0, 24.5, 69.2)      # west, south, east, north: Sweden and the coasts beside it
TOLERANCE = 0.002                    # degrees, about 200 m (W-30, W-33f: at least twice W-23c's vertices)
MIN_LAKE = 0.004                     # square degrees: Vänern is about 1.3, Siljan 0.05


CELL = 0.1                           # degrees: the coast is kept within one cell of a county edge
SWEDEN = {"rings": [], "near": set()}


def load_sweden(path):
    with open(path) as f:
        geo = json.load(f)
    for feature in geo["features"]:
        g = feature["geometry"]
        for poly in ([g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]):
            SWEDEN["rings"].append(poly[0])
            for x, y in poly[0]:
                cx, cy = int(x // CELL), int(y // CELL)
                SWEDEN["near"].update((cx + i, cy + j) for i in (-1, 0, 1) for j in (-1, 0, 1))


def in_ring(p, ring):
    x, y, hit = p[0], p[1], False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def in_sweden(p):
    return any(in_ring(p, r) for r in SWEDEN["rings"])


def inside(p):
    """Near a county edge: the coast part that is Sweden's."""
    return (int(p[0] // CELL), int(p[1] // CELL)) in SWEDEN["near"]


def simplify(points, tol=TOLERANCE):
    """Douglas-Peucker, iterative."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = points[a], points[b]
        dx, dy = x2 - x1, y2 - y1
        norm = (dx * dx + dy * dy) ** 0.5
        best, at = -1.0, None
        for i in range(a + 1, b):
            x, y = points[i]
            d = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / norm if norm else ((x - x1) ** 2 + (y - y1) ** 2) ** 0.5
            if d > best:
                best, at = d, i
        if at is not None and best > tol:
            keep[at] = True
            stack += [(a, at), (at, b)]
    return [p for p, k in zip(points, keep) if k]


def rounded(points):
    out = []
    for x, y in points:
        p = [round(x, 3), round(y, 3)]
        if not out or out[-1] != p:
            out.append(p)
    return out


def area(ring):
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]))) / 2


def runs_inside(line):
    """The parts of a line inside the box, one point past each edge so a line reaches it."""
    out, cur = [], []
    for i, p in enumerate(line):
        if inside(p) or (i + 1 < len(line) and inside(line[i + 1])) or (cur and i > 0 and inside(line[i - 1])):
            cur.append(p)
        elif cur:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return [r for r in out if len(r) > 1]


def lakes(geo):
    polys = []
    for f in geo["features"]:
        g = f["geometry"]
        for poly in ([g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]):
            ring = poly[0]
            if area(ring) < MIN_LAKE or not any(BOX[0] <= x <= BOX[2] and BOX[1] <= y <= BOX[3] for x, y in ring):
                continue
            if not any(in_sweden(p) for p in ring[::max(1, len(ring) // 20)]):
                continue
            ring = rounded(simplify(ring))
            if len(ring) >= 4:
                polys.append([ring])
    return polys


def coast(geo):
    lines = []
    for f in geo["features"]:
        g = f["geometry"]
        for line in ([g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]):
            for part in runs_inside(line):
                part = rounded(simplify(part))
                if len(part) > 1:
                    lines.append(part)
    return lines


def main(lakes_path, coast_path, lan_path):
    load_sweden(lan_path)
    with open(lakes_path) as f:
        lake_geo = json.load(f)
    with open(coast_path) as f:
        coast_geo = json.load(f)
    out = {"type": "FeatureCollection",
           "source": "Natural Earth 1:10m lakes and coastline v5.1.2 (public domain), scripts/water-outline.py",
           "features": [
               {"type": "Feature", "properties": {"kind": "lake"}, "geometry": {"type": "MultiPolygon", "coordinates": lakes(lake_geo)}},
               {"type": "Feature", "properties": {"kind": "coast"}, "geometry": {"type": "MultiLineString", "coordinates": coast(coast_geo)}},
           ]}
    json.dump(out, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(*sys.argv[1:4])
