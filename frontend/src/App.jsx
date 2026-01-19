
import React, { useEffect, useState } from 'react';
import ThreeMap from './ThreeMap.jsx';

function App() {
  const [buildings, setBuildings] = useState([]);
  useEffect(() => {
    fetch('http://localhost:5000/api/buildings')
      .then(r => r.json())
      .then(setBuildings);
  }, []);

  return <ThreeMap buildings={buildings} />;
}

export default App;
