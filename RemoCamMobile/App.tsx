/**
 * RemoCam Mobile App
 * Full rewrite with Home/Share/View modes, persistent room code, proper UI
 */

import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  SafeAreaView,
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  TextInput,
  Alert,
  Platform,
  PermissionsAndroid,
  StatusBar,
  KeyboardAvoidingView,
  ScrollView,
} from 'react-native';

const BACKEND_URL = 'https://camera-i73y.onrender.com';
const ROOM_CODE_KEY = 'remocam_room_code';

// Global error handler for Release mode crashes
if (!__DEV__) {
  const globalHandler = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error: any, isFatal?: boolean) => {
    Alert.alert('JS Crash', `Error: ${error.message}\n\nPlease share this error.`);
    if (globalHandler) {
      globalHandler(error, isFatal);
    }
  });
}

// Lazy load native modules - prevents crash on startup
let RTCPeerConnection: any = null;
let RTCIceCandidate: any = null;
let RTCSessionDescription: any = null;
let mediaDevices: any = null;
let RTCView: any = null;
let io: any = null;
let AsyncStorage: any = null;
let ReactNativeForegroundService: any = null;

function loadModules(): boolean {
  try {
    const webrtc = require('react-native-webrtc');
    RTCPeerConnection = webrtc.RTCPeerConnection;
    RTCIceCandidate = webrtc.RTCIceCandidate;
    RTCSessionDescription = webrtc.RTCSessionDescription;
    mediaDevices = webrtc.mediaDevices;
    RTCView = webrtc.RTCView;
  } catch (e) { console.error('WebRTC failed:', e); return false; }

  try {
    io = require('socket.io-client').io;
  } catch (e) { console.error('Socket.io failed:', e); return false; }

  try {
    AsyncStorage = require('@react-native-async-storage/async-storage').default;
  } catch (e) { console.warn('AsyncStorage failed (non-fatal):', e); }

  // Foreground service removed to prevent Android 5-second OS kills

  return true;
}

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
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
  ],
};

// Force VP8 codec in SDP to prevent H.264 hardware encoder crashes on Android
// The previous implementation was broken (returned true for everything = no-op)
function forceVP8InSDP(sdp: string): string {
  try {
    // Find VP8 payload type number (e.g., "96" from "a=rtpmap:96 VP8/90000")
    const vp8Match = sdp.match(/a=rtpmap:(\d+) VP8\/90000/);
    if (!vp8Match) {
      console.warn('VP8 not found in SDP, using original');
      return sdp; // VP8 not available, return as-is
    }
    const vp8PT = vp8Match[1];

    // Find RTX payload type for VP8 (retransmission)
    const rtxMatch = sdp.match(new RegExp(`a=fmtp:(\\d+) apt=${vp8PT}`));
    const rtxPT = rtxMatch ? rtxMatch[1] : null;

    // Build list of payload types to KEEP (VP8 + its RTX)
    const keepPTs = rtxPT ? [vp8PT, rtxPT] : [vp8PT];
    console.log('Keeping VP8 payload types:', keepPTs);

    // Rewrite m=video line to only list VP8 payload types
    // Before: "m=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99 100 101"
    // After:  "m=video 9 UDP/TLS/RTP/SAVPF 96 97"  (only VP8 + its RTX)
    const newSdp = sdp.replace(
      /m=video (\d+) ([A-Z/]+) ([\d ]+)/,
      (_match: string, port: string, proto: string) =>
        `m=video ${port} ${proto} ${keepPTs.join(' ')}`,
    );
    return newSdp;
  } catch (e) {
    console.warn('forceVP8InSDP failed, using original SDP:', e);
    return sdp; // Fallback to original if manipulation fails
  }
}

type Screen = 'home' | 'share' | 'view';

