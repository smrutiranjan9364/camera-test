// viewer.js

// Connect to viewer WebSocket
const socket = new WebSocket('wss://your-server.com/viewer');

socket.onopen = () => {
    console.log('Connected to viewer server');
};

socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    if (data.type === 'cameras') {
        updateCameraList(data.data);
    } else if (data.type === 'video') {
        displayVideo(data.cameraId, data.data);
    } else if (data.type === 'camera_closed') {
        removeCamera(data.cameraId);
    }
};

socket.onclose = () => {
    console.log('Disconnected from viewer server');
    // Try to reconnect after 3 seconds
    setTimeout(() => {
        location.reload();
    }, 3000);
};

// Update camera list
function updateCameraList(cameras) {
    const listElement = document.getElementById('camera-list');
    
    if (cameras.length === 0) {
        listElement.innerHTML = '<div class="no-camera">No cameras connected</div>';
        return;
    }
    
    listElement.innerHTML = cameras.map(camera => 
        `<div class="camera-item" data-camera-id="${camera.id}">
            Camera ${camera.id} - Started at ${new Date(camera.startTime).toLocaleString()}
        </div>`
    ).join('');
    
    // Add click handlers
    document.querySelectorAll('.camera-item').forEach(item => {
        item.addEventListener('click', () => {
            const cameraId = item.getAttribute('data-camera-id');
            selectCamera(cameraId);
        });
    });
}

// Select a camera to view
function selectCamera(cameraId) {
    const container = document.getElementById('video-container');
    container.innerHTML = `
        <video id="video-player" autoplay muted></video>
        <p>Camera ${cameraId}</p>
    `;
    
    // Highlight selected camera
    document.querySelectorAll('.camera-item').forEach(item => {
        if (item.getAttribute('data-camera-id') === cameraId) {
            item.style.backgroundColor = '#e3f2fd';
        } else {
            item.style.backgroundColor = '';
        }
    });
}

// Display video data
function displayVideo(cameraId, data) {
    const video = document.getElementById('video-player');
    if (!video) return;
    
    // Create blob from base64 data
    const blob = new Blob([atob(data)], { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    
    // Play the video
    video.src = url;
}

// Remove camera from list
function removeCamera(cameraId) {
    const item = document.querySelector(`[data-camera-id="${cameraId}"]`);
    if (item) {
        item.remove();
    }
    
    // If this was the selected camera, clear the video
    const video = document.getElementById('video-player');
    if (video) {
        const container = document.getElementById('video-container');
        container.innerHTML = '<div class="no-camera">Camera disconnected</div>';
    }
}