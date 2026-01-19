import * as THREE from "three";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

function safeLabel(v) {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

export default function ThreeMap({ buildings, matchedIds }) {
  const mountRef = useRef(null);

  const sceneRef = useRef(null);
  const rendererRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);

  const meshesRef = useRef([]);
  const groupRef = useRef(null);

  const [selected, setSelected] = useState(null); // {building, x, y}

  // ---------- Visual tuning ----------
  const HEIGHT_SCALE = 2.2; // makes buildings pop (1.5–4 looks good)
  const MIN_HEIGHT = 8;     // prevents “flat/line” buildings
  const XY_SCALE = 1;       // footprint_xy should already be meters; keep 1

  // Stable materials (don’t recreate every render)
  const mats = useMemo(() => {
    return {
      base: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.75, metalness: 0.05 }),
      match: new THREE.MeshStandardMaterial({ color: 0xd93025, roughness: 0.65, metalness: 0.05 }),
      selected: new THREE.MeshStandardMaterial({ color: 0x1a73e8, roughness: 0.55, metalness: 0.08 }),
      ground: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1.0, metalness: 0.0 }),
    };
  }, []);

  function makeShapeFromFootprintXY(footprintXY) {
    if (!Array.isArray(footprintXY) || footprintXY.length < 3) return null;

    // Convert to Vector2
    let pts = footprintXY.map(([x, y]) => new THREE.Vector2(x * XY_SCALE, y * XY_SCALE));

    // Remove last point if it repeats the first (common in GeoJSON rings)
    if (pts.length >= 2) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      if (a.distanceTo(b) < 0.0001) pts = pts.slice(0, -1);
    }
    if (pts.length < 3) return null;

    // Fix winding order (Three wants CCW for correct faces)
    if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();

    const shape = new THREE.Shape();
    shape.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, pts[i].y);
    shape.closePath();

    return shape;
  }

  // Build / rebuild scene when building dataset changes
  useEffect(() => {
    if (!mountRef.current) return;

    // Cleanup previous renderer
    if (rendererRef.current) {
      rendererRef.current.domElement?.remove();
      rendererRef.current.dispose();
    }
    meshesRef.current = [];
    setSelected(null);

    const width = mountRef.current.clientWidth;
    const height = mountRef.current.clientHeight;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf7f7f7);

    // Camera
    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 200000);

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    mountRef.current.appendChild(renderer.domElement);

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.position.set(300, -400, 700);
    scene.add(dir);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;

    // Group all buildings so we can fit camera to it
    const group = new THREE.Group();
    scene.add(group);
    groupRef.current = group;

    // Compute dataset center (so everything is near origin)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    buildings.forEach((b) => {
      const pts = b.footprint_xy;
      if (!Array.isArray(pts) || pts.length < 3) return;
      for (const [x, y] of pts) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    });

    const centerX = Number.isFinite(minX) ? (minX + maxX) / 2 : 0;
    const centerY = Number.isFinite(minY) ? (minY + maxY) / 2 : 0;

    // Ground (centered under buildings)
    const groundSize = 2500;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(groundSize, groundSize), mats.ground);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0, 0);
    scene.add(ground);

    // Build meshes
    buildings.forEach((b) => {
      const pts = b.footprint_xy;
      if (!Array.isArray(pts) || pts.length < 3) return;

      // Center to origin for stable camera/controls
      const centered = pts.map(([x, y]) => [x - centerX, y - centerY]);

      const shape = makeShapeFromFootprintXY(centered);
      if (!shape) return;

      const rawH = Number(b.height) || 10;
      const h = Math.max(MIN_HEIGHT, rawH * HEIGHT_SCALE);

      const geo = new THREE.ExtrudeGeometry(shape, {
        depth: h,
        bevelEnabled: false,
      });

      // Put extrusion up on Z axis (so “height” is vertical)
      geo.rotateX(Math.PI / 2);
      geo.computeVertexNormals();

      const mesh = new THREE.Mesh(geo, mats.base);
      mesh.userData = { building: b };
      group.add(mesh);
      meshesRef.current.push(mesh);
    });

    // Fit camera to buildings (THIS fixes the “lines” look)
    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);

    const maxDim = Math.max(size.x, size.y, size.z);
    controls.target.copy(center);

    camera.near = 0.1;
    camera.far = maxDim * 20 + 5000;
    camera.position.set(center.x, center.y - maxDim * 1.25, center.z + maxDim * 0.85);
    camera.updateProjectionMatrix();

    // Store refs
    sceneRef.current = scene;
    rendererRef.current = renderer;
    cameraRef.current = camera;
    controlsRef.current = controls;

    // Render loop
    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // Resize
    const handleResize = () => {
      if (!mountRef.current) return;
      const w = mountRef.current.clientWidth;
      const h2 = mountRef.current.clientHeight;
      camera.aspect = w / h2;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h2);
    };
    window.addEventListener("resize", handleResize);

    // Click interaction
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const applyMaterials = (selectedId) => {
      meshesRef.current.forEach((m) => {
        const b = m.userData.building;
        const isMatch = matchedIds?.has?.(b.id);
        const isSel = selectedId && b.id === selectedId;
        m.material = isSel ? mats.selected : isMatch ? mats.match : mats.base;
      });
    };

    const handleClick = (ev) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);

      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(meshesRef.current, false);

      if (hits.length > 0) {
        const b = hits[0].object.userData.building;
        applyMaterials(b.id);
        setSelected({ building: b, x: ev.clientX - rect.left + 8, y: ev.clientY - rect.top + 8 });
      } else {
        applyMaterials(null);
        setSelected(null);
      }
    };

    renderer.domElement.addEventListener("click", handleClick);

    // initial material state
    applyMaterials(selected?.building?.id || null);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", handleResize);
      renderer.domElement.removeEventListener("click", handleClick);
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildings, mats]);

  // Update highlights when matchedIds changes
  useEffect(() => {
    meshesRef.current.forEach((m) => {
      const b = m.userData.building;
      const isSelected = selected?.building?.id === b.id;
      const isMatch = matchedIds?.has?.(b.id);
      m.material = isSelected ? mats.selected : isMatch ? mats.match : mats.base;
    });
  }, [matchedIds, selected, mats]);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />

      {/* Popup */}
      {selected && (
        <div
          style={{
            position: "absolute",
            left: selected.x,
            top: selected.y,
            background: "white",
            border: "1px solid #ddd",
            borderRadius: 12,
            padding: 12,
            width: 320,
            boxShadow: "0 10px 30px rgba(0,0,0,0.12)",
            fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
            fontSize: 13,
            pointerEvents: "none",
          }}
        >
          <div style={{ fontWeight: 800, marginBottom: 8 }}>Building</div>
          <div style={{ marginBottom: 6 }}>
            <b>Address:</b> {safeLabel(selected.building.address)}
          </div>
          <div style={{ marginBottom: 6 }}>
            <b>Height:</b> {safeLabel(selected.building.height)}
          </div>
          <div style={{ marginBottom: 6 }}>
            <b>Zoning:</b> {safeLabel(selected.building.zoning)}
          </div>
          <div style={{ marginBottom: 10 }}>
            <b>Assessed Value:</b> {safeLabel(selected.building.assessed_value)}
          </div>

          <div style={{ fontWeight: 800, marginBottom: 6 }}>Raw data</div>
          <div
            style={{
              maxHeight: 180,
              overflow: "auto",
              background: "#fafafa",
              border: "1px solid #eee",
              borderRadius: 8,
              padding: 8,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: 11,
            }}
          >
            {JSON.stringify(selected.building.properties || {}, null, 2)}
          </div>
        </div>
      )}
    </div>
  );
}
