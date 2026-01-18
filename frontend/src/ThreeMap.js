
import * as THREE from 'three';
import { useEffect } from 'react';

export default function ThreeMap({ buildings }) {
  useEffect(() => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 1, 10000);
    const renderer = new THREE.WebGLRenderer();
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    buildings.forEach(b => {
      if (!b.geom) return;
      const coords = b.geom.coordinates[0];
      const shape = new THREE.Shape(coords.map(c => new THREE.Vector2(c[0]*10000, c[1]*10000)));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: Number(b.height) || 10, bevelEnabled: false });
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 'gray' }));
      scene.add(mesh);
    });

    camera.position.set(0, -500, 500);
    renderer.render(scene, camera);
  }, [buildings]);

  return null;
}
