const { app, BrowserWindow, ipcMain } = require('electron');
const dgram = require('dgram');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const UDP_PORT = 41234;
const BROADCAST_ADDR = '255.255.255.255';
const DISCOVERY_INTERVAL = 8000;
const HEARTBEAT_INTERVAL = 5000;
const PEER_TIMEOUT = 20000;

const DEDUP_CACHE_MAX = 200;
const SAME_CONTENT_SUPPRESS_MS = 2000;
const REMOTE_UPDATE_COOLDOWN_MS = 1500;

const NODE_ID = crypto.randomBytes(8).toString('hex');

let mainWindow = null;
let udpSocket = null;
let peers = new Map();

let currentContent = '';
let lamportClock = 0;
let originNodeId = NODE_ID;

const seenMessageIds = new Map();
const lastBroadcastSignature = { hash: '', time: 0 };
let lastRemoteApplyTime = 0;

let isApplyingRemote = false;
let discoveryTimer = null;
let heartbeatTimer = null;
let peerCleanupTimer = null;
let dedupCleanupTimer = null;

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

function generateMsgId() {
  return crypto.randomBytes(12).toString('hex');
}

function contentHash(str) {
  return crypto.createHash('sha1').update(str || '').digest('hex');
}

function tickClock(remoteClock) {
  const now = Date.now();
  if (typeof remoteClock === 'number' && remoteClock > lamportClock) {
    lamportClock = remoteClock;
  }
  lamportClock = Math.max(lamportClock + 1, now);
  return lamportClock;
}

function isMessageDuplicate(msgId) {
  if (!msgId) return false;
  const now = Date.now();
  if (seenMessageIds.has(msgId)) {
    seenMessageIds.set(msgId, now);
    return true;
  }
  seenMessageIds.set(msgId, now);
  if (seenMessageIds.size > DEDUP_CACHE_MAX) {
    const sortedKeys = [...seenMessageIds.entries()]
      .sort((a, b) => a[1] - b[1]);
    const toDelete = sortedKeys.slice(0, Math.floor(DEDUP_CACHE_MAX / 4));
    for (const [k] of toDelete) {
      seenMessageIds.delete(k);
    }
  }
  return false;
}

function versionCompare(rmtClock, rmtNodeId, rmtOrigin) {
  if (rmtClock !== lamportClock) {
    return rmtClock > lamportClock ? 1 : -1;
  }
  if (rmtOrigin !== originNodeId) {
    return rmtOrigin > originNodeId ? 1 : -1;
  }
  return rmtNodeId > NODE_ID ? 1 : (rmtNodeId < NODE_ID ? -1 : 0);
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
    try {
      udpSocket.setBroadcast(true);
    } catch (e) {}
    const address = udpSocket.address();
    console.log(`[UDP] listening on ${address.address}:${address.port}`);
    console.log(`[Node] ID: ${NODE_ID} Host: ${os.hostname()}`);
    console.log(`[Net] IPs: ${getLocalIPs().join(', ')}`);
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
  const envelope = { ...data, msgId: data.msgId || generateMsgId() };
  const msg = Buffer.from(JSON.stringify(envelope));
  udpSocket.send(msg, 0, msg.length, UDP_PORT, address, (err) => {
    if (err) {
      console.error('Send error:', err);
    }
  });
}

function handleMessage(data, rinfo) {
  if (!data || !data.type) return;

  if (data.nodeId === NODE_ID) return;

  if (data.msgId && isMessageDuplicate(data.msgId)) {
    return;
  }

  const peerKey = `${rinfo.address}:${data.nodeId}`;
  const now = Date.now();

  if (['DISCOVERY', 'HEARTBEAT', 'SYNC', 'CONTENT_REQ', 'ACK'].includes(data.type)) {
    peers.set(peerKey, {
      address: rinfo.address,
      nodeId: data.nodeId,
      lastSeen: now,
      peerName: data.peerName || '未知设备'
    });
  }

  switch (data.type) {
    case 'DISCOVERY':
      handleDiscovery(data, rinfo);
      break;

    case 'HEARTBEAT':
      break;

    case 'SYNC':
      handleSync(data, rinfo);
      break;

    case 'CONTENT_REQ':
      sendSyncTo(rinfo.address);
      break;

    case 'ACK':
      break;
  }

  updatePeersOnUI();
}

