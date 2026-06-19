const api = window.stickyNoteAPI;

const tabsScroll = document.getElementById('tabsScroll');
const noteTitleInput = document.getElementById('noteTitleInput');
const textarea = document.getElementById('noteTextarea');
const statusIndicator = document.getElementById('statusIndicator');
const peerCountEl = document.getElementById('peerCount');
const noteCountEl = document.getElementById('noteCount');
const syncStatusEl = document.getElementById('syncStatus');
const peersPanel = document.getElementById('peersPanel');
const peersList = document.getElementById('peersList');
const deviceInfoEl = document.getElementById('deviceInfo');
const pinBtn = document.getElementById('pinBtn');
const newNoteBtn = document.getElementById('newNoteBtn');
const refreshBtn = document.getElementById('refreshBtn');
const syncBtn = document.getElementById('syncBtn');
const deleteNoteBtn = document.getElementById('deleteNoteBtn');
const closePeersBtn = document.getElementById('closePeersBtn');
const toast = document.getElementById('toast');

let notes = [];
let activeNoteId = null;
let currentPeers = [];
let isApplyingRemote = false;
let contentDebounceTimer = null;
let titleDebounceTimer = null;
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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

function renderTabs() {
  const sorted = [...notes].sort((a, b) => a.order - b.order);
  tabsScroll.innerHTML = '';

  for (const note of sorted) {
    const tab = document.createElement('div');
    tab.className = 'tab-item' + (note.id === activeNoteId ? ' active' : '');
    tab.dataset.noteId = note.id;

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = note.title || '未命名';
    title.title = note.title || '未命名';

    const closeBtn = document.createElement('span');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '×';
    closeBtn.title = '删除便签';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDeleteNote(note.id);
    });

    tab.appendChild(title);
    tab.appendChild(closeBtn);

    tab.addEventListener('click', () => {
      if (note.id !== activeNoteId) {
        switchNote(note.id);
      }
    });

    tabsScroll.appendChild(tab);
  }

  const plusBtn = document.createElement('div');
  plusBtn.className = 'tab-item new-tab';
  plusBtn.textContent = '+';
  plusBtn.title = '新建便签';
  plusBtn.addEventListener('click', handleCreateNote);
  tabsScroll.appendChild(plusBtn);

  noteCountEl.textContent = `共 ${notes.length} 条便签`;
}

function getActiveNote() {
  return notes.find(n => n.id === activeNoteId) || null;
}

function switchNote(noteId) {
  activeNoteId = noteId;
  const note = getActiveNote();
  if (!note) return;

  isApplyingRemote = true;
  noteTitleInput.value = note.title || '';
  textarea.value = note.content || '';
  isApplyingRemote = false;

  renderTabs();
}

async function handleCreateNote() {
  try {
    const note = await api.createNote();
    showToast(`新建便签「${note.title}」`);
  } catch (e) {
    console.error('Create note error:', e);
    showToast('创建失败');
  }
}

async function handleDeleteNote(noteId) {
  if (!confirm('确定要删除这条便签吗？此操作会同步到所有设备。')) {
    return;
  }
  try {
    const result = await api.deleteNote(noteId);
    if (result.ok) {
      showToast('便签已删除');
    }
  } catch (e) {
    console.error('Delete note error:', e);
    showToast('删除失败');
  }
}

noteTitleInput.addEventListener('input', () => {
  if (isApplyingRemote) return;
  const note = getActiveNote();
  if (!note || note.title === noteTitleInput.value) return;

  if (titleDebounceTimer) clearTimeout(titleDebounceTimer);
  titleDebounceTimer = setTimeout(async () => {
    try {
      if (!activeNoteId) return;
      setSyncStatus('同步标题...', 'syncing');
      await api.updateNoteTitle(activeNoteId, noteTitleInput.value);
    } catch (e) {
      console.error('Update title error:', e);
    }
  }, 200);
});

