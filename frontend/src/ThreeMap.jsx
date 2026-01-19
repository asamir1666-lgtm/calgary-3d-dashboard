import * as THREE from "three";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

function safeLabel(v) {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

export default function ThreeMap({ buildings, matchedIds }) {
  const mountRef = useRef(null);
  const rendererRef = useRef(null);
  const meshesRef = useRef([]);
  const [selected, setSelected] = useState(null);

  const HEIGHT_SCALE = 2.5;
  const MIN_HEIGHT = 10;

  const mats = useMemo(() => {
    return {
      base: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.75, metalness: 0.05 }),
      match: new THREE.MeshStandardMaterial({ color: 0xd93025, roughness: 0.65, metalness: 0.05 }),
      selected: new THREE.MeshStandardMaterial({ color: 0x1a73e8, roughness: 0.55, metalness: 0.08 }),
      ground: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1.0, metalness: 0.0 }),
      edge: new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 }),
    };
  }, []);

  function makeShape(pointsXY) {
    if (!Array.isArray(pointsXY) || pointsXY.length < 3) return null;

    let pts = pointsXY.map(([x, y]) => new THREE.Vector2(Number(x), Number(y)));

    // Drop duplicate last point if same as first
    if (pts.length >= 2) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      if (a.distanceTo(b) < 0.0001) pts = pts.slice(0, -1);
    }
    if (pts.length < 3) return null;

    // Ensure CCW winding
    if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();

    const shape = new THREE.Shape();
    shape.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, pts[i].y);
    shape.closePath();
    return shape;
  }

  useEffect(() => {
    if (!mountRef.current) return;

    // cleanup
    if (rendererRef.current) {
      rendererRef.current.domElement?.remove();
      rendererRef.current.dispose();
    }
    meshesRef.current = [];
    setSelected(null);

    const width = mountRef.current.clientWidth;
    const height = mountRef.current.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf7f7f7);

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 200000);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.position.set(400, -500, 800);
    scene.add(dir);

    // controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;

    const group = new THREE.Group();
    scene.add(group);

    // ground
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(2500, 2500), mats.ground);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0, 0);
    scene.add(ground);

    // build meshes
    buildings.forEach((b) => {
      const pts = b.footprint_xy;
      if (!Array.isArray(pts) || pts.length < 3) return;

      const shape = makeShape(pts);
      if (!shape) return;

      const rawH = Number(b.height) || 10;
      const h = Math.max(MIN_HEIGHT, rawH * HEIGHT_SCALE);

      // IMPORTANT: extrude goes up +Z by default. Do NOT rotate it.
      const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
      geo.computeVertexNormals();

      const mesh = new THREE.Mesh(geo, mats.base);
      mesh.userData = { building: b };

      // outline (visual polish)
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), mats.edge);
      edges.raycast = () => null; // ✅ prevent edges from stealing clicks
      mesh.add(edges);

      group.add(mesh);
      meshesRef.current.push(mesh);
    });

    // fit camera
    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const maxDim = Math.max(size.x, size.y, size.z) || 400;
    controls.target.copy(center);

    camera.near = 0.1;
    camera.far = maxDim * 30 + 5000;
    camera.position.set(center.x + maxDim * 0.5, center.y - maxDim * 1.35, center.z + maxDim * 0.9);
    camera.updateProjectionMatrix();

    // selection/highlight
    const applyMaterials = (selectedId) => {
      meshesRef.current.forEach((m) => {
        const bid = m.userData.building?.id;
        const isMatch = matchedIds?.has?.(bid);
        const isSel = selectedId && bid === selectedId;
        m.material = isSel ? mats.selected : isMatch ? mats.match : mats.base;
      });
    };

    // click
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const handleClick = (ev) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);

      raycaster.setFromCamera(mouse, camera);

      // intersect only building meshes (not children)
      const hits = raycaster.intersectObjects(meshesRef.current, false);

      if (hits.length > 0) {
        const building = hits[0].object.userData.building;
        applyMaterials(building.id);
        setSelected({ building, x: ev.clientX - rect.left + 8, y: ev.clientY - rect.top + 8 });
      } else {
        applyMaterials(null);
        setSelected(null);
      }
    };

    renderer.domElement.addEventListener("click", handleClick);

    // resize
    const handleResize = () => {
      if (!mountRef.current) return;
      const w = mountRef.current.clientWidth;
      const h2 = mountRef.current.clientHeight;
      camera.aspect = w / h2;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h2);
    };
    window.addEventListener("resize", handleResize);

    // loop
    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // init
    applyMaterials(null);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", handleResize);
      renderer.domElement.removeEventListener("click", handleClick);
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildings, mats]);

  // update highlights when matchedIds changes
  useEffect(() => {
    meshesRef.current.forEach((m) => {
      const bid = m.userData.building?.id;
      const isSelected = selected?.building?.id === bid;
      const isMatch = matchedIds?.has?.(bid);
      m.material = isSelected ? mats.selected : isMatch ? mats.match : mats.base;
    });
  }, [matchedIds, selected, mats]);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />

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
          <div style={{ marginBottom: 6 }}><b>Address:</b> {safeLabel(selected.building.address)}</div>
          <div style={{ marginBottom: 6 }}><b>Height:</b> {safeLabel(selected.building.height)}</div>
          <div style={{ marginBottom: 6 }}><b>Zoning:</b> {safeLabel(selected.building.zoning)}</div>
          <div style={{ marginBottom: 10 }}><b>Assessed Value:</b> {safeLabel(selected.building.assessed_value)}</div>

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
