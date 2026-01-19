import React, { useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "calgary_map_projects_v1";

function readAllProjects() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeAllProjects(projects) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}

export default function ProjectManager({
  activeFilters,
  setActiveFilters,
  applyFiltersToMap, // optional
}) {
  const [username, setUsername] = useState(() => localStorage.getItem("pm_username") || "");
  const [projectName, setProjectName] = useState("");
  const [allProjects, setAllProjects] = useState([]);

  useEffect(() => {
    setAllProjects(readAllProjects());
  }, []);

  useEffect(() => {
    localStorage.setItem("pm_username", username);
  }, [username]);

  const userProjects = useMemo(() => {
    const u = username.trim().toLowerCase();
    if (!u) return [];
    return allProjects
      .filter((p) => (p.username || "").toLowerCase() === u)
      .sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
  }, [allProjects, username]);

  function onSaveProject() {
    const u = username.trim();
    const n = projectName.trim();

    if (!u) return alert("Enter a username first.");
    if (!n) return alert("Enter a project name.");

    const next = [...allProjects];

    // overwrite if same username + project name
    const idx = next.findIndex(
      (p) =>
        (p.username || "").toLowerCase() === u.toLowerCase() &&
        (p.name || "").toLowerCase() === n.toLowerCase()
    );

    const payload = {
      username: u,
      name: n,
      savedAt: new Date().toISOString(),
      filters: activeFilters ?? {},
    };

    if (idx >= 0) next[idx] = payload;
    else next.push(payload);

    writeAllProjects(next);
    setAllProjects(next);
    setProjectName("");
  }

  function onLoadProject(p) {
    const nextFilters = p.filters ?? {};
    setActiveFilters(nextFilters);

    // if your 3D map needs an explicit apply call:
    if (typeof applyFiltersToMap === "function") {
      applyFiltersToMap(nextFilters);
    }
  }

  function onDeleteProject(p) {
    const next = allProjects.filter(
      (x) =>
        !(
          (x.username || "").toLowerCase() === (p.username || "").toLowerCase() &&
          (x.name || "").toLowerCase() === (p.name || "").toLowerCase()
        )
    );
    writeAllProjects(next);
    setAllProjects(next);
  }

  return (
    <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 10, maxWidth: 520 }}>
      <h3 style={{ margin: "0 0 10px" }}>Projects</h3>

      {/* Username */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
        <label style={{ width: 90 }}>Username</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="e.g. ali"
          style={{ flex: 1, padding: 8, borderRadius: 8, border: "1px solid #ccc" }}
        />
      </div>

      {/* Save */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
        <label style={{ width: 90 }}>Project</label>
        <input
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder="e.g. Tall buildings MU-1"
          style={{ flex: 1, padding: 8, borderRadius: 8, border: "1px solid #ccc" }}
        />
        <button
          onClick={onSaveProject}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #222",
            background: "#222",
            color: "white",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          Save Project
        </button>
      </div>

      {/* List */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Saved Projects</div>

        {!username.trim() ? (
          <div style={{ color: "#666" }}>Enter a username to see saved projects.</div>
        ) : userProjects.length === 0 ? (
          <div style={{ color: "#666" }}>No projects saved yet for “{username.trim()}”.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {userProjects.map((p) => (
              <div
                key={`${p.username}:${p.name}`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: 10,
                  border: "1px solid #eee",
                  borderRadius: 10,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.name}
                  </div>
                  <div style={{ fontSize: 12, color: "#666" }}>
                    Saved {new Date(p.savedAt).toLocaleString()}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => onLoadProject(p)}
                    style={{
                      padding: "7px 10px",
                      borderRadius: 8,
                      border: "1px solid #222",
                      background: "white",
                      cursor: "pointer",
                    }}
                  >
                    Load
                  </button>
                  <button
                    onClick={() => onDeleteProject(p)}
                    style={{
                      padding: "7px 10px",
                      borderRadius: 8,
                      border: "1px solid #ccc",
                      background: "white",
                      cursor: "pointer",
                      color: "#b00020",
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Debug */}
      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer" }}>Active filters (debug)</summary>
        <pre style={{ marginTop: 8, background: "#f7f7f7", padding: 10, borderRadius: 10, overflowX: "auto" }}>
          {JSON.stringify(activeFilters ?? {}, null, 2)}
        </pre>
      </details>
    </div>
  );
}
