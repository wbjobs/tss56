const api = window.stickyNoteAPI;

const textarea = document.getElementById('noteTextarea');
const statusIndicator = document.getElementById('statusIndicator');
const peerCountEl = document.getElementById('peerCount');
const syncStatusEl = document.getElementById('syncStatus');
const peersPanel = document.getElementById('peersPanel');
const peersList = document.getElementById('peersList');
const deviceInfoEl = document.getElementById('deviceInfo');
const pinBtn = document.getElementById('pinBtn');
const refreshBtn = document.getElementById('refreshBtn');
const syncBtn = document.getElementById('syncBtn');
const closePeersBtn = document.getElementById('closePeersBtn');
const toast = document.getElementById('toast');

let debounceTimer = null;
let isApplyingRemote = false;
let currentPeers = [];
let toastTimer = null;
let syncStatusTimer = null;

function showToast(message, duration = 2000) {
  toast.textContent = message;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}

function setSyncStatus(text, type = 'normal') {
  syncStatusEl.textContent = text;
  statusIndicator.className = 'status-indicator';

  if (type === 'syncing') {
    statusIndicator.classList.add('syncing');
  } else if (currentPeers.length > 0) {
    statusIndicator.classList.add('online');
  }

  if (syncStatusTimer) clearTimeout(syncStatusTimer);
  if (type === 'syncing') {
    syncStatusTimer = setTimeout(() => {
      syncStatusEl.textContent = '已同步';
      statusIndicator.className = 'status-indicator' + (currentPeers.length > 0 ? ' online' : '');
    }, 1000);
  }
}

function updatePeerDisplay(peers) {
  currentPeers = peers;
  peerCountEl.textContent = `发现 ${peers.length} 台设备`;

  if (peers.length === 0) {
    peersList.innerHTML = '<div class="peer-item empty">暂无设备</div>';
    statusIndicator.className = 'status-indicator';
  } else {
    const uniquePeers = new Map();
    for (const p of peers) {
      uniquePeers.set(p.address + p.name, p);
    }
    const list = [...uniquePeers.values()];
    peersList.innerHTML = list.map(p => `
      <div class="peer-item">
        <span class="peer-name">${escapeHtml(p.name)}</span>
        <span class="peer-addr">(${p.address})</span>
      </div>
    `).join('');
    statusIndicator.className = 'status-indicator online';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

textarea.addEventListener('input', () => {
  if (isApplyingRemote) return;

  setSyncStatus('正在同步...', 'syncing');

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    try {
      const result = await api.sendContentChange(textarea.value);
      if (result && result.ignored) {
        return;
      }
    } catch (e) {
      console.error('Send content error:', e);
    }
  }, 150);
});

pinBtn.addEventListener('click', async () => {
  try {
    const isTop = await api.toggleAlwaysOnTop();
    if (isTop) {
      pinBtn.classList.add('active');
      showToast('窗口已置顶');
    } else {
      pinBtn.classList.remove('active');
      showToast('已取消置顶');
    }
  } catch (e) {
    console.error('Toggle pin error:', e);
  }
});

refreshBtn.addEventListener('click', async () => {
  try {
    await api.refreshPeers();
    showToast('正在搜索设备...');
  } catch (e) {
    console.error('Refresh peers error:', e);
  }
});

syncBtn.addEventListener('click', async () => {
  try {
    await api.requestSync();
    setSyncStatus('请求同步中...', 'syncing');
    showToast('已请求同步');
  } catch (e) {
    console.error('Request sync error:', e);
  }
});

peerCountEl.addEventListener('click', () => {
  peersPanel.classList.toggle('open');
});

closePeersBtn.addEventListener('click', () => {
  peersPanel.classList.remove('open');
});

api.onContentUpdate((data) => {
  isApplyingRemote = true;

  const selectionStart = textarea.selectionStart;
  const selectionEnd = textarea.selectionEnd;
  const scrollTop = textarea.scrollTop;

  textarea.value = data.content || '';

  try {
    textarea.setSelectionRange(
      Math.min(selectionStart, textarea.value.length),
      Math.min(selectionEnd, textarea.value.length)
    );
    textarea.scrollTop = scrollTop;
  } catch (e) {}

  textarea.classList.add('remote-update');
  setTimeout(() => {
    textarea.classList.remove('remote-update');
  }, 600);

  setSyncStatus(`接收自 ${data.from || '远程'}`, 'syncing');

  setTimeout(() => {
    isApplyingRemote = false;
  }, 50);
});

api.onPeersUpdate((peers) => {
  updatePeerDisplay(peers);
});

async function init() {
  try {
    const info = await api.getAppInfo();
    deviceInfoEl.textContent = `本机: ${info.hostName} | IP: ${info.localIPs.join(', ')} | 端口: ${info.port} | ID: ${info.nodeId.slice(0, 8)}`;

    const isTop = await api.isAlwaysOnTop();
    if (isTop) {
      pinBtn.classList.add('active');
    }

    setTimeout(() => {
      api.refreshPeers();
    }, 500);
  } catch (e) {
    console.error('Init error:', e);
    deviceInfoEl.textContent = '初始化失败';
  }
}

window.addEventListener('beforeunload', () => {
  if (api.removeAllListeners) {
    api.removeAllListeners();
  }
});

init();
