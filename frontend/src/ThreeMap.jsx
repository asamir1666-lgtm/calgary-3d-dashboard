import * as THREE from "three";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

function safeLabel(v) {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

// lon/lat degrees -> Web Mercator meters (EPSG:3857)
function lonLatToMercatorMeters(lon, lat) {
  const R = 6378137;
  const x = (R * (lon * Math.PI)) / 180;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI)) / 360);
  return [x, y];
}

function hash01(str) {
  const s = String(str ?? "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export default function ThreeMap({
  buildings,
  matchedIds,
  // optional (works with your updated App.jsx)
  selectedBuildingId = null,
  onSelectBuilding = null,
}) {
  const mountRef = useRef(null);
  const rendererRef = useRef(null);
  const meshesRef = useRef([]);

  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectedInfo, setSelectedInfo] = useState(null);

  // Look tuning
  const HEIGHT_SCALE = 2.6;
  const MIN_HEIGHT = 10;

  const mats = useMemo(() => {
    // Base grey buildings (like your screenshot)
    const wallBase = new THREE.MeshLambertMaterial({ color: 0x6f6f6f });
    const roofBase = new THREE.MeshLambertMaterial({ color: 0x7a7a7a });

    // Highlight/selected colors (still readable)
    const wallMatch = new THREE.MeshLambertMaterial({ color: 0xd93025 });
    const roofMatch = new THREE.MeshLambertMaterial({ color: 0xb3261e });

    const wallSelected = new THREE.MeshLambertMaterial({ color: 0x1a73e8 });
    const roofSelected = new THREE.MeshLambertMaterial({ color: 0x1558b0 });

    // Thin outline
    const edge = new THREE.LineBasicMaterial({
      color: 0x111111,
      transparent: true,
      opacity: 0.35,
    });

    return {
      base: [roofBase, roofBase, wallBase],
      match: [roofMatch, roofMatch, wallMatch],
      selected: [roofSelected, roofSelected, wallSelected],
      edge,
    };
  }, []);

  function makeShape(pointsXY) {
    if (!Array.isArray(pointsXY) || pointsXY.length < 3) return null;

    let pts = pointsXY.map(([x, y]) => new THREE.Vector2(Number(x), Number(y)));

    // drop duplicated last point
    if (pts.length >= 2) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      if (a.distanceTo(b) < 0.01) pts = pts.slice(0, -1);
    }
    if (pts.length < 3) return null;

    if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();

    const shape = new THREE.Shape();
    shape.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, pts[i].y);
    shape.closePath();
    return shape;
  }

  // Light “map” texture: roads + parks + river band
  function makeMapTexture(groundSize) {
    const canvas = document.createElement("canvas");
    canvas.width = 2048;
    canvas.height = 2048;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // base (paper)
    ctx.fillStyle = "#f7f7f7";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // subtle paper noise
    for (let i = 0; i < 12000; i++) {
      const x = Math.random() * canvas.width;
      const y = Math.random() * canvas.height;
      const a = Math.random() * 0.05;
      ctx.fillStyle = `rgba(0,0,0,${a})`;
      ctx.fillRect(x, y, 1, 1);
    }

    // major roads grid
    ctx.lineWidth = 14;
    ctx.strokeStyle = "#d7d7d7";
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const x = t * canvas.width;
      const y = t * canvas.height;

      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    // minor roads
    ctx.lineWidth = 6;
    ctx.strokeStyle = "#e6d9c8";
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const x = t * canvas.width;
      const y = t * canvas.height;

      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    // parks (patches)
    ctx.fillStyle = "rgba(150, 200, 150, 0.35)";
    for (let i = 0; i < 14; i++) {
      const x = Math.random() * canvas.width * 0.9;
      const y = Math.random() * canvas.height * 0.9;
      const w = 120 + Math.random() * 260;
      const h = 90 + Math.random() * 220;
      ctx.fillRect(x, y, w, h);
    }

    // river band (top-ish)
    ctx.fillStyle = "rgba(120, 170, 210, 0.45)";
    ctx.beginPath();
    ctx.moveTo(0, canvas.height * 0.12);
    ctx.bezierCurveTo(
      canvas.width * 0.35,
      canvas.height * 0.05,
      canvas.width * 0.65,
      canvas.height * 0.2,
      canvas.width,
      canvas.height * 0.12
    );
    ctx.lineTo(canvas.width, canvas.height * 0.22);
    ctx.bezierCurveTo(
      canvas.width * 0.65,
      canvas.height * 0.28,
      canvas.width * 0.35,
      canvas.height * 0.14,
      0,
      canvas.height * 0.22
    );
    ctx.closePath();
    ctx.fill();

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 8;
    tex.needsUpdate = true;

    return tex;
  }

  useEffect(() => {
    if (!mountRef.current) return;

    // cleanup
    if (rendererRef.current) {
      rendererRef.current.domElement?.remove();
      rendererRef.current.dispose();
    }
    meshesRef.current = [];
    setSelectedIds(new Set());
    setSelectedInfo(null);

    const width = mountRef.current.clientWidth;
    const height = mountRef.current.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf2f2f2);

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 250000);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Lighting: soft + flat (like screenshot)
    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 0.75);
    sun.position.set(1300, -900, 1700);
    scene.add(sun);

    // controls (map-like)
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = false;
    controls.maxPolarAngle = Math.PI / 2.2;
    controls.minDistance = 120;
    controls.maxDistance = 30000;

    const group = new THREE.Group();
    scene.add(group);

    // origin from first building
    let originMx = 0;
    let originMy = 0;
    const first = buildings?.find(
      (b) => Array.isArray(b?.footprint_ll) && b.footprint_ll.length > 2
    );
    if (first) {
      const [lon0, lat0] = first.footprint_ll[0];
      [originMx, originMy] = lonLatToMercatorMeters(Number(lon0), Number(lat0));
    }

    // buildings
    buildings.forEach((b, idx) => {
      const ll = b.footprint_ll;
      if (!Array.isArray(ll) || ll.length < 3) return;

      const ptsMeters = ll.map(([lon, lat]) => {
        const [mx, my] = lonLatToMercatorMeters(Number(lon), Number(lat));
        return [mx - originMx, my - originMy];
      });

      const shape = makeShape(ptsMeters);
      if (!shape) return;

      const rawH = Number(b.height) || 10;
      const r = hash01(b.id ?? idx);
      const jitter = 0.85 + r * 0.6; // subtle size variation
      const h = Math.max(MIN_HEIGHT, rawH * HEIGHT_SCALE * jitter);

      const geo = new THREE.ExtrudeGeometry(shape, {
        depth: h,
        bevelEnabled: false,
        curveSegments: 1,
        steps: 1,
      });
      geo.computeVertexNormals();

      const mesh = new THREE.Mesh(geo, mats.base);
      mesh.userData = { building: b };
      mesh.position.z = 0;

      // thin outline
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), mats.edge);
      edges.raycast = () => null;
      mesh.add(edges);

      group.add(mesh);
      meshesRef.current.push(mesh);
    });

    // fit bounds
    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    // map plane
    const groundSize = Math.max(size.x, size.y) * 2.2 || 4500;
    const mapTex = makeMapTexture(groundSize);

    const groundMat = new THREE.MeshBasicMaterial({
      map: mapTex || null,
      color: mapTex ? 0xffffff : 0xf7f7f7,
    });

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(groundSize, groundSize),
      groundMat
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(center.x, center.y, 0);
    scene.add(ground);

    // isometric-ish camera angle
    controls.target.copy(center);

    const maxDim = Math.max(size.x, size.y, size.z) || 600;
    camera.near = 0.1;
    camera.far = maxDim * 100 + 40000;
    camera.position.set(
      center.x + maxDim * 1.8,
      center.y - maxDim * 2.4,
      center.z + maxDim * 1.4
    );
    camera.updateProjectionMatrix();

    // apply highlight/selection materials
    const applyMaterials = (selSet) => {
      meshesRef.current.forEach((m) => {
        const bid = m.userData.building?.id;
        const isMatch = matchedIds?.has?.(bid);
        const isSel = selSet?.has?.(bid);
        m.material = isSel ? mats.selected : isMatch ? mats.match : mats.base;
      });
    };

    // initial selection from prop
    if (selectedBuildingId != null) {
      const s = new Set([selectedBuildingId]);
      setSelectedIds(s);
      applyMaterials(s);
    } else {
      applyMaterials(new Set());
    }

    // click
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const handleClick = (ev) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);

      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(meshesRef.current, false);

      if (hits.length > 0) {
        const building = hits[0].object.userData.building;
        const bid = building?.id;

        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (ev.shiftKey) {
            if (next.has(bid)) next.delete(bid);
            else next.add(bid);
          } else {
            next.clear();
            next.add(bid);
          }
          applyMaterials(next);
          if (onSelectBuilding) onSelectBuilding(bid);
          return next;
        });

        setSelectedInfo({
          building,
          x: ev.clientX - rect.left + 8,
          y: ev.clientY - rect.top + 8,
        });
      } else {
        const empty = new Set();
        applyMaterials(empty);
        setSelectedIds(empty);
        setSelectedInfo(null);
        if (onSelectBuilding) onSelectBuilding(null);
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

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", handleResize);
      renderer.domElement.removeEventListener("click", handleClick);
      renderer.domElement?.remove();
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildings, mats]);

  // update highlights if matchedIds changes
  useEffect(() => {
    const sel = selectedIds || new Set();
    meshesRef.current.forEach((m) => {
      const bid = m.userData.building?.id;
      const isSelected = sel?.has?.(bid);
      const isMatch = matchedIds?.has?.(bid);
      m.material = isSelected ? mats.selected : isMatch ? mats.match : mats.base;
    });
  }, [matchedIds, selectedIds, mats]);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />

      {selectedInfo && (
        <div
          style={{
            position: "absolute",
            left: selectedInfo.x,
            top: selectedInfo.y,
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
            <b>Address:</b> {safeLabel(selectedInfo.building.address)}
          </div>
          <div style={{ marginBottom: 6 }}>
            <b>Height:</b> {safeLabel(selectedInfo.building.height)}
          </div>
          <div style={{ marginBottom: 6 }}>
            <b>Zoning:</b> {safeLabel(selectedInfo.building.zoning)}
          </div>
          <div style={{ marginBottom: 10 }}>
            <b>Assessed Value:</b> {safeLabel(selectedInfo.building.assessed_value)}
          </div>
        </div>
      )}
    </div>
  );
}
