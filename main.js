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

const DEDUP_CACHE_MAX = 500;
const SAME_OP_SUPPRESS_MS = 2000;
const REMOTE_UPDATE_COOLDOWN_MS = 800;

const NODE_ID = crypto.randomBytes(8).toString('hex');

let mainWindow = null;
let udpSocket = null;
const peers = new Map();

const notes = new Map();
let lamportClock = 0;

const seenMessageIds = new Map();
const lastBroadcastOps = new Map();
let lastRemoteApplyTime = 0;

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

function generateNoteId() {
  return crypto.randomBytes(8).toString('hex');
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

function versionNewer(rmtClock, rmtOrigin, localClock, localOrigin) {
  if (rmtClock !== localClock) {
    return rmtClock > localClock;
  }
  return rmtOrigin > localOrigin;
}

function createDefaultNote() {
  const id = generateNoteId();
  tickClock();
  return {
    id,
    title: '新便签',
    content: '',
    order: notes.size,
    deleted: false,
    clock: lamportClock,
    origin: NODE_ID
  };
}

function serializeNotes() {
  return [...notes.values()];
}

function serializeActiveNotes() {
  return [...notes.values()].filter(n => !n.deleted).sort((a, b) => a.order - b.order);
}

function broadcastNoteOp(op, noteId, payload) {
  const note = notes.get(noteId);
  if (!note) return;

  tickClock();
  note.clock = lamportClock;
  note.origin = NODE_ID;

  const opKey = `${op}:${noteId}:${JSON.stringify(payload)}`;
  const now = Date.now();
  const prev = lastBroadcastOps.get(opKey);
  if (prev && now - prev < SAME_OP_SUPPRESS_MS) {
    return;
  }
  lastBroadcastOps.set(opKey, now);
  if (lastBroadcastOps.size > 100) {
    const sorted = [...lastBroadcastOps.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of sorted.slice(0, 25)) {
      lastBroadcastOps.delete(k);
    }
  }

  sendMessage({
    type: 'NOTE_OP',
    nodeId: NODE_ID,
    lamportClock: lamportClock,
    peerName: os.hostname(),
    op,
    noteId,
    payload: applyOpPayload(op, payload, note),
    noteClock: note.clock,
    noteOrigin: note.origin
  });

  console.log(`[OP] ${op} note=${noteId.slice(0, 6)} clock=${note.clock}`);
}

function applyOpPayload(op, payload, note) {
  switch (op) {
    case 'create':
      return {
        title: note.title,
        content: note.content,
        order: note.order,
        deleted: note.deleted
      };
    case 'update_title':
      return { title: payload.title };
    case 'update_content':
      return { content: payload.content };
    case 'update_order':
      return { order: payload.order };
    case 'delete':
      return { deleted: true };
    case 'restore':
      return { deleted: false };
    default:
      return payload || {};
  }
}

function applyRemoteNoteOp(op, noteId, payload, rmtClock, rmtOrigin) {
  let note = notes.get(noteId);

  if (!note) {
    if (op === 'create') {
      tickClock(rmtClock);
      note = {
        id: noteId,
        title: payload.title || '未命名',
        content: payload.content || '',
        order: typeof payload.order === 'number' ? payload.order : notes.size,
        deleted: !!payload.deleted,
        clock: rmtClock,
        origin: rmtOrigin
      };
      notes.set(noteId, note);
      return true;
    }
    if (op === 'delete' && payload && payload.deleted) {
      tickClock(rmtClock);
      notes.set(noteId, {
        id: noteId,
        title: payload.title || '已删除',
        content: '',
        order: notes.size,
        deleted: true,
        clock: rmtClock,
        origin: rmtOrigin
      });
      return true;
    }
    return false;
  }

  if (!versionNewer(rmtClock, rmtOrigin, note.clock, note.origin)) {
    return false;
  }

  tickClock(rmtClock);
  note.clock = rmtClock;
  note.origin = rmtOrigin;

  let changed = false;
  switch (op) {
    case 'create':
      if (typeof payload.title !== undefined && note.title !== payload.title) {
      note.title = payload.title; changed = true;
    }
    if (typeof payload.content !== undefined && note.content !== payload.content) {
      note.content = payload.content; changed = true;
    }
    if (typeof payload.order === 'number' && note.order !== payload.order) {
      note.order = payload.order; changed = true;
    }
    if (typeof payload.deleted === 'boolean' && note.deleted !== payload.deleted) {
      note.deleted = payload.deleted; changed = true;
    }
    break;
    case 'update_title':
      if (payload && typeof payload.title === 'string' && note.title !== payload.title) {
        note.title = payload.title;
        changed = true;
      }
      break;
    case 'update_content':
      if (payload && typeof payload.content !== undefined && note.content !== payload.content) {
        note.content = payload.content;
        changed = true;
      }
      break;
    case 'update_order':
      if (payload && typeof payload.order === 'number' && note.order !== payload.order) {
        note.order = payload.order;
        changed = true;
      }
      break;
    case 'delete':
      if (!note.deleted) {
        note.deleted = true;
        changed = true;
      }
      break;
    case 'restore':
      if (note.deleted) {
        note.deleted = false;
        changed = true;
      }
      break;
  }
  return changed;
}

function applyFullState(remoteNotes) {
  let anyChanged = false;
  for (const rn of remoteNotes) {
    if (!rn || !rn.id) continue;
    const local = notes.get(rn.id);
    if (!local) {
      tickClock(rn.clock);
      notes.set(rn.id, {
        id: rn.id,
        title: rn.title || '未命名',
        content: rn.content || '',
        order: typeof rn.order === 'number' ? rn.order : notes.size,
        deleted: !!rn.deleted,
        clock: rn.clock || 0,
        origin: rn.origin || NODE_ID
      });
      anyChanged = true;
      continue;
    }
    if (versionNewer(rn.clock, rn.origin, local.clock, local.origin)) {
      tickClock(rn.clock);
      let c = false;
      if (local.title !== (rn.title || '')) { local.title = rn.title || ''; c = true; }
      if (local.content !== (rn.content || '')) { local.content = rn.content || ''; c = true; }
      if (typeof rn.order === 'number' && local.order !== rn.order) { local.order = rn.order; c = true; }
      if (local.deleted !== !!rn.deleted) { local.deleted = !!rn.deleted; c = true; }
      local.clock = rn.clock;
      local.origin = rn.origin || NODE_ID;
      if (c) anyChanged = true;
    }
  }
  return anyChanged;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 500,
    minWidth: 340,
    minHeight: 380,
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
  if (data.msgId && isMessageDuplicate(data.msgId)) return;

  const peerKey = `${rinfo.address}:${data.nodeId}`;
  const now = Date.now();

  if (['DISCOVERY', 'HEARTBEAT', 'NOTE_OP', 'FULL_STATE', 'STATE_REQ'].includes(data.type)) {
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
    case 'NOTE_OP':
      handleNoteOp(data, rinfo);
      break;
    case 'FULL_STATE':
      handleFullState(data, rinfo);
      break;
    case 'STATE_REQ':
      sendFullStateTo(rinfo.address);
      break;
  }

  updatePeersOnUI();
}

function handleDiscovery(data, rinfo) {
  const rmtClock = data.lamportClock || 0;
  if (rmtClock > lamportClock) {
    lamportClock = rmtClock;
  }
  setTimeout(() => sendFullStateTo(rinfo.address), 50 + Math.random() * 150);
}

function handleNoteOp(data, rinfo) {
  const { op, noteId, payload, noteClock, noteOrigin } = data;
  if (!op || !noteId) return;
  const rmtClock = typeof noteClock === 'number' ? noteClock : (data.lamportClock || 0);
  const rmtOrigin = noteOrigin || data.nodeId;

  const now = Date.now();
  if (now - lastRemoteApplyTime < REMOTE_UPDATE_COOLDOWN_MS && notes.size > 0) {
    // still proceed but delayed
  }

  const changed = applyRemoteNoteOp(op, noteId, payload, rmtClock, rmtOrigin);

  if (changed) {
    lastRemoteApplyTime = now;
    pushStateToRenderer(data.peerName || rinfo.address);
  }
}

function handleFullState(data, rinfo) {
  if (!Array.isArray(data.notes)) return;
  const changed = applyFullState(data.notes);
  if (changed) {
    pushStateToRenderer(data.peerName || rinfo.address);
  }
}

function sendFullStateTo(address) {
  sendMessage({
    type: 'FULL_STATE',
    nodeId: NODE_ID,
    lamportClock: lamportClock,
    peerName: os.hostname(),
    notes: serializeNotes()
  }, address);
}

function broadcastFullState() {
  sendMessage({
    type: 'FULL_STATE',
    nodeId: NODE_ID,
    lamportClock: lamportClock,
    peerName: os.hostname(),
    notes: serializeNotes()
  });
}

function broadcastDiscovery() {
  sendMessage({
    type: 'DISCOVERY',
    nodeId: NODE_ID,
    peerName: os.hostname(),
    lamportClock: lamportClock
  });
}

function broadcastHeartbeat() {
  sendMessage({
    type: 'HEARTBEAT',
    nodeId: NODE_ID,
    peerName: os.hostname()
  });
}

function pushStateToRenderer(fromName) {
  if (!mainWindow) return;
  mainWindow.webContents.send('notes:update', {
    notes: serializeActiveNotes(),
    from: fromName || 'remote'
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
  const cutoff = now - 120000;
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

function ensureAtLeastOneNote() {
  const actives = serializeActiveNotes();
  if (actives.length === 0) {
    const note = createDefaultNote();
    notes.set(note.id, note);
    return note.id;
  }
  return actives[0].id;
}

function setupIPC() {
  ipcMain.handle('notes:get-all', () => {
    ensureAtLeastOneNote();
    return {
      notes: serializeActiveNotes(),
    nodeId: NODE_ID,
    lamportClock: lamportClock
    };
  });

  ipcMain.handle('note:create', () => {
    const note = createDefaultNote();
    notes.set(note.id, note);
    broadcastNoteOp('create', note.id, {});
    pushStateToRenderer('local');
    return note;
  });

  ipcMain.handle('note:update-title', (event, { noteId, title }) => {
    const note = notes.get(noteId);
    if (!note || note.title === title) return { ok: false };
    tickClock();
    note.title = title;
    note.clock = lamportClock;
    note.origin = NODE_ID;
    broadcastNoteOp('update_title', noteId, { title });
    pushStateToRenderer('local');
    return { ok: true, clock: note.clock };
  });

  ipcMain.handle('note:update-content', (event, { noteId, content }) => {
    const note = notes.get(noteId);
    if (!note || note.content === content) return { ok: false };
    tickClock();
    note.content = content;
    note.clock = lamportClock;
    note.origin = NODE_ID;
    broadcastNoteOp('update_content', noteId, { content });
    pushStateToRenderer('local');
    return { ok: true, clock: note.clock };
  });

  ipcMain.handle('note:update-order', (event, { noteId, order }) => {
    const note = notes.get(noteId);
    if (!note || note.order === order) return { ok: false };
    tickClock();
    note.order = order;
    note.clock = lamportClock;
    note.origin = NODE_ID;
    broadcastNoteOp('update_order', noteId, { order });
    pushStateToRenderer('local');
    return { ok: true, clock: note.clock };
  });

  ipcMain.handle('note:delete', (event, { noteId }) => {
    const note = notes.get(noteId);
    if (!note || note.deleted) return { ok: false };
    tickClock();
    note.deleted = true;
    note.clock = lamportClock;
    note.origin = NODE_ID;
    broadcastNoteOp('delete', noteId, {});
    const active = serializeActiveNotes();
    const nextId = active.length > 0 ? active[0].id : null;
    pushStateToRenderer('local');
    return { ok: true, nextActiveId: nextId };
  });

  ipcMain.handle('app:get-info', () => {
    return {
      nodeId: NODE_ID,
      hostName: os.hostname(),
      localIPs: getLocalIPs(),
      port: UDP_PORT,
      lamportClock: lamportClock,
      peerCount: peers.size,
      noteCount: serializeActiveNotes().length,
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

  ipcMain.handle('notes:request-sync', () => {
    sendMessage({
      type: 'STATE_REQ',
      nodeId: NODE_ID,
      peerName: os.hostname()
    });
    return true;
  });
}

app.whenReady().then(() => {
  ensureAtLeastOneNote();
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
