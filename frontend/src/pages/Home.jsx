import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Camera, Eye } from 'lucide-react';

export default function Home() {
  const navigate = useNavigate();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: '20px' }} className="animate-fade-in">
      <div className="glass-panel" style={{ padding: '40px', textAlign: 'center', maxWidth: '400px', width: '100%' }}>
        <h1 style={{ fontSize: '2.5rem', marginBottom: '10px', color: 'white' }}>RemoCam</h1>
        <p style={{ color: 'var(--text-muted)', marginBottom: '40px' }}>Turn your old phone into a remote security camera.</p>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <button 
            className="btn btn-primary" 
            onClick={() => navigate('/camera')}
            style={{ padding: '16px', fontSize: '1.2rem' }}
          >
            <Camera size={24} />
            Share Camera
          </button>
          
          <button 
            className="btn glass-panel" 
            onClick={() => navigate('/viewer')}
            style={{ padding: '16px', fontSize: '1.2rem', backgroundColor: 'rgba(255,255,255,0.1)' }}
          >
            <Eye size={24} />
            View Camera
          </button>
        </div>
      </div>
    </div>
  );
}
