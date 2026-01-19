"""Calgary Open Data fetch + normalization.

Robust for Socrata geometry:
- Some Calgary datasets store geometry in projected meters (not lon/lat).
- within_box() may be rejected for some geometry columns.
- We fetch a batch, detect coord system, then choose a 3–4 block window automatically.

Output:
- buildings[] with footprint_xy ready for Three.js
- properties retained for popups
"""

from __future__ import annotations

import math
import os
from typing import Any, Dict, List, Tuple

import requests


SOCRATA_URL = "https://data.calgary.ca/resource/cchr-krqg.json"

# User-provided bbox (works only if dataset is lon/lat). Keep it, but we may ignore it.
DEFAULT_BBOX = {
    "south": float(os.getenv("BBOX_S", "51.046")),
    "west": float(os.getenv("BBOX_W", "-114.071")),
    "north": float(os.getenv("BBOX_N", "51.049")),
    "east": float(os.getenv("BBOX_E", "-114.065")),
}

# How many records to fetch when server-side filtering fails / is unusable
FALLBACK_LIMIT = int(os.getenv("FALLBACK_LIMIT", "5000"))

# Approx “3–4 blocks” window size (meters) if dataset uses projected coordinates
WINDOW_METERS = float(os.getenv("WINDOW_METERS", "600"))  # 600m ~ several city blocks


def _first_geom(record: Dict[str, Any]) -> Dict[str, Any] | None:
    return record.get("the_geom") or record.get("geom")


def _as_float(v: Any) -> float | None:
    try:
        if v is None:
            return None
        return float(v)
    except Exception:
        return None


def _project_lonlat_to_xy(
    lon: float,
    lat: float,
    lon0: float,
    lat0: float,
) -> Tuple[float, float]:
    """Approx lon/lat -> local meters (good enough for a few city blocks)."""
    meters_per_deg_lat = 111_320.0
    meters_per_deg_lon = 111_320.0 * math.cos(math.radians(lat0))
    x = (lon - lon0) * meters_per_deg_lon
    y = (lat - lat0) * meters_per_deg_lat
    return x, y


def _extract_ring_coords(geom: Dict[str, Any]) -> List[List[float]] | None:
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


def _looks_like_lonlat(ring: List[List[float]]) -> bool:
    """
    Heuristic: lon/lat values are usually within [-180..180], [-90..90].
    Projected meters will be way larger (thousands/millions).
    """
    if not ring:
        return False
    x0, y0 = ring[0][0], ring[0][1]
    return (abs(x0) <= 180.0) and (abs(y0) <= 90.0)


def _ring_intersects_bbox_lonlat(ring: List[List[float]], bbox: Dict[str, float]) -> bool:
    lons = [p[0] for p in ring]
    lats = [p[1] for p in ring]
    if not lons or not lats:
        return False
    min_lon, max_lon = min(lons), max(lons)
    min_lat, max_lat = min(lats), max(lats)
    return not (
        max_lon < bbox["west"]
        or min_lon > bbox["east"]
        or max_lat < bbox["south"]
        or min_lat > bbox["north"]
    )


def _ring_intersects_window_xy(ring: List[List[float]], win: Dict[str, float]) -> bool:
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    if not xs or not ys:
        return False
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    return not (
        max_x < win["min_x"]
        or min_x > win["max_x"]
        or max_y < win["min_y"]
        or min_y > win["max_y"]
    )


def _fetch_batch() -> List[Dict[str, Any]]:
    r = requests.get(SOCRATA_URL, params={"$limit": FALLBACK_LIMIT}, timeout=60)
    r.raise_for_status()
    data = r.json()
    if not isinstance(data, list):
        raise RuntimeError("Unexpected Socrata response shape (expected list).")
    return data


