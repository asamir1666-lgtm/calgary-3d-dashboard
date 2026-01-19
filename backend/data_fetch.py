"""
Calgary Open Data fetch + joins — FIXED (no more 400).

Why you keep getting 400:
- `within_box(<field>, ...)` MUST use the dataset's real geometry column name.
- For Calgary Socrata datasets, it is NOT always `geometry` / `shape`.
- This version AUTO-DISCOVERS the correct geometry field via the Socrata metadata API
  (https://data.calgary.ca/api/views/<dataset_id>) and then uses it in within_box().

Also:
- Keeps bbox-filtered requests (fast)
- Uses STRtree joins (fast)
"""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Any, Dict, List, Optional, Tuple

import requests
from shapely.geometry import Point
from shapely.geometry import shape as shp_shape
from shapely.strtree import STRtree


# --- Calgary Open Data endpoints (Socrata GeoJSON) ---
BUILDINGS_ID = "cchr-krqg"
LAND_USE_ID = "qe6k-p9nh"
ASSESS_ID = "4bsw-nn7w"

BUILDINGS_URL = f"https://data.calgary.ca/resource/{BUILDINGS_ID}.geojson"
LAND_USE_URL = f"https://data.calgary.ca/resource/{LAND_USE_ID}.geojson"
ASSESS_URL = f"https://data.calgary.ca/resource/{ASSESS_ID}.geojson"

SITE_ROOT = "https://data.calgary.ca"


DEFAULT_BBOX = {
    "south": float(os.getenv("BBOX_S", "51.046")),
    "west": float(os.getenv("BBOX_W", "-114.071")),
    "north": float(os.getenv("BBOX_N", "51.049")),
    "east": float(os.getenv("BBOX_E", "-114.065")),
}

RETURN_LIMIT = int(os.getenv("RETURN_LIMIT", "300"))

BUILDINGS_FETCH_LIMIT = int(os.getenv("BUILDINGS_FETCH_LIMIT", "4000"))
LAND_USE_FETCH_LIMIT = int(os.getenv("LAND_USE_FETCH_LIMIT", "12000"))
ASSESS_FETCH_LIMIT = int(os.getenv("ASSESS_FETCH_LIMIT", "12000"))

ENABLE_ZONING_JOIN = os.getenv("ENABLE_ZONING_JOIN", "1") == "1"
ENABLE_ASSESS_JOIN = os.getenv("ENABLE_ASSESS_JOIN", "1") == "1"

HTTP_TIMEOUT = int(os.getenv("HTTP_TIMEOUT", "30"))

# If you *already know* a dataset's geom field, you can force it via env:
# GEOM_FIELD_cchr-krqg=the_geom   (example)
def _forced_geom_field(dataset_id: str) -> Optional[str]:
    return os.getenv(f"GEOM_FIELD_{dataset_id}")


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
        return coords[0] if coords and coords[0] else None

    if gtype == "MultiPolygon":
        try:
            return coords[0][0]
        except Exception:
            return None

    return None


