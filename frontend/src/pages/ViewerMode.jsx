import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { socket } from '../utils/socket';
import { ArrowLeft, SwitchCamera, Zap, RefreshCw } from 'lucide-react';

// STUN + Free TURN servers (needed for Indian mobile networks like Jio/Airtel)
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:openrelay.metered.ca:80' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
};

export default function ViewerMode() {
  const [codeInput, setCodeInput] = useState('');
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [isReconnecting, setIsReconnecting] = useState(false);

  const videoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const roomCodeRef = useRef('');
  const candidateQueue = useRef([]);
  const navigate = useNavigate();

  const cleanupPeer = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
  };

  const handleOffer = useCallback(async (offer) => {
    console.log('Received offer, creating peer connection...');
    setStatus('Connecting to camera...');
    setIsReconnecting(false);
    cleanupPeer();

    const pc = new RTCPeerConnection(ICE_SERVERS);
    peerConnectionRef.current = pc;

    pc.ontrack = (event) => {
      console.log('Got remote track:', event.track.kind, event.streams);
      let stream;
      if (event.streams && event.streams[0]) {
        stream = event.streams[0];
      } else {
        stream = new MediaStream([event.track]);
      }
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // Explicitly call play() - required on mobile browsers
        videoRef.current.play().catch(e => console.warn('Video play error:', e));
        setStatus('Live');
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      console.log('ICE state:', state);
      if (state === 'failed') {
        setStatus('Connection failed. Reconnecting...');
        setIsReconnecting(true);
        // Auto-reconnect: re-join the room so camera sends a new offer
        setTimeout(() => {
          if (roomCodeRef.current) {
            socket.emit('join-room', roomCodeRef.current, (res) => {
              if (!res.success) {
                setStatus('Could not reconnect. Please refresh.');
                setIsReconnecting(false);
              }
            });
          }
        }, 2000);
      } else if (state === 'disconnected') {
        // Temporary - don't panic, may recover
        setStatus('Reconnecting...');
        setIsReconnecting(true);
      } else if (state === 'connected' || state === 'completed') {
        setStatus('Live');
        setIsReconnecting(false);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', {
          roomCode: roomCodeRef.current,
          candidate: event.candidate,
        });
      }
    };

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      
      // Process any queued candidates
      while (candidateQueue.current.length > 0) {
        const c = candidateQueue.current.shift();
        pc.addIceCandidate(new RTCIceCandidate(c)).catch(e => console.warn('ICE add error:', e));
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', {
        roomCode: roomCodeRef.current,
        answer: answer,
      });
      console.log('Answer sent');
    } catch (err) {
      console.error('Error handling offer:', err);
      setError('Failed to connect. Try again.');
      setStatus('');
    }
  }, []);

  const handleIceCandidate = useCallback((candidate) => {
    if (peerConnectionRef.current) {
      if (peerConnectionRef.current.remoteDescription) {
        peerConnectionRef.current
          .addIceCandidate(new RTCIceCandidate(candidate))
          .catch(e => console.warn('ICE candidate error (safe to ignore):', e));
      } else {
        candidateQueue.current.push(candidate);
      }
    }
  }, []);

  useEffect(() => {
    socket.connect();
    socket.on('offer', handleOffer);
    socket.on('ice-candidate', handleIceCandidate);

    return () => {
      socket.off('offer', handleOffer);
      socket.off('ice-candidate', handleIceCandidate);
      socket.disconnect();
      cleanupPeer();
    };
  }, [handleOffer, handleIceCandidate]);

  const handleJoin = (e) => {
    e.preventDefault();
    setError('');
    if (codeInput.length !== 6) {
      setError('Code must be 6 digits.');
      return;
    }
    setStatus('Joining room...');
    roomCodeRef.current = codeInput;

    socket.emit('join-room', codeInput, (response) => {
      if (response.success) {
        setJoined(true);
        setStatus('Waiting for video stream...');
      } else {
        setError('Invalid code. Is the camera phone open on Share Camera?');
        setStatus('');
        roomCodeRef.current = '';
      }
    });
  };

  const handleManualReconnect = () => {
    setIsReconnecting(true);
    setStatus('Reconnecting...');
    cleanupPeer();
    socket.emit('join-room', roomCodeRef.current, (res) => {
      if (!res.success) {
        setStatus('Could not reconnect. Refresh and try again.');
        setIsReconnecting(false);
      }
    });
  };

  const remoteToggleCamera = () => socket.emit('toggle-camera', roomCodeRef.current);
  const remoteToggleTorch = () => socket.emit('toggle-torch', roomCodeRef.current);

  const isLive = status === 'Live';

  return (
    <div className="animate-fade-in" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '16px', display: 'flex', alignItems: 'center', background: 'rgba(0,0,0,0.5)', zIndex: 10 }}>
        <button className="btn-icon" onClick={() => navigate('/')}>
          <ArrowLeft size={24} color="white" />
        </button>
        <div style={{ marginLeft: '16px' }}>
          <h2 style={{ fontSize: '1.2rem', margin: 0 }}>Viewer Mode</h2>
          <span style={{ fontSize: '0.9rem', color: isLive ? '#22c55e' : 'var(--text-muted)' }}>
            {status}
          </span>
        </div>
        {isReconnecting && (
          <button
            className="btn-icon"
            style={{ marginLeft: 'auto' }}
            onClick={handleManualReconnect}
            title="Reconnect"
          >
            <RefreshCw size={20} color="white" />
          </button>
        )}
      </div>

      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {!joined ? (
          <div className="glass-panel" style={{ padding: '40px', maxWidth: '400px', width: '100%', margin: '0 20px' }}>
            <h3 style={{ marginBottom: '8px', textAlign: 'center', fontSize: '1.5rem' }}>Enter Camera Code</h3>
            <p style={{ textAlign: 'center', color: 'var(--text-muted)', marginBottom: '24px', fontSize: '0.9rem' }}>
              Open the app on your old phone, go to "Share Camera", and enter the code shown there
            </p>
            <form onSubmit={handleJoin} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <input
                type="text"
                inputMode="numeric"
                maxLength="6"
                placeholder="000000"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, ''))}
                className="input-field"
                autoFocus
              />
              {error && <div style={{ color: 'var(--danger)', textAlign: 'center', fontWeight: '500' }}>{error}</div>}
              <button type="submit" className="btn btn-primary" style={{ padding: '16px' }}>
                Connect
              </button>
            </form>
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted={false}
              style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', background: '#000' }}
            />

            {!isLive && (
              <div style={{
                position: 'absolute', top: '50%', left: '50%',
                transform: 'translate(-50%, -50%)',
                textAlign: 'center', zIndex: 5
              }}>
                <div style={{ width: '48px', height: '48px', border: '4px solid var(--primary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 12px' }} />
                <p style={{ color: 'var(--text-muted)' }}>{status || 'Connecting...'}</p>
              </div>
            )}

            <div className="overlay-ui">
              <div />
              <div className="controls-bar">
                <button className="btn-icon" onClick={remoteToggleCamera} title="Switch Remote Camera">
                  <SwitchCamera size={24} color="white" />
                </button>
                <button className="btn-icon" onClick={remoteToggleTorch} title="Toggle Remote Flashlight">
                  <Zap size={24} color="white" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