def _choose_projected_window(records: List[Dict[str, Any]]) -> Dict[str, float]:
    """
    Pick a seed building that has geometry, then create a WINDOW_METERS square around it.
    This gives a contiguous “few blocks” area regardless of coordinate system origin.
    """
    half = WINDOW_METERS / 2.0

    for rec in records:
        ring = _extract_ring_coords(_first_geom(rec) or {})
        if not ring or len(ring) < 3:
            continue

        # Use first point as a quick anchor
        x0, y0 = float(ring[0][0]), float(ring[0][1])
        return {"min_x": x0 - half, "max_x": x0 + half, "min_y": y0 - half, "max_y": y0 + half}

    raise RuntimeError("No valid geometries found in fetched batch.")


def fetch_buildings(bbox: Dict[str, float] | None = None, limit: int = 250) -> Dict[str, Any]:
    bbox = bbox or DEFAULT_BBOX

    raw = _fetch_batch()

    # Find first usable ring to detect coordinate type
    sample_ring = None
    for rec in raw:
        g = _first_geom(rec)
        ring = _extract_ring_coords(g) if g else None
        if ring and len(ring) >= 3:
            sample_ring = ring
            break

    if not sample_ring:
        raise RuntimeError("No valid building polygons returned from Calgary API.")

    is_lonlat = _looks_like_lonlat(sample_ring)

    # If projected coords, auto-select a contiguous window (3–4 blocks)
    projected_window = None
    if not is_lonlat:
        projected_window = _choose_projected_window(raw)

    # Projection anchor:
    # - for lon/lat, compute from bbox center
    # - for projected, use window center (and treat coords as already meters)
    if is_lonlat:
        lat0 = (bbox["south"] + bbox["north"]) / 2.0
        lon0 = (bbox["west"] + bbox["east"]) / 2.0
    else:
        lat0 = 0.0
        lon0 = 0.0

    buildings: List[Dict[str, Any]] = []
    for idx, rec in enumerate(raw):
        geom = _first_geom(rec)
        ring = _extract_ring_coords(geom) if geom else None
        if not ring or len(ring) < 3:
            continue

        # Filter to the target area
        if is_lonlat:
            if not _ring_intersects_bbox_lonlat(ring, bbox):
                continue
        else:
            if projected_window and not _ring_intersects_window_xy(ring, projected_window):
                continue

        height = (
            _as_float(rec.get("height"))
            or _as_float(rec.get("bldg_height"))
            or _as_float(rec.get("building_height"))
            or _as_float(rec.get("max_height"))
            or 10.0
        )

        zoning = rec.get("zoning") or rec.get("land_use") or rec.get("zone")
        address = rec.get("address") or rec.get("street_address") or rec.get("full_address")
        assessed_value = (
            _as_float(rec.get("assessed_value"))
            or _as_float(rec.get("assessment"))
            or _as_float(rec.get("value"))
        )

        # Footprints
        footprint_ll = [[float(p[0]), float(p[1])] for p in ring]

        if is_lonlat:
            footprint_xy = [list(_project_lonlat_to_xy(p[0], p[1], lon0, lat0)) for p in footprint_ll]
        else:
            # Already in meters (projected). Just normalize around first point to avoid huge coordinates in Three.js.
            x_ref, y_ref = footprint_ll[0][0], footprint_ll[0][1]
            footprint_xy = [[p[0] - x_ref, p[1] - y_ref] for p in footprint_ll]

        buildings.append(
            {
                "id": rec.get("id") or rec.get("objectid") or f"b{idx}",
                "height": height,
                "zoning": zoning,
                "assessed_value": assessed_value,
                "address": address,
                "footprint_ll": footprint_ll,
                "footprint_xy": footprint_xy,
                "properties": rec,
            }
        )

        if len(buildings) >= limit:
            break

    return {
        "bbox": bbox,
        "projection": {"lat0": lat0, "lon0": lon0, "coord_system": "lonlat" if is_lonlat else "projected_meters"},
        "window_meters": projected_window,
        "count": len(buildings),
        "buildings": buildings,
    }
