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

export default function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [payload, setPayload] = useState(null); // {bbox, projection, count, buildings}

  // LLM + persistence UI
  const [username, setUsername] = useState("ali");
  const [projectName, setProjectName] = useState("");
  const [projects, setProjects] = useState([]);

  const [nlQuery, setNlQuery] = useState("");
  const [filters, setFilters] = useState([]);

  // ✅ history stores BOTH filters + matched ids so "Back" truly restores the view
  const [history, setHistory] = useState([]);

  const [matchedIds, setMatchedIds] = useState(new Set());

  // prevents double-applying when we already have matched_ids from server
  const skipNextApplyRef = useRef(false);

  const buildings = payload?.buildings || [];

  // ---------- HISTORY ----------
  function pushHistorySnapshot(snapshot) {
    // snapshot = { filters: [...], matched_ids: [...] }
    setHistory((h) => {
      const next = [...h, snapshot];
      return next.slice(-30);
    });
  }

  function pushCurrentToHistory() {
    pushHistorySnapshot({
      filters: Array.isArray(filters) ? JSON.parse(JSON.stringify(filters)) : [],
      matched_ids: Array.from(matchedIds || []),
    });
  }

  function goBack() {
    setHistory((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];

      // restore filters + highlights immediately
      skipNextApplyRef.current = true;
      setFilters(prev.filters || []);
      setMatchedIds(new Set(prev.matched_ids || []));

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
    if (!user) return;
    try {
      const r = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(user)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Failed to fetch projects");

      setProjects(normalizeProjectsResponse(j));
    } catch (e) {
      console.warn(e);
      // keep UI usable; don’t hard-fail
    }
  }

  // ---------- APPLY FILTERS (compute highlights) ----------
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
      // save snapshot so Back works
      pushCurrentToHistory();

      const r = await fetch(`${API_BASE}/api/nl_query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, existing_filters: filters }),
      });

      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "LLM query failed");

      // server may return: {filter, filters, matched_ids, count}
      const nextFilters = Array.isArray(j.filters)
        ? j.filters
        : j.filter
        ? [...filters, j.filter]
        : filters;

      // We already have matched_ids from backend -> skip apply_filters
      skipNextApplyRef.current = true;
      setFilters(nextFilters);
      setMatchedIds(new Set(j.matched_ids || []));
      setNlQuery("");
    } catch (e) {
      setError(String(e.message || e));
    }
  }

  // ---------- SAVE PROJECT ----------
  async function saveProject() {
    const name = projectName.trim();
    const user = username.trim();

    if (!user) return setError("Enter a username first.");
    if (!name) return setError("Enter a project name.");
    if (!filters.length) return setError("Run a query first so there are filters to save.");

    setError("");
    try {
      // ✅ Optional: push history so you can Back after save if you change things
      pushCurrentToHistory();

      // Save filters (backend should compute highlights on load)
      const r = await fetch(`${API_BASE}/api/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: user,
          name,
          filters,
          // Extra: some backends may choose to store this too
          matched_ids: Array.from(matchedIds || []),
        }),
      });

      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Save failed");

      setProjectName("");
      await refreshProjects(user);
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

    // Save current snapshot so Back works
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

      // If backend returns matched_ids, use them immediately.
      if (Array.isArray(j.matched_ids)) {
        skipNextApplyRef.current = true;
        setFilters(loadedFilters);
        setMatchedIds(new Set(j.matched_ids));
      } else {
        // ✅ Fallback: backend didn't return matched_ids -> compute highlights now.
        skipNextApplyRef.current = true;
        setFilters(loadedFilters);
        await applyFilters(loadedFilters);
      }
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
        </div>

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
        <div style={{ fontSize: 12, color: "#666", marginTop: 8 }}>
          Try: <i>"show buildings in RC-G zoning"</i>, <i>"show buildings less than $500,000"</i>
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
              }}
              style={{ padding: 10, borderRadius: 8, border: "1px solid #ddd", cursor: "pointer" }}
            >
              Clear All
            </button>
          </div>
        )}

        <hr style={{ margin: "16px 0" }} />

        <h3 style={{ margin: "0 0 8px 0" }}>Save / Load Analysis</h3>
        <div style={{ display: "grid", gap: 8 }}>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
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

              return (
                <button
                  key={`${name}-${idx}`}
                  onClick={() => loadProject(p)}
                  style={{
                    textAlign: "left",
                    padding: 10,
                    borderRadius: 8,
                    border: "1px solid #eee",
                    cursor: "pointer",
                    background: "white",
                  }}
                  title="Load project"
                >
                  <b>{name}</b>
                  <div style={{ fontSize: 12, color: "#666" }}>
                    {savedFilters ? savedFilters.map(prettyFilter).join(" | ") : "Saved analysis"}
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
        <ThreeMap buildings={buildings} matchedIds={matchedIds} />
      </div>
    </div>
  );
}
