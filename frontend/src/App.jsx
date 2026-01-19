import React, { useEffect, useMemo, useRef, useState } from "react";
import ThreeMap from "./ThreeMap.jsx";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:5000";

function prettyFilter(f) {
  if (!f) return "";
  return `${f.attribute} ${f.operator} ${f.value}`;
}

// Normalize projects response: can be [] or {projects: []}
function normalizeProjectsResponse(j) {
  if (Array.isArray(j)) return j;
  if (j && Array.isArray(j.projects)) return j.projects;
  return [];
}

// Normalize project name key differences
function getProjectName(p) {
  if (!p) return "";
  if (typeof p === "string") return p;
  return p.name || p.project_name || p.title || "";
}

// normalize ids into Numbers (fixes string/number mismatch)
function normalizeIdSet(arr) {
  return new Set((arr || []).map((x) => (x === null || x === undefined ? x : String(x))));
}

function normalizeIdArray(arr) {
  return (arr || [])
    .filter((x) => x !== null && x !== undefined)
    .map((x) => Number(x));
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [payload, setPayload] = useState(null);

  // UI state
  const [username, setUsername] = useState("ali");
  const [projectName, setProjectName] = useState("");
  const [projects, setProjects] = useState([]);

  const [activeProjectName, setActiveProjectName] = useState("");

  const [nlQuery, setNlQuery] = useState("");
  const [filters, setFilters] = useState([]);

  // history stores filters + matched ids + selected buildings
  const [history, setHistory] = useState([]);

  const [matchedIds, setMatchedIds] = useState(new Set());

  // ✅ MULTI SELECT (Set of ids)
  const [selectedBuildingIds, setSelectedBuildingIds] = useState(new Set());

  // ✅ keep single for backward compatibility (optional)
  const selectedBuildingId = useMemo(() => {
    // last selected id (for any parts still using single)
    const arr = Array.from(selectedBuildingIds);
    return arr.length ? arr[arr.length - 1] : null;
  }, [selectedBuildingIds]);

  // force map remount to refresh view
  const [mapKey, setMapKey] = useState(0);

  // prevents double-applying when we already have matched_ids from server
  const skipNextApplyRef = useRef(false);

  const buildings = payload?.buildings || [];

  // ---------- HISTORY ----------
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
      selected_building_ids: Array.from(selectedBuildingIds || []),
      active_project_name: activeProjectName,
    });
  }

  function goBack() {
    setHistory((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];

      skipNextApplyRef.current = true;
      setFilters(prev.filters || []);
      setMatchedIds(normalizeIdSet(prev.matched_ids || []));
      setSelectedBuildingIds(normalizeIdSet(prev.selected_building_ids || []));
      setActiveProjectName(prev.active_project_name || "");

      setMapKey((k) => k + 1);
      return h.slice(0, -1);
    });
  }

  // ---------- DATA ----------
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

  // ---------- PROJECTS ----------
  async function refreshProjects(user = username) {
    const u = (user || "").trim();
    if (!u) return;
    try {
      const r = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(u)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Failed to fetch projects");
      setProjects(normalizeProjectsResponse(j));
    } catch (e) {
      console.warn(e);
    }
  }

  // ---------- APPLY FILTERS ----------
  async function applyFilters(nextFilters) {
    try {
      const r = await fetch(`${API_BASE}/api/apply_filters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters: nextFilters }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Failed to apply filters");
      setMatchedIds(normalizeIdSet(j.matched_ids || []));
    } catch (e) {
      console.warn(e);
    }
  }

  useEffect(() => {
    loadBuildings();
  }, []);

  useEffect(() => {
    refreshProjects(username);

    // changing username should reset active project + selection
    setActiveProjectName("");
    setSelectedBuildingIds(new Set());
    setFilters([]);
    setMatchedIds(new Set());
    setHistory([]);
    setMapKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  // When filters change, compute highlights (unless we already got matched_ids from server)
  useEffect(() => {
    if (skipNextApplyRef.current) {
      skipNextApplyRef.current = false;
      return;
    }
    applyFilters(filters);
  }, [filters]);

  // ---------- LLM QUERY ----------
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
      setMatchedIds(normalizeIdSet(j.matched_ids || []));
      setNlQuery("");

      // leaving project mode if you run new analysis
      setActiveProjectName("");

      setMapKey((k) => k + 1);
    } catch (e) {
      setError(String(e.message || e));
    }
  }

  // ---------- MULTI-SELECT BUILDINGS ----------
  function toggleSelectBuilding(id) {
  if (id === null || id === undefined) return;

  pushCurrentToHistory();
  setActiveProjectName("");

  setSelectedBuildingIds((prev) => {
    const next = new Set(prev);
    const key = String(id);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  setMapKey((k) => k + 1);
}


  function clearSelectedBuildings() {
    pushCurrentToHistory();
    setSelectedBuildingIds(new Set());
    setActiveProjectName("");
    setMapKey((k) => k + 1);
  }

  // ---------- SAVE PROJECT ----------
  async function saveProject() {
    const name = projectName.trim();
    const user = username.trim();

    if (!user) return setError("Enter a username first.");
    if (!name) return setError("Enter a project name.");

    const selectedArr = Array.from(selectedBuildingIds || []);

    if (!filters.length && selectedArr.length === 0) {
      return setError("Add filters or select buildings before saving.");
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

        
          selected_building_ids: Array.from(selectedBuildingIds || []).map(String),
          selected_building_id: Array.from(selectedBuildingIds || []).map(String).slice(-1)[0] ?? null,


      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Save failed");

      setProjectName("");
      await refreshProjects(user);

      setActiveProjectName(name);
      setMapKey((k) => k + 1);
    } catch (e) {
      setError(String(e.message || e));
    }
  }

  // ---------- LOAD PROJECT ----------
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

      setActiveProjectName(name);

      // ✅ NEW: load multi-select if present, else fallback to single
      const loadedSelected =
        Array.isArray(j.selected_building_ids)
          ? normalizeIdSet(j.selected_building_ids)
          : j.selected_building_id !== null && j.selected_building_id !== undefined
          ? new Set([Number(j.selected_building_id)])
          : new Set();

      setSelectedBuildingIds(loadedSelected);

      if (Array.isArray(j.matched_ids)) {
        skipNextApplyRef.current = true;
        setFilters(loadedFilters);
        setMatchedIds(normalizeIdSet(j.matched_ids));
      } else {
        skipNextApplyRef.current = true;
        setFilters(loadedFilters);
        await applyFilters(loadedFilters);
      }

      setMapKey((k) => k + 1);
    } catch (e) {
      setError(String(e.message || e));
    }
  }

  function removeFilter(idx) {
    pushCurrentToHistory();
    setFilters((prev) => prev.filter((_, i) => i !== idx));
    setActiveProjectName("");
  }

  const ui = useMemo(() => {
    return {
      loading,
      error,
      count: payload?.count || 0,
      matched: matchedIds.size,
      selected: selectedBuildingIds.size,
    };
  }, [loading, error, payload, matchedIds, selectedBuildingIds]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "380px 1fr", height: "100vh" }}>
      {/* Sidebar */}
      <div
        style={{
          borderRight: "1px solid #e5e5e5",
          padding: 16,
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          overflow: "auto",
        }}
      >
        <h2 style={{ margin: "0 0 8px 0" }}>Calgary 3D City Dashboard</h2>

        <div style={{ fontSize: 13, color: "#555", marginBottom: 12 }}>
          Buildings loaded: <b>{ui.count}</b> &nbsp; | &nbsp; Highlighted: <b>{ui.matched}</b>
          <br />
          Selected buildings: <b>{ui.selected}</b>
        </div>

        {activeProjectName ? (
          <div
            style={{
              background: "#e8f0fe",
              border: "1px solid #c6dafc",
              padding: 10,
              borderRadius: 10,
              fontSize: 13,
              marginBottom: 12,
            }}
          >
            Active project: <b>{activeProjectName}</b>
          </div>
        ) : null}

        {ui.loading && <div>Loading buildings…</div>}
        {ui.error && (
          <div
            style={{
              background: "#fff3f3",
              border: "1px solid #ffd0d0",
              padding: 10,
              borderRadius: 8,
            }}
          >
            <b>Error:</b> {ui.error}
          </div>
        )}

        <hr style={{ margin: "16px 0" }} />

        <h3 style={{ margin: "0 0 8px 0" }}>LLM Query</h3>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={nlQuery}
            onChange={(e) => setNlQuery(e.target.value)}
            placeholder='e.g. "highlight buildings over 30"'
            style={{ flex: 1, padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
            onKeyDown={(e) => {
              if (e.key === "Enter") runLLMQuery();
            }}
          />
          <button
            onClick={runLLMQuery}
            style={{ padding: "10px 12px", borderRadius: 8, border: "1px solid #ddd", cursor: "pointer" }}
          >
            Run
          </button>
        </div>

        <h3 style={{ margin: "16px 0 8px 0" }}>Active Filters</h3>
        {filters.length === 0 ? (
          <div style={{ fontSize: 13, color: "#777" }}>No filters yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filters.map((f, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  padding: 10,
                  border: "1px solid #eee",
                  borderRadius: 8,
                }}
              >
                <div style={{ fontSize: 13 }}>{prettyFilter(f)}</div>
                <button
                  onClick={() => removeFilter(i)}
                  style={{ border: "none", background: "transparent", cursor: "pointer", color: "#b00" }}
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            ))}

            {history.length > 0 && (
              <button
                onClick={goBack}
                style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd", cursor: "pointer" }}
              >
                Back
              </button>
            )}

            <button
              onClick={() => {
                pushCurrentToHistory();
                setFilters([]);
                setMatchedIds(new Set());
                setSelectedBuildingIds(new Set());
                setActiveProjectName("");
                setMapKey((k) => k + 1);
              }}
              style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd", cursor: "pointer" }}
            >
              Clear All
            </button>
          </div>
        )}

        <hr style={{ margin: "16px 0" }} />

        <h3 style={{ margin: "0 0 8px 0" }}>Selected Buildings</h3>
        {ui.selected === 0 ? (
          <div style={{ fontSize: 13, color: "#777" }}>Click buildings on the map to select (multi-select).</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ fontSize: 13, color: "#555" }}>
              Selected IDs:{" "}
              <span style={{ fontFamily: "monospace" }}>
                {Array.from(selectedBuildingIds).slice(0, 50).join(", ")}
                {ui.selected > 50 ? " ..." : ""}
              </span>
            </div>

            <button
              onClick={clearSelectedBuildings}
              style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd", cursor: "pointer" }}
            >
              Clear Selected
            </button>
          </div>
        )}

        <hr style={{ margin: "16px 0" }} />

        <h3 style={{ margin: "0 0 8px 0" }}>Save / Load Analysis</h3>
        <div style={{ display: "grid", gap: 8 }}>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value.trimStart())}
            placeholder="Username (no auth required)"
            style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
          />

          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Project name"
              style={{ flex: 1, padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
            />
            <button
              onClick={saveProject}
              style={{ padding: "10px 12px", borderRadius: 8, border: "1px solid #ddd", cursor: "pointer" }}
            >
              Save
            </button>
          </div>
        </div>

        <h4 style={{ margin: "16px 0 8px 0" }}>Saved Projects</h4>
        {projects.length === 0 ? (
          <div style={{ fontSize: 13, color: "#777" }}>No saved projects for this user.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {projects.map((p, idx) => {
              const name = getProjectName(p) || `Project ${idx + 1}`;
              const savedFilters = Array.isArray(p?.filters) ? p.filters : null;
              const isActive = name === activeProjectName;

              // show a hint if backend returns this in the list
              const selectedCount =
                Array.isArray(p?.selected_building_ids)
                  ? p.selected_building_ids.length
                  : p?.selected_building_id
                  ? 1
                  : 0;

              return (
                <button
                  key={`${name}-${idx}`}
                  onClick={() => loadProject(p)}
                  style={{
                    textAlign: "left",
                    padding: 10,
                    borderRadius: 8,
                    border: isActive ? "2px solid #1a73e8" : "1px solid #eee",
                    cursor: "pointer",
                    background: isActive ? "#e8f0fe" : "white",
                  }}
                  title="Load project"
                >
                  <b>{name}</b>
                  <div style={{ fontSize: 12, color: "#666" }}>
                    {selectedCount ? `${selectedCount} selected building(s)` : "No selected buildings"}{" "}
                    {savedFilters ? `• ${savedFilters.map(prettyFilter).join(" | ")}` : ""}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <hr style={{ margin: "16px 0" }} />
        <button
          onClick={loadBuildings}
          style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd", cursor: "pointer" }}
        >
          Refresh Buildings
        </button>
        <div style={{ fontSize: 12, color: "#666", marginTop: 8 }}>
          API: <code>{API_BASE}</code>
        </div>
      </div>

      {/* 3D View */}
      <div style={{ position: "relative" }}>
        <ThreeMap
          key={mapKey}
          buildings={buildings}
          matchedIds={matchedIds}
          selectedBuildingIds={selectedBuildingIds}   // ✅ NEW (multi-select)
          selectedBuildingId={selectedBuildingId}     // optional compatibility
          onSelectBuilding={toggleSelectBuilding}     // ✅ now toggles
        />
      </div>
    </div>
  );
}
