from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from typing import Any, Dict, List, Optional, Tuple

import requests
from flask import Flask, jsonify, request
from flask_cors import CORS
from shapely.geometry import Point
from shapely.geometry import shape as shp_shape
from shapely.strtree import STRtree

"""
Backend for:
- /api/buildings
- /api/apply_filters
- /api/projects/<username>
- /api/save
- /api/load
- /api/nl_query   (simple working NL -> filter)

Fixes:
- building.id is ALWAYS a string
- matched_ids are ALWAYS strings
- /api/load ALWAYS returns matched_ids (computed if missing)
- selected_building_id saved/loaded
- projects persist to ./data/projects/<username>.json
"""

app = Flask(__name__)
CORS(app)

# -------------------- Calgary Open Data (Socrata) --------------------
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

DATA_DIR = os.path.join(os.getcwd(), "data")
PROJECTS_DIR = os.path.join(DATA_DIR, "projects")
os.makedirs(PROJECTS_DIR, exist_ok=True)


# -------------------- helpers --------------------
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
    forced = _forced_geom_field(dataset_id)
    if forced:
        return forced

    meta_url = f"{SITE_ROOT}/api/views/{dataset_id}"
    r = requests.get(meta_url, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    meta = r.json()

    cols = meta.get("columns") or []
    geom_candidates: List[str] = []
    for c in cols:
        dt = (c.get("dataTypeName") or "").lower()
        fn = c.get("fieldName")
        if not fn:
            continue
        if dt in {"location", "point", "polygon", "multipolygon", "line", "multiline", "multipoint"}:
            geom_candidates.append(fn)

    preferred_order = ["the_geom", "geom", "shape", "location"]
    for p in preferred_order:
        if p in geom_candidates:
            return p

    if geom_candidates:
        return geom_candidates[0]

    return "the_geom"


def _within_box_where(bbox: Dict[str, float], geom_field: str) -> str:
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


# -------- Main buildings function --------
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

        # ✅ CRITICAL FIX: IDs ALWAYS STRINGS
        bid = props.get("id") or props.get("objectid") or props.get("globalid") or f"b{idx}"
        bid = str(bid)

        buildings.append(
            {
                "id": bid,
                "height": float(height or 0),
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


# -------------------- Filter engine --------------------
def _get_attr(b: Dict[str, Any], attr: str) -> Any:
    # allow attribute access from top-level or properties dict
    if attr in b:
        return b.get(attr)
    props = b.get("properties") or {}
    return props.get(attr)


def _to_num(x: Any) -> Optional[float]:
    try:
        if x is None:
            return None
        if isinstance(x, (int, float)):
            return float(x)
        s = str(x).replace(",", "").strip()
        return float(s)
    except Exception:
        return None


def _match_one(b: Dict[str, Any], f: Dict[str, Any]) -> bool:
    attr = str(f.get("attribute") or "").strip()
    op = str(f.get("operator") or "").strip().lower()
    val = f.get("value")

    if not attr or not op:
        return True

    actual = _get_attr(b, attr)

    # normalize some common fields
    if attr in {"height", "assessed_value"}:
        a = _to_num(actual)
        v = _to_num(val)
        if a is None or v is None:
            return False
        if op in {">", "gt"}:
            return a > v
        if op in {">=", "gte"}:
            return a >= v
        if op in {"<", "lt"}:
            return a < v
        if op in {"<=", "lte"}:
            return a <= v
        if op in {"=", "==", "eq"}:
            return a == v
        if op in {"!=", "neq"}:
            return a != v
        return False

    # string ops
    a_str = "" if actual is None else str(actual)
    v_str = "" if val is None else str(val)

    if op in {"contains", "includes"}:
        return v_str.lower() in a_str.lower()
    if op in {"starts_with", "startswith"}:
        return a_str.lower().startswith(v_str.lower())
    if op in {"ends_with", "endswith"}:
        return a_str.lower().endswith(v_str.lower())
    if op in {"=", "==", "eq"}:
        return a_str.lower() == v_str.lower()
    if op in {"!=", "neq"}:
        return a_str.lower() != v_str.lower()

    return False


def compute_matched_ids(buildings: List[Dict[str, Any]], filters: List[Dict[str, Any]]) -> List[str]:
    if not filters:
        return []
    out: List[str] = []
    for b in buildings:
        ok = True
        for f in filters:
            if not _match_one(b, f):
                ok = False
                break
        if ok:
            out.append(str(b.get("id")))
    return out


# -------------------- Project persistence --------------------
def _safe_user(u: str) -> str:
    u = (u or "").strip().lower()
    u = re.sub(r"[^a-z0-9_\-\.]", "_", u)
    return u or "user"


def _project_path(username: str) -> str:
    return os.path.join(PROJECTS_DIR, f"{_safe_user(username)}.json")


def _load_user_projects(username: str) -> Dict[str, Any]:
    path = _project_path(username)
    if not os.path.exists(path):
        return {"projects": {}}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_user_projects(username: str, data: Dict[str, Any]) -> None:
    path = _project_path(username)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# -------------------- In-memory building cache --------------------
# Frontend calls /api/buildings first; we keep the latest payload here
LATEST_PAYLOAD: Optional[Dict[str, Any]] = None


def _ensure_latest_payload() -> Dict[str, Any]:
    global LATEST_PAYLOAD
    if LATEST_PAYLOAD and isinstance(LATEST_PAYLOAD.get("buildings"), list):
        return LATEST_PAYLOAD
    LATEST_PAYLOAD = fetch_buildings()
    return LATEST_PAYLOAD


# -------------------- API endpoints --------------------
@app.get("/api/health")
def health():
    return jsonify({"ok": True})


@app.get("/api/buildings")
def api_buildings():
    global LATEST_PAYLOAD
    bbox = request.args.get("bbox")
    limit = request.args.get("limit")

    # allow optional bbox JSON in query (?bbox={"north":...})
    use_bbox = None
    if bbox:
        try:
            use_bbox = json.loads(bbox)
        except Exception:
            use_bbox = None

    use_limit = None
    if limit:
        try:
            use_limit = int(limit)
        except Exception:
            use_limit = None

    payload = fetch_buildings(bbox=use_bbox, limit=use_limit)
    LATEST_PAYLOAD = payload
    return jsonify(payload)


@app.post("/api/apply_filters")
def api_apply_filters():
    payload = request.get_json(force=True, silent=True) or {}
    filters = payload.get("filters") or []
    latest = _ensure_latest_payload()
    buildings = latest.get("buildings") or []

    matched = compute_matched_ids(buildings, filters)
    return jsonify({"matched_ids": matched, "count": len(matched)})


@app.get("/api/projects/<username>")
def api_projects(username: str):
    data = _load_user_projects(username)
    projects = data.get("projects") or {}

    # return as list (frontend supports {projects: []} or [])
    out = []
    for name, p in projects.items():
        out.append(
            {
                "name": name,
                "filters": p.get("filters") or [],
                "selected_building_id": p.get("selected_building_id"),
                # optional: include matched_ids for previews
                "matched_ids": p.get("matched_ids") or [],
            }
        )

    # sort by name
    out.sort(key=lambda x: x.get("name", ""))
    return jsonify({"projects": out})


@app.post("/api/save")
def api_save():
    payload = request.get_json(force=True, silent=True) or {}
    username = str(payload.get("username") or "").strip()
    name = str(payload.get("name") or "").strip()

    if not username:
        return jsonify({"error": "username is required"}), 400
    if not name:
        return jsonify({"error": "name is required"}), 400

    filters = payload.get("filters") or []
    selected_building_id = payload.get("selected_building_id")
    if selected_building_id is not None:
        selected_building_id = str(selected_building_id)

    # Use backend truth for matched_ids (so load is always correct)
    latest = _ensure_latest_payload()
    buildings = latest.get("buildings") or []
    matched_ids = compute_matched_ids(buildings, filters)

    data = _load_user_projects(username)
    if "projects" not in data:
        data["projects"] = {}

    data["projects"][name] = {
        "name": name,
        "filters": filters,
        "matched_ids": matched_ids,  # ✅ always stored as strings
        "selected_building_id": selected_building_id,
    }

    _save_user_projects(username, data)
    return jsonify({"ok": True, "saved": name, "matched_count": len(matched_ids)})


@app.post("/api/load")
def api_load():
    payload = request.get_json(force=True, silent=True) or {}
    username = str(payload.get("username") or "").strip()
    name = str(payload.get("name") or "").strip()

    if not username:
        return jsonify({"error": "username is required"}), 400
    if not name:
        return jsonify({"error": "name is required"}), 400

    data = _load_user_projects(username)
    projects = data.get("projects") or {}
    proj = projects.get(name)

    if not proj:
        return jsonify({"error": "project not found"}), 404

    filters = proj.get("filters") or []
    selected_building_id = proj.get("selected_building_id")
    if selected_building_id is not None:
        selected_building_id = str(selected_building_id)

    # ✅ always return matched_ids (compute if missing)
    matched_ids = proj.get("matched_ids")
    if not isinstance(matched_ids, list):
        latest = _ensure_latest_payload()
        buildings = latest.get("buildings") or []
        matched_ids = compute_matched_ids(buildings, filters)

    matched_ids = [str(x) for x in matched_ids]

    return jsonify(
        {
            "name": name,
            "filters": filters,
            "matched_ids": matched_ids,
            "selected_building_id": selected_building_id,
        }
    )


# Simple NL -> filter so your UI works without an LLM
# Examples:
# "over 30" -> height > 30
# "less than 500000" -> assessed_value < 500000
# "zoning rc-g" -> zoning contains "RC-G"
# "address 10 ave" -> address contains "10 ave"
@app.post("/api/nl_query")
def api_nl_query():
    payload = request.get_json(force=True, silent=True) or {}
    q = str(payload.get("query") or "").strip()
    existing_filters = payload.get("existing_filters") or []

    if not q:
        return jsonify({"error": "query is required"}), 400

    ql = q.lower()

    # height
    m = re.search(r"(height|over)\s*(\d+(\.\d+)?)", ql)
    if "height" in ql or "over" in ql:
        m2 = re.search(r"(\d+(\.\d+)?)", ql)
        if m2 and ("over" in ql or "greater" in ql):
            v = float(m2.group(1))
            f = {"attribute": "height", "operator": ">", "value": v}
        elif m2 and ("under" in ql or "less" in ql):
            v = float(m2.group(1))
            f = {"attribute": "height", "operator": "<", "value": v}
        else:
            f = None
    else:
        f = None

    # assessed value
    if f is None and ("assessed" in ql or "value" in ql or "$" in ql or "cad" in ql):
        m3 = re.search(r"(\d[\d,]*)", ql)
        if m3:
            v = float(m3.group(1).replace(",", ""))
            if "less" in ql or "under" in ql or "<" in ql:
                f = {"attribute": "assessed_value", "operator": "<", "value": v}
            elif "more" in ql or "over" in ql or ">" in ql:
                f = {"attribute": "assessed_value", "operator": ">", "value": v}

    # zoning
    if f is None and "zoning" in ql:
        # take word after zoning
        m4 = re.search(r"zoning\s+([a-z0-9\-\_]+)", ql)
        if m4:
            z = m4.group(1)
            f = {"attribute": "zoning", "operator": "contains", "value": z}

    # address
    if f is None and "address" in ql:
        m5 = re.search(r"address\s+(.+)$", q, flags=re.IGNORECASE)
        if m5:
            s = m5.group(1).strip()
            if s:
                f = {"attribute": "address", "operator": "contains", "value": s}

    if f is None:
        return jsonify({"error": "Could not parse query. Try: 'over 30', 'value under 500000', 'zoning rc-g'."}), 400

    next_filters = list(existing_filters) + [f]

    latest = _ensure_latest_payload()
    buildings = latest.get("buildings") or []
    matched = compute_matched_ids(buildings, next_filters)

    return jsonify({"filter": f, "filters": next_filters, "matched_ids": matched, "count": len(matched)})


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=True)
