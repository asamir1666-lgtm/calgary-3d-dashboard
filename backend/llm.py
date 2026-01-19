"""LLM parsing for natural language queries -> deterministic filter JSON.

The assignment wants an LLM, but the rest of the system should be reliable.
So we:
- Ask the LLM to output STRICT JSON.
- Extract the first JSON object from the text.
- Validate/normalize fields.
- Provide a lightweight regex fallback if the LLM fails.

Return format (always):
{
  "attribute": "height" | "zoning" | "assessed_value" | "address" | <any> ,
  "operator": ">" | "<" | "==" | "contains",
  "value": <number|string>
}
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, Optional

import requests


HF_MODEL = os.getenv("HF_MODEL", "mistralai/Mistral-7B-Instruct-v0.2")
HF_API = f"https://api-inference.huggingface.co/models/{HF_MODEL}"


def _hf_headers() -> Dict[str, str]:
    key = os.getenv("HF_API_KEY", "").strip()
    return {"Authorization": f"Bearer {key}"} if key else {}


def _extract_json_object(text: str) -> Optional[Dict[str, Any]]:
    # Find the first {...} block and try to parse it.
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return None
    blob = m.group(0)
    try:
        return json.loads(blob)
    except Exception:
        # Sometimes the model returns single quotes; attempt a conservative fix.
        try:
            blob2 = blob.replace("'", '"')
            return json.loads(blob2)
        except Exception:
            return None


def _normalize_filter(f: Dict[str, Any]) -> Dict[str, Any]:
    attr = str(f.get("attribute", "")).strip().lower()
    op = str(f.get("operator", "")).strip()
    val = f.get("value")

    # Common synonyms
    if attr in {"building height", "bldg_height", "bldgheight", "height_m", "height"}:
        attr = "height"
    if attr in {"zone", "zoning_type", "zoning"}:
        attr = "zoning"
    if attr in {"assessed", "assessment", "assessedvalue", "assessed_value", "value", "price"}:
        attr = "assessed_value"

    # Operator normalization
    if op in {">=", "=>"}:
        op = ">"
    if op in {"<=", "=<"}:
        op = "<"
    if op in {"=", "eq"}:
        op = "=="
    if op.lower() in {"contains", "include", "includes"}:
        op = "contains"

    # Value normalization
    if isinstance(val, str):
        v = val.strip().replace(",", "")
        # Numbers like "500k" or "$500,000"
        v = v.replace("$", "")
        m = re.fullmatch(r"(\d+(?:\.\d+)?)k", v.lower())
        if m:
            val = float(m.group(1)) * 1000
        else:
            try:
                # If it's numeric, cast
                if re.fullmatch(r"\d+(?:\.\d+)?", v):
                    val = float(v)
            except Exception:
                pass

    if not attr:
        attr = "height"  # safe default
    if op not in {">", "<", "==", "contains"}:
        op = "=="

    return {"attribute": attr, "operator": op, "value": val}


def _regex_fallback(text: str) -> Dict[str, Any]:
    t = text.lower()

    # Height
    m = re.search(r"(over|greater than|>|above)\s*(\d+(?:\.\d+)?)", t)
    if "height" in t and m:
        return {"attribute": "height", "operator": ">", "value": float(m.group(2))}
    m = re.search(r"(under|less than|<|below)\s*(\d+(?:\.\d+)?)", t)
    if "height" in t and m:
        return {"attribute": "height", "operator": "<", "value": float(m.group(2))}

    # Assessed value
    if "$" in t or "value" in t or "assess" in t:
        m = re.search(r"(over|greater than|>|above)\s*\$?([\d,]+)", t)
        if m:
            return {"attribute": "assessed_value", "operator": ">", "value": float(m.group(2).replace(",", ""))}
        m = re.search(r"(under|less than|<|below)\s*\$?([\d,]+)", t)
        if m:
            return {"attribute": "assessed_value", "operator": "<", "value": float(m.group(2).replace(",", ""))}

    # Zoning (RC-G etc.)
    m = re.search(r"\b([a-z]{1,3}-?[a-z]{0,3})\b", text, flags=re.IGNORECASE)
    if "zoning" in t or "zone" in t:
        if m:
            return {"attribute": "zoning", "operator": "contains", "value": m.group(1).upper()}

    # Commercial/residential keywords
    if "commercial" in t:
        return {"attribute": "zoning", "operator": "contains", "value": "C"}
    if "residential" in t:
        return {"attribute": "zoning", "operator": "contains", "value": "R"}

    # Default: no-op filter
    return {"attribute": "height", "operator": ">", "value": 0}


def parse_query(user_text: str) -> Dict[str, Any]:
    user_text = (user_text or "").strip()
    if not user_text:
        return {"attribute": "height", "operator": ">", "value": 0}

    # If HF key missing, fallback to regex
    if not os.getenv("HF_API_KEY"):
        return _regex_fallback(user_text)

    # Prompt intentionally mirrors the assignment spec:
    # "Extract the filter from this query: {user_input}. Return a JSON object with
    #  'attribute', 'operator', and 'value'."
    prompt = (
        "Extract the filter from this query: "
        f"{user_text}\n\n"
        "Return a JSON object with:\n"
        "- attribute (e.g., height, zoning, assessed_value, address)\n"
        "- operator (one of: >, <, ==, contains)\n"
        "- value (number or string)\n\n"
        "Return ONLY JSON (no markdown).\n"
        "Example: {\"attribute\":\"height\",\"operator\":\">\",\"value\":100}"
    )

    try:
        r = requests.post(
            HF_API,
            headers=_hf_headers(),
            json={"inputs": prompt, "parameters": {"max_new_tokens": 120, "temperature": 0.2}},
            timeout=45,
        )
        r.raise_for_status()
        data = r.json()

        # HF returns list of {generated_text: ...} for text-generation models
        generated = ""
        if isinstance(data, list) and data:
            generated = data[0].get("generated_text", "")
        elif isinstance(data, dict):
            generated = data.get("generated_text", "") or data.get("error", "")

        f = _extract_json_object(generated)
        if not f:
            # Some models echo the prompt; try extracting from full content
            f = _extract_json_object(str(data))
        if not f:
            return _regex_fallback(user_text)

        normalized = _normalize_filter(f)

        # Unit handling: if the user explicitly asked for feet/ft and the filter is height,
        # convert to meters (dataset heights are treated as meters across the app).
        try:
            if normalized.get("attribute") == "height":
                t = user_text.lower()
                if " feet" in t or "foot" in t or " ft" in t or t.endswith("ft"):
                    v = normalized.get("value")
                    if isinstance(v, (int, float)):
                        normalized["value"] = float(v) * 0.3048
        except Exception:
            pass

        return normalized
    except Exception:
        return _regex_fallback(user_text)
