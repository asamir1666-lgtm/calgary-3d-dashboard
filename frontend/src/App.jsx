import React, { useEffect, useMemo, useRef, useState } from "react";
import ThreeMap from "./ThreeMap.jsx";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:5000";

function prettyFilter(f) {
  if (!f) return "";
  return `${f.attribute} ${f.operator} ${f.value}`;
}

function normalizeProjectsResponse(j) {
  if (Array.isArray(j)) return j;
  if (j && Array.isArray(j.projects)) return j.projects;
  return [];
}

function getProjectName(p) {
  if (!p) return "";
  if (typeof p === "string") return p;
  return p.name || p.project_name || p.title || "";
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [payload, setPayload] = useState(null);

  const [username, setUsername] = useState("ali");
  const [projectName, setProjectName] = useState("");
  const [projects, setProjects] = useState([]);

  const [nlQuery, setNlQuery] = useState("");
  const [filters, setFilters] = useState([]);
  const [history, setHistory] = useState([]);
  const [matchedIds, setMatchedIds] = useState(new Set());

  // ✅ NEW: store selected building
  const [selectedBuildingId, setSelectedBuildingId] = useState(null);

  // ✅ NEW: force map remount to "refresh"
  const [mapKey, setMapKey] = useState(0);

  const skipNextApplyRef = useRef(false);

  const buildings = payload?.buildings || [];

  function pushHistorySnapshot(snapshot) {
    setHistory((h) => {
      const next = [...h, snapshot];
      return next.slice(-30);
    });
  }

  function pushCurrentToHistory() {
    pushHistorySnapshot({
      filters: Array.isArray(filters) ? JSON.parse(JSON.stringify(filters)) : [],
      matched_ids: Array.from(matchedIds || []),
      selected_building_id: selectedBuildingId,
    });
  }

  function goBack() {
    setHistory((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];

      skipNextApplyRef.current = true;
      setFilters(prev.filters || []);
      setMatchedIds(new Set(prev.matched_ids || []));
      setSelectedBuildingId(prev.selected_building_id ?? null);

      // refresh map so selection/highlights re-apply visually
      setMapKey((k) => k + 1);

      return h.slice(0, -1);
    });
  }

  async function loadBuildings() {
    setLoading(true);
    setError("");
    try {
      const r = await fetch(`${API_BASE}/api/buildings`);
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Failed to fetch buildings");
      setPayload(j);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  async function refreshProjects(user = username) {
    if (!user) return;
    try {
      const r = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(user)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Failed to fetch projects");
      setProjects(normalizeProjectsResponse(j));
    } catch (e) {
      console.warn(e);
    }
  }

  async function applyFilters(nextFilters) {
    try {
      const r = await fetch(`${API_BASE}/api/apply_filters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters: nextFilters }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Failed to apply filters");
      setMatchedIds(new Set(j.matched_ids || []));
    } catch (e) {
      console.warn(e);
    }
  }

  useEffect(() => {
    loadBuildings();
  }, []);

  useEffect(() => {
    refreshProjects(username);
  }, [username]);

  useEffect(() => {
    if (skipNextApplyRef.current) {
      skipNextApplyRef.current = false;
      return;
    }
    applyFilters(filters);
  }, [filters]);

  async function runLLMQuery() {
    const q = nlQuery.trim();
    if (!q) return;

    setError("");
    try {
      pushCurrentToHistory();

      const r = await fetch(`${API_BASE}/api/nl_query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, existing_filters: filters }),
      });

      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "LLM query failed");

      const nextFilters = Array.isArray(j.filters)
        ? j.filters
        : j.filter
        ? [...filters, j.filter]
        : filters;

      skipNextApplyRef.current = true;
      setFilters(nextFilters);
      setMatchedIds(new Set(j.matched_ids || []));
      setNlQuery("");

      setMapKey((k) => k + 1);
    } catch (e) {
      setError(String(e.message || e));
    }
  }

  async function saveProject() {
    const name = projectName.trim();
    const user = username.trim();

    if (!user) return setError("Enter a username first.");
    if (!name) return setError("Enter a project name.");

    // ✅ allow save even if no filters, as long as they selected a building
    if (!filters.length && !selectedBuildingId) {
      return setError("Add filters or select a building before saving.");
    }

    setError("");
    try {
      pushCurrentToHistory();

      const r = await fetch(`${API_BASE}/api/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: user,
          name,
          filters,
          matched_ids: Array.from(matchedIds || []),
          selected_building_id: selectedBuildingId, // ✅ NEW
        }),
      });

      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Save failed");

      setProjectName("");
      await refreshProjects(user);

      // ✅ refresh map after save
      setMapKey((k) => k + 1);
    } catch (e) {
      setError(String(e.message || e));
    }
  }

  async function loadProject(p) {
    const user = username.trim();
    if (!user) return setError("Enter a username first.");

    const name = getProjectName(p);
    if (!name) return setError("This saved project is missing a name.");

    pushCurrentToHistory();
    setError("");

    try {
      const r = await fetch(`${API_BASE}/api/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user, name }),
      });

      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Load failed");

      const loadedFilters = Array.isArray(j.filters) ? j.filters : [];

      // ✅ load building selection too
      setSelectedBuildingId(j.selected_building_id ?? null);

      if (Array.isArray(j.matched_ids)) {
        skipNextApplyRef.current = true;
        setFilters(loadedFilters);
        setMatchedIds(new Set(j.matched_ids));
      } else {
        skipNextApplyRef.current = true;
        setFilters(loadedFilters);
        await applyFilters(loadedFilters);
      }

      // ✅ force map refresh so camera/selection updates
      setMapKey((k) => k + 1);
    } catch (e) {
      setError(String(e.message || e));
    }
  }

  function removeFilter(idx) {
    pushCurrentToHistory();
    setFilters((prev) => prev.filter((_, i) => i !== idx));
  }

  const ui = useMemo(() => {
    return {
      loading,
      error,
      count: payload?.count || 0,
      matched: matchedIds.size,
    };
  }, [loading, error, payload, matchedIds]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "380px 1fr", height: "100vh" }}>
      {/* Sidebar ... unchanged ... */}

      {/* 3D View */}
      <div style={{ position: "relative" }}>
        <ThreeMap
          key={mapKey}
          buildings={buildings}
          matchedIds={matchedIds}
          selectedBuildingId={selectedBuildingId}
          onSelectBuilding={(id) => setSelectedBuildingId(id)}
        />
      </div>
    </div>
  );
}
