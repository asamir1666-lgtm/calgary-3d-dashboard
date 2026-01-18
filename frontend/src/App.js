
import React, { useEffect, useState } from 'react';
import ThreeMap from './ThreeMap';

function App() {
  const [buildings, setBuildings] = useState([]);
  useEffect(() => {
    fetch('https://calgary-3d-dashboard-q63w.onrender.com')
      .then(r => r.json())
      .then(setBuildings);
  }, []);

  return <ThreeMap buildings={buildings} />;
}

export default App;
