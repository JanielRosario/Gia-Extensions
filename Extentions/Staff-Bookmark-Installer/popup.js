const DEFAULT_CONFIG_URL = 'https://raw.githubusercontent.com/JanielRosario/Gia-Extensions/main/Bookmark%20Installer/bookmarks-config.json';
const STORAGE_KEYS = {
  agencyId: 'staffBookmarkAgencyId',
  positionId: 'staffBookmarkPositionId',
  skipExistingAnywhere: 'staffBookmarkSkipExistingAnywhere'
};

const state = {
  config: null,
  selectedAgencyId: '',
  selectedPositionId: '',
  installing: false
};

const hasExtensionApi = typeof chrome !== 'undefined' && chrome.bookmarks && chrome.storage;

const agencySelect = document.getElementById('agencySelect');
const positionSelect = document.getElementById('positionSelect');
const skipExistingAnywhere = document.getElementById('skipExistingAnywhere');
const installButton = document.getElementById('installButton');
const refreshButton = document.getElementById('refreshButton');
const configStatus = document.getElementById('configStatus');
const message = document.getElementById('message');
const managedPath = document.getElementById('managedPath');
const bookmarkCount = document.getElementById('bookmarkCount');
const folderCount = document.getElementById('folderCount');
const updatedAt = document.getElementById('updatedAt');
const previewTree = document.getElementById('previewTree');
const resultLog = document.getElementById('resultLog');

function setMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle('error', isError);
}

function setBadge(text, status = 'neutral') {
  configStatus.textContent = text;
  configStatus.className = `badge ${status}`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

function getConfigUrl() {
  if (hasExtensionApi) return DEFAULT_CONFIG_URL;
  return new URL('../../Bookmark%20Installer/bookmarks-config.json', window.location.href).href;
}

function chromeCall(namespace, method, ...args) {
  return new Promise((resolve, reject) => {
    namespace[method](...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
      } else {
        resolve(result);
      }
    });
  });
}

async function getStoredSettings() {
  if (!hasExtensionApi) {
    return {
      [STORAGE_KEYS.agencyId]: localStorage.getItem(STORAGE_KEYS.agencyId) || '',
      [STORAGE_KEYS.positionId]: localStorage.getItem(STORAGE_KEYS.positionId) || '',
      [STORAGE_KEYS.skipExistingAnywhere]: localStorage.getItem(STORAGE_KEYS.skipExistingAnywhere) !== 'false'
    };
  }
  return chromeCall(chrome.storage.local, 'get', Object.values(STORAGE_KEYS));
}

async function setStoredSettings(settings) {
  if (!hasExtensionApi) {
    Object.entries(settings).forEach(([key, value]) => {
      localStorage.setItem(key, String(value));
    });
    return;
  }
  await chromeCall(chrome.storage.local, 'set', settings);
}

function normalizeTitle(value, fallback) {
  return String(value || '').replace(/\s+/g, ' ').trim() || fallback;
}

function normalizeNodes(nodes) {
  return (Array.isArray(nodes) ? nodes : [])
    .map((node) => {
      if (!node || typeof node !== 'object') return null;
      const isFolder = node.type === 'folder' || Array.isArray(node.children);
      const title = normalizeTitle(node.title, isFolder ? 'Folder' : 'Bookmark');
      if (isFolder) {
        return {
          id: node.id || '',
          type: 'folder',
          title,
          children: normalizeNodes(node.children)
        };
      }
      const url = String(node.url || '').trim();
      if (!url) return null;
      return {
        id: node.id || '',
        type: 'bookmark',
        title,
        url
      };
    })
    .filter(Boolean);
}

function normalizeConfig(config) {
  const incoming = config && typeof config === 'object' ? config : {};
  return {
    schemaVersion: Number(incoming.schemaVersion) || 1,
    updatedAt: incoming.updatedAt || '-',
    managedRootTitle: normalizeTitle(incoming.managedRootTitle, 'GWPC Staff'),
    agencies: (Array.isArray(incoming.agencies) ? incoming.agencies : [])
      .map((agency) => ({
        id: String(agency.id || '').trim(),
        name: normalizeTitle(agency.name, 'Agency'),
        positions: (Array.isArray(agency.positions) ? agency.positions : [])
          .map((position) => ({
            id: String(position.id || '').trim(),
            name: normalizeTitle(position.name, 'Position'),
            bookmarks: normalizeNodes(position.bookmarks)
          }))
          .filter((position) => position.id)
      }))
      .filter((agency) => agency.id)
  };
}

function getAgency() {
  return state.config.agencies.find((agency) => agency.id === state.selectedAgencyId) || state.config.agencies[0] || null;
}