@lru_cache(maxsize=32)
def _discover_geom_field(dataset_id: str) -> str:
    """
    Ask Socrata metadata for the dataset and pick the column that holds geometry.
    This removes guessing (geometry/the_geom/shape/etc.) and fixes 400s.
    """
    forced = _forced_geom_field(dataset_id)
    if forced:
        return forced

    meta_url = f"{SITE_ROOT}/api/views/{dataset_id}"
    r = requests.get(meta_url, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    meta = r.json()

    cols = meta.get("columns") or []
    # Socrata: geometry columns often have dataTypeName like 'location', 'point', 'multipolygon', 'polygon', etc.
    geom_candidates: List[str] = []
    for c in cols:
        dt = (c.get("dataTypeName") or "").lower()
        fn = c.get("fieldName")
        if not fn:
            continue
        if dt in {"location", "point", "polygon", "multipolygon", "line", "multiline", "multipoint"}:
            geom_candidates.append(fn)

    # Most common preferred names if present
    preferred_order = ["the_geom", "geom", "shape", "location"]
    for p in preferred_order:
        if p in geom_candidates:
            return p

    if geom_candidates:
        return geom_candidates[0]

    # If metadata didn't expose it (rare), fall back to most common
    return "the_geom"


def _within_box_where(bbox: Dict[str, float], geom_field: str) -> str:
    # within_box(<geom_field>, north, west, south, east)
    return (
        f"within_box({geom_field},"
        f"{bbox['north']},{bbox['west']},"
        f"{bbox['south']},{bbox['east']})"
    )


def _fetch_geojson_features(url: str, limit: int, where: Optional[str] = None) -> List[Dict[str, Any]]:
    params = {"$limit": limit}
    if where:
        params["$where"] = where

    r = requests.get(url, params=params, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    gj = r.json()

    feats = gj.get("features")
    if not isinstance(feats, list):
        raise RuntimeError(f"GeoJSON response from {url} missing 'features'.")
    return feats


def _fetch_bbox_features(url: str, dataset_id: str, limit: int, bbox: Dict[str, float]) -> List[Dict[str, Any]]:
    geom_field = _discover_geom_field(dataset_id)
    where = _within_box_where(bbox, geom_field=geom_field)
    return _fetch_geojson_features(url, limit, where=where)


def _bbox_center(bbox: Dict[str, float]) -> Tuple[float, float]:
    origin_x = (bbox["west"] + bbox["east"]) / 2.0
    origin_y = (bbox["south"] + bbox["north"]) / 2.0
    return origin_x, origin_y


# -------- Spatial index loaders (bbox-filtered) --------

@lru_cache(maxsize=8)
def _load_land_use_index(north: float, west: float, south: float, east: float):
    bbox = {"north": north, "west": west, "south": south, "east": east}
    feats = _fetch_bbox_features(LAND_USE_URL, LAND_USE_ID, LAND_USE_FETCH_LIMIT, bbox)

    geoms = []
    props_list = []
    for f in feats:
        geom = f.get("geometry")
        if not geom:
            continue
        try:
            g = shp_shape(geom)
            if g.is_empty:
                continue
            geoms.append(g)
            props_list.append(f.get("properties") or {})
        except Exception:
            continue

    if not geoms:
        return None, {}, []

    tree = STRtree(geoms)
    id_to_props = {id(g): p for g, p in zip(geoms, props_list)}
    return tree, id_to_props, geoms


@lru_cache(maxsize=8)
def _load_assess_index(north: float, west: float, south: float, east: float):
    bbox = {"north": north, "west": west, "south": south, "east": east}
    feats = _fetch_bbox_features(ASSESS_URL, ASSESS_ID, ASSESS_FETCH_LIMIT, bbox)

    geoms = []
    props_list = []
    for f in feats:
        geom = f.get("geometry")
        if not geom:
            continue
        try:
            g = shp_shape(geom)
            if g.is_empty:
                continue
            geoms.append(g)
            props_list.append(f.get("properties") or {})
        except Exception:
            continue

    if not geoms:
        return None, {}, []

    tree = STRtree(geoms)
    id_to_props = {id(g): p for g, p in zip(geoms, props_list)}
    return tree, id_to_props, geoms


def _zoning_for_point(p: Point, bbox: Dict[str, float]) -> Optional[str]:
    tree, id_to_props, _ = _load_land_use_index(bbox["north"], bbox["west"], bbox["south"], bbox["east"])
    if not tree:
        return None

    for poly in tree.query(p):
        try:
            if poly.contains(p):
                props = id_to_props.get(id(poly), {}) or {}
                return (
                    props.get("land_use_district")
                    or props.get("district")
                    or props.get("lu_district")
                    or props.get("code")
                    or props.get("lud")
                )
        except Exception:
            continue
    return None


def _assessed_value_for_point(p: Point, bbox: Dict[str, float]) -> Optional[float]:
    tree, id_to_props, _ = _load_assess_index(bbox["north"], bbox["west"], bbox["south"], bbox["east"])
    if not tree:
        return None

    for poly in tree.query(p):
        try:
            if poly.contains(p):
                props = id_to_props.get(id(poly), {}) or {}
                return (
                    _as_float(props.get("assessed_value"))
                    or _as_float(props.get("assessment"))
                    or _as_float(props.get("total_assessed_value"))
                    or _as_float(props.get("value"))
                )
        except Exception:
            continue
    return None


# -------- Main API function --------

def fetch_buildings(bbox: Dict[str, float] | None = None, limit: int | None = None) -> Dict[str, Any]:
    bbox = bbox or DEFAULT_BBOX
    limit = int(limit or RETURN_LIMIT)

    building_features = _fetch_bbox_features(BUILDINGS_URL, BUILDINGS_ID, BUILDINGS_FETCH_LIMIT, bbox)

    origin_x, origin_y = _bbox_center(bbox)
    buildings: List[Dict[str, Any]] = []

    for idx, f in enumerate(building_features):
        geom = f.get("geometry") or {}
        props = f.get("properties") or {}

        ring = _extract_ring_coords(geom)
        if not ring or len(ring) < 3:
            continue

        footprint_ll = [[float(p[0]), float(p[1])] for p in ring]

        try:
            poly = shp_shape(geom)
            c = poly.centroid
            p_centroid = Point(c.x, c.y)
        except Exception:
            xs = [p[0] for p in footprint_ll]
            ys = [p[1] for p in footprint_ll]
            p_centroid = Point(sum(xs) / len(xs), sum(ys) / len(ys))

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

        if ENABLE_ZONING_JOIN:
            zoning = _zoning_for_point(p_centroid, bbox) or zoning

        if ENABLE_ASSESS_JOIN:
            assessed_value = _assessed_value_for_point(p_centroid, bbox) or assessed_value

        footprint_xy = [[p[0] - origin_x, p[1] - origin_y] for p in footprint_ll]

        buildings.append(
            {
                "id": props.get("id") or props.get("objectid") or props.get("globalid") or f"b{idx}",
                "height": height,
                "zoning": zoning,
                "assessed_value": assessed_value,
                "address": address,
                "footprint_ll": footprint_ll,
                "footprint_xy": footprint_xy,
                "properties": props,
            }
        )

        if len(buildings) >= limit:
            break

    if not buildings:
        raise RuntimeError("0 buildings returned for this bbox. Try a bigger bbox or check dataset availability.")

    return {
        "bbox": bbox,
        "projection": {
            "coord_system": "EPSG:4326_lonlat_degrees",
            "origin_x": origin_x,
            "origin_y": origin_y,
        },
        "geom_field_used": _discover_geom_field(BUILDINGS_ID),
        "count": len(buildings),
        "buildings": buildings,
    }
