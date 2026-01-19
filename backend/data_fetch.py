"""Calgary Open Data fetch + normalization.

We keep this small but robust:
- Fetch building polygons for a 3-4 block bounding box.
- Normalize to a stable JSON shape for the frontend.
- Project lon/lat to local XY meters for Three.js.

If a field (height, zoning, etc.) is missing, we keep the raw properties
so the popup always has data.
"""

from __future__ import annotations

import math
import os
from typing import Any, Dict, List, Tuple

import requests


# City of Calgary Open Data (Socrata)
SOCRATA_URL = "https://data.calgary.ca/resource/cchr-krqg.json"

# Default downtown bbox (roughly 3-4 blocks). You can change these if you want.
DEFAULT_BBOX = {
    "south": float(os.getenv("BBOX_S", "51.046")),
    "west": float(os.getenv("BBOX_W", "-114.071")),
    "north": float(os.getenv("BBOX_N", "51.049")),
    "east": float(os.getenv("BBOX_E", "-114.065")),
}


def _first_geom(record: Dict[str, Any]) -> Dict[str, Any] | None:
    """Socrata datasets vary: some use 'geom', others 'the_geom'."""
    return record.get("geom") or record.get("the_geom")


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
    """Return outer ring [[lon,lat], ...] if Polygon or MultiPolygon."""
    if not geom:
        return None
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if not coords:
        return None

    # Polygon: [ [ [lon,lat], ... ] , [hole], ... ]
    if gtype == "Polygon":
        if isinstance(coords, list) and len(coords) > 0 and isinstance(coords[0], list):
            return coords[0]

    # MultiPolygon: [ [ [ [lon,lat]... ] ], [poly2], ... ]
    if gtype == "MultiPolygon":
        try:
            return coords[0][0]
        except Exception:
            return None

    return None


def fetch_buildings(bbox: Dict[str, float] | None = None, limit: int = 250) -> Dict[str, Any]:
    """Fetch and return normalized buildings + projection metadata."""
    bbox = bbox or DEFAULT_BBOX

    params = {
        "$limit": limit,
        "$where": (
            f"within_box(geom,{bbox['south']},{bbox['west']},{bbox['north']},{bbox['east']})"
        ),
    }
    r = requests.get(SOCRATA_URL, params=params, timeout=30)
    r.raise_for_status()
    raw = r.json()

    # Compute reference center for projection
    lat0 = (bbox["south"] + bbox["north"]) / 2.0
    lon0 = (bbox["west"] + bbox["east"]) / 2.0

    buildings: List[Dict[str, Any]] = []
    for idx, rec in enumerate(raw):
        geom = _first_geom(rec)
        ring = _extract_ring_coords(geom) if geom else None
        if not ring or len(ring) < 3:
            continue

        # Normalize height: accept several possible field names
        height = (
            _as_float(rec.get("height"))
            or _as_float(rec.get("bldg_height"))
            or _as_float(rec.get("building_height"))
            or _as_float(rec.get("max_height"))
            or 10.0
        )

        # Normalize zoning/value/address best-effort
        zoning = rec.get("zoning") or rec.get("land_use") or rec.get("zone")
        address = rec.get("address") or rec.get("street_address") or rec.get("full_address")
        assessed_value = (
            _as_float(rec.get("assessed_value"))
            or _as_float(rec.get("assessment"))
            or _as_float(rec.get("value"))
        )

        # Project footprint
        footprint_ll = [[float(p[0]), float(p[1])] for p in ring]
        footprint_xy = [list(_project_lonlat_to_xy(p[0], p[1], lon0, lat0)) for p in footprint_ll]

        buildings.append(
            {
                "id": rec.get("id") or rec.get("objectid") or f"b{idx}",
                "height": height,
                "zoning": zoning,
                "assessed_value": assessed_value,
                "address": address,
                "footprint_ll": footprint_ll,
                "footprint_xy": footprint_xy,
                "properties": rec,  # keep raw so popup always has data
            }
        )

    return {
        "bbox": bbox,
        "projection": {"lat0": lat0, "lon0": lon0},
        "count": len(buildings),
        "buildings": buildings,
    }
