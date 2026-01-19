import React, { useEffect, useMemo, useState } from "react";
import ThreeMap from "./ThreeMap";

const API_BASE = import.meta.env.VITE_API_BASE || "";

function asSet(ids) {
  if (!ids) return new Set();
  if (ids instanceof Set) return ids;
  if (Array.isArray(ids)) return new Set(ids);
  return new Set();
}

export default function App() {
  const [buildings, setBuildings] = useState([]);

  // LLM / filtering state
  const [query, setQuery] = useState("");
  const [activeFilters, setActiveFilters] = useState([]); // array of {attribute, operator, value, ...}
  const [matchedIds, setMatchedIds] = useState(new Set());

  // Project persistence UI
  const [username, setUsername] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projects, setProjects] = useState([]); // list of saved project names/rows
  const [status, setStatus] = useState("");

  // ✅ History stack so you can go back after save/load/run
  // Each entry is: { activeFilters, matchedIds }
  const [history, setHistory] = useState([]);

  // ---------- Load buildings once ----------
  useEffect(() => {
    (async () => {
      try {
        setStatus("Loading buildings...");
        const res = await fetch(`${API_BASE}/api/buildings`);
        if (!res.ok) throw new Error(`Failed to load buildings: ${res.status}`);
        const data = await res.json();
        setBuildings(data || []);
        setStatus("");
      } catch (e) {
        console.error(e);
        setStatus(String(e?.message || e));
      }
    })();
  }, []);

  // ---------- Load saved projects when username changes ----------
  useEffect(() => {
    if (!username) {
      setProjects([]);
      return;
    }
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(username)}`);
        if (!res.ok) throw new Error(`Failed to load projects: ${res.status}`);
        const data = await res.json();
        // Support either: {projects:[...]} or [...]
        const list = Array.isArray(data) ? data : (data.projects || []);
        setProjects(list);
      } catch (e) {
        console.error(e);
      }
    })();
  }, [username]);

  // Helpful derived UI
  const matchedCount = useMemo(() => matchedIds?.size || 0, [matchedIds]);

  // ✅ Push current state to history BEFORE changing it
  const pushHistory = () => {
    setHistory((prev) => [
      ...prev,
      {
        activeFilters: Array.isArray(activeFilters) ? JSON.parse(JSON.stringify(activeFilters)) : [],
        matchedIds: Array.from(matchedIds || []),
      },
    ]);
  };

  // ✅ Back: restore previous filters + highlights
  const handleBack = () => {
    setHistory((prev) => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];

      setActiveFilters(last.activeFilters || []);
      setMatchedIds(new Set(last.matchedIds || []));

      return prev.slice(0, -1);
    });
  };

  // ---------- Run NL query ----------
  const runQuery = async () => {
    const q = query.trim();
    if (!q) return;

    try {
      setStatus("Running query...");
      pushHistory();

      const res = await fetch(`${API_BASE}/api/nl_query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });

      if (!res.ok) throw new Error(`Query failed: ${res.status}`);
      const data = await res.json();

      // Expect: { filters, matched_ids, count }
      setActiveFilters(Array.isArray(data.filters) ? data.filters : (data.filters ? [data.filters] : []));
      setMatchedIds(asSet(data.matched_ids));
      setStatus(`Matched ${data.count ?? (data.matched_ids?.length ?? 0)} buildings`);
    } catch (e) {
      console.error(e);
      setStatus(String(e?.message || e));
    }
  };

  // ---------- Save project ----------
  const saveProject = async () => {
    const u = username.trim();
    const name = projectName.trim();
    if (!u || !name) {
      setStatus("Enter a username + project name.");
      return;
    }
    if (!activeFilters?.length) {
      setStatus("No active filters to save yet.");
      return;
    }

    try {
      setStatus("Saving...");
      const res = await fetch(`${API_BASE}/api/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: u,
          name,
          filters: activeFilters,
        }),
      });

      if (!res.ok) throw new Error(`Save failed: ${res.status}`);
      setStatus("Saved!");

      // refresh list
      const listRes = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(u)}`);
      if (listRes.ok) {
        const data = await listRes.json();
        const list = Array.isArray(data) ? data : (data.projects || []);
        setProjects(list);
      }
    } catch (e) {
      console.error(e);
      setStatus(String(e?.message || e));
    }
  };

  // ---------- Load project (fix: actually applies saved filters + highlights) ----------
  const loadProject = async (proj) => {
    const u = username.trim();
    if (!u) {
      setStatus("Enter a username first.");
      return;
    }

    // proj might be a string or an object like {name: "..."}
    const name = typeof proj === "string" ? proj : (proj?.name || proj?.project_name || "");
    if (!name) return;

    try {
      setStatus("Loading project...");
      pushHistory();

      const res = await fetch(`${API_BASE}/api/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, name }),
      });

      if (!res.ok) throw new Error(`Load failed: ${res.status}`);
      const data = await res.json();

      // Expect: { filters, matched_ids, count }
      setActiveFilters(Array.isArray(data.filters) ? data.filters : (data.filters ? [data.filters] : []));
      setMatchedIds(asSet(data.matched_ids));
      setStatus(`Loaded "${name}" (${data.count ?? (data.matched_ids?.length ?? 0)} matches)`);
    } catch (e) {
      console.error(e);
      setStatus(String(e?.message || e));
    }
  };

  // ---------- Clear ----------
  const clearAll = () => {
    pushHistory();
    setActiveFilters([]);
    setMatchedIds(new Set());
    setStatus("Cleared.");
  };

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", overflow: "hidden" }}>
      <ThreeMap buildings={buildings} matchedIds={matchedIds} />

      {/* UI Panel */}
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          width: 420,
          background: "rgba(255,255,255,0.92)",
          border: "1px solid #e5e5e5",
          borderRadius: 14,
          padding: 14,
          boxShadow: "0 12px 30px rgba(0,0,0,0.12)",
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        }}
      >
        <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 10 }}>
          Calgary 3D Dashboard
        </div>

        {/* NL Query */}
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Try: "highlight buildings over 100 feet"'
            style={{
              flex: 1,
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid #ddd",
              outline: "none",
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") runQuery();
            }}
          />
          <button
            onClick={runQuery}
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: "white",
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            Run
          </button>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <button
            onClick={handleBack}
            disabled={history.length === 0}
            style={{
              padding: "9px 10px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: history.length ? "white" : "#f3f3f3",
              cursor: history.length ? "pointer" : "not-allowed",
              fontWeight: 700,
              flex: 1,
            }}
          >
            Back
          </button>

          <button
            onClick={clearAll}
            style={{
              padding: "9px 10px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: "white",
              cursor: "pointer",
              fontWeight: 700,
              flex: 1,
            }}
          >
            Clear
          </button>
        </div>

        {/* Active Filters */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>
            Active Filters <span style={{ fontWeight: 600, color: "#666" }}>({matchedCount} matches)</span>
          </div>
          <div
            style={{
              maxHeight: 120,
              overflow: "auto",
              background: "#fafafa",
              border: "1px solid #eee",
              borderRadius: 10,
              padding: 10,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: 12,
              whiteSpace: "pre-wrap",
            }}
          >
            {activeFilters?.length ? JSON.stringify(activeFilters, null, 2) : "—"}
          </div>
        </div>

        {/* Project Persistence */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8 }}>Projects</div>

          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              style={{
                flex: 1,
                padding: "9px 10px",
                borderRadius: 10,
                border: "1px solid #ddd",
                outline: "none",
              }}
            />
            <input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Project name"
              style={{
                flex: 1,
                padding: "9px 10px",
                borderRadius: 10,
                border: "1px solid #ddd",
                outline: "none",
              }}
            />
            <button
              onClick={saveProject}
              style={{
                padding: "9px 10px",
                borderRadius: 10,
                border: "1px solid #ddd",
                background: "white",
                cursor: "pointer",
                fontWeight: 800,
              }}
            >
              Save
            </button>
          </div>

          <div
            style={{
              border: "1px solid #eee",
              borderRadius: 10,
              padding: 10,
              background: "#fff",
              maxHeight: 140,
              overflow: "auto",
            }}
          >
            {!username ? (
              <div style={{ color: "#666", fontSize: 12 }}>Enter a username to see saved projects.</div>
            ) : projects?.length ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {projects.map((p, idx) => {
                  const name = typeof p === "string" ? p : (p.name || p.project_name || `Project ${idx + 1}`);
                  return (
                    <button
                      key={`${name}-${idx}`}
                      onClick={() => loadProject(p)}
                      style={{
                        textAlign: "left",
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: "1px solid #eee",
                        background: "white",
                        cursor: "pointer",
                        fontWeight: 700,
                      }}
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div style={{ color: "#666", fontSize: 12 }}>No saved projects yet.</div>
            )}
          </div>
        </div>

        {/* Status */}
        {status && (
          <div style={{ fontSize: 12, color: "#444" }}>
            {status}
          </div>
        )}
      </div>
    </div>
  );
}
