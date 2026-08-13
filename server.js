const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// In-memory stores (use Redis/DB in production)
const cameras = new Map(); // cameraId -> {ws, startTime, authorized}
const viewers = new Map(); // viewerId -> {ws, authorizedCameras: Set}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Authentication middleware (basic example - use proper auth in production)
const authenticate = (req, res, next) => {
    const token = req.headers.authorization || req.query.token;
    // Verify token here
    next();
};

// Camera WebSocket endpoint
const cameraWss = new WebSocket.Server({ noServer: true });

cameraWss.on('connection', (ws, req) => {
    // Extract authentication from query params
    const url = new URL(req.url, 'http://localhost');
    const cameraId = url.searchParams.get('id');
    const authToken = url.searchParams.get('token');
    
    if (!cameraId || !validateCameraAuth(authToken)) {
        ws.close(1008, 'Authentication failed');
        return;
    }
    
    console.log(`Camera ${cameraId} connected`);
    cameras.set(cameraId, { ws, startTime: new Date(), authorized: true });
    
    // Notify authorized viewers
    broadcastCameraList();
    
    ws.on('message', (data) => {
        // Forward the video chunk to every connected viewer
        broadcastVideoToViewers(cameraId, data);
    });
    
    ws.on('close', () => {
        cameras.delete(cameraId);
        notifyViewersCameraClosed(cameraId);
        broadcastCameraList();
    });
    
    ws.on('error', (err) => {
        console.error(`Camera ${cameraId} error:`, err);
    });
});

// Viewer WebSocket endpoint
const viewerWss = new WebSocket.Server({ noServer: true });

// Single upgrade handler routes by path (attaching two path-based
// WebSocket.Servers to one HTTP server does not work with the ws library)
server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/ws/camera') {
        cameraWss.handleUpgrade(req, socket, head, (ws) => {
            cameraWss.emit('connection', ws, req);
        });
    } else if (pathname === '/ws/viewer') {
        viewerWss.handleUpgrade(req, socket, head, (ws) => {
            viewerWss.emit('connection', ws, req);
        });
    } else {
        socket.destroy();
    }
});

viewerWss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const viewerToken = url.searchParams.get('token');
    
    if (!validateViewerAuth(viewerToken)) {
        ws.close(1008, 'Authentication required');
        return;
    }
    
    const viewerId = generateId();
    viewers.set(viewerId, { ws, authorizedCameras: new Set() });
    
    // Send current camera list (array of id strings)
    ws.send(JSON.stringify({
        type: 'cameras',
        data: Array.from(cameras.keys())
    }));
    
    ws.on('close', () => {
        viewers.delete(viewerId);
    });
});