function getPosition() {
  const agency = getAgency();
  if (!agency) return null;
  return agency.positions.find((position) => position.id === state.selectedPositionId) || agency.positions[0] || null;
}

function countNodes(nodes) {
  return (nodes || []).reduce((totals, node) => {
    if (node.type === 'folder') {
      const childTotals = countNodes(node.children);
      return {
        folders: totals.folders + 1 + childTotals.folders,
        bookmarks: totals.bookmarks + childTotals.bookmarks
      };
    }
    return {
      folders: totals.folders,
      bookmarks: totals.bookmarks + 1
    };
  }, { folders: 0, bookmarks: 0 });
}

function renderPreviewNodes(nodes) {
  if (!nodes || !nodes.length) {
    return '<div class="empty">No bookmarks configured for this position.</div>';
  }
  return nodes.map((node) => {
    if (node.type === 'folder') {
      return `
        <div class="preview-item folder">
          ${escapeHtml(node.title)}
          <div class="preview-children">${renderPreviewNodes(node.children)}</div>
        </div>
      `;
    }
    return `<div class="preview-item">${escapeHtml(node.title)}</div>`;
  }).join('');
}

function renderSelections() {
  if (!state.config || !state.config.agencies.length) {
    agencySelect.innerHTML = '';
    positionSelect.innerHTML = '';
    installButton.disabled = true;
    previewTree.innerHTML = '<div class="empty">No bookmark config loaded.</div>';
    return;
  }

  if (!state.config.agencies.some((agency) => agency.id === state.selectedAgencyId)) {
    state.selectedAgencyId = state.config.agencies[0].id;
  }

  const agency = getAgency();
  if (!agency.positions.some((position) => position.id === state.selectedPositionId)) {
    state.selectedPositionId = agency.positions[0] ? agency.positions[0].id : '';
  }

  agencySelect.innerHTML = state.config.agencies.map((agencyItem) => (
    `<option value="${escapeHtml(agencyItem.id)}">${escapeHtml(agencyItem.name)}</option>`
  )).join('');
  agencySelect.value = state.selectedAgencyId;

  positionSelect.innerHTML = agency.positions.map((position) => (
    `<option value="${escapeHtml(position.id)}">${escapeHtml(position.name)}</option>`
  )).join('');
  positionSelect.value = state.selectedPositionId;

  const position = getPosition();
  const counts = position ? countNodes(position.bookmarks) : { folders: 0, bookmarks: 0 };
  managedPath.textContent = position ? `${state.config.managedRootTitle} / ${agency.name} / ${position.name}` : '-';
  bookmarkCount.textContent = String(counts.bookmarks);
  folderCount.textContent = String(counts.folders);
  updatedAt.textContent = state.config.updatedAt || '-';
  previewTree.innerHTML = position ? renderPreviewNodes(position.bookmarks) : '<div class="empty">No position selected.</div>';
  installButton.disabled = !hasExtensionApi || !position || state.installing;
}

