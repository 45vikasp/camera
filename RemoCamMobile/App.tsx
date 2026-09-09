/**
 * RemoCam Mobile App
 * Clean rewrite - no module-level side effects
 */

import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  SafeAreaView,
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Alert,
  Platform,
  PermissionsAndroid,
  StatusBar,
} from 'react-native';

const BACKEND_URL = 'https://camera-i73y.onrender.com';

let RTCPeerConnection: any = null;
let RTCIceCandidate: any = null;
let RTCSessionDescription: any = null;
let mediaDevices: any = null;
let RTCView: any = null;
let io: any = null;
let ReactNativeForegroundService: any = null;

// Lazy load all native modules to prevent crash on startup
function loadNativeModules() {
  try {
    const webrtc = require('react-native-webrtc');
    RTCPeerConnection = webrtc.RTCPeerConnection;
    RTCIceCandidate = webrtc.RTCIceCandidate;
    RTCSessionDescription = webrtc.RTCSessionDescription;
    mediaDevices = webrtc.mediaDevices;
    RTCView = webrtc.RTCView;
  } catch (e) {
    console.error('WebRTC load failed:', e);
    return false;
  }
  try {
    io = require('socket.io-client').io;
  } catch (e) {
    console.error('Socket.io load failed:', e);
    return false;
  }
  try {
    ReactNativeForegroundService = require('@supersami/rn-foreground-service').default;
    ReactNativeForegroundService.register();
  } catch (e) {
    // foreground service optional - app can work without it
    console.warn('ForegroundService load failed (non-fatal):', e);
    ReactNativeForegroundService = null;
  }
  return true;
}

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
  ],
};