function broadcastVideoToViewers(cameraId, chunk) {
    // Frame the binary chunk as: [4-byte id length][id bytes][video bytes]
    // so the viewer can tell which camera each chunk belongs to.
    const idBuf = Buffer.from(cameraId, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(idBuf.length, 0);
    const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const framed = Buffer.concat([header, idBuf, body]);

    viewers.forEach((viewer) => {
        if (viewer.ws.readyState === WebSocket.OPEN) {
            viewer.ws.send(framed);
        }
    });
}

function broadcastCameraList() {
    const cameraList = Array.from(cameras.keys());
    viewers.forEach((viewer) => {
        if (viewer.ws.readyState === WebSocket.OPEN) {
            viewer.ws.send(JSON.stringify({
                type: 'cameras',
                data: cameraList
            }));
        }
    });
}

function notifyViewersCameraClosed(cameraId) {
    viewers.forEach((viewer) => {
        viewer.authorizedCameras.delete(cameraId);
        if (viewer.ws.readyState === WebSocket.OPEN) {
            viewer.ws.send(JSON.stringify({
                type: 'camera_closed',
                cameraId
            }));
        }
    });
}

// Routes

// Landing page
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Camera Test</title>
            <style>
                body { font-family: Arial; max-width: 600px; margin: 60px auto; padding: 20px; text-align: center; }
                a.btn { display: inline-block; margin: 10px; padding: 14px 28px; background: #007bff; color: #fff; text-decoration: none; border-radius: 6px; }
            </style>
        </head>
        <body>
            <h1>Camera Test</h1>
            <p>Choose an option:</p>
            <a class="btn" href="/broadcast">Broadcast Camera</a>
            <a class="btn" href="/view">View Cameras</a>
        </body>
        </html>
    `);
});

// Legitimate camera streaming interface (not deceptive)
app.get('/broadcast', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Broadcast Camera</title>
            <style>
                body { font-family: Arial; max-width: 800px; margin: 0 auto; padding: 20px; }
                #status { padding: 10px; margin: 10px 0; border-radius: 4px; }
                .connected { background: #d4edda; color: #155724; }
                .disconnected { background: #f8d7da; color: #721c24; }
                .connecting { background: #fff3cd; color: #856404; }
                video { width: 100%; max-width: 600px; background: #000; }
                .warning { 
                    background: #fff3cd; 
                    border: 1px solid #ffeaa7; 
                    padding: 15px; 
                    border-radius: 4px;
                    margin-bottom: 20px;
                }
            </style>
        </head>
        <body>
            <h1>Camera Broadcast</h1>
            
            <div class="warning">
                <strong>Privacy Notice:</strong> Your camera feed will be streamed to 
                authorized viewers. A red indicator will show when broadcasting.
            </div>
            
            <div id="status" class="disconnected">Disconnected</div>
            
            <video id="preview" autoplay muted playsinline></video>
            
            <div style="margin-top: 20px;">
                <button id="startBtn" onclick="startBroadcast()">Start Broadcast</button>
                <button id="stopBtn" onclick="stopBroadcast()" disabled>Stop Broadcast</button>
            </div>
            
            <div id="broadcastInfo" style="margin-top: 20px; display: none;">
                <p><strong>Broadcasting as:</strong> <span id="cameraId"></span></p>
                <p style="color: #dc3545; font-weight: bold;">🔴 LIVE - Camera Active</p>
            </div>

            <script>
                const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const wsUrl = \`\${wsProtocol}//\${window.location.host}/ws/camera\`;
                
                let ws = null;
                let stream = null;
                let captureTimer = null;
                const cameraId = 'cam_' + Math.random().toString(36).substr(2, 9);
                
                async function startBroadcast() {
                    try {
                        document.getElementById('status').className = 'connecting';
                        document.getElementById('status').textContent = 'Requesting camera access...';
                        
                        stream = await navigator.mediaDevices.getUserMedia({ 
                            video: true, 
                            audio: false 
                        });
                        
                        document.getElementById('preview').srcObject = stream;
                        
                        // Connect WebSocket with authentication
                        ws = new WebSocket(\`\${wsUrl}?id=\${cameraId}&token=YOUR_AUTH_TOKEN\`);
                        
                        ws.onopen = () => {
                            document.getElementById('status').className = 'connected';
                            document.getElementById('status').textContent = 'Connected - Broadcasting';
                            document.getElementById('startBtn').disabled = true;
                            document.getElementById('stopBtn').disabled = false;
                            document.getElementById('broadcastInfo').style.display = 'block';
                            document.getElementById('cameraId').textContent = cameraId;
                            
                            startStreaming();
                        };
                        
                        ws.onclose = () => {
                            document.getElementById('status').className = 'disconnected';
                            document.getElementById('status').textContent = 'Disconnected';
                            stopBroadcast();
                        };
                        
                        ws.onerror = (err) => {
                            console.error('WebSocket error:', err);
                            document.getElementById('status').textContent = 'Connection error';
                        };
                        
                    } catch (err) {
                        console.error('Failed to start:', err);
                        document.getElementById('status').textContent = 'Error: ' + err.message;
                    }
                }
                
                function startStreaming() {
                    // Send JPEG frames grabbed from a canvas (MJPEG over WebSocket).
                    // Far more robust than streaming WebM chunks through MediaSource.
                    const video = document.getElementById('preview');
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');

                    captureTimer = setInterval(() => {
                        if (!ws || ws.readyState !== WebSocket.OPEN) return;
                        if (!video.videoWidth) return; // camera not ready yet

                        canvas.width = video.videoWidth;
                        canvas.height = video.videoHeight;
                        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

                        canvas.toBlob((blob) => {
                            if (blob && ws && ws.readyState === WebSocket.OPEN) {
                                ws.send(blob);
                            }
                        }, 'image/jpeg', 0.6);
                    }, 100); // ~10 frames per second
                }
                
                function stopBroadcast() {
                    if (captureTimer) {
                        clearInterval(captureTimer);
                        captureTimer = null;
                    }
                    if (ws) {
                        ws.close();
                        ws = null;
                    }
                    if (stream) {
                        stream.getTracks().forEach(track => track.stop());
                        stream = null;
                    }
                    document.getElementById('preview').srcObject = null;
                    document.getElementById('startBtn').disabled = false;
                    document.getElementById('stopBtn').disabled = true;
                    document.getElementById('broadcastInfo').style.display = 'none';
                    document.getElementById('status').className = 'disconnected';
                    document.getElementById('status').textContent = 'Disconnected';
                }
                
                // Cleanup on page unload
                window.onbeforeunload = stopBroadcast;
            </script>
        </body>
        </html>
    `);
});

