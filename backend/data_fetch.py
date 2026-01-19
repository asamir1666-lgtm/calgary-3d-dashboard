"""Calgary Open Data fetch + normalization + joins (GeoJSON-first).

Meets requirements:
- Pull building footprints + height from Calgary Open Data.
- Restrict to ~5 blocks (WINDOW_METERS).
- Join zoning (Land Use Districts) and assessed value (assessment parcels) via centroid point-in-polygon.
- Return stable JSON for frontend (footprint_xy, height, zoning, assessed_value, etc.)
"""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Any, Dict, List, Optional, Tuple

import requests
from shapely.geometry import Point
from shapely.geometry import shape as shp_shape


# --- Calgary Open Data endpoints (Socrata GeoJSON) ---
BUILDINGS_URL = "https://data.calgary.ca/resource/cchr-krqg.geojson"  # 3D Buildings - Citywide
LAND_USE_URL = "https://data.calgary.ca/resource/qe6k-p9nh.geojson"   # Land Use Districts (zoning)
ASSESS_URL = "https://data.calgary.ca/resource/4bsw-nn7w.geojson"     # Assessment parcels (assessed values)


# Keep env vars for compatibility
DEFAULT_BBOX = {
    "south": float(os.getenv("BBOX_S", "51.046")),
    "west": float(os.getenv("BBOX_W", "-114.071")),
    "north": float(os.getenv("BBOX_N", "51.049")),
    "east": float(os.getenv("BBOX_E", "-114.065")),
}

FETCH_LIMIT = int(os.getenv("FETCH_LIMIT", "8000"))

# ✅ ~5 blocks window (projected meters)
WINDOW_METERS = float(os.getenv("WINDOW_METERS", "450"))

# These joins can be expensive; allow turning them off if needed
ENABLE_ZONING_JOIN = os.getenv("ENABLE_ZONING_JOIN", "1") == "1"
ENABLE_ASSESS_JOIN = os.getenv("ENABLE_ASSESS_JOIN", "1") == "1"

# Cap the number of zoning/assessment features loaded (safety)
LAND_USE_LIMIT = int(os.getenv("LAND_USE_LIMIT", "50000"))
ASSESS_LIMIT = int(os.getenv("ASSESS_LIMIT", "50000"))


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


def _fetch_geojson_features(url: str, limit: int) -> List[Dict[str, Any]]:
    r = requests.get(url, params={"$limit": limit}, timeout=120)
    r.raise_for_status()
    gj = r.json()
    feats = gj.get("features")
    if not isinstance(feats, list):
        raise RuntimeError(f"GeoJSON response from {url} missing 'features'.")
    return feats


def _choose_projected_window(building_features: List[Dict[str, Any]]) -> Dict[str, float]:
    """Pick a seed building with valid polygon, then define a WINDOW_METERS square around it."""
    half = WINDOW_METERS / 2.0
    for f in building_features:
        geom = f.get("geometry") or {}
        ring = _extract_ring_coords(geom)
        if ring and len(ring) >= 3:
            x0, y0 = float(ring[0][0]), float(ring[0][1])
            return {
                "min_x": x0 - half,
                "max_x": x0 + half,
                "min_y": y0 - half,
                "max_y": y0 + half,
            }
    raise RuntimeError("No valid building polygon geometries found.")


def _feature_bbox_xy(feat: Dict[str, Any]) -> Optional[Tuple[float, float, float, float]]:
    geom = feat.get("geometry")
    if not geom:
        return None
    ring = _extract_ring_coords(geom)
    if not ring or len(ring) < 3:
        return None
    return _bbox_of_ring(ring)


def _bbox_overlap(a: Tuple[float, float, float, float], b: Tuple[float, float, float, float]) -> bool:
    aminx, aminy, amaxx, amaxy = a
    bminx, bminy, bmaxx, bmaxy = b
    return not (amaxx < bminx or aminx > bmaxx or amaxy < bminy or aminy > bmaxy)


@lru_cache(maxsize=1)
def _load_land_use() -> List[Dict[str, Any]]:
    feats = _fetch_geojson_features(LAND_USE_URL, LAND_USE_LIMIT)
    # Precompute bbox for speed
    out = []
    for f in feats:
        bb = _feature_bbox_xy(f)
        if bb:
            f["_bbox"] = bb
            out.append(f)
    return out


@lru_cache(maxsize=1)
def _load_assess() -> List[Dict[str, Any]]:
    feats = _fetch_geojson_features(ASSESS_URL, ASSESS_LIMIT)
    out = []
    for f in feats:
        bb = _feature_bbox_xy(f)
        if bb:
            f["_bbox"] = bb
            out.append(f)
    return out