function handleDiscovery(data, rinfo) {
  const rmtClock = data.lamportClock || 0;
  if (rmtClock > lamportClock) {
    lamportClock = rmtClock;
  }

  if (currentContent && (data.lamportClock || 0) < lamportClock) {
    setTimeout(() => sendSyncTo(rinfo.address), 100 + Math.random() * 200);
  } else if (!currentContent && data.content) {
    handleSync(data, rinfo);
  } else if (currentContent) {
    setTimeout(() => sendSyncTo(rinfo.address), 50 + Math.random() * 150);
  }
}

function handleSync(data, rinfo) {
  const rmtContent = data.content || '';
  const rmtClock = typeof data.lamportClock === 'number' ? data.lamportClock : (data.timestamp || 0);
  const rmtOrigin = data.originNodeId || data.nodeId;
  const rmtNodeId = data.nodeId;

  if (rmtClock > lamportClock) {
    lamportClock = rmtClock;
  }

  if (rmtContent === currentContent) {
    if (rmtClock >= lamportClock) {
      originNodeId = rmtOrigin;
    }
    return;
  }

  const cmp = versionCompare(rmtClock, rmtNodeId, rmtOrigin);

  if (cmp > 0) {
    lamportClock = rmtClock;
    originNodeId = rmtOrigin;
    currentContent = rmtContent;
    lastRemoteApplyTime = Date.now();
    isApplyingRemote = true;

    if (mainWindow) {
      mainWindow.webContents.send('content:update', {
        content: currentContent,
        lamportClock: lamportClock,
        originNodeId: originNodeId,
        from: data.peerName || rinfo.address
      });
    }

    setTimeout(() => {
      isApplyingRemote = false;
    }, 100);

    return;
  }

  if (cmp < 0) {
    const now = Date.now();
    if (now - lastRemoteApplyTime < REMOTE_UPDATE_COOLDOWN_MS) {
      return;
    }
    if (lastBroadcastSignature.hash === contentHash(currentContent) &&
        now - lastBroadcastSignature.time < SAME_CONTENT_SUPPRESS_MS) {
      return;
    }
    setTimeout(() => {
      broadcastContent();
    }, 50 + Math.random() * 150);
  }
}

function sendSyncTo(address) {
  if (!udpSocket) return;
  sendMessage({
    type: 'SYNC',
    nodeId: NODE_ID,
    lamportClock: lamportClock,
    originNodeId: originNodeId,
    content: currentContent,
    peerName: os.hostname()
  }, address);
}

function broadcastContent() {
  const hash = contentHash(currentContent);
  const now = Date.now();

  if (lastBroadcastSignature.hash === hash &&
      now - lastBroadcastSignature.time < SAME_CONTENT_SUPPRESS_MS) {
    return;
  }

  lastBroadcastSignature.hash = hash;
  lastBroadcastSignature.time = now;

  sendMessage({
    type: 'SYNC',
    nodeId: NODE_ID,
    lamportClock: lamportClock,
    originNodeId: originNodeId,
    content: currentContent,
    peerName: os.hostname()
  });

  console.log(`[BROADCAST] clock=${lamportClock} origin=${originNodeId.slice(0, 6)} len=${currentContent.length}`);
}

function broadcastDiscovery() {
  sendMessage({
    type: 'DISCOVERY',
    nodeId: NODE_ID,
    peerName: os.hostname(),
    lamportClock: lamportClock,
    originNodeId: originNodeId,
    content: currentContent
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

function cleanupDedupCache() {
  if (seenMessageIds.size <= DEDUP_CACHE_MAX) return;
  const now = Date.now();
  const cutoff = now - 60000;
  for (const [k, t] of seenMessageIds.entries()) {
    if (t < cutoff) {
      seenMessageIds.delete(k);
    }
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

    if (content === currentContent) {
      return { timestamp: lamportClock, unchanged: true };
    }

    tickClock();
    originNodeId = NODE_ID;
    currentContent = content;

    broadcastContent();

    return { timestamp: lamportClock, originNodeId: NODE_ID };
  });

  ipcMain.handle('app:get-info', () => {
    return {
      nodeId: NODE_ID,
      hostName: os.hostname(),
      localIPs: getLocalIPs(),
      port: UDP_PORT,
      lamportClock: lamportClock,
      peerCount: peers.size,
      dedupCacheSize: seenMessageIds.size
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
  dedupCleanupTimer = setInterval(cleanupDedupCache, 30000);

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
  if (dedupCleanupTimer) clearInterval(dedupCleanupTimer);
  if (udpSocket) {
    try {
      udpSocket.close();
    } catch (e) {}
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
