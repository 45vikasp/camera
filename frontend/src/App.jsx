import { HashRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import CameraMode from './pages/CameraMode';
import ViewerMode from './pages/ViewerMode';
import './index.css';

function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/camera" element={<CameraMode />} />
        <Route path="/viewer" element={<ViewerMode />} />
      </Routes>
    </HashRouter>
  );
}

export default App;