def _zoning_for_point(x: float, y: float, win_bbox: Tuple[float, float, float, float]) -> Optional[str]:
    """Return zoning code for a point using Land Use polygons."""
    p = Point(x, y)
    for f in _load_land_use():
        bb = f.get("_bbox")
        if not bb or not _bbox_overlap(bb, win_bbox):
            continue

        geom = f.get("geometry")
        props = f.get("properties") or {}
        if not geom:
            continue

        poly = shp_shape(geom)
        if poly.contains(p):
            # Try common field names (dataset may vary)
            return (
                props.get("land_use_district")
                or props.get("district")
                or props.get("lu_district")
                or props.get("code")
                or props.get("lud")
            )
    return None


def _assessed_value_for_point(x: float, y: float, win_bbox: Tuple[float, float, float, float]) -> Optional[float]:
    """Return assessed value for a point using assessment parcels."""
    p = Point(x, y)
    for f in _load_assess():
        bb = f.get("_bbox")
        if not bb or not _bbox_overlap(bb, win_bbox):
            continue

        geom = f.get("geometry")
        props = f.get("properties") or {}
        if not geom:
            continue

        poly = shp_shape(geom)
        if poly.contains(p):
            return (
                _as_float(props.get("assessed_value"))
                or _as_float(props.get("assessment"))
                or _as_float(props.get("total_assessed_value"))
                or _as_float(props.get("value"))
            )
    return None


def fetch_buildings(bbox: Dict[str, float] | None = None, limit: int = 200) -> Dict[str, Any]:
    bbox = bbox or DEFAULT_BBOX

    building_features = _fetch_geojson_features(BUILDINGS_URL, FETCH_LIMIT)

    # Choose a contiguous ~5-block window in projected meters
    win = _choose_projected_window(building_features)
    origin_x = (win["min_x"] + win["max_x"]) / 2.0
    origin_y = (win["min_y"] + win["max_y"]) / 2.0
    win_bbox = (win["min_x"], win["min_y"], win["max_x"], win["max_y"])

    buildings: List[Dict[str, Any]] = []

    for idx, f in enumerate(building_features):
        geom = f.get("geometry") or {}
        props = f.get("properties") or {}

        ring = _extract_ring_coords(geom)
        if not ring or len(ring) < 3:
            continue

        if not _intersects_window(ring, win):
            continue

        # Footprint (projected coords)
        footprint_ll = [[float(p[0]), float(p[1])] for p in ring]

        # Centroid (simple average is OK for small polygons; fast)
        xs = [p[0] for p in footprint_ll]
        ys = [p[1] for p in footprint_ll]
        cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)

        # Height
        height = (
            _as_float(props.get("height"))
            or _as_float(props.get("bldg_height"))
            or _as_float(props.get("building_height"))
            or _as_float(props.get("max_height"))
            or 10.0
        )

        # Base fields (may be missing in building dataset)
        zoning = props.get("zoning") or props.get("land_use") or props.get("zone")
        address = props.get("address") or props.get("street_address") or props.get("full_address")
        assessed_value = (
            _as_float(props.get("assessed_value"))
            or _as_float(props.get("assessment"))
            or _as_float(props.get("value"))
        )

        # ✅ Join zoning + assessed value using real Calgary datasets
        if ENABLE_ZONING_JOIN:
            zoning = _zoning_for_point(cx, cy, win_bbox) or zoning

        if ENABLE_ASSESS_JOIN:
            assessed_value = _assessed_value_for_point(cx, cy, win_bbox) or assessed_value

        # Centered coords for Three.js
        footprint_xy = [[p[0] - origin_x, p[1] - origin_y] for p in footprint_ll]

        buildings.append(
            {
                "id": props.get("id") or props.get("objectid") or props.get("globalid") or f"b{idx}",
                "height": height,
                "zoning": zoning,
                "assessed_value": assessed_value,
                "address": address,
                "footprint_ll": footprint_ll,   # raw projected coords
                "footprint_xy": footprint_xy,   # centered for Three.js
                "properties": props,            # raw record for popup
            }
        )

        if len(buildings) >= limit:
            break

    if not buildings:
        raise RuntimeError("0 buildings after filtering. Increase FETCH_LIMIT or WINDOW_METERS.")

    return {
        "bbox": bbox,
        "projection": {"coord_system": "projected_meters", "origin_x": origin_x, "origin_y": origin_y},
        "window_meters": win,
        "area_m2": WINDOW_METERS * WINDOW_METERS,
        "count": len(buildings),
        "buildings": buildings,
    }