// Viewer interface (requires authentication)
app.get('/view', authenticate, (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Camera Viewer</title>
            <style>
                body { font-family: Arial; max-width: 1000px; margin: 0 auto; padding: 20px; }
                .camera-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
                .camera-card { border: 1px solid #ddd; border-radius: 8px; overflow: hidden; }
                .camera-header { background: #f8f9fa; padding: 10px; font-weight: bold; }
                .camera-video { width: 100%; height: 200px; background: #000; object-fit: cover; display: block; }
                .no-cameras { text-align: center; padding: 50px; color: #666; }
            </style>
        </head>
        <body>
            <h1>Camera Viewer</h1>
            <div id="cameraList" class="camera-grid">
                <div class="no-cameras">No active cameras</div>
            </div>
            
            <script>
                const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const ws = new WebSocket(\`\${wsProtocol}//\${window.location.host}/ws/viewer?token=YOUR_TOKEN\`);
                ws.binaryType = 'arraybuffer';

                const cameras = new Set();      // known camera ids (with a card)
                const lastUrl = new Map();      // id -> previous object URL (to revoke)

                ws.onmessage = (event) => {
                    if (typeof event.data === 'string') {
                        const msg = JSON.parse(event.data);
                        if (msg.type === 'cameras') {
                            updateCameraList(msg.data);
                        } else if (msg.type === 'camera_closed') {
                            removeCamera(msg.cameraId);
                        }
                    } else {
                        handleFrame(event.data); // ArrayBuffer: [id len][id][jpeg]
                    }
                };

                function ensureCard(id) {
                    if (cameras.has(id)) return;
                    cameras.add(id);
                    const container = document.getElementById('cameraList');
                    const placeholder = container.querySelector('.no-cameras');
                    if (placeholder) placeholder.remove();

                    const card = document.createElement('div');
                    card.className = 'camera-card';
                    card.id = 'cam-' + id;
                    card.innerHTML =
                        '<div class="camera-header">Camera ' + id + '</div>' +
                        '<img class="camera-video" id="video-' + id + '" alt="camera feed">';
                    container.appendChild(card);
                }

                function updateCameraList(ids) {
                    ids.forEach(ensureCard);
                    Array.from(cameras).forEach(id => {
                        if (!ids.includes(id)) removeCamera(id);
                    });
                    showPlaceholderIfEmpty();
                }

                function handleFrame(buffer) {
                    // Parse [4-byte id length][id bytes][jpeg bytes]
                    const view = new DataView(buffer);
                    const idLen = view.getUint32(0);
                    const id = new TextDecoder().decode(new Uint8Array(buffer, 4, idLen));
                    const jpegBytes = buffer.slice(4 + idLen);

                    ensureCard(id);
                    const img = document.getElementById('video-' + id);
                    if (!img) return;

                    const url = URL.createObjectURL(new Blob([jpegBytes], { type: 'image/jpeg' }));
                    const prev = lastUrl.get(id);
                    img.onload = () => { if (prev) URL.revokeObjectURL(prev); };
                    img.src = url;
                    lastUrl.set(id, url);
                }

                function removeCamera(id) {
                    cameras.delete(id);
                    const prev = lastUrl.get(id);
                    if (prev) { URL.revokeObjectURL(prev); lastUrl.delete(id); }
                    const el = document.getElementById('cam-' + id);
                    if (el) el.remove();
                    showPlaceholderIfEmpty();
                }

                function showPlaceholderIfEmpty() {
                    const container = document.getElementById('cameraList');
                    if (!container.querySelector('.camera-card')) {
                        container.innerHTML = '<div class="no-cameras">No active cameras</div>';
                    }
                }
            </script>
        </body>
        </html>
    `);
});

// Stub functions - implement properly
function validateCameraAuth(token) {
    // Implement proper JWT or session validation
    return token === 'YOUR_AUTH_TOKEN'; // Placeholder
}

function validateViewerAuth(token) {
    // Implement proper authentication
    return token === 'YOUR_TOKEN'; // Placeholder
}

function generateId() {
    return Math.random().toString(36).substring(2, 15);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
