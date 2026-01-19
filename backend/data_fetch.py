"""Calgary Open Data fetch + normalization (robust).

- Fetch 3D building polygons from Calgary Open Data (Socrata).
- Normalize to stable JSON for frontend.
- Support geometry stored as:
  - different field names (the_geom, geom, multipolygon, shape, geometry)
  - dict OR JSON-string
- Works for projected coordinate datasets (meters), and uses a single shared origin
  so all buildings share the same XY coordinate space (better Three.js controls/selection).
"""

from __future__ import annotations

import json
import math
import os
from typing import Any, Dict, List, Tuple, Optional

import requests


SOCRATA_URL = "https://data.calgary.ca/resource/cchr-krqg.json"

# These lon/lat bbox env vars are kept for compatibility, but this dataset is often projected.
DEFAULT_BBOX = {
    "south": float(os.getenv("BBOX_S", "51.046")),
    "west": float(os.getenv("BBOX_W", "-114.071")),
    "north": float(os.getenv("BBOX_N", "51.049")),
    "east": float(os.getenv("BBOX_E", "-114.065")),
}

FALLBACK_LIMIT = int(os.getenv("FALLBACK_LIMIT", "8000"))

# ~3–4 blocks window if dataset is projected meters (tune if you want)
WINDOW_METERS = float(os.getenv("WINDOW_METERS", "650"))


def _as_float(v: Any) -> Optional[float]:
    try:
        if v is None:
            return None
        return float(v)
    except Exception:
        return None


def _project_lonlat_to_xy(lon: float, lat: float, lon0: float, lat0: float) -> Tuple[float, float]:
    meters_per_deg_lat = 111_320.0
    meters_per_deg_lon = 111_320.0 * math.cos(math.radians(lat0))
    x = (lon - lon0) * meters_per_deg_lon
    y = (lat - lat0) * meters_per_deg_lat
    return x, y


def _coerce_geom(value: Any) -> Optional[Dict[str, Any]]:
    """Accept dict OR JSON-string geometry."""
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        s = value.strip()
        # Sometimes Socrata returns geometry as a JSON string
        if (s.startswith("{") and s.endswith("}")) or (s.startswith("[") and s.endswith("]")):
            try:
                parsed = json.loads(s)
                return parsed if isinstance(parsed, dict) else None
            except Exception:
                return None
    return None


def _first_geom(record: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Try multiple common geometry keys, and coerce string->dict if needed."""
    for k in ("the_geom", "geom", "multipolygon", "shape", "geometry"):
        g = _coerce_geom(record.get(k))
        if g:
            return g
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

    # Some datasets may store as "Multipolygon" etc (case variants)
    if isinstance(gtype, str) and gtype.lower() == "multipolygon":
        try:
            return coords[0][0]
        except Exception:
            return None

    return None


def _looks_like_lonlat(ring: List[List[float]]) -> bool:
    """Heuristic: lon/lat ~ within [-180..180], [-90..90]. Projected meters are huge."""
    if not ring:
        return False
    x0, y0 = float(ring[0][0]), float(ring[0][1])
    return (abs(x0) <= 180.0) and (abs(y0) <= 90.0)


def _fetch_batch() -> List[Dict[str, Any]]:
    r = requests.get(SOCRATA_URL, params={"$limit": FALLBACK_LIMIT}, timeout=60)
    r.raise_for_status()
    data = r.json()
    if not isinstance(data, list):
        raise RuntimeError("Unexpected Socrata response shape (expected list).")
    return data


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


def _choose_projected_window(records: List[Dict[str, Any]]) -> Dict[str, float]:
    """Pick a seed building with valid polygon, then define a WINDOW_METERS square around it."""
    half = WINDOW_METERS / 2.0
    for rec in records:
        g = _first_geom(rec)
        ring = _extract_ring_coords(g) if g else None
        if ring and len(ring) >= 3:
            x0, y0 = float(ring[0][0]), float(ring[0][1])
            return {"min_x": x0 - half, "max_x": x0 + half, "min_y": y0 - half, "max_y": y0 + half}
    raise RuntimeError("No valid building polygons found in fetched batch (geometry missing/unreadable).")


def fetch_buildings(bbox: Dict[str, float] | None = None, limit: int = 400) -> Dict[str, Any]:
    """
    Returns:
      {
        bbox, projection, window_meters, count,
        buildings: [{id,height,zoning,assessed_value,address,footprint_ll,footprint_xy,properties}]
      }
    """
    bbox = bbox or DEFAULT_BBOX
    raw = _fetch_batch()

    # Find first usable polygon to detect coordinate system
    sample_ring = None
    for rec in raw:
        g = _first_geom(rec)
        ring = _extract_ring_coords(g) if g else None
        if ring and len(ring) >= 3:
            sample_ring = ring
            break

    if not sample_ring:
        raise RuntimeError(
            "No valid building polygons returned from Calgary API. "
            "Likely geometry field name differs OR geometry is not being included."
        )

    is_lonlat = _looks_like_lonlat(sample_ring)

    # Choose target area:
    # - If lon/lat: you can later re-enable a true lon/lat bbox filter if you want
    # - If projected: auto-pick a 3–4 block window
    projected_window = _choose_projected_window(raw) if not is_lonlat else None

    # Single shared origin for the whole scene
    if is_lonlat:
        lat0 = (bbox["south"] + bbox["north"]) / 2.0
        lon0 = (bbox["west"] + bbox["east"]) / 2.0
        origin_x, origin_y = 0.0, 0.0  # lon/lat projection uses lon0/lat0
    else:
        # origin = center of window in meters
        origin_x = (projected_window["min_x"] + projected_window["max_x"]) / 2.0
        origin_y = (projected_window["min_y"] + projected_window["max_y"]) / 2.0
        lat0, lon0 = 0.0, 0.0

    buildings: List[Dict[str, Any]] = []
    for idx, rec in enumerate(raw):
        g = _first_geom(rec)
        ring = _extract_ring_coords(g) if g else None
        if not ring or len(ring) < 3:
            continue

        # Filter to 3–4 blocks if projected
        if projected_window and not _intersects_window(ring, projected_window):
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

        footprint_ll = [[float(p[0]), float(p[1])] for p in ring]

        if is_lonlat:
            footprint_xy = [list(_project_lonlat_to_xy(p[0], p[1], lon0, lat0)) for p in footprint_ll]
        else:
            # Projected meters -> shared origin shift
            footprint_xy = [[p[0] - origin_x, p[1] - origin_y] for p in footprint_ll]

        buildings.append(
            {
                "id": rec.get("id") or rec.get("objectid") or rec.get("globalid") or f"b{idx}",
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

    if not buildings:
        raise RuntimeError(
            "0 buildings after filtering. Increase FALLBACK_LIMIT or WINDOW_METERS, "
            "or the dataset may not be returning geometry fields."
        )

    return {
        "bbox": bbox,
        "projection": {"lat0": lat0, "lon0": lon0, "coord_system": "lonlat" if is_lonlat else "projected_meters"},
        "window_meters": projected_window,
        "count": len(buildings),
        "buildings": buildings,
    }
