const { app, BrowserWindow, ipcMain } = require('electron');
const dgram = require('dgram');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const UDP_PORT = 41234;
const BROADCAST_ADDR = '255.255.255.255';
const DISCOVERY_INTERVAL = 5000;
const HEARTBEAT_INTERVAL = 3000;
const PEER_TIMEOUT = 15000;

const NODE_ID = crypto.randomBytes(8).toString('hex');

let mainWindow = null;
let udpSocket = null;
let peers = new Map();
let currentContent = '';
let currentTimestamp = 0;
let lastSyncSendTimestamp = 0;
let isApplyingRemote = false;
let discoveryTimer = null;
let heartbeatTimer = null;
let peerCleanupTimer = null;

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 360,
    height: 440,
    minWidth: 280,
    minHeight: 320,
    alwaysOnTop: true,
    title: '便签同步器',
    frame: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile('index.html');
}

function createUdpSocket() {
  udpSocket = dgram.createSocket('udp4');

  udpSocket.on('error', (err) => {
    console.error(`UDP socket error:\n${err.stack}`);
  });

  udpSocket.on('message', (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString());
      handleMessage(data, rinfo);
    } catch (e) {
      console.error('Failed to parse UDP message:', e);
    }
  });

  udpSocket.on('listening', () => {
    udpSocket.setBroadcast(true);
    const address = udpSocket.address();
    console.log(`UDP listening on ${address.address}:${address.port}`);
    console.log(`Node ID: ${NODE_ID}`);
    console.log(`Local IPs: ${getLocalIPs().join(', ')}`);
  });

  udpSocket.bind(UDP_PORT, () => {
    try {
      udpSocket.setBroadcast(true);
    } catch (e) {
      console.error('setBroadcast error:', e);
    }
  });
}

function sendMessage(data, address = BROADCAST_ADDR) {
  if (!udpSocket) return;
  const msg = Buffer.from(JSON.stringify(data));
  udpSocket.send(msg, 0, msg.length, UDP_PORT, address, (err) => {
    if (err) {
      console.error('Send error:', err);
    }
  });
}

function handleMessage(data, rinfo) {
  if (!data || !data.type || data.nodeId === NODE_ID) return;

  const peerKey = `${rinfo.address}:${data.nodeId}`;
  const now = Date.now();

  if (data.type === 'DISCOVERY' || data.type === 'HEARTBEAT' || data.type === 'SYNC' || data.type === 'CONTENT_REQ') {
    peers.set(peerKey, {
      address: rinfo.address,
      nodeId: data.nodeId,
      lastSeen: now,
      peerName: data.peerName || '未知设备'
    });
  }

  switch (data.type) {
    case 'DISCOVERY':
      sendMessage({
        type: 'SYNC',
        nodeId: NODE_ID,
        timestamp: currentTimestamp,
        content: currentContent,
        peerName: os.hostname()
      }, rinfo.address);
      break;

    case 'HEARTBEAT':
      break;

    case 'SYNC':
      handleSync(data, rinfo);
      break;

    case 'CONTENT_REQ':
      sendMessage({
        type: 'SYNC',
        nodeId: NODE_ID,
        timestamp: currentTimestamp,
        content: currentContent,
        peerName: os.hostname()
      }, rinfo.address);
      break;
  }

  updatePeersOnUI();
}

function handleSync(data, rinfo) {
  const remoteTimestamp = data.timestamp || 0;
  const remoteContent = data.content || '';

  if (remoteTimestamp > currentTimestamp) {
    currentTimestamp = remoteTimestamp;
    currentContent = remoteContent;
    isApplyingRemote = true;

    if (mainWindow) {
      mainWindow.webContents.send('content:update', {
        content: currentContent,
        timestamp: currentTimestamp,
        from: data.peerName || rinfo.address
      });
    }

    setTimeout(() => {
      isApplyingRemote = false;
    }, 100);
  } else if (remoteTimestamp < currentTimestamp && currentContent !== remoteContent) {
    sendMessage({
      type: 'SYNC',
      nodeId: NODE_ID,
      timestamp: currentTimestamp,
      content: currentContent,
      peerName: os.hostname()
    }, rinfo.address);
  }
}

function broadcastContent() {
  lastSyncSendTimestamp = currentTimestamp;
  sendMessage({
    type: 'SYNC',
    nodeId: NODE_ID,
    timestamp: currentTimestamp,
    content: currentContent,
    peerName: os.hostname()
  });
}

function broadcastDiscovery() {
  sendMessage({
    type: 'DISCOVERY',
    nodeId: NODE_ID,
    peerName: os.hostname(),
    timestamp: currentTimestamp
  });
}

function broadcastHeartbeat() {
  sendMessage({
    type: 'HEARTBEAT',
    nodeId: NODE_ID,
    peerName: os.hostname()
  });
}

function cleanupPeers() {
  const now = Date.now();
  let changed = false;
  for (const [key, peer] of peers.entries()) {
    if (now - peer.lastSeen > PEER_TIMEOUT) {
      peers.delete(key);
      changed = true;
    }
  }
  if (changed) {
    updatePeersOnUI();
  }
}

function updatePeersOnUI() {
  if (!mainWindow) return;
  const peerList = [];
  for (const peer of peers.values()) {
    peerList.push({
      name: peer.peerName,
      address: peer.address
    });
  }
  mainWindow.webContents.send('peers:update', peerList);
}

function setupIPC() {
  ipcMain.handle('content:change', (event, { content }) => {
    if (isApplyingRemote) return { ignored: true };

    const now = Date.now();
    currentTimestamp = now;
    currentContent = content;

    broadcastContent();

    return { timestamp: currentTimestamp };
  });

  ipcMain.handle('app:get-info', () => {
    return {
      nodeId: NODE_ID,
      hostName: os.hostname(),
      localIPs: getLocalIPs(),
      port: UDP_PORT
    };
  });

  ipcMain.handle('window:toggle-always-on-top', () => {
    if (!mainWindow) return false;
    const isTop = mainWindow.isAlwaysOnTop();
    mainWindow.setAlwaysOnTop(!isTop);
    return !isTop;
  });

  ipcMain.handle('window:is-always-on-top', () => {
    if (!mainWindow) return true;
    return mainWindow.isAlwaysOnTop();
  });

  ipcMain.handle('peers:request-refresh', () => {
    broadcastDiscovery();
    updatePeersOnUI();
    return true;
  });

  ipcMain.handle('content:request-sync', () => {
    broadcastDiscovery();
    return true;
  });
}

app.whenReady().then(() => {
  createWindow();
  createUdpSocket();
  setupIPC();

  setTimeout(() => {
    broadcastDiscovery();
  }, 1000);

  discoveryTimer = setInterval(broadcastDiscovery, DISCOVERY_INTERVAL);
  heartbeatTimer = setInterval(broadcastHeartbeat, HEARTBEAT_INTERVAL);
  peerCleanupTimer = setInterval(cleanupPeers, 5000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (discoveryTimer) clearInterval(discoveryTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (peerCleanupTimer) clearInterval(peerCleanupTimer);
  if (udpSocket) {
    try {
      udpSocket.close();
    } catch (e) {}
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