textarea.addEventListener('input', () => {
  if (isApplyingRemote) return;
  const note = getActiveNote();
  if (!note || note.content === textarea.value) return;

  setSyncStatus('正在同步...', 'syncing');

  if (contentDebounceTimer) clearTimeout(contentDebounceTimer);
  contentDebounceTimer = setTimeout(async () => {
    try {
      if (!activeNoteId) return;
      await api.updateNoteContent(activeNoteId, textarea.value);
    } catch (e) {
      console.error('Update content error:', e);
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

newNoteBtn.addEventListener('click', handleCreateNote);

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
    await api.requestFullSync();
    setSyncStatus('请求全量同步...', 'syncing');
    showToast('已请求全量同步');
  } catch (e) {
    console.error('Request sync error:', e);
  }
});

deleteNoteBtn.addEventListener('click', () => {
  if (activeNoteId) {
    handleDeleteNote(activeNoteId);
  }
});

peerCountEl.addEventListener('click', () => {
  peersPanel.classList.toggle('open');
});

closePeersBtn.addEventListener('click', () => {
  peersPanel.classList.remove('open');
});

function applyNotesFromRemote(incomingNotes, fromName) {
  const oldActiveNote = getActiveNote();
  const oldActiveStillExists = incomingNotes.some(n => n.id === activeNoteId);

  notes = [...incomingNotes];

  let flashActive = false;

  if (!oldActiveStillExists && notes.length > 0) {
    activeNoteId = notes[0].id;
    flashActive = true;
  }

  if (flashActive || activeNoteId === null) {
    isApplyingRemote = true;
    const note = getActiveNote();
    if (note) {
      noteTitleInput.value = note.title || '';
      textarea.value = note.content || '';
    }
    isApplyingRemote = false;
  } else {
    const note = getActiveNote();
    if (note && !isApplyingRemote) {
      const oldTitle = noteTitleInput.value;
      const oldContent = textarea.value;

      if (note.title !== oldTitle) {
        isApplyingRemote = true;
        noteTitleInput.value = note.title || '';
        isApplyingRemote = false;
      }
      if (note.content !== oldContent) {
        isApplyingRemote = true;
        const selStart = textarea.selectionStart;
        const selEnd = textarea.selectionEnd;
        const scrollTop = textarea.scrollTop;

        textarea.value = note.content || '';
        try {
          textarea.setSelectionRange(
            Math.min(selStart, textarea.value.length),
            Math.min(selEnd, textarea.value.length)
          );
          textarea.scrollTop = scrollTop;
        } catch (e) {}

        textarea.classList.add('remote-update');
        setTimeout(() => textarea.classList.remove('remote-update'), 600);
        isApplyingRemote = false;
      }
    }
  }

  renderTabs();

  if (fromName && fromName !== 'local') {
    setSyncStatus(`接收自 ${fromName}`, 'syncing');
  }
}

api.onNotesUpdate((data) => {
  applyNotesFromRemote(data.notes || [], data.from || 'remote');
});

api.onPeersUpdate((peers) => {
  updatePeerDisplay(peers);
});

async function init() {
  try {
    const data = await api.getAllNotes();
    notes = data.notes || [];
    if (notes.length > 0) {
      activeNoteId = notes[0].id;
    }

    const info = await api.getAppInfo();
    const clockStr = info.lamportClock ? ` | Clock: ${info.lamportClock}` : '';
    deviceInfoEl.textContent = `本机: ${info.hostName} | IP: ${info.localIPs.join(', ')} | 端口: ${info.port} | ID: ${info.nodeId.slice(0, 8)}${clockStr}`;

    const isTop = await api.isAlwaysOnTop();
    if (isTop) {
      pinBtn.classList.add('active');
    }

    const active = getActiveNote();
    if (active) {
      noteTitleInput.value = active.title || '';
      textarea.value = active.content || '';
    }

    renderTabs();

    setTimeout(() => {
      api.refreshPeers();
    }, 500);

    setInterval(async () => {
      try {
        const fresh = await api.getAppInfo();
        const cStr = fresh.lamportClock ? ` | Clock: ${fresh.lamportClock}` : '';
        deviceInfoEl.textContent = `本机: ${fresh.hostName} | IP: ${fresh.localIPs.join(', ')} | 端口: ${fresh.port} | ID: ${fresh.nodeId.slice(0, 8)}${cStr}`;
      } catch (e) {}
    }, 5000);
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