export default function App() {
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [isSharing, setIsSharing] = useState(false);
  const [status, setStatus] = useState('Press "Start Sharing" to begin');
  const [localStream, setLocalStream] = useState<any>(null);

  const socketRef = useRef<any>(null);
  const peerConnectionRef = useRef<any>(null);
  const streamRef = useRef<any>(null);

  useEffect(() => {
    // Initialize everything inside useEffect - never at module level
    try {
      const ok = loadNativeModules();
      if (!ok) {
        setInitError('Failed to load camera modules. Please restart the app.');
        return;
      }
      // Generate room code
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      setRoomCode(code);
      setReady(true);
    } catch (e: any) {
      setInitError(`Initialization error: ${e?.message || 'Unknown error'}`);
    }

    return () => {
      cleanup();
    };
  }, []);

  const cleanup = useCallback(() => {
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t: any) => t.stop());
        streamRef.current = null;
      }
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      if (ReactNativeForegroundService) {
        try { ReactNativeForegroundService.stop(); } catch (_) {}
      }
    } catch (e) {
      console.warn('Cleanup error:', e);
    }
  }, []);

  const requestPermissions = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;
    try {
      const grants = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.CAMERA,
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        ...(Platform.Version >= 33 ? [PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS] : []),
      ]);
      const cameraOk = grants[PermissionsAndroid.PERMISSIONS.CAMERA] === PermissionsAndroid.RESULTS.GRANTED;
      const micOk = grants[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] === PermissionsAndroid.RESULTS.GRANTED;
      if (!cameraOk || !micOk) {
        Alert.alert('Permission Denied', 'Camera and Microphone permissions are required.');
        return false;
      }
      return true;
    } catch (e) {
      console.warn('Permission error:', e);
      return false;
    }
  }, []);

  const startForegroundService = useCallback(() => {
    if (!ReactNativeForegroundService) return;
    try {
      ReactNativeForegroundService.start({
        id: 3456,
        title: 'RemoCam is Active',
        message: 'Camera is sharing in the background',
        icon: 'ic_launcher',
        setOnlyAlertOnce: true,
        color: '#3b82f6',
      });
    } catch (e) {
      console.warn('ForegroundService start error (non-fatal):', e);
    }
  }, []);

  const startSharing = useCallback(async () => {
    if (!ready) return;

    setStatus('Requesting permissions...');
    const hasPerms = await requestPermissions();
    if (!hasPerms) {
      setStatus('Permissions denied');
      return;
    }

    setStatus('Starting camera...');
    try {
      // Camera stream
      const stream = await mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode: 'environment', width: 640, height: 480 },
      });
      streamRef.current = stream;
      setLocalStream(stream);

      // Start foreground service for background support
      startForegroundService();

      // Connect socket
      setStatus('Connecting to server...');
      const socket = io(BACKEND_URL, {
        transports: ['websocket'],
        timeout: 10000,
      });
      socketRef.current = socket;

      socket.on('connect', () => {
        socket.emit('register-camera', roomCode);
        setIsSharing(true);
        setStatus('✓ Connected. Waiting for viewer...\nCode: ' + roomCode);
      });

      socket.on('connect_error', (err: any) => {
        setStatus('Server connection failed: ' + err.message);
      });

      socket.on('viewer-joined', () => {
        setStatus('Viewer connected! Streaming...');
        startWebRTC();
      });

      socket.on('answer', (answer: any) => {
        if (peerConnectionRef.current) {
          peerConnectionRef.current.setRemoteDescription(
            new RTCSessionDescription(answer)
          ).catch(console.error);
        }
      });

      socket.on('ice-candidate', (candidate: any) => {
        if (peerConnectionRef.current && candidate) {
          peerConnectionRef.current.addIceCandidate(
            new RTCIceCandidate(candidate)
          ).catch(console.error);
        }
      });

    } catch (e: any) {
      console.error('Start sharing error:', e);
      setStatus('Error: ' + (e?.message || 'Failed to start camera'));
      Alert.alert('Camera Error', e?.message || 'Failed to access camera. Check permissions.');
    }
  }, [ready, roomCode, requestPermissions, startForegroundService]);

  const startWebRTC = useCallback(async () => {
    try {
      const pc = new RTCPeerConnection(ICE_SERVERS);
      peerConnectionRef.current = pc;

      pc.onicecandidate = (event: any) => {
        if (event.candidate && socketRef.current) {
          socketRef.current.emit('ice-candidate', {
            roomCode,
            candidate: event.candidate,
          });
        }
      };

      pc.onconnectionstatechange = () => {
        setStatus('Stream state: ' + pc.connectionState);
      };

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track: any) => {
          pc.addTrack(track, streamRef.current);
        });
      }

      const offer = await pc.createOffer({ offerToReceiveVideo: false, offerToReceiveAudio: false });
      await pc.setLocalDescription(offer);
      socketRef.current?.emit('offer', { roomCode, offer });
    } catch (e: any) {
      console.error('WebRTC error:', e);
      setStatus('WebRTC Error: ' + e?.message);
    }
  }, [roomCode]);

  const stopSharing = useCallback(() => {
    cleanup();
    setLocalStream(null);
    setIsSharing(false);
    setStatus('Stopped. Press "Start Sharing" to begin again.');
  }, [cleanup]);

  // Error screen
  if (initError) {
    return (
      <SafeAreaView style={styles.errorContainer}>
        <Text style={styles.errorTitle}>⚠️ Startup Error</Text>
        <Text style={styles.errorText}>{initError}</Text>
        <Text style={styles.errorHint}>Please reinstall the app or contact support.</Text>
      </SafeAreaView>
    );
  }

  // Loading screen
  if (!ready) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.loadingText}>Loading RemoCam...</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" />

      <View style={styles.header}>
        <Text style={styles.title}>📷 RemoCam</Text>
        <Text style={styles.subtitle}>Remote Camera Sharing</Text>
      </View>

      <View style={styles.videoContainer}>
        {localStream && RTCView ? (
          <RTCView
            streamURL={localStream.toURL()}
            style={styles.video}
            objectFit="cover"
            zOrder={0}
          />
        ) : (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderIcon}>📷</Text>
            <Text style={styles.placeholderText}>Camera Preview</Text>
            <Text style={styles.placeholderSub}>Start sharing to see preview</Text>
          </View>
        )}
      </View>

      <View style={styles.controls}>
        <View style={styles.codeBox}>
          <Text style={styles.codeLabel}>Your Room Code</Text>
          <Text style={styles.code}>{roomCode}</Text>
          <Text style={styles.codeHint}>Enter this code in the web viewer</Text>
        </View>

        <Text style={styles.statusText}>{status}</Text>

        {!isSharing ? (
          <TouchableOpacity style={styles.buttonStart} onPress={startSharing} activeOpacity={0.8}>
            <Text style={styles.buttonText}>▶ Start Sharing</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.buttonStop} onPress={stopSharing} activeOpacity={0.8}>
            <Text style={styles.buttonText}>■ Stop Sharing</Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  errorContainer: { flex: 1, backgroundColor: '#0f172a', justifyContent: 'center', alignItems: 'center', padding: 30 },
  errorTitle: { color: '#ef4444', fontSize: 24, fontWeight: 'bold', marginBottom: 16 },
  errorText: { color: '#fca5a5', fontSize: 14, textAlign: 'center', marginBottom: 16 },
  errorHint: { color: '#64748b', fontSize: 12, textAlign: 'center' },
  loadingText: { color: '#94a3b8', fontSize: 18, textAlign: 'center', marginTop: 200 },
  header: { padding: 20, alignItems: 'center', paddingTop: 10 },
  title: { fontSize: 28, fontWeight: 'bold', color: '#fff', letterSpacing: 1 },
  subtitle: { color: '#64748b', marginTop: 4, fontSize: 13 },
  videoContainer: { flex: 1, backgroundColor: '#020617', margin: 16, borderRadius: 20, overflow: 'hidden', borderWidth: 1, borderColor: '#1e293b' },
  video: { flex: 1 },
  placeholder: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8 },
  placeholderIcon: { fontSize: 48, marginBottom: 8 },
  placeholderText: { color: '#475569', fontSize: 18, fontWeight: '600' },
  placeholderSub: { color: '#334155', fontSize: 13 },
  controls: { padding: 16, gap: 12 },
  codeBox: { backgroundColor: '#1e293b', padding: 16, borderRadius: 16, alignItems: 'center', borderWidth: 1, borderColor: '#334155' },
  codeLabel: { color: '#64748b', fontSize: 12, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 6 },
  code: { fontSize: 36, fontWeight: 'bold', letterSpacing: 10, color: '#3b82f6', fontVariant: ['tabular-nums'] },
  codeHint: { color: '#475569', fontSize: 11, marginTop: 6 },
  statusText: { color: '#94a3b8', fontSize: 13, textAlign: 'center', minHeight: 36 },
  buttonStart: { backgroundColor: '#3b82f6', padding: 18, borderRadius: 14, alignItems: 'center' },
  buttonStop: { backgroundColor: '#ef4444', padding: 18, borderRadius: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 18, fontWeight: 'bold', letterSpacing: 0.5 },
});
