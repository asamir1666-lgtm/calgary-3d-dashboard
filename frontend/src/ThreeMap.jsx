import * as THREE from "three";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

function safeLabel(v) {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

// lon/lat degrees -> Web Mercator meters (EPSG:3857)
function lonLatToMercatorMeters(lon, lat) {
  const R = 6378137;
  const x = R * (lon * Math.PI) / 180;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [x, y];
}

// ✅ Simple pitched roof (triangle look) placed on top of a building.
// footprintPts: Array<[x,y]> meters (same coordinate system as extrusions)
// height: building height
function makePitchedRoof(footprintPts, height, roofMat) {
  if (!Array.isArray(footprintPts) || footprintPts.length < 3) return null;

  // centroid
  let cx = 0,
    cy = 0;
  for (const [x, y] of footprintPts) {
    cx += x;
    cy += y;
  }
  cx /= footprintPts.length;
  cy /= footprintPts.length;

  // bbox
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const [x, y] of footprintPts) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  const dx = maxX - minX;
  const dy = maxY - minY;

  // if tiny building footprint, skip roof
  if (!isFinite(dx) || !isFinite(dy) || dx < 4 || dy < 4) return null;

  // roof dimensions
  const roofLen = Math.max(dx, dy);
  const roofWid = Math.min(dx, dy);

  // roof rise based on height
  const rise = Math.max(2.5, Math.min(14, height * 0.2));

  // Make a triangle profile, extrude it
  const tri = new THREE.Shape();
  tri.moveTo(-roofLen / 2, 0);
  tri.lineTo(roofLen / 2, 0);
  tri.lineTo(0, rise);
  tri.closePath();

  const geo = new THREE.ExtrudeGeometry(tri, {
    depth: roofWid,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1,
  });
  geo.computeVertexNormals();

  const roof = new THREE.Mesh(geo, roofMat);
  roof.castShadow = true;
  roof.receiveShadow = true;

  // Put it on top
  roof.position.set(cx, cy, height + 0.15);

  // ExtrudeGeometry extrudes along +Z for depth; rotate so depth becomes Y
  roof.rotation.x = Math.PI / 2;

  // Align roof along long axis
  if (dx < dy) roof.rotation.z = Math.PI / 2;

  // Center the depth
  roof.position.y -= roofWid / 2;

  return roof;
}