export default function App() {
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState<Screen>('home');
  const [roomCode, setRoomCode] = useState('');
  const [viewerCode, setViewerCode] = useState('');
  const [isSharing, setIsSharing] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [status, setStatus] = useState('');
  const [localStream, setLocalStream] = useState<any>(null);
  const [remoteStream, setRemoteStream] = useState<any>(null);

  const socketRef = useRef<any>(null);
  const pcRef = useRef<any>(null);
  const streamRef = useRef<any>(null);
  const candidateQueue = useRef<any[]>([]);

  // --- Init ---
  useEffect(() => {
    try {
      const ok = loadModules();
      if (!ok) { setStatus('init_error'); return; }
      loadOrCreateRoomCode();
      setReady(true);
    } catch (e: any) {
      setStatus('init_error');
    }
  }, []);

  const loadOrCreateRoomCode = async () => {
    try {
      let code = null;
      if (AsyncStorage) {
        code = await AsyncStorage.getItem(ROOM_CODE_KEY);
      }
      if (!code) {
        code = Math.floor(100000 + Math.random() * 900000).toString();
        if (AsyncStorage) await AsyncStorage.setItem(ROOM_CODE_KEY, code);
      }
      setRoomCode(code);
    } catch {
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      setRoomCode(code);
    }
  };

  // --- Cleanup ---
  const cleanup = useCallback(() => {
    try {
      streamRef.current?.getTracks().forEach((t: any) => t.stop());
      streamRef.current = null;
      pcRef.current?.close();
      pcRef.current = null;
      socketRef.current?.disconnect();
      socketRef.current = null;
      setLocalStream(null);
      setRemoteStream(null);
      candidateQueue.current = [];
      setIsSharing(false);
      setIsConnecting(false);
      // ForegroundService removed
    } catch (e) { console.warn('cleanup error', e); }
  }, []);

  // --- Permissions ---
  const requestPermissions = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;
    try {
      const perms: string[] = [
        PermissionsAndroid.PERMISSIONS.CAMERA,
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      ];
      if (Platform.Version >= 33) perms.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      const grants = await PermissionsAndroid.requestMultiple(perms);
      return (
        grants[PermissionsAndroid.PERMISSIONS.CAMERA] === PermissionsAndroid.RESULTS.GRANTED &&
        grants[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] === PermissionsAndroid.RESULTS.GRANTED
      );
    } catch { return false; }
  }, []);

  // ===================== SHARE MODE =====================
  const startSharing = useCallback(async () => {
    const ok = await requestPermissions();
    if (!ok) { Alert.alert('Permission Denied', 'Camera & Mic permissions are required.'); return; }

    setStatus('Starting camera...');
    try {
      const stream = await mediaDevices.getUserMedia({
        audio: true,
        video: {
          facingMode: 'environment',
          width: { ideal: 640, max: 1280 },
          height: { ideal: 480, max: 720 },
          frameRate: { ideal: 24, max: 30 },
        },
      });
      streamRef.current = stream;
      setLocalStream(stream);

      // ForegroundService removed to prevent 5-second crash

      setStatus('Connecting to server...');
      const socket = io(BACKEND_URL, { transports: ['websocket'], timeout: 10000 });
      socketRef.current = socket;

      socket.on('connect', () => {
        socket.emit('register-camera', roomCode);
        setIsSharing(true);
        setStatus('✓ Sharing active. Waiting for viewer...');
      });

      socket.on('connect_error', (e: any) => setStatus('Server error: ' + e.message));

      socket.on('viewer-joined', () => {
        setStatus('📱 Viewer connected! Streaming...');
        // Await properly and catch errors
        startShareWebRTC().catch((e: any) => {
          console.error('startShareWebRTC failed:', e);
          setStatus('WebRTC init error: ' + e?.message);
        });
      });

      socket.on('answer', async (answer: any) => {
        try {
          if (pcRef.current) {
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(answer));
            // Process any queued candidates
            while (candidateQueue.current.length > 0) {
              const c = candidateQueue.current.shift();
              try {
                await pcRef.current.addIceCandidate(new RTCIceCandidate(c));
              } catch (e) { console.error('Ice queued error', e); }
            }
          }
        } catch (err) {
          console.warn('Set remote description error:', err);
        }
      });

      socket.on('ice-candidate', (c: any) => {
        if (c && c.candidate && pcRef.current) {
          if (pcRef.current.remoteDescription) {
            pcRef.current.addIceCandidate(new RTCIceCandidate(c)).catch((e:any) => console.error('Ice error', e));
          } else {
            // Queue candidate until remote description is set to avoid native crash
            candidateQueue.current.push(c);
          }
        }
      });
    } catch (e: any) {
      setStatus('Error: ' + e?.message);
      Alert.alert('Camera Error', e?.message || 'Failed to access camera.');
    }
  }, [roomCode, requestPermissions]);

  const startShareWebRTC = useCallback(async () => {
    try {
      console.log('startShareWebRTC: creating peer connection...');
      const pc = new RTCPeerConnection(ICE_SERVERS);
      pcRef.current = pc;

      pc.onicecandidate = (e: any) => {
        if (e.candidate) {
          const plainCandidate = {
            candidate: e.candidate.candidate,
            sdpMLineIndex: e.candidate.sdpMLineIndex,
            sdpMid: e.candidate.sdpMid,
          };
          socketRef.current?.emit('ice-candidate', { roomCode, candidate: plainCandidate });
        }
      };

      pc.onconnectionstatechange = () => {
        console.log('PC connection state:', pc.connectionState);
      };

      // Add tracks from local stream
      if (!streamRef.current) {
        throw new Error('No local stream available');
      }
      streamRef.current.getTracks().forEach((t: any) => {
        console.log('Adding track:', t.kind);
        pc.addTrack(t, streamRef.current);
      });

      // Create offer
      console.log('Creating offer...');
      const offer = await pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });

      // ✅ PROPERLY force VP8 to prevent H.264 hardware encoder crash on Android
      // Previous implementation was broken (returned true for all - was a complete no-op)
      const vp8SDP = forceVP8InSDP(offer.sdp);
      console.log('SDP VP8 forced, setting local description...');

      // Set local description with VP8-only SDP
      await pc.setLocalDescription({ type: offer.type, sdp: vp8SDP });

      // Send the VP8-only offer to viewer
      const plainOffer = { type: offer.type, sdp: vp8SDP };
      socketRef.current?.emit('offer', { roomCode, offer: plainOffer });
      console.log('Offer sent to viewer');
    } catch (e: any) {
      console.error('startShareWebRTC error:', e);
      setStatus('WebRTC error: ' + (e?.message || 'Unknown error'));
    }
  }, [roomCode]);

  const stopSharing = useCallback(() => {
    cleanup();
    setStatus('');
  }, [cleanup]);

  // ===================== VIEW MODE =====================
  const connectToCamera = useCallback(async () => {
    const code = viewerCode.trim();
    if (code.length !== 6) {
      Alert.alert('Invalid Code', 'Please enter a valid 6-digit room code.');
      return;
    }
    setIsConnecting(true);
    setStatus('Connecting to camera...');

    try {
      const socket = io(BACKEND_URL, { transports: ['websocket'], timeout: 10000 });
      socketRef.current = socket;

      socket.on('connect', () => {
        socket.emit('join-as-viewer', code);
        setStatus('Waiting for camera stream...');
      });

      socket.on('connect_error', (e: any) => {
        setStatus('Server error: ' + e.message);
        setIsConnecting(false);
      });

      socket.on('offer', async (offer: any) => {
        try {
          const pc = new RTCPeerConnection(ICE_SERVERS);
          pcRef.current = pc;

          pc.onicecandidate = (e: any) => {
        if (e.candidate) {
          const plainCandidate = {
            candidate: e.candidate.candidate,
            sdpMLineIndex: e.candidate.sdpMLineIndex,
            sdpMid: e.candidate.sdpMid,
          };
          socket.emit('ice-candidate', { roomCode: code, candidate: plainCandidate });
        }
      };

          pc.ontrack = (e: any) => {
            if (e.streams && e.streams[0]) {
              setRemoteStream(e.streams[0]);
              setStatus('🎥 Live stream connected!');
              setIsConnecting(false);
            }
          };

          await pc.setRemoteDescription(new RTCSessionDescription(offer));
          
          // Process queued candidates
          while (candidateQueue.current.length > 0) {
            const c = candidateQueue.current.shift();
            pc.addIceCandidate(new RTCIceCandidate(c)).catch(console.error);
          }

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          
          const plainAnswer = { type: answer.type, sdp: answer.sdp };
          socket.emit('answer', { roomCode: code, answer: plainAnswer });
        } catch (e: any) {
          setStatus('Stream error: ' + e?.message);
          setIsConnecting(false);
        }
      });

      socket.on('ice-candidate', (c: any) => {
        if (c && pcRef.current) {
          if (pcRef.current.remoteDescription) {
            pcRef.current.addIceCandidate(new RTCIceCandidate(c)).catch(console.error);
          } else {
            candidateQueue.current.push(c);
          }
        }
      });

      socket.on('camera-offline', () => {
        setStatus('Camera is offline or code is wrong.');
        setIsConnecting(false);
      });

    } catch (e: any) {
      setStatus('Error: ' + e?.message);
      setIsConnecting(false);
    }
  }, [viewerCode]);

  const disconnectViewer = useCallback(() => {
    cleanup();
    setStatus('');
  }, [cleanup]);

  // ===================== NAVIGATION =====================
  const goHome = useCallback(() => {
    cleanup();
    setStatus('');
    setViewerCode('');
    setScreen('home');
  }, [cleanup]);

  // ===================== ERROR STATE =====================
  if (status === 'init_error') {
    return (
      <SafeAreaView style={styles.errorContainer}>
        <Text style={styles.errorIcon}>⚠️</Text>
        <Text style={styles.errorTitle}>Startup Error</Text>
        <Text style={styles.errorText}>Failed to load camera modules. Please reinstall the app.</Text>
      </SafeAreaView>
    );
  }

  if (!ready) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.loadingText}>Loading RemoCam...</Text>
      </SafeAreaView>
    );
  }

  // ===================== HOME SCREEN =====================
  if (screen === 'home') {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor="#0f172a" />
        <View style={styles.homeContent}>
          <View style={styles.homeLogoArea}>
            <Text style={styles.homeLogo}>📷</Text>
            <Text style={styles.homeTitle}>RemoCam</Text>
            <Text style={styles.homeSubtitle}>Turn your phone into a remote camera</Text>
          </View>

          <View style={styles.homeCard}>
            <TouchableOpacity style={styles.btnShare} onPress={() => setScreen('share')} activeOpacity={0.85}>
              <Text style={styles.btnIcon}>📸</Text>
              <View>
                <Text style={styles.btnTitle}>Share Camera</Text>
                <Text style={styles.btnDesc}>Stream this phone's camera</Text>
              </View>
            </TouchableOpacity>

            <View style={styles.divider} />

            <TouchableOpacity style={styles.btnView} onPress={() => setScreen('view')} activeOpacity={0.85}>
              <Text style={styles.btnIcon}>👁️</Text>
              <View>
                <Text style={styles.btnTitleDark}>View Camera</Text>
                <Text style={styles.btnDescDark}>Watch a remote camera stream</Text>
              </View>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // ===================== SHARE SCREEN =====================
  if (screen === 'share') {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor="#0f172a" />
        <View style={styles.topBar}>
          <TouchableOpacity onPress={goHome} style={styles.backBtn}>
            <Text style={styles.backBtnText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.screenTitle}>Share Camera</Text>
          <View style={{ width: 70 }} />
        </View>

        <View style={styles.videoContainer}>
          {localStream && RTCView ? (
            <RTCView streamURL={localStream.toURL()} style={styles.video} objectFit="cover" zOrder={0} />
          ) : (
            <View style={styles.placeholder}>
              <Text style={styles.placeholderIcon}>📷</Text>
              <Text style={styles.placeholderText}>Camera Preview</Text>
              <Text style={styles.placeholderSub}>Start sharing to activate camera</Text>
            </View>
          )}
        </View>

        <View style={styles.controls}>
          <View style={styles.codeBox}>
            <Text style={styles.codeLabel}>YOUR ROOM CODE</Text>
            <Text style={styles.code}>{roomCode}</Text>
            <Text style={styles.codeHint}>Share this code with the viewer</Text>
          </View>
          {!!status && <Text style={styles.statusText}>{status}</Text>}
          {!isSharing ? (
            <TouchableOpacity style={styles.btnStart} onPress={startSharing} activeOpacity={0.85}>
              <Text style={styles.actionBtnText}>▶  Start Sharing</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.btnStop} onPress={stopSharing} activeOpacity={0.85}>
              <Text style={styles.actionBtnText}>■  Stop Sharing</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    );
  }

  // ===================== VIEW SCREEN =====================
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" />
      <View style={styles.topBar}>
        <TouchableOpacity onPress={goHome} style={styles.backBtn}>
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.screenTitle}>View Camera</Text>
        <View style={{ width: 70 }} />
      </View>

      <View style={styles.videoContainer}>
        {remoteStream && RTCView ? (
          <RTCView streamURL={remoteStream.toURL()} style={styles.video} objectFit="cover" zOrder={0} />
        ) : (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderIcon}>👁️</Text>
            <Text style={styles.placeholderText}>
              {isConnecting ? 'Connecting...' : 'No Stream'}
            </Text>
            <Text style={styles.placeholderSub}>
              {isConnecting ? 'Please wait...' : 'Enter code below to connect'}
            </Text>
          </View>
        )}
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.controls}>
          {!remoteStream ? (
            <>
              <Text style={styles.inputLabel}>ENTER ROOM CODE</Text>
              <TextInput
                style={styles.codeInput}
                value={viewerCode}
                onChangeText={setViewerCode}
                placeholder="6-digit code"
                placeholderTextColor="#475569"
                keyboardType="number-pad"
                maxLength={6}
                editable={!isConnecting}
              />
              {!!status && <Text style={styles.statusText}>{status}</Text>}
              <TouchableOpacity
                style={[styles.btnStart, isConnecting && styles.btnDisabled]}
                onPress={connectToCamera}
                disabled={isConnecting}
                activeOpacity={0.85}>
                <Text style={styles.actionBtnText}>
                  {isConnecting ? '⏳ Connecting...' : '▶  Connect'}
                </Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              {!!status && <Text style={styles.statusText}>{status}</Text>}
              <TouchableOpacity style={styles.btnStop} onPress={disconnectViewer} activeOpacity={0.85}>
                <Text style={styles.actionBtnText}>■  Disconnect</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },

  // Error / loading
  errorContainer: { flex: 1, backgroundColor: '#0f172a', justifyContent: 'center', alignItems: 'center', padding: 30 },
  errorIcon: { fontSize: 48, marginBottom: 16 },
  errorTitle: { color: '#ef4444', fontSize: 22, fontWeight: 'bold', marginBottom: 12 },
  errorText: { color: '#fca5a5', fontSize: 14, textAlign: 'center' },
  loadingText: { color: '#94a3b8', fontSize: 18, textAlign: 'center', marginTop: 200 },

  // Home
  homeContent: { flex: 1, justifyContent: 'center', padding: 24 },
  homeLogoArea: { alignItems: 'center', marginBottom: 40 },
  homeLogo: { fontSize: 64, marginBottom: 12 },
  homeTitle: { fontSize: 36, fontWeight: 'bold', color: '#fff', letterSpacing: 1 },
  homeSubtitle: { color: '#64748b', fontSize: 14, marginTop: 6 },
  homeCard: { backgroundColor: '#1e293b', borderRadius: 20, overflow: 'hidden', borderWidth: 1, borderColor: '#334155' },
  btnShare: { flexDirection: 'row', alignItems: 'center', gap: 16, padding: 22, backgroundColor: '#3b82f6' },
  btnView: { flexDirection: 'row', alignItems: 'center', gap: 16, padding: 22 },
  btnIcon: { fontSize: 32 },
  btnTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  btnDesc: { color: 'rgba(255,255,255,0.7)', fontSize: 12, marginTop: 2 },
  btnTitleDark: { color: '#e2e8f0', fontSize: 18, fontWeight: 'bold' },
  btnDescDark: { color: '#64748b', fontSize: 12, marginTop: 2 },
  divider: { height: 1, backgroundColor: '#334155' },

  // Top bar
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  backBtn: { paddingVertical: 6, paddingHorizontal: 4 },
  backBtnText: { color: '#3b82f6', fontSize: 16 },
  screenTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold' },

  // Video
  videoContainer: { flex: 1, backgroundColor: '#020617', margin: 16, borderRadius: 20, overflow: 'hidden', borderWidth: 1, borderColor: '#1e293b' },
  video: { flex: 1 },
  placeholder: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  placeholderIcon: { fontSize: 48, marginBottom: 12 },
  placeholderText: { color: '#475569', fontSize: 18, fontWeight: '600' },
  placeholderSub: { color: '#334155', fontSize: 13, marginTop: 6 },

  // Controls
  controls: { padding: 16, gap: 10 },
  codeBox: { backgroundColor: '#1e293b', padding: 16, borderRadius: 16, alignItems: 'center', borderWidth: 1, borderColor: '#334155' },
  codeLabel: { color: '#64748b', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 6 },
  code: { fontSize: 38, fontWeight: 'bold', letterSpacing: 10, color: '#3b82f6' },
  codeHint: { color: '#475569', fontSize: 11, marginTop: 6 },
  statusText: { color: '#94a3b8', fontSize: 13, textAlign: 'center' },
  inputLabel: { color: '#64748b', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 4 },
  codeInput: {
    backgroundColor: '#1e293b', color: '#fff', fontSize: 28, fontWeight: 'bold',
    letterSpacing: 8, textAlign: 'center', padding: 16, borderRadius: 14,
    borderWidth: 1, borderColor: '#334155',
  },
  btnStart: { backgroundColor: '#3b82f6', padding: 18, borderRadius: 14, alignItems: 'center' },
  btnStop: { backgroundColor: '#ef4444', padding: 18, borderRadius: 14, alignItems: 'center' },
  btnDisabled: { backgroundColor: '#475569' },
  actionBtnText: { color: '#fff', fontSize: 18, fontWeight: 'bold', letterSpacing: 0.5 },
});
