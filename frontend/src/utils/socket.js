import { io } from 'socket.io-client';

// Replace this URL with your deployed backend URL (e.g., from Render, Heroku, etc.)
// For local testing, it uses localhost. If you deploy to Netlify, it will try to use the Netlify URL, which won't work because Netlify only hosts the frontend!
const BACKEND_URL = window.location.hostname === 'localhost' 
  ? 'http://localhost:3001' 
  : 'https://camera-i73y.onrender.com';

export const socket = io(BACKEND_URL, {
  autoConnect: false // We connect manually when needed
});
