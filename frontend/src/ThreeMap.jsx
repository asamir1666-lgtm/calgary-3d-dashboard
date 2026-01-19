import * as THREE from "three";
import React, { useEffect, useRef, useState } from "react";
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
  const [selected, setSelected] = useState(null); // {building, screenX, screenY}

  // Build / rebuild scene when building dataset changes
  useEffect(() => {
    if (!mountRef.current) return;

    // Cleanup previous
    if (rendererRef.current) {
      rendererRef.current.domElement?.remove();
      rendererRef.current.dispose();
    }
    meshesRef.current = [];
    setSelected(null);

    const width = mountRef.current.clientWidth;
    const height = mountRef.current.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf8f8f8);

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 100000);
    camera.position.set(0, -250, 220);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    mountRef.current.appendChild(renderer.domElement);

    // Lights
    const hemi = new THREE.HemisphereLight(0xffffff, 0x999999, 1.0);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(200, -200, 400);
    scene.add(dir);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.target.set(0, 0, 20);

    // Ground
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(2000, 2000),
      new THREE.MeshStandardMaterial({ color: 0xffffff })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.z = 0;
    scene.add(ground);

    // Build meshes
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6 });
    const highlightMat = new THREE.MeshStandardMaterial({ color: 0xd93025 });
    const selectedMat = new THREE.MeshStandardMaterial({ color: 0x1a73e8 });

    // Fit to data
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;

    buildings.forEach((b) => {
      const pts = b.footprint_xy;
      if (!Array.isArray(pts) || pts.length < 3) return;
      pts.forEach(([x, y]) => {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      });
    });

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    buildings.forEach((b) => {
      const pts = b.footprint_xy;
      if (!Array.isArray(pts) || pts.length < 3) return;

      const shape = new THREE.Shape();
      pts.forEach(([x, y], i) => {
        const xx = x - centerX;
        const yy = y - centerY;
        if (i === 0) shape.moveTo(xx, yy);
        else shape.lineTo(xx, yy);
      });
      shape.closePath();

      const h = Number(b.height) || 10;
      const geo = new THREE.ExtrudeGeometry(shape, {
        depth: h,
        bevelEnabled: false,
      });

      // Put extrusion on Z axis
      geo.rotateX(Math.PI / 2);
      geo.translate(0, h / 2, 0);

      const mesh = new THREE.Mesh(geo, baseMat.clone());
      mesh.userData = { building: b, baseMat, highlightMat, selectedMat };
      scene.add(mesh);
      meshesRef.current.push(mesh);
    });

    // Camera framing
    const span = Math.max(maxX - minX, maxY - minY);
    camera.position.set(0, -span * 0.9, span * 0.6);
    controls.target.set(0, 0, 0);

    // Store refs
    sceneRef.current = scene;
    rendererRef.current = renderer;
    cameraRef.current = camera;
    controlsRef.current = controls;

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

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

    const handleClick = (ev) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(meshesRef.current, false);

      // Reset selected style
      meshesRef.current.forEach((m) => {
        const b = m.userData.building;
        const isMatch = matchedIds?.has?.(b.id);
        m.material = isMatch ? highlightMat : baseMat;
      });

      if (hits.length > 0) {
        const obj = hits[0].object;
        const b = obj.userData.building;
        obj.material = selectedMat;
        setSelected({ building: b, x: ev.clientX - rect.left + 8, y: ev.clientY - rect.top + 8 });
      } else {
        setSelected(null);
      }
    };
    renderer.domElement.addEventListener("click", handleClick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", handleResize);
      renderer.domElement.removeEventListener("click", handleClick);
      renderer.dispose();
    };
  }, [buildings]);

  // Update highlights when matchedIds changes
  useEffect(() => {
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6 });
    const highlightMat = new THREE.MeshStandardMaterial({ color: 0xd93025 });
    const selectedMat = new THREE.MeshStandardMaterial({ color: 0x1a73e8 });

    meshesRef.current.forEach((m) => {
      const b = m.userData.building;
      const isSelected = selected?.building?.id === b.id;
      const isMatch = matchedIds?.has?.(b.id);
      m.material = isSelected ? selectedMat : isMatch ? highlightMat : baseMat;
    });
  }, [matchedIds, selected]);

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
            borderRadius: 10,
            padding: 12,
            width: 320,
            boxShadow: "0 10px 30px rgba(0,0,0,0.12)",
            fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
            fontSize: 13,
            pointerEvents: "none",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Building</div>
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

          <div style={{ fontWeight: 700, marginBottom: 6 }}>Raw data</div>
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
