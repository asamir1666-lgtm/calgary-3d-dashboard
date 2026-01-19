import * as THREE from "three";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/* ---------------- utils ---------------- */

function safeLabel(v) {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

function lonLatToMercatorMeters(lon, lat) {
  const R = 6378137;
  const x = (R * (lon * Math.PI)) / 180;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [x, y];
}

// shrink polygon toward centroid (creates spacing between buildings)
function insetPolygon(points, factor = 0.92) {
  let cx = 0, cy = 0;
  for (const [x, y] of points) {
    cx += x;
    cy += y;
  }
  cx /= points.length;
  cy /= points.length;

  return points.map(([x, y]) => [
    cx + (x - cx) * factor,
    cy + (y - cy) * factor,
  ]);
}

/* ---------------- component ---------------- */

export default function ThreeMap({
  buildings,
  matchedIds,
  selectedBuildingId,
  onSelectBuilding,
}) {
  const mountRef = useRef(null);
  const rendererRef = useRef(null);
  const meshesRef = useRef([]);

  const [selectedIds, setSelectedIds] = useState(new Set());
  const [selectedInfo, setSelectedInfo] = useState(null);

  // visual tuning
  const HEIGHT_SCALE = 2.8;
  const MIN_HEIGHT = 10;
  const SPACING_FACTOR = 0.90; // 👈 smaller = more space

  const mats = useMemo(() => {
    const wallBase = new THREE.MeshStandardMaterial({
      color: 0xf3f0e8,
      roughness: 0.96,
      metalness: 0.0,
    });

    const roofBase = new THREE.MeshStandardMaterial({
      color: 0xf8f6ef,
      roughness: 0.97,
      metalness: 0.0,
    });

    const wallMatch = new THREE.MeshStandardMaterial({
      color: 0xe05a52,
      roughness: 0.92,
    });

    const roofMatch = new THREE.MeshStandardMaterial({
      color: 0xeb6b65,
      roughness: 0.93,
    });

    const wallSelected = new THREE.MeshStandardMaterial({
      color: 0x4a86e8,
      roughness: 0.9,
    });

    const roofSelected = new THREE.MeshStandardMaterial({
      color: 0x6fa3ff,
      roughness: 0.92,
    });

    const edge = new THREE.LineBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.05,
    });

    return {
      base: [roofBase, roofBase, wallBase],
      match: [roofMatch, roofMatch, wallMatch],
      selected: [roofSelected, roofSelected, wallSelected],
      edge,
    };
  }, []);

  function makeShape(pointsXY) {
    if (!pointsXY || pointsXY.length < 3) return null;

    const pts = pointsXY.map(([x, y]) => new THREE.Vector2(x, y));
    if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();

    const shape = new THREE.Shape();
    shape.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      shape.lineTo(pts[i].x, pts[i].y);
    }
    shape.closePath();
    return shape;
  }

  useEffect(() => {
    if (!mountRef.current) return;

    if (rendererRef.current) {
      rendererRef.current.domElement.remove();
      rendererRef.current.dispose();
    }

    meshesRef.current = [];
    setSelectedIds(new Set());
    setSelectedInfo(null);

    const width = mountRef.current.clientWidth;
    const height = mountRef.current.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf3f5f6);
    scene.fog = new THREE.Fog(0xf3f5f6, 2000, 12000);

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 200000);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.45));

    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(1600, -1200, 2000);
    sun.castShadow = true;
    scene.add(sun);

    // controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.minDistance = 120;
    controls.maxDistance = 22000;

    const group = new THREE.Group();
    scene.add(group);

    // origin
    let originMx = 0, originMy = 0;
    const first = buildings.find(b => b.footprint_ll?.length > 2);
    if (first) {
      [originMx, originMy] = lonLatToMercatorMeters(
        first.footprint_ll[0][0],
        first.footprint_ll[0][1]
      );
    }

    // build buildings
    buildings.forEach((b) => {
      if (!b.footprint_ll || b.footprint_ll.length < 3) return;

      const ptsMeters = b.footprint_ll.map(([lon, lat]) => {
        const [mx, my] = lonLatToMercatorMeters(lon, lat);
        return [mx - originMx, my - originMy];
      });

      const spaced = insetPolygon(ptsMeters, SPACING_FACTOR);
      const shape = makeShape(spaced);
      if (!shape) return;

      const h = Math.max(MIN_HEIGHT, (b.height || 10) * HEIGHT_SCALE);

      const geo = new THREE.ExtrudeGeometry(shape, {
        depth: h,
        bevelEnabled: false,
      });
      geo.computeVertexNormals();

      const mesh = new THREE.Mesh(geo, mats.base);
      mesh.userData = { building: b };
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        mats.edge
      );
      edges.raycast = () => null;
      mesh.add(edges);

      group.add(mesh);
      meshesRef.current.push(mesh);
    });

    // fit camera
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    controls.target.copy(center);
    camera.position.set(
      center.x + size.x * 1.2,
      center.y - size.y * 1.4,
      center.z + size.z * 1.1
    );
    camera.updateProjectionMatrix();

    const applyMaterials = (sel) => {
      meshesRef.current.forEach((m) => {
        const id = m.userData.building.id;
        if (sel.has(id)) m.material = mats.selected;
        else if (matchedIds?.has(id)) m.material = mats.match;
        else m.material = mats.base;
      });
    };

    applyMaterials(new Set());

    // click
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const handleClick = (e) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(meshesRef.current);

      if (hits.length) {
        const b = hits[0].object.userData.building;
        const id = b.id;

        setSelectedIds(new Set([id]));
        onSelectBuilding?.(id);

        setSelectedInfo({
          building: b,
          x: e.clientX - rect.left + 8,
          y: e.clientY - rect.top + 8,
        });

        applyMaterials(new Set([id]));
      } else {
        setSelectedIds(new Set());
        setSelectedInfo(null);
        applyMaterials(new Set());
      }
    };

    renderer.domElement.addEventListener("click", handleClick);

    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      requestAnimationFrame(animate);
    };
    animate();

    return () => {
      renderer.domElement.removeEventListener("click", handleClick);
      renderer.dispose();
    };
  }, [buildings, matchedIds, mats]);

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
            borderRadius: 10,
            padding: 12,
            width: 280,
            boxShadow: "0 12px 30px rgba(0,0,0,0.15)",
            fontSize: 13,
            pointerEvents: "none",
          }}
        >
          <b>{safeLabel(selectedInfo.building.address)}</b>
          <div>Height: {safeLabel(selectedInfo.building.height)}</div>
          <div>Zoning: {safeLabel(selectedInfo.building.zoning)}</div>
          <div>Value: {safeLabel(selectedInfo.building.assessed_value)}</div>
        </div>
      )}
    </div>
  );
}