async function fetchConfig() {
  setBadge('Loading');
  setMessage('Loading bookmark sets...');
  installButton.disabled = true;
  const separator = getConfigUrl().includes('?') ? '&' : '?';
  const url = `${getConfigUrl()}${separator}v=${Date.now()}`;
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Config returned ${response.status}`);
  }
  state.config = normalizeConfig(await response.json());
  if (!state.config.agencies.length) {
    throw new Error('Bookmark config has no agencies.');
  }
  setBadge('Ready', 'ready');
  setMessage(hasExtensionApi ? 'Choose an agency and position, then install.' : 'Open this page as the installed extension to write bookmarks.', !hasExtensionApi);
  renderSelections();
}

async function load() {
  const settings = await getStoredSettings();
  state.selectedAgencyId = settings[STORAGE_KEYS.agencyId] || '';
  state.selectedPositionId = settings[STORAGE_KEYS.positionId] || '';
  skipExistingAnywhere.checked = settings[STORAGE_KEYS.skipExistingAnywhere] !== false;
  try {
    await fetchConfig();
  } catch (error) {
    setBadge('Error', 'error');
    setMessage(error.message || String(error), true);
    renderSelections();
  }
}

async function getBookmarkBarId() {
  const tree = await chromeCall(chrome.bookmarks, 'getTree');
  const root = tree && tree[0];
  const children = root && Array.isArray(root.children) ? root.children : [];
  const bookmarksBar = children.find((node) => node.id === '1') ||
    children.find((node) => /bookmark|favorite/i.test(node.title || '')) ||
    children[0];
  if (!bookmarksBar) {
    throw new Error('Could not find the bookmarks bar.');
  }
  return bookmarksBar.id;
}

async function getChildren(parentId) {
  return chromeCall(chrome.bookmarks, 'getChildren', parentId);
}

async function ensureFolder(parentId, title, stats) {
  const normalizedTitle = normalizeTitle(title, 'Folder');
  const children = await getChildren(parentId);
  const existing = children.find((node) => !node.url && node.title.trim().toLowerCase() === normalizedTitle.toLowerCase());
  if (existing) {
    stats.reusedFolders += 1;
    return existing;
  }
  const created = await chromeCall(chrome.bookmarks, 'create', { parentId, title: normalizedTitle });
  stats.createdFolders += 1;
  return created;
}

async function urlExistsAnywhere(url) {
  const matches = await chromeCall(chrome.bookmarks, 'search', { url });
  return Array.isArray(matches) && matches.some((node) => node.url === url);
}

async function urlExistsUnderParent(parentId, url) {
  const children = await getChildren(parentId);
  return children.some((node) => node.url === url);
}

async function installBookmarkNodes(nodes, parentId, stats, options) {
  for (const node of nodes || []) {
    if (node.type === 'folder') {
      const folder = await ensureFolder(parentId, node.title, stats);
      await installBookmarkNodes(node.children, folder.id, stats, options);
      continue;
    }

    if (options.skipExistingAnywhere && await urlExistsAnywhere(node.url)) {
      stats.skippedBookmarks += 1;
      continue;
    }

    if (await urlExistsUnderParent(parentId, node.url)) {
      stats.skippedBookmarks += 1;
      continue;
    }

    await chromeCall(chrome.bookmarks, 'create', {
      parentId,
      title: normalizeTitle(node.title, node.url),
      url: node.url
    });
    stats.createdBookmarks += 1;
  }
}

async function installBookmarks() {
  const agency = getAgency();
  const position = getPosition();
  if (!agency || !position) {
    setMessage('Choose an agency and position before installing.', true);
    return;
  }

  state.installing = true;
  installButton.disabled = true;
  resultLog.textContent = 'Installing...';
  setMessage('Installing bookmarks...');

  const stats = {
    createdFolders: 0,
    reusedFolders: 0,
    createdBookmarks: 0,
    skippedBookmarks: 0
  };

  try {
    await setStoredSettings({
      [STORAGE_KEYS.agencyId]: agency.id,
      [STORAGE_KEYS.positionId]: position.id,
      [STORAGE_KEYS.skipExistingAnywhere]: skipExistingAnywhere.checked
    });

    const barId = await getBookmarkBarId();
    const managedRoot = await ensureFolder(barId, state.config.managedRootTitle, stats);
    const agencyFolder = await ensureFolder(managedRoot.id, agency.name, stats);
    const positionFolder = await ensureFolder(agencyFolder.id, position.name, stats);
    await installBookmarkNodes(position.bookmarks, positionFolder.id, stats, {
      skipExistingAnywhere: skipExistingAnywhere.checked
    });

    resultLog.textContent = [
      `Managed folder: ${state.config.managedRootTitle} / ${agency.name} / ${position.name}`,
      `Folders created: ${stats.createdFolders}`,
      `Folders reused: ${stats.reusedFolders}`,
      `Bookmarks created: ${stats.createdBookmarks}`,
      `Bookmarks skipped: ${stats.skippedBookmarks}`
    ].join('\n');
    setMessage('Bookmark installation finished.');
  } catch (error) {
    resultLog.textContent = error.message || String(error);
    setMessage(error.message || String(error), true);
  } finally {
    state.installing = false;
    renderSelections();
  }
}

agencySelect.addEventListener('change', async () => {
  state.selectedAgencyId = agencySelect.value;
  const agency = getAgency();
  state.selectedPositionId = agency && agency.positions[0] ? agency.positions[0].id : '';
  await setStoredSettings({
    [STORAGE_KEYS.agencyId]: state.selectedAgencyId,
    [STORAGE_KEYS.positionId]: state.selectedPositionId
  });
  renderSelections();
});

positionSelect.addEventListener('change', async () => {
  state.selectedPositionId = positionSelect.value;
  await setStoredSettings({
    [STORAGE_KEYS.positionId]: state.selectedPositionId
  });
  renderSelections();
});

skipExistingAnywhere.addEventListener('change', async () => {
  await setStoredSettings({
    [STORAGE_KEYS.skipExistingAnywhere]: skipExistingAnywhere.checked
  });
});

installButton.addEventListener('click', installBookmarks);
refreshButton.addEventListener('click', load);

load();
