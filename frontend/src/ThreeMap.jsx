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
  const x = R * (lon * Math.PI / 180);
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 360)));
  return [x, y];
}

export default function ThreeMap({ buildings, matchedIds }) {
  const mountRef = useRef(null);
  const rendererRef = useRef(null);
  const meshesRef = useRef([]);
  const [selected, setSelected] = useState(null);

  // tune these
  const HEIGHT_SCALE = 1.0; // now that coords are meters, start at 1.0
  const MIN_HEIGHT = 8;     // meters

  const mats = useMemo(() => {
    return {
      base: new THREE.MeshStandardMaterial({ color: 0xa3a7ad, roughness: 0.85, metalness: 0.02 }),
      match: new THREE.MeshStandardMaterial({ color: 0xd93025, roughness: 0.75, metalness: 0.02 }),
      selected: new THREE.MeshStandardMaterial({ color: 0x1a73e8, roughness: 0.65, metalness: 0.05 }),
      ground: new THREE.MeshStandardMaterial({ color: 0xf3f3f3, roughness: 1.0, metalness: 0.0 }),
      edge: new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16 }),
    };
  }, []);

  function makeShape(pointsXY) {
    if (!Array.isArray(pointsXY) || pointsXY.length < 3) return null;

    let pts = pointsXY.map(([x, y]) => new THREE.Vector2(Number(x), Number(y)));

    // Drop duplicate last point if same as first
    if (pts.length >= 2) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      if (a.distanceTo(b) < 0.01) pts = pts.slice(0, -1); // meters now, so 0.01m is safe
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
    scene.background = new THREE.Color(0xeceff1);
    scene.fog = new THREE.Fog(0xeceff1, 1500, 9000);

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 200000);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio || 1);

    // ✅ better “map” look
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    // ✅ shadows
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // lights (more directional, less flat)
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(1200, -900, 1800);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 8000;
    sun.shadow.camera.left = -3000;
    sun.shadow.camera.right = 3000;
    sun.shadow.camera.top = 3000;
    sun.shadow.camera.bottom = -3000;
    scene.add(sun);

    // subtle fill to avoid harsh contrast
    const fill = new THREE.DirectionalLight(0xffffff, 0.25);
    fill.position.set(-900, 1200, 900);
    scene.add(fill);

    // controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.screenSpacePanning = false;
    controls.maxPolarAngle = Math.PI / 2.05; // don’t go under ground
    controls.minDistance = 80;
    controls.maxDistance = 12000;

    const group = new THREE.Group();
    scene.add(group);

    // ----- Convert buildings to meters + choose a consistent origin -----
    // Use bbox center from your data if available, otherwise center of first building.
    let originMx = 0;
    let originMy = 0;

    const first = buildings?.find((b) => Array.isArray(b?.footprint_ll) && b.footprint_ll.length > 2);
    if (first) {
      const [lon0, lat0] = first.footprint_ll[0];
      [originMx, originMy] = lonLatToMercatorMeters(Number(lon0), Number(lat0));
    }

    // Build meshes
    buildings.forEach((b, i) => {
      const ll = b.footprint_ll; // ✅ use lon/lat from API
      if (!Array.isArray(ll) || ll.length < 3) return;

      const ptsMeters = ll.map(([lon, lat]) => {
        const [mx, my] = lonLatToMercatorMeters(Number(lon), Number(lat));
        return [mx - originMx, my - originMy];
      });

      const shape = makeShape(ptsMeters);
      if (!shape) return;

      const rawH = Number(b.height) || 10;
      const h = Math.max(MIN_HEIGHT, rawH * HEIGHT_SCALE);

      // Extrude in +Z, then rotate so Z is up and polygon sits on ground plane.
      const geo = new THREE.ExtrudeGeometry(shape, {
        depth: h,
        bevelEnabled: false,
        curveSegments: 2,
        steps: 1,
      });
      geo.computeVertexNormals();

      const mesh = new THREE.Mesh(geo, mats.base);
      mesh.userData = { building: b };
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      // outline
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), mats.edge);
      edges.raycast = () => null;
      mesh.add(edges);

      group.add(mesh);
      meshesRef.current.push(mesh);
    });

    // Ground sized to content
    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const groundSize = Math.max(size.x, size.y) * 1.6 || 2500;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(groundSize, groundSize), mats.ground);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(center.x, center.y, 0);
    ground.receiveShadow = true;
    scene.add(ground);

    // Fit camera
    const maxDim = Math.max(size.x, size.y, size.z) || 400;
    controls.target.copy(center);

    camera.near = 0.1;
    camera.far = maxDim * 40 + 10000;
    camera.position.set(center.x + maxDim * 0.9, center.y - maxDim * 1.4, center.z + maxDim * 0.8);
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