export default function ThreeMap({ buildings, matchedIds }) {
  const mountRef = useRef(null);
  const rendererRef = useRef(null);
  const meshesRef = useRef([]);

  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectedInfo, setSelectedInfo] = useState(null);

  // ✅ Map-look tuning
  const HEIGHT_SCALE = 2.2;
  const MIN_HEIGHT = 12;

  const mats = useMemo(() => {
    // Procedural "window" texture
    const makeFacadeTexture = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 512;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;

      ctx.fillStyle = "#7b7f86";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (let x = 0; x < canvas.width; x += 8) {
        const t = (x / canvas.width) * 0.12;
        ctx.fillStyle = `rgba(255,255,255,${t})`;
        ctx.fillRect(x, 0, 1, canvas.height);
      }

      const padX = 18;
      const padY = 18;
      const winW = 14;
      const winH = 18;
      const gapX = 10;
      const gapY = 14;

      for (let y = padY; y < canvas.height - padY; y += winH + gapY) {
        for (let x = padX; x < canvas.width - padX; x += winW + gapX) {
          const lit = Math.random() < 0.18;
          ctx.fillStyle = lit
            ? "rgba(255, 244, 214, 0.85)"
            : "rgba(30, 36, 44, 0.55)";
          ctx.fillRect(x, y, winW, winH);
        }
      }

      ctx.fillStyle = "rgba(0,0,0,0.08)";
      for (let y = 0; y < canvas.height; y += 64) {
        ctx.fillRect(0, y, canvas.width, 2);
      }

      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(1.2, 1.0);
      tex.anisotropy = 8;
      tex.needsUpdate = true;
      return tex;
    };

    const facadeTex = makeFacadeTexture();

    const wallBase = new THREE.MeshStandardMaterial({
      map: facadeTex || null,
      color: 0x9aa0a6,
      roughness: 0.92,
      metalness: 0.02,
      emissive: 0x000000,
      emissiveIntensity: 0.25,
    });

    const roofBase = new THREE.MeshStandardMaterial({
      color: 0x7c828a,
      roughness: 0.95,
      metalness: 0.02,
    });

    const wallMatch = wallBase.clone();
    wallMatch.color = new THREE.Color(0xd93025);
    wallMatch.emissive = new THREE.Color(0x6b1a16);
    wallMatch.emissiveIntensity = 0.55;

    const roofMatch = roofBase.clone();
    roofMatch.color = new THREE.Color(0xb3261e);

    const wallSelected = wallBase.clone();
    wallSelected.color = new THREE.Color(0x1a73e8);
    wallSelected.emissive = new THREE.Color(0x0b2a66);
    wallSelected.emissiveIntensity = 0.6;

    const roofSelected = roofBase.clone();
    roofSelected.color = new THREE.Color(0x1558b0);

    return {
      base: [roofBase, roofBase, wallBase],
      match: [roofMatch, roofMatch, wallMatch],
      selected: [roofSelected, roofSelected, wallSelected],

      // ✅ for pitched roofs: reuse roofBase etc
      roofBase,
      roofMatch,
      roofSelected,

      ground: new THREE.MeshStandardMaterial({
        color: 0xf2f2f2,
        roughness: 1.0,
        metalness: 0.0,
      }),
      edge: new THREE.LineBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.12,
      }),
    };
  }, []);

  function makeShape(pointsXY) {
    if (!Array.isArray(pointsXY) || pointsXY.length < 3) return null;

    let pts = pointsXY.map(([x, y]) => new THREE.Vector2(Number(x), Number(y)));

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
    scene.background = new THREE.Color(0xeceff1);
    scene.fog = new THREE.Fog(0xeceff1, 1500, 9000);

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 200000);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio || 1);

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(1200, -900, 1800);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 9000;
    sun.shadow.camera.left = -4000;
    sun.shadow.camera.right = 4000;
    sun.shadow.camera.top = 4000;
    sun.shadow.camera.bottom = -4000;
    scene.add(sun);

    const fill = new THREE.DirectionalLight(0xffffff, 0.25);
    fill.position.set(-900, 1200, 900);
    scene.add(fill);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.screenSpacePanning = false;
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.minDistance = 80;
    controls.maxDistance = 14000;

    const group = new THREE.Group();
    scene.add(group);

    // ----- origin -----
    let originMx = 0;
    let originMy = 0;

    const first = buildings?.find(
      (b) => Array.isArray(b?.footprint_ll) && b.footprint_ll.length > 2
    );
    if (first) {
      const [lon0, lat0] = first.footprint_ll[0];
      [originMx, originMy] = lonLatToMercatorMeters(Number(lon0), Number(lat0));
    }

    // Build meshes (3D model map style)
    buildings.forEach((b) => {
      const ll = b.footprint_ll;
      if (!Array.isArray(ll) || ll.length < 3) return;

      const ptsMeters = ll.map(([lon, lat]) => {
        const [mx, my] = lonLatToMercatorMeters(Number(lon), Number(lat));
        return [mx - originMx, my - originMy];
      });

      const shape = makeShape(ptsMeters);
      if (!shape) return;

      // ✅ vary height slightly so it looks like a real map model
      const rawH = Number(b.height) || 10;
      const jitter = 0.85 + Math.random() * 0.55; // 0.85..1.40
      const h = Math.max(MIN_HEIGHT, rawH * HEIGHT_SCALE * jitter);

      // main "box" building
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

      // outline
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), mats.edge);
      edges.raycast = () => null;
      mesh.add(edges);

      group.add(mesh);
      meshesRef.current.push(mesh);

      // ✅ add pitched roof to some buildings
      if (Math.random() < 0.35) {
        const roof = makePitchedRoof(ptsMeters, h, mats.roofBase);
        if (roof) group.add(roof);
      }
    });

    // Ground sized to content
    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const groundSize = Math.max(size.x, size.y) * 2.2 || 3500;

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(groundSize, groundSize),
      mats.ground
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(center.x, center.y, 0);
    ground.receiveShadow = true;
    scene.add(ground);

    // single subtle grid
    const gridHelper = new THREE.GridHelper(groundSize, 110, 0x000000, 0x000000);
    gridHelper.position.set(center.x, center.y, 0.01);
    if (Array.isArray(gridHelper.material)) {
      gridHelper.material.forEach((m) => {
        m.transparent = true;
        m.opacity = 0.08;
      });
    } else {
      gridHelper.material.transparent = true;
      gridHelper.material.opacity = 0.08;
    }
    scene.add(gridHelper);

    // Fit camera
    const maxDim = Math.max(size.x, size.y, size.z) || 400;
    controls.target.copy(center);

    camera.near = 0.1;
    camera.far = maxDim * 60 + 16000;

    // more "map model" angle (slightly higher + tilted)
    camera.position.set(
      center.x + maxDim * 1.3,
      center.y - maxDim * 1.75,
      center.z + maxDim * 1.25
    );
    camera.updateProjectionMatrix();

    // selection/highlight
    const applyMaterials = (selIds) => {
      meshesRef.current.forEach((m) => {
        const bid = m.userData.building?.id;
        const isMatch = matchedIds?.has?.(bid);
        const isSel = selIds?.has?.(bid);
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

    applyMaterials(new Set());

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", handleResize);
      renderer.domElement.removeEventListener("click", handleClick);
      renderer.domElement?.remove();
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildings, mats]);

  // update highlights when matchedIds changes
  useEffect(() => {
    meshesRef.current.forEach((m) => {
      const bid = m.userData.building?.id;
      const isSelected = selectedIds?.has?.(bid);
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

          <div style={{ marginBottom: 10, color: "#555", fontSize: 12 }}>
            Selected: <b>{selectedIds.size}</b> (Shift+Click to multi-select)
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
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: 11,
            }}
          >
            {JSON.stringify(selectedInfo.building.properties || {}, null, 2)}
          </div>
        </div>
      )}
    </div>
  );
}
