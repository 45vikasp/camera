import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { socket } from '../utils/socket';
import { ArrowLeft, SwitchCamera, Zap, ZapOff } from 'lucide-react';

export default function CameraMode() {
  const [roomCode, setRoomCode] = useState(null);
  const [facingMode, setFacingMode] = useState('environment');
  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [status, setStatus] = useState('Initializing...');
  const [viewerConnected, setViewerConnected] = useState(false);
  const [wakeLockActive, setWakeLockActive] = useState(false);

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const wakeLockRef = useRef(null);
  const navigate = useNavigate();

  // STUN + Free TURN servers (needed for Indian mobile networks like Jio/Airtel)
  const iceServers = {
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

  const startCamera = async (mode) => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
    }
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: mode },
        audio: true // Includes microphone as requested
      });
      
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      
      // Check for torch capability
      const videoTrack = stream.getVideoTracks()[0];
      const capabilities = videoTrack.getCapabilities && videoTrack.getCapabilities();
      if (capabilities && capabilities.torch) {
        setHasTorch(true);
      } else {
        setHasTorch(false);
        setTorchOn(false);
      }

      // If we are already connected to a peer, we need to replace the tracks
      if (peerConnectionRef.current) {
        const senders = peerConnectionRef.current.getSenders();
        
        const newAudioTrack = stream.getAudioTracks()[0];
        const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
        if (audioSender && newAudioTrack) {
          audioSender.replaceTrack(newAudioTrack);
        }

        const newVideoTrack = stream.getVideoTracks()[0];
        const videoSender = senders.find(s => s.track && s.track.kind === 'video');
        if (videoSender && newVideoTrack) {
          videoSender.replaceTrack(newVideoTrack);
        }
      }

    } catch (err) {
      console.error("Error accessing camera:", err);
      setStatus("Camera access denied or unavailable.");
    }
  };

  useEffect(() => {
    socket.connect();
    
    // Retrieve or generate a persistent 6-digit code for this device
    let code = localStorage.getItem('cameraCode');
    if (!code) {
      code = Math.floor(100000 + Math.random() * 900000).toString();
      localStorage.setItem('cameraCode', code);
    }
    setRoomCode(code);
    setStatus('Waiting for viewer...');
    
    // Register the camera with this persistent code
    socket.emit('register-camera', code, (response) => {
      console.log("Camera registered on server");
    });

    startCamera(facingMode);

    // Request Wake Lock to prevent screen from turning off
    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request('screen');
          setWakeLockActive(true);
          console.log('Wake Lock acquired - screen will stay on');
          wakeLockRef.current.addEventListener('release', () => {
            setWakeLockActive(false);
          });
        }
      } catch (err) {
        console.log('Wake Lock not supported or denied:', err.message);
      }
    };
    requestWakeLock();

    // Re-acquire wake lock if page becomes visible again
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible' && wakeLockRef.current === null) {
        requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Socket Event Listeners
    socket.on('viewer-joined', async (viewerId) => {
      console.log('Viewer joined:', viewerId);
      setStatus('Viewer connected!');
      setViewerConnected(true);
      createWebRTCPeerConnection(code);
    });

    socket.on('answer', (answer) => {
      console.log('Received answer');
      if (peerConnectionRef.current) {
        peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answer));
      }
    });

    socket.on('ice-candidate', (candidate) => {
      if (peerConnectionRef.current) {
        peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    socket.on('toggle-camera', () => {
      toggleCamera();
    });

    socket.on('toggle-torch', () => {
      toggleTorch();
    });

    return () => {
      socket.off('viewer-joined');
      socket.off('answer');
      socket.off('ice-candidate');
      socket.off('toggle-camera');
      socket.off('toggle-torch');
      socket.disconnect();
      document.removeEventListener('visibilitychange', () => {});
      if (wakeLockRef.current) {
        wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }
    };
  }, []);

  const createWebRTCPeerConnection = async (currentRoomCode) => {
    const pc = new RTCPeerConnection(iceServers);
    peerConnectionRef.current = pc;

    // Send ICE candidates to the viewer
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', {
          roomCode: currentRoomCode,
          candidate: event.candidate,
        });
      }
    };

    // Add local stream tracks to the connection
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, streamRef.current);
      });
    }

    // Create and send an offer
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', {
        roomCode: currentRoomCode,
        offer: offer,
      });
    } catch (err) {
      console.error('Error creating offer:', err);
    }
  };

  const toggleCamera = () => {
    setFacingMode(prev => {
      const newMode = prev === 'environment' ? 'user' : 'environment';
      startCamera(newMode);
      return newMode;
    });
  };

  const toggleTorch = () => {
    if (!streamRef.current) return;
    const videoTrack = streamRef.current.getVideoTracks()[0];
    
    setTorchOn(prevState => {
      const newTorchState = !prevState;
      videoTrack.applyConstraints({
        advanced: [{ torch: newTorchState }]
      }).catch(err => console.error('Error toggling torch:', err));
      return newTorchState;
    });
  };

  return (
    <div className="animate-fade-in" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '16px', display: 'flex', alignItems: 'center', background: 'rgba(0,0,0,0.5)' }}>
        <button className="btn-icon" onClick={() => navigate('/')}>
          <ArrowLeft size={24} color="white" />
        </button>
        <div style={{ marginLeft: '16px' }}>
          <h2 style={{ fontSize: '1.2rem', margin: 0 }}>Camera Mode</h2>
          <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>{status}</span>
        </div>
        {wakeLockActive && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(34, 197, 94, 0.2)', padding: '4px 10px', borderRadius: '20px', border: '1px solid rgba(34, 197, 94, 0.4)' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#22c55e' }} />
            <span style={{ fontSize: '0.75rem', color: '#22c55e' }}>Screen On</span>
          </div>
        )}
      </div>

      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <video 
          ref={videoRef} 
          autoPlay 
          playsInline 
          muted // Muted locally so we don't hear ourselves
          style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute' }}
        />
        
        <div className="overlay-ui">
          <div style={{ textAlign: 'center', marginTop: '40px' }}>
            {!viewerConnected && roomCode && (
              <div className="glass-panel" style={{ display: 'inline-block', padding: '20px 40px', background: 'rgba(0,0,0,0.7)' }}>
                <div style={{ fontSize: '1rem', color: 'var(--text-muted)', marginBottom: '8px' }}>Your Connection Code:</div>
                <div style={{ fontSize: '3rem', letterSpacing: '8px', color: 'white', fontWeight: 'bold' }}>{roomCode}</div>
              </div>
            )}
          </div>
          
          <div className="controls-bar">
            <button className="btn-icon" onClick={toggleCamera} title="Switch Camera">
              <SwitchCamera size={24} color="white" />
            </button>
            {hasTorch && (
              <button className={`btn-icon ${torchOn ? 'btn-primary' : ''}`} onClick={toggleTorch} title="Toggle Flashlight">
                {torchOn ? <Zap size={24} color="white" /> : <ZapOff size={24} color="white" />}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
