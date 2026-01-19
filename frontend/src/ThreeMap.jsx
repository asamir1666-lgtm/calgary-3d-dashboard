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
  const lonRad = (Number(lon) * Math.PI) / 180;
  const latRad = (Number(lat) * Math.PI) / 180;
  const x = R * lonRad;
  const y = R * Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  return [x, y];
}

function centroidXY(pts) {
  let cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  return [cx / pts.length, cy / pts.length];
}

// shrink polygon toward centroid (creates visible “street gaps”)
function insetPolygon(points, factor = 0.92) {
  const [cx, cy] = centroidXY(points);
  return points.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor]);
}

export default function ThreeMap({
  buildings,
  matchedIds,

  // optional (works with your App.jsx version)
  selectedBuildingId = null,
  onSelectBuilding = null,
}) {
  const mountRef = useRef(null);
  const rendererRef = useRef(null);
  const meshesRef = useRef([]);

  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectedInfo, setSelectedInfo] = useState(null);

  // “Esri 3D Digital Calgary” vibe
  const HEIGHT_SCALE = 2.8;
  const MIN_HEIGHT = 9;

  // spacing so selection is obvious
  const SPACING_FACTOR = 0.90; // smaller => more gap (0.86 big gap, 0.93 small)

  const mats = useMemo(() => {
    // soft white buildings (no texture)
    const wallBase = new THREE.MeshStandardMaterial({
      color: 0xf7f7f7,
      roughness: 0.98,
      metalness: 0.0,
      emissive: new THREE.Color(0x111111),
      emissiveIntensity: 0.03, // prevents dark faces
    });

    const roofBase = new THREE.MeshStandardMaterial({
      color: 0xfbfbfb,
      roughness: 0.99,
      metalness: 0.0,
      emissive: new THREE.Color(0x111111),
      emissiveIntensity: 0.02,
    });

    const wallMatch = new THREE.MeshStandardMaterial({
      color: 0xd93025,
      roughness: 0.92,
      metalness: 0.0,
    });

    const roofMatch = new THREE.MeshStandardMaterial({
      color: 0xb3261e,
      roughness: 0.92,
      metalness: 0.0,
    });

    const wallSelected = new THREE.MeshStandardMaterial({
      color: 0x1a73e8,
      roughness: 0.90,
      metalness: 0.0,
    });

    const roofSelected = new THREE.MeshStandardMaterial({
      color: 0x1558b0,
      roughness: 0.90,
      metalness: 0.0,
    });

    // ultra-subtle edges (Esri has almost none)
    const edge = new THREE.LineBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.035,
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

  // “Esri-ish” map background (procedural)
  function makeEsriStyleGroundTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = 2048;
    canvas.height = 2048;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // base light gray
    ctx.fillStyle = "#efefef";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // subtle noise
    for (let i = 0; i < 18000; i++) {
      const x = Math.random() * canvas.width;
      const y = Math.random() * canvas.height;
      const a = Math.random() * 0.05;
      ctx.fillStyle = `rgba(0,0,0,${a})`;
      ctx.fillRect(x, y, 1, 1);
    }

    // parks (light green areas)
    ctx.fillStyle = "rgba(176, 210, 150, 0.55)";
    for (let i = 0; i < 10; i++) {
      const x = (0.10 + Math.random() * 0.75) * canvas.width;
      const y = (0.10 + Math.random() * 0.75) * canvas.height;
      const w = (0.18 + Math.random() * 0.22) * canvas.width;
      const h = (0.12 + Math.random() * 0.20) * canvas.height;
      ctx.fillRect(x, y, w, h);
    }

    // water band (like river/lake)
    ctx.fillStyle = "rgba(110, 175, 220, 0.85)";
    ctx.beginPath();
    ctx.moveTo(0, canvas.height * 0.12);
    ctx.bezierCurveTo(
      canvas.width * 0.35,
      canvas.height * 0.04,
      canvas.width * 0.65,
      canvas.height * 0.20,
      canvas.width,
      canvas.height * 0.12
    );
    ctx.lineTo(canvas.width, canvas.height * 0.26);
    ctx.bezierCurveTo(
      canvas.width * 0.65,
      canvas.height * 0.33,
      canvas.width * 0.35,
      canvas.height * 0.18,
      0,
      canvas.height * 0.26
    );
    ctx.closePath();
    ctx.fill();

    // major roads (light, thick)
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 18;
    for (let i = 0; i <= 7; i++) {
      const t = i / 7;
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

    // minor roads (slightly darker)
    ctx.strokeStyle = "rgba(220,220,220,0.90)";
    ctx.lineWidth = 7;
    for (let i = 0; i <= 28; i++) {
      const t = i / 28;
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

    // tree rows along “roads”
    for (let i = 0; i < 18; i++) {
      const y = (0.12 + i * 0.045) * canvas.height;
      for (let x = 0; x < canvas.width; x += 22) {
        ctx.fillStyle = "rgba(65, 140, 70, 0.8)";
        ctx.beginPath();
        ctx.arc(x + (i % 2) * 11, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  }

  useEffect(() => {
    if (!mountRef.current) return;

    // cleanup previous renderer
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
    scene.background = new THREE.Color(0xe9ecef);
    scene.fog = new THREE.Fog(0xe9ecef, 2200, 14000);

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 250000);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    // soft Esri-style tone
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;

    // soft shadows
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // lighting (bright + soft)
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));

    const hemi = new THREE.HemisphereLight(0xffffff, 0xdfe6ee, 0.55);
    scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xffffff, 0.95);
    sun.position.set(1900, -1300, 2300);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 20000;
    sun.shadow.camera.left = -7000;
    sun.shadow.camera.right = 7000;
    sun.shadow.camera.top = 7000;
    sun.shadow.camera.bottom = -7000;
    scene.add(sun);

    // controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.screenSpacePanning = false;
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.minDistance = 150;
    controls.maxDistance = 30000;

    const group = new THREE.Group();
    scene.add(group);

    // origin from first building
    let originMx = 0;
    let originMy = 0;
    const first = buildings?.find((b) => Array.isArray(b?.footprint_ll) && b.footprint_ll.length > 2);
    if (first) {
      const [lon0, lat0] = first.footprint_ll[0];
      [originMx, originMy] = lonLatToMercatorMeters(lon0, lat0);
    }

    // build buildings
    buildings.forEach((b) => {
      const ll = b.footprint_ll;
      if (!Array.isArray(ll) || ll.length < 3) return;

      const ptsMeters = ll.map(([lon, lat]) => {
        const [mx, my] = lonLatToMercatorMeters(lon, lat);
        return [mx - originMx, my - originMy];
      });

      // create “street gaps”
      const spaced = insetPolygon(ptsMeters, SPACING_FACTOR);

      const shape = makeShape(spaced);
      if (!shape) return;

      const rawH = Number(b.height) || 10;
      const h = Math.max(MIN_HEIGHT, rawH * HEIGHT_SCALE);

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
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      // tiny edges only
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), mats.edge);
      edges.raycast = () => null;
      mesh.add(edges);

      group.add(mesh);
      meshesRef.current.push(mesh);
    });

    // bounds
    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    // ground (Esri-ish)
    const groundSize = Math.max(size.x, size.y) * 2.6 || 5000;
    const groundTex = makeEsriStyleGroundTexture();

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(groundSize, groundSize),
      new THREE.MeshStandardMaterial({
        map: groundTex || null,
        color: groundTex ? 0xffffff : 0xefefef,
        roughness: 1.0,
        metalness: 0.0,
      })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(center.x, center.y, 0);
    ground.receiveShadow = true;
    scene.add(ground);

    // camera like your screenshot (tilted)
    const maxDim = Math.max(size.x, size.y, size.z) || 600;
    controls.target.copy(center);

    camera.near = 0.1;
    camera.far = maxDim * 120 + 50000;
    camera.position.set(
      center.x + maxDim * 1.6,
      center.y - maxDim * 2.05,
      center.z + maxDim * 1.25
    );
    camera.updateProjectionMatrix();

    // highlight/selection
    const applyMaterials = (selSet) => {
      meshesRef.current.forEach((m) => {
        const bid = m.userData.building?.id;
        const isMatch = matchedIds?.has?.(bid);
        const isSel = selSet?.has?.(bid);
        m.material = isSel ? mats.selected : isMatch ? mats.match : mats.base;
      });
    };

    // apply initial selectedBuildingId
    if (selectedBuildingId != null) {
      const s = new Set([selectedBuildingId]);
      setSelectedIds(s);
      applyMaterials(s);
    } else {
      applyMaterials(new Set());
    }

    // click select
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

    // animate
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
  }, [buildings, mats, matchedIds, selectedBuildingId, onSelectBuilding]);

  // if matchedIds changes, re-apply materials
  useEffect(() => {
    const sel = selectedIds || new Set();
    meshesRef.current.forEach((m) => {
      const bid = m.userData.building?.id;
      const isSel = sel?.has?.(bid);
      const isMatch = matchedIds?.has?.(bid);
      m.material = isSel ? mats.selected : isMatch ? mats.match : mats.base;
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
          <div style={{ color: "#666", fontSize: 12 }}>
            Tip: Shift+Click to multi-select.
          </div>
        </div>
      )}
    </div>
  );
}
