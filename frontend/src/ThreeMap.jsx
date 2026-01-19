import * as THREE from "three";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

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

function hash01(str) {
  const s = String(str ?? "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function centroidXY(pts) {
  let cx = 0,
    cy = 0;
  for (const [x, y] of pts) {
    cx += x;
    cy += y;
  }
  return [cx / pts.length, cy / pts.length];
}

function makePitchedRoof(footprintPts, height, roofMat) {
  if (!Array.isArray(footprintPts) || footprintPts.length < 3) return null;

  const [cx, cy] = centroidXY(footprintPts);

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
  if (!isFinite(dx) || !isFinite(dy) || dx < 6 || dy < 6) return null;

  const roofLen = Math.max(dx, dy);
  const roofWid = Math.min(dx, dy);
  const rise = Math.max(2.5, Math.min(16, height * 0.22));

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

  roof.position.set(cx, cy, height + 0.2);
  roof.rotation.x = Math.PI / 2;

  if (dx < dy) roof.rotation.z = Math.PI / 2;

  roof.position.y -= roofWid / 2;

  return roof;
}

export default function ThreeMap({
  buildings,
  matchedIds,
  selectedBuildingId,
  onSelectBuilding,
}) {
  const mountRef = useRef(null);
  const rendererRef = useRef(null);

  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);

  const meshesRef = useRef([]); // building meshes only
  const centroidByIdRef = useRef(new Map()); // id -> {x,y,z}

  const [selectedInfo, setSelectedInfo] = useState(null);

  const HEIGHT_SCALE = 3.0;
  const MIN_HEIGHT = 10;

  const mats = useMemo(() => {
    const wallMatch = new THREE.MeshStandardMaterial({
      color: 0xd93025,
      roughness: 0.85,
      metalness: 0.02,
      emissive: 0x5b1512,
      emissiveIntensity: 0.55,
    });
    const roofMatch = new THREE.MeshStandardMaterial({
      color: 0xb3261e,
      roughness: 0.9,
      metalness: 0.02,
    });

    const wallSelected = new THREE.MeshStandardMaterial({
      color: 0x1a73e8,
      roughness: 0.82,
      metalness: 0.02,
      emissive: 0x0b2a66,
      emissiveIntensity: 0.6,
    });
    const roofSelected = new THREE.MeshStandardMaterial({
      color: 0x1558b0,
      roughness: 0.9,
      metalness: 0.02,
    });

    const ground = new THREE.MeshStandardMaterial({
      color: 0xf2f2f2,
      roughness: 1.0,
      metalness: 0.0,
    });

    const platform = new THREE.MeshStandardMaterial({
      color: 0xe7e7e7,
      roughness: 1.0,
      metalness: 0.0,
    });

    const road = new THREE.MeshStandardMaterial({
      color: 0x2b2b2b,
      roughness: 1.0,
      metalness: 0.0,
    });

    const majorRoad = new THREE.MeshStandardMaterial({
      color: 0x1f1f1f,
      roughness: 1.0,
      metalness: 0.0,
    });

    const edge = new THREE.LineBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.12,
    });

    return {
      match: [roofMatch, roofMatch, wallMatch],
      selected: [roofSelected, roofSelected, wallSelected],
      ground,
      platform,
      road,
      majorRoad,
      edge,
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

  function applyMaterials() {
    const selId = selectedBuildingId ?? null;

    for (const m of meshesRef.current) {
      const bid = m.userData.building?.id;
      const isMatch = matchedIds?.has?.(bid);
      const isSel = selId !== null && bid === selId;

      if (isSel) m.material = mats.selected;
      else if (isMatch) m.material = mats.match;
      else m.material = m.userData.baseMatArray;
    }
  }

  function focusOnBuildingId(bid) {
    if (!bid) return;
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    const cent = centroidByIdRef.current.get(bid);
    if (!controls || !camera || !cent) return;

    const target = new THREE.Vector3(cent.x, cent.y, 0);
    controls.target.copy(target);

    // go to a nice angle
    const dist = 900;
    camera.position.set(target.x + dist * 0.9, target.y - dist * 1.2, Math.max(260, cent.z + 420));
    camera.updateProjectionMatrix();
  }

  useEffect(() => {
    if (!mountRef.current) return;

    // cleanup
    if (rendererRef.current) {
      rendererRef.current.domElement?.remove();
      rendererRef.current.dispose();
    }

    meshesRef.current = [];
    centroidByIdRef.current = new Map();
    setSelectedInfo(null);

    const width = mountRef.current.clientWidth;
    const height = mountRef.current.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xeceff1);
    scene.fog = new THREE.Fog(0xeceff1, 2000, 14000);

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 250000);

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

    sceneRef.current = scene;
    cameraRef.current = camera;

    scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(1600, -1200, 2200);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 14000;
    sun.shadow.camera.left = -6000;
    sun.shadow.camera.right = 6000;
    sun.shadow.camera.top = 6000;
    sun.shadow.camera.bottom = -6000;
    scene.add(sun);

    const fill = new THREE.DirectionalLight(0xffffff, 0.22);
    fill.position.set(-1200, 1600, 1100);
    scene.add(fill);

    const controls = new OrbitControls(camera, renderer.domElement);
    controlsRef.current = controls;
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.screenSpacePanning = false;
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.minDistance = 120;
    controls.maxDistance = 22000;

    const group = new THREE.Group();
    scene.add(group);

    // origin
    let originMx = 0;
    let originMy = 0;

    const first = buildings?.find(
      (b) => Array.isArray(b?.footprint_ll) && b.footprint_ll.length > 2
    );
    if (first) {
      const [lon0, lat0] = first.footprint_ll[0];
      [originMx, originMy] = lonLatToMercatorMeters(Number(lon0), Number(lat0));
    }

    const centroids = [];

    buildings.forEach((b) => {
      const ll = b.footprint_ll;
      if (!Array.isArray(ll) || ll.length < 3) return;

      const ptsMeters = ll.map(([lon, lat]) => {
        const [mx, my] = lonLatToMercatorMeters(Number(lon), Number(lat));
        return [mx - originMx, my - originMy];
      });

      const shape = makeShape(ptsMeters);
      if (!shape) return;

      const baseH = Number(b.height) || 10;
      const r = hash01(b.id ?? b.address ?? JSON.stringify(ll).slice(0, 40));
      const jitter = 0.9 + r * 0.7;
      const h = Math.max(MIN_HEIGHT, baseH * HEIGHT_SCALE * jitter);

      const hue = 0.55 + r * 0.12;
      const sat = 0.08 + r * 0.1;
      const light = 0.55 + r * 0.12;

      const wallColor = new THREE.Color().setHSL(hue, sat, light);
      const roofColor = new THREE.Color().setHSL(hue, sat * 0.7, light * 0.85);

      const wallMat = new THREE.MeshStandardMaterial({
        color: wallColor,
        roughness: 0.9,
        metalness: 0.02,
      });

      const roofMat = new THREE.MeshStandardMaterial({
        color: roofColor,
        roughness: 0.95,
        metalness: 0.02,
      });

      const baseMatArray = [roofMat, roofMat, wallMat];

      const geo = new THREE.ExtrudeGeometry(shape, {
        depth: h,
        bevelEnabled: false,
        curveSegments: 1,
        steps: 1,
      });
      geo.computeVertexNormals();

      const mesh = new THREE.Mesh(geo, baseMatArray);
      mesh.userData = { building: b, baseMatArray };
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), mats.edge);
      edges.raycast = () => null;
      mesh.add(edges);

      group.add(mesh);
      meshesRef.current.push(mesh);

      const [cx, cy] = centroidXY(ptsMeters);
      centroids.push({ id: b.id, x: cx, y: cy, z: h });
      centroidByIdRef.current.set(b.id, { x: cx, y: cy, z: h });

      if (r < 0.35) {
        const roof = makePitchedRoof(ptsMeters, h, roofMat);
        if (roof) group.add(roof);
      }
    });

    // fit bounds
    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const groundSize = Math.max(size.x, size.y) * 2.4 || 4500;

    // platform
    const platformThickness = Math.max(20, groundSize * 0.005);
    const platform = new THREE.Mesh(
      new THREE.BoxGeometry(groundSize, groundSize, platformThickness),
      mats.platform
    );
    platform.position.set(center.x, center.y, -platformThickness / 2);
    platform.receiveShadow = true;
    scene.add(platform);

    // ground
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(groundSize, groundSize), mats.ground);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(center.x, center.y, 0);
    ground.receiveShadow = true;
    scene.add(ground);

    // grid
    const gridHelper = new THREE.GridHelper(groundSize, 120, 0x000000, 0x000000);
    gridHelper.position.set(center.x, center.y, 0.02);
    if (Array.isArray(gridHelper.material)) {
      gridHelper.material.forEach((m) => {
        m.transparent = true;
        m.opacity = 0.1;
      });
    } else {
      gridHelper.material.transparent = true;
      gridHelper.material.opacity = 0.1;
    }
    scene.add(gridHelper);

    // roads
    const roadsGroup = new THREE.Group();
    scene.add(roadsGroup);

    const majorStep = groundSize / 6;
    const majorWidth = Math.max(18, groundSize * 0.006);

    for (let i = -3; i <= 3; i++) {
      const x = center.x + i * majorStep;
      const roadV = new THREE.Mesh(new THREE.PlaneGeometry(majorWidth, groundSize), mats.majorRoad);
      roadV.rotation.x = -Math.PI / 2;
      roadV.position.set(x, center.y, 0.03);
      roadV.receiveShadow = true;
      roadsGroup.add(roadV);

      const y = center.y + i * majorStep;
      const roadH = new THREE.Mesh(new THREE.PlaneGeometry(groundSize, majorWidth), mats.majorRoad);
      roadH.rotation.x = -Math.PI / 2;
      roadH.position.set(center.x, y, 0.03);
      roadH.receiveShadow = true;
      roadsGroup.add(roadH);
    }

    const maxLinksPerNode = 2;
    const roadWidth = Math.max(8, groundSize * 0.003);
    const maxRoadLen = groundSize * 0.18;

    for (let i = 0; i < centroids.length; i++) {
      const a = centroids[i];
      const dists = [];
      for (let j = 0; j < centroids.length; j++) {
        if (i === j) continue;
        const b = centroids[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > 0 && d < maxRoadLen) dists.push({ j, d });
      }
      dists.sort((p, q) => p.d - q.d);

      for (let k = 0; k < Math.min(maxLinksPerNode, dists.length); k++) {
        const b = centroids[dists[k].j];
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const len = dists[k].d;

        const seg = new THREE.Mesh(new THREE.PlaneGeometry(roadWidth, len), mats.road);
        seg.rotation.x = -Math.PI / 2;

        const ang = Math.atan2(b.x - a.x, b.y - a.y);
        seg.rotation.z = ang;

        seg.position.set(midX, midY, 0.04);
        seg.receiveShadow = true;
        roadsGroup.add(seg);
      }
    }

    // camera
    const maxDim = Math.max(size.x, size.y, size.z) || 600;
    controls.target.copy(center);

    camera.near = 0.1;
    camera.far = maxDim * 80 + 20000;
    camera.position.set(center.x + maxDim * 1.6, center.y - maxDim * 2.1, center.z + maxDim * 1.25);
    camera.updateProjectionMatrix();

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
        const bid = building?.id ?? null;

        if (bid !== null && bid !== undefined) {
          onSelectBuilding?.(bid); // ✅ sends to App so it gets saved
          applyMaterials();
          focusOnBuildingId(bid);
        }

        setSelectedInfo({
          building,
          x: ev.clientX - rect.left + 8,
          y: ev.clientY - rect.top + 8,
        });
      } else {
        onSelectBuilding?.(null);
        applyMaterials();
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

    // initial paint + focus
    applyMaterials();
    if (selectedBuildingId) focusOnBuildingId(selectedBuildingId);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", handleResize);
      renderer.domElement.removeEventListener("click", handleClick);
      renderer.domElement?.remove();
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildings, mats]);

  // update visuals when matched or selected changes
  useEffect(() => {
    applyMaterials();
    if (selectedBuildingId) focusOnBuildingId(selectedBuildingId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchedIds, selectedBuildingId]);

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
