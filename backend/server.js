const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Track which socket is the camera for each room
const cameraSocketMap = {}; // roomCode -> socketId

// A simple function to generate a random 6-digit code
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Camera device requests a code to create a room (legacy, keeping just in case)
  socket.on('create-room', (callback) => {
    const roomCode = generateCode();
    socket.join(roomCode);
    cameraSocketMap[roomCode] = socket.id;
    console.log(`Room created: ${roomCode} by ${socket.id}`);
    
    if (callback) {
      callback({ code: roomCode });
    }
  });

  // Camera device registers with a persistent code
  socket.on('register-camera', (roomCode, callback) => {
    socket.join(roomCode);
    cameraSocketMap[roomCode] = socket.id;
    console.log(`Camera registered with code: ${roomCode} by ${socket.id}`);
    if (callback) {
      callback({ success: true });
    }
  });

  // Viewer device joins a room using the code (used by laptop/browser frontend)
  socket.on('join-room', (roomCode, callback) => {
    const room = io.sockets.adapter.rooms.get(roomCode);
    if (room && room.size > 0) {
      socket.join(roomCode);
      console.log(`Browser viewer ${socket.id} joined room ${roomCode}`);
      
      // Notify the camera that a viewer joined
      socket.to(roomCode).emit('viewer-joined', socket.id);
      
      if (callback) {
        callback({ success: true });
      }
    } else {
      console.log(`Room ${roomCode} not found for browser viewer`);
      if (callback) {
        callback({ success: false, message: 'Invalid or expired code.' });
      }
    }
  });

  // ✅ FIX: Mobile app viewer uses 'join-as-viewer' — this was MISSING and caused APK crash
  socket.on('join-as-viewer', (roomCode) => {
    const room = io.sockets.adapter.rooms.get(roomCode);
    if (room && room.size > 0) {
      socket.join(roomCode);
      console.log(`Mobile viewer ${socket.id} joined room ${roomCode}`);
      
      // Notify the camera that a mobile viewer joined
      socket.to(roomCode).emit('viewer-joined', socket.id);
    } else {
      console.log(`Room ${roomCode} not found for mobile viewer`);
      // Notify the viewer that camera is offline
      socket.emit('camera-offline');
    }
  });

  // --- WebRTC Signaling ---
  
  socket.on('offer', (data) => {
    // data should contain { roomCode, offer }
    socket.to(data.roomCode).emit('offer', data.offer);
  });

  socket.on('answer', (data) => {
    // data should contain { roomCode, answer }
    socket.to(data.roomCode).emit('answer', data.answer);
  });

  socket.on('ice-candidate', (data) => {
    // data should contain { roomCode, candidate }
    socket.to(data.roomCode).emit('ice-candidate', data.candidate);
  });

  // --- Remote Controls ---

  // Request camera device to toggle front/back lens
  socket.on('toggle-camera', (roomCode) => {
    socket.to(roomCode).emit('toggle-camera');
  });

  // Request camera device to toggle flashlight (torch)
  socket.on('toggle-torch', (roomCode) => {
    socket.to(roomCode).emit('toggle-torch');
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // If the camera disconnected, notify all viewers in that room
    for (const [roomCode, camSocketId] of Object.entries(cameraSocketMap)) {
      if (camSocketId === socket.id) {
        console.log(`Camera disconnected from room ${roomCode}, notifying viewers`);
        socket.to(roomCode).emit('camera-offline');
        delete cameraSocketMap[roomCode];
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
