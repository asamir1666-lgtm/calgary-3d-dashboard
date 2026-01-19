"""Calgary Open Data fetch + normalization (GeoJSON-first, reliable).

Why this version:
- Some Socrata datasets do NOT include polygon geometry in the plain .json rows.
- The Socrata GeoJSON endpoint reliably includes geometry in features[].geometry.  :contentReference[oaicite:2]{index=2}
- Calgary "3D Buildings - Citywide" uses projected coordinates (meters), not lon/lat. :contentReference[oaicite:3]{index=3}

What this returns:
{
  bbox, projection, window_meters, count,
  buildings: [{id,height,zoning,assessed_value,address,footprint_ll,footprint_xy,properties}]
}
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Tuple

import requests


# Use GeoJSON endpoint (most reliable geometry access)
SOCRATA_GEOJSON_URL = "https://data.calgary.ca/resource/cchr-krqg.geojson"

# Still keep these env vars for compatibility, but dataset is projected (meters)
DEFAULT_BBOX = {
    "south": float(os.getenv("BBOX_S", "51.046")),
    "west": float(os.getenv("BBOX_W", "-114.071")),
    "north": float(os.getenv("BBOX_N", "51.049")),
    "east": float(os.getenv("BBOX_E", "-114.065")),
}

# How many features to fetch from the GeoJSON endpoint
FETCH_LIMIT = int(os.getenv("FETCH_LIMIT", "8000"))

# Approx “3–4 blocks” window size in meters for projected datasets
WINDOW_METERS = float(os.getenv("WINDOW_METERS", "650"))


def _as_float(v: Any) -> Optional[float]:
    try:
        if v is None:
            return None
        return float(v)
    except Exception:
        return None


def _extract_ring_coords(geom: Dict[str, Any]) -> Optional[List[List[float]]]:
    """Return outer ring [[x,y], ...] from Polygon or MultiPolygon."""
    if not geom:
        return None
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if not coords:
        return None

    if gtype == "Polygon":
        try:
            return coords[0]
        except Exception:
            return None

    if gtype == "MultiPolygon":
        try:
            return coords[0][0]
        except Exception:
            return None

    return None


def _bbox_of_ring(ring: List[List[float]]) -> Tuple[float, float, float, float]:
    xs = [float(p[0]) for p in ring]
    ys = [float(p[1]) for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


def _intersects_window(ring: List[List[float]], win: Dict[str, float]) -> bool:
    minx, miny, maxx, maxy = _bbox_of_ring(ring)
    return not (
        maxx < win["min_x"]
        or minx > win["max_x"]
        or maxy < win["min_y"]
        or miny > win["max_y"]
    )


def _fetch_geojson_features() -> List[Dict[str, Any]]:
    params = {"$limit": FETCH_LIMIT}
    r = requests.get(SOCRATA_GEOJSON_URL, params=params, timeout=60)
    r.raise_for_status()
    gj = r.json()
    feats = gj.get("features")
    if not isinstance(feats, list):
        raise RuntimeError("GeoJSON response missing 'features' array.")
    return feats


def _choose_projected_window(features: List[Dict[str, Any]]) -> Dict[str, float]:
    """Pick a seed building with valid polygon, then define a WINDOW_METERS square around it."""
    half = WINDOW_METERS / 2.0
    for f in features:
        geom = f.get("geometry") or {}
        ring = _extract_ring_coords(geom)
        if ring and len(ring) >= 3:
            x0, y0 = float(ring[0][0]), float(ring[0][1])
            return {"min_x": x0 - half, "max_x": x0 + half, "min_y": y0 - half, "max_y": y0 + half}
    raise RuntimeError("No valid polygon geometries found in GeoJSON features.")


def fetch_buildings(bbox: Dict[str, float] | None = None, limit: int = 400) -> Dict[str, Any]:
    bbox = bbox or DEFAULT_BBOX

    features = _fetch_geojson_features()

    # This dataset is projected meters -> choose a contiguous “few blocks” window
    win = _choose_projected_window(features)
    origin_x = (win["min_x"] + win["max_x"]) / 2.0
    origin_y = (win["min_y"] + win["max_y"]) / 2.0

    buildings: List[Dict[str, Any]] = []
    for idx, f in enumerate(features):
        geom = f.get("geometry") or {}
        props = f.get("properties") or {}

        ring = _extract_ring_coords(geom)
        if not ring or len(ring) < 3:
            continue

        if not _intersects_window(ring, win):
            continue

        # best-effort fields (depend on dataset schema)
        height = (
            _as_float(props.get("height"))
            or _as_float(props.get("bldg_height"))
            or _as_float(props.get("building_height"))
            or _as_float(props.get("max_height"))
            or 10.0
        )
        zoning = props.get("zoning") or props.get("land_use") or props.get("zone")
        address = props.get("address") or props.get("street_address") or props.get("full_address")
        assessed_value = (
            _as_float(props.get("assessed_value"))
            or _as_float(props.get("assessment"))
            or _as_float(props.get("value"))
        )

        # In projected meters, geometry coords are already planar. Use a single shared origin:
        footprint_ll = [[float(p[0]), float(p[1])] for p in ring]
        footprint_xy = [[p[0] - origin_x, p[1] - origin_y] for p in footprint_ll]

        buildings.append(
            {
                "id": props.get("id") or props.get("objectid") or props.get("globalid") or f"b{idx}",
                "height": height,
                "zoning": zoning,
                "assessed_value": assessed_value,
                "address": address,
                "footprint_ll": footprint_ll,     # raw projected coords
                "footprint_xy": footprint_xy,     # centered for Three.js
                "properties": props,              # popup always has data
            }
        )

        if len(buildings) >= limit:
            break

    if not buildings:
        raise RuntimeError(
            "0 buildings after filtering. Increase FETCH_LIMIT or WINDOW_METERS."
        )

    return {
        "bbox": bbox,
        "projection": {"coord_system": "projected_meters", "origin_x": origin_x, "origin_y": origin_y},
        "window_meters": win,
        "count": len(buildings),
        "buildings": buildings,
    }
