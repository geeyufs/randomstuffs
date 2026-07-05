const DEFAULT_PANEL_COUNT = 2;
const BASE_MIN_PANEL_PERCENT = 10;
const STORAGE_CODEC_KEY = 'comparator-storage-v1';
const APP_VERSION = window.__COMPARATOR_ASSET_VERSION__ || 'dev';

const STORAGE_KEYS = {
  LIBRARY: 'text_comp_library_v1',
  SKIP_DELETE_CONFIRM: 'text_comp_skip_delete_confirm',
  APP_SCRIPT_HASH: 'text_comp_app_script_hash_v1'
};

const elements = {
  appContainer: document.getElementById('app-container'),
  topbarRevealZone: document.getElementById('topbar-reveal-zone'),
  appHeader: document.querySelector('.app-header'),
  workspace: document.querySelector('.workspace'),
  groupSelect: document.getElementById('group-select'),
  entrySelect: document.getElementById('entry-select'),
  groupDropdown: document.getElementById('group-dropdown'),
  entryDropdown: document.getElementById('entry-dropdown'),
  groupDropdownButton: document.getElementById('group-dropdown-button'),
  entryDropdownButton: document.getElementById('entry-dropdown-button'),
  groupDropdownLabel: document.getElementById('group-dropdown-label'),
  entryDropdownLabel: document.getElementById('entry-dropdown-label'),
  groupDropdownMenu: document.getElementById('group-dropdown-menu'),
  entryDropdownMenu: document.getElementById('entry-dropdown-menu'),
  btnAddGroup: document.getElementById('btn-add-group'),
  btnAddEntry: document.getElementById('btn-add-entry'),
  btnRemoveGroup: document.getElementById('btn-remove-group'),
  btnRemoveEntry: document.getElementById('btn-remove-entry'),
  btnModeEdit: document.getElementById('btn-mode-edit'),
  btnModeRender: document.getElementById('btn-mode-render'),
  btnSave: document.getElementById('btn-save'),
  btnSaveText: document.querySelector('.save-btn-text'),
  btnAddPanel: document.getElementById('btn-add-panel'),
  btnDeletePanel: document.getElementById('btn-delete-panel'),
  btnResetLayout: document.getElementById('btn-reset-layout'),
  btnClear: document.getElementById('btn-clear'),
  deleteConfirmModal: document.getElementById('delete-confirm-modal'),
  deleteConfirmSkip: document.getElementById('delete-confirm-skip'),
  btnDeleteCancel: document.getElementById('btn-delete-cancel'),
  btnDeleteConfirm: document.getElementById('btn-delete-confirm'),
  nameModal: document.getElementById('name-modal'),
  nameModalTitle: document.getElementById('name-modal-title'),
  nameModalLabel: document.getElementById('name-modal-label'),
  nameModalInput: document.getElementById('name-modal-input'),
  btnNameCancel: document.getElementById('btn-name-cancel'),
  btnNameConfirm: document.getElementById('btn-name-confirm')
};

let panels = [];
let paneSizes = [];
let viewMode = 'edit';
let library = null;
let isDirty = false;
let dragState = null;
let isDeleteMode = false;
let pendingDeletePanelId = null;
let pendingNameMode = null;
let scrollSaveTimers = new Map();
let isRestoringScroll = false;
let restoreScrollTimer = null;
let topbarRevealTimer = null;
let didCheckForUpdate = false;
let lastActiveElementBeforeModal = null;

if (typeof marked !== 'undefined') {
  marked.setOptions({
    breaks: true,
    gfm: true
  });
}

function createPanelId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `panel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createEmptyPanels(count = DEFAULT_PANEL_COUNT) {
  return Array.from({ length: count }, () => ({
    id: createPanelId(),
    text: '',
    editorScrollTop: 0,
    renderScrollTop: 0
  }));
}

function clonePanels(value) {
  const normalized = normalizePanels(value);
  return normalized ? normalized.map((panel) => ({ ...panel })) : createEmptyPanels();
}

function createEntry(name = 'Entry 1') {
  const entryPanels = createEmptyPanels();

  return {
    id: createPanelId(),
    name,
    panels: entryPanels,
    layout: equalPaneSizes(entryPanels.length),
    viewMode: 'edit'
  };
}

function createGroup(name = 'Default') {
  const entry = createEntry();

  return {
    id: createPanelId(),
    name,
    entries: [entry],
    activeEntryId: entry.id
  };
}

function createDefaultLibrary() {
  const group = createGroup();

  return {
    version: 1,
    groups: [group],
    activeGroupId: group.id
  };
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function applyStorageCodec(bytes) {
  const output = new Uint8Array(bytes);

  for (let i = 0; i < output.length; i += 1) {
    const keyCode = STORAGE_CODEC_KEY.charCodeAt(i % STORAGE_CODEC_KEY.length);
    output[i] = output[i] ^ keyCode ^ ((i * 31) & 255);
  }

  return output;
}

function encodeStorageValue(value) {
  const bytes = new TextEncoder().encode(value);
  return `tc2:${bytesToBase64(applyStorageCodec(bytes))}`;
}

function decodeStorageValue(value) {
  if (!value || !value.startsWith('tc2:')) {
    return null;
  }

  try {
    const bytes = applyStorageCodec(base64ToBytes(value.slice(4)));
    return new TextDecoder().decode(bytes);
  } catch (error) {
    console.warn('Unable to decode stored comparator data.', error);
    return null;
  }
}

async function clearNamedBrowserCaches() {
  if (!('caches' in window)) {
    return;
  }

  const cacheNames = await caches.keys();
  await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)));
}

async function hashText(value) {
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  let hash = 0;

  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }

  return `fallback-${Math.abs(hash).toString(16)}`;
}

async function fetchLatestAppScriptHash() {
  const response = await fetch(`app.js?check=${Date.now()}`, {
    cache: 'no-store',
    headers: {
      'Cache-Control': 'no-cache'
    }
  });

  if (!response.ok) {
    return null;
  }

  return hashText(await response.text());
}

async function reloadWithFreshAssets(assetReloadValue) {
  await clearNamedBrowserCaches();
  const url = new URL(window.location.href);
  url.searchParams.set('assetReload', assetReloadValue);
  url.searchParams.set('reload', Date.now().toString(36));
  window.location.replace(url.toString());
}

async function checkForAppScriptUpdate() {
  const latestHash = await fetchLatestAppScriptHash();

  if (!latestHash) {
    return false;
  }

  const storedHash = safeGetLocalStorageItem(STORAGE_KEYS.APP_SCRIPT_HASH);
  safeSetLocalStorageItem(STORAGE_KEYS.APP_SCRIPT_HASH, latestHash);

  if (!storedHash || storedHash === latestHash) {
    return false;
  }

  await reloadWithFreshAssets(latestHash.slice(0, 16));
  return true;
}

async function checkForAppUpdate() {
  if (didCheckForUpdate || APP_VERSION === 'dev') {
    return;
  }

  didCheckForUpdate = true;

  try {
    if (await checkForAppScriptUpdate()) {
      return;
    }

    const response = await fetch(`version.json?check=${Date.now()}`, {
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache'
      }
    });

    if (!response.ok) {
      return;
    }

    const data = await response.json();
    const latestVersion = typeof data.version === 'string' ? data.version.trim() : '';

    if (!latestVersion || latestVersion === APP_VERSION) {
      return;
    }

    await reloadWithFreshAssets(latestVersion);
  } catch (error) {
    console.warn('Unable to check for app updates.', error);
  }
}

function normalizePanels(value) {
  if (!Array.isArray(value)) {
    return null;
  }

  const normalized = value
    .filter((panel) => panel && typeof panel === 'object')
    .map((panel) => ({
      id: typeof panel.id === 'string' && panel.id ? panel.id : createPanelId(),
      text: typeof panel.text === 'string' ? panel.text : '',
      editorScrollTop: Number.isFinite(Number(panel.editorScrollTop)) ? Math.max(0, Number(panel.editorScrollTop)) : 0,
      renderScrollTop: Number.isFinite(Number(panel.renderScrollTop)) ? Math.max(0, Number(panel.renderScrollTop)) : 0
    }));

  return normalized.length ? normalized : null;
}

function normalizeEntry(value, fallbackName = 'Entry 1') {
  if (!value || typeof value !== 'object') {
    return createEntry(fallbackName);
  }

  const entryPanels = clonePanels(value.panels);
  const entry = {
    id: typeof value.id === 'string' && value.id ? value.id : createPanelId(),
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : fallbackName,
    panels: entryPanels,
    layout: Array.isArray(value.layout) ? value.layout : equalPaneSizes(entryPanels.length),
    viewMode: value.viewMode === 'render' ? 'render' : 'edit'
  };

  return entry;
}

function normalizeGroup(value, fallbackName = 'Default') {
  if (!value || typeof value !== 'object') {
    return createGroup(fallbackName);
  }

  const entries = Array.isArray(value.entries)
    ? value.entries.map((entry, index) => normalizeEntry(entry, `Entry ${index + 1}`))
    : [];
  const normalizedEntries = entries.length ? entries : [createEntry()];
  const activeEntryExists = normalizedEntries.some((entry) => entry.id === value.activeEntryId);

  return {
    id: typeof value.id === 'string' && value.id ? value.id : createPanelId(),
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : fallbackName,
    entries: normalizedEntries,
    activeEntryId: activeEntryExists ? value.activeEntryId : normalizedEntries[0].id
  };
}

function normalizeLibrary(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.groups)) {
    return null;
  }

  const groups = value.groups.map((group, index) => normalizeGroup(group, index === 0 ? 'Default' : `Group ${index + 1}`));

  if (!groups.length) {
    return null;
  }

  const activeGroupExists = groups.some((group) => group.id === value.activeGroupId);

  return {
    version: 1,
    groups,
    activeGroupId: activeGroupExists ? value.activeGroupId : groups[0].id
  };
}

function readStoredLibrary() {
  const savedLibrary = decodeStorageValue(safeGetLocalStorageItem(STORAGE_KEYS.LIBRARY));

  if (!savedLibrary) {
    return null;
  }

  try {
    return normalizeLibrary(JSON.parse(savedLibrary));
  } catch (error) {
    console.warn('Unable to parse comparator library.', error);
    return null;
  }
}

function getActiveGroup() {
  return library.groups.find((group) => group.id === library.activeGroupId) || library.groups[0];
}

function getActiveEntry() {
  const group = getActiveGroup();
  return group.entries.find((entry) => entry.id === group.activeEntryId) || group.entries[0];
}

function captureCurrentEntryState() {
  collectPanelValues();

  return {
    panels: clonePanels(panels),
    layout: [...paneSizes],
    viewMode
  };
}

function getSelectionIds() {
  const group = getActiveGroup();
  const entry = getActiveEntry();

  return {
    groupId: group.id,
    entryId: entry.id
  };
}

function applySelectionIds(groupId, entryId) {
  const group = library.groups.find((item) => item.id === groupId) || library.groups[0];
  library.activeGroupId = group.id;

  if (entryId && group.entries.some((entry) => entry.id === entryId)) {
    group.activeEntryId = entryId;
  } else if (!group.entries.some((entry) => entry.id === group.activeEntryId)) {
    group.activeEntryId = group.entries[0].id;
  }
}

function syncLibraryFromStorage({ preserveCurrentEntry = false } = {}) {
  const storedLibrary = readStoredLibrary();

  if (!storedLibrary) {
    return false;
  }

  const { groupId, entryId } = getSelectionIds();
  const currentEntryState = preserveCurrentEntry ? captureCurrentEntryState() : null;
  const previousLibrary = library;
  library = storedLibrary;
  applySelectionIds(groupId, entryId);

  if (currentEntryState) {
    const group = library.groups.find((item) => item.id === groupId);
    const entry = group ? group.entries.find((item) => item.id === entryId) : null;

    if (!entry) {
      library = previousLibrary;
      return false;
    }

    entry.panels = currentEntryState.panels;
    entry.layout = currentEntryState.layout;
    entry.viewMode = currentEntryState.viewMode;
  }

  return true;
}

function safeSetLocalStorageItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn(`Unable to write '${key}' to localStorage.`, error);
    return false;
  }
}

function safeGetLocalStorageItem(key) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    console.warn(`Unable to read '${key}' from localStorage.`, error);
    return null;
  }
}

function clearAllScrollSaveTimers() {
  scrollSaveTimers.forEach((timer) => clearTimeout(timer.id));
  scrollSaveTimers.clear();
}

function flushPendingScrollSaves() {
  const timers = Array.from(scrollSaveTimers.values());

  if (!timers.length) {
    return true;
  }

  clearAllScrollSaveTimers();

  if (timers.some((timer) => timer.dirtyOnStart) || isDirty) {
    setDirty(true);
    return true;
  }

  return saveAllData();
}

function saveFocusBeforeModal() {
  lastActiveElementBeforeModal = document.activeElement;
}

function restoreFocusAfterModal() {
  if (lastActiveElementBeforeModal && document.body.contains(lastActiveElementBeforeModal) && typeof lastActiveElementBeforeModal.focus === 'function') {
    lastActiveElementBeforeModal.focus();
  }
  lastActiveElementBeforeModal = null;
}

function handleModalFocusTrap(e, modalContainer) {
  if (e.key !== 'Tab') {
    return;
  }

  const focusables = Array.from(
    modalContainer.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')
  );

  if (!focusables.length) {
    return;
  }

  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  if (e.shiftKey) {
    if (document.activeElement === first || !modalContainer.contains(document.activeElement)) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (document.activeElement === last || !modalContainer.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  }
}

function applyEntry(entry) {
  clearAllScrollSaveTimers();
  panels = clonePanels(entry.panels);
  paneSizes = Array.isArray(entry.layout) ? [...entry.layout] : equalPaneSizes(panels.length);
  viewMode = entry.viewMode === 'render' ? 'render' : 'edit';

  renderWorkspace();
  setViewMode(viewMode);
  setDirty(false);
}

function writeLibraryToStorage() {
  return safeSetLocalStorageItem(STORAGE_KEYS.LIBRARY, encodeStorageValue(JSON.stringify(library)));
}

function collectPanelValues({ preserveRenderScroll = false } = {}) {
  panels = panels.map((panel) => {
    const pane = elements.workspace.querySelector(`[data-panel-id="${panel.id}"]`);
    const textarea = pane ? pane.querySelector('textarea') : null;
    const renderedView = pane ? pane.querySelector('.rendered-view') : null;

    return {
      ...panel,
      text: textarea ? textarea.value : panel.text,
      editorScrollTop: textarea ? textarea.scrollTop : panel.editorScrollTop,
      renderScrollTop: preserveRenderScroll
        ? panel.renderScrollTop
        : (renderedView ? renderedView.scrollTop : panel.renderScrollTop)
    };
  });
}

function renderMarkdown(markdown, target) {
  if (typeof marked === 'undefined') {
    target.textContent = markdown;
    return;
  }

  const parsed = marked.parse(markdown);

  if (typeof DOMPurify === 'undefined') {
    target.textContent = parsed;
    return;
  }

  target.innerHTML = DOMPurify.sanitize(parsed, { USE_PROFILES: { html: true } });
}

function performRender() {
  collectPanelValues({ preserveRenderScroll: true });

  panels.forEach((panel) => {
    const pane = elements.workspace.querySelector(`[data-panel-id="${panel.id}"]`);
    const target = pane ? pane.querySelector('.rendered-markdown') : null;

    if (target) {
      renderMarkdown(panel.text, target);
    }
  });

  panels.forEach(restorePanelScroll);
}

function setDirty(dirty) {
  isDirty = dirty;
  elements.btnSave.disabled = !dirty;
  elements.btnSave.classList.toggle('dirty', dirty);
  elements.btnSave.setAttribute('aria-label', dirty ? 'Save changes' : 'Saved');
  elements.btnSaveText.textContent = dirty ? 'Save' : 'Saved';
}

function writeCurrentEntry() {
  syncLibraryFromStorage({ preserveCurrentEntry: true });
  const entry = getActiveEntry();
  const state = captureCurrentEntryState();
  entry.panels = state.panels;
  entry.layout = state.layout;
  entry.viewMode = state.viewMode;
  return writeLibraryToStorage();
}

function saveAllData() {
  if (writeCurrentEntry()) {
    setDirty(false);
    return true;
  }

  setDirty(true);
  return false;
}

function triggerSaveButton() {
  setDirty(true);
  elements.btnSave.click();
}

function persistTransientPanelState(dirtyOnStart) {
  if (dirtyOnStart || isDirty) {
    setDirty(true);
    return;
  }

  triggerSaveButton();
}

function usesMobileTopbarReveal() {
  return window.matchMedia('(hover: none), (pointer: coarse), (max-width: 768px)').matches;
}

function canAutoHideTopbar() {
  return viewMode === 'render' && window.matchMedia('(max-width: 1180px)').matches;
}

function updatePanelLayoutClasses() {
  const isMultiPanel = panels.length > 1;
  const shouldAutoHideTopbar = canAutoHideTopbar();
  elements.appContainer.classList.toggle('multi-panel', isMultiPanel);
  elements.appContainer.classList.toggle('two-panel', panels.length === 2);
  elements.appContainer.classList.toggle('topbar-auto-hide', shouldAutoHideTopbar);

  if (!shouldAutoHideTopbar) {
    clearTimeout(topbarRevealTimer);
    elements.appContainer.classList.remove('topbar-revealed');
  }
}

function hideTopbar() {
  clearTimeout(topbarRevealTimer);

  if (canAutoHideTopbar() && !isAnyLibraryDropdownOpen()) {
    elements.appContainer.classList.remove('topbar-revealed');
  }
}

function scheduleTopbarHide(delay = 600) {
  clearTimeout(topbarRevealTimer);
  topbarRevealTimer = setTimeout(hideTopbar, delay);
}

function showTopbar({ temporary = false } = {}) {
  if (!canAutoHideTopbar()) {
    return;
  }

  clearTimeout(topbarRevealTimer);
  elements.appContainer.classList.add('topbar-revealed');

  if (temporary) {
    scheduleTopbarHide(1800);
  }
}

function showTopbarOnPanelScroll() {
  if (usesMobileTopbarReveal()) {
    showTopbar({ temporary: true });
  }
}

function handleTopbarPointerMove(e) {
  if (usesMobileTopbarReveal() || !canAutoHideTopbar()) {
    return;
  }

  if (isAnyLibraryDropdownOpen()) {
    showTopbar();
    return;
  }

  if (e.clientY <= 22) {
    showTopbar();
    return;
  }

  if (!elements.appContainer.classList.contains('topbar-revealed')) {
    return;
  }

  const headerRect = elements.appHeader.getBoundingClientRect();

  if (e.clientY > headerRect.bottom + 8) {
    scheduleTopbarHide(250);
  }
}

function saveLayout() {
  setDirty(true);
}

function equalPaneSizes(count = panels.length) {
  const size = 100 / Math.max(1, count);
  return Array.from({ length: count }, () => size);
}

function normalizePaneSizes(sizes) {
  if (!Array.isArray(sizes) || sizes.length !== panels.length) {
    return equalPaneSizes();
  }

  const numericSizes = sizes.map((size) => Number(size));

  if (numericSizes.some((size) => !Number.isFinite(size) || size <= 0)) {
    return equalPaneSizes();
  }

  const total = numericSizes.reduce((sum, size) => sum + size, 0);

  if (!total) {
    return equalPaneSizes();
  }

  return numericSizes.map((size) => (size / total) * 100);
}

function getMinPanelPercent() {
  return Math.min(BASE_MIN_PANEL_PERCENT, (100 / Math.max(1, panels.length)) * 0.35);
}

function getPanelLayoutSize(isVertical) {
  const workspaceRect = elements.workspace.getBoundingClientRect();
  const workspaceSize = isVertical ? workspaceRect.height : workspaceRect.width;
  const dividerSize = Array.from(elements.workspace.querySelectorAll('.divider-column'))
    .reduce((total, divider) => {
      const dividerRect = divider.getBoundingClientRect();
      return total + (isVertical ? dividerRect.height : dividerRect.width);
    }, 0);

  return Math.max(1, workspaceSize - dividerSize);
}

function applyPaneSizes(shouldPersist = true) {
  paneSizes = normalizePaneSizes(paneSizes);

  elements.workspace.querySelectorAll('.pane').forEach((pane, index) => {
    pane.style.flex = `${paneSizes[index]} 1 0`;
  });

  const isVertical = window.innerWidth <= 768;

  elements.workspace.querySelectorAll('.divider-column').forEach((divider) => {
    divider.setAttribute('aria-orientation', isVertical ? 'horizontal' : 'vertical');
  });

  if (shouldPersist) {
    saveLayout();
  }
}

function resetLayout() {
  const dirtyOnStart = isDirty;
  paneSizes = equalPaneSizes();
  applyPaneSizes(false);
  persistTransientPanelState(dirtyOnStart);
}

function createPaneMarkup(panel, index) {
  const hiddenEditorClass = viewMode === 'render' ? ' hidden' : '';
  const hiddenRenderClass = viewMode === 'render' ? '' : ' hidden';

  return `
    <section class="pane" data-panel-id="${panel.id}">
      <div class="panel-actions" aria-label="Panel actions">
        <button class="panel-action-btn" type="button" data-panel-action="copy" title="Copy panel" aria-label="Copy panel">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        </button>
        <button class="panel-action-btn" type="button" data-panel-action="clear" title="Clear panel" aria-label="Clear panel">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" width="14" height="14"><path d="M3 6h18"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>
        </button>
      </div>
      <div class="pane-content editor-view${hiddenEditorClass}">
        <textarea class="code-editor" aria-label="Panel ${index + 1} text editor" placeholder="Paste or type text here..." spellcheck="false"></textarea>
      </div>
      <div class="pane-content rendered-view${hiddenRenderClass}">
        <div class="rendered-markdown"></div>
      </div>
    </section>
  `;
}

function restorePanelScroll(panel) {
  const pane = elements.workspace.querySelector(`[data-panel-id="${panel.id}"]`);

  if (!pane) {
    return;
  }

  const textarea = pane.querySelector('textarea');
  const renderedView = pane.querySelector('.rendered-view');

  isRestoringScroll = true;
  clearTimeout(restoreScrollTimer);

  if (textarea) {
    textarea.scrollTop = panel.editorScrollTop || 0;
  }

  if (renderedView) {
    renderedView.scrollTop = panel.renderScrollTop || 0;
  }

  restoreScrollTimer = setTimeout(() => {
    isRestoringScroll = false;
  }, 0);
}

function updatePanelScroll(panelId, source, scrollTop) {
  const panel = panels.find((item) => item.id === panelId);

  if (!panel) {
    return;
  }

  if (source === 'render') {
    panel.renderScrollTop = scrollTop;
  } else {
    panel.editorScrollTop = scrollTop;
  }
}

function schedulePanelScrollSave(panelId, source, scrollTop) {
  updatePanelScroll(panelId, source, scrollTop);

  if (isRestoringScroll) {
    return;
  }

  showTopbarOnPanelScroll();

  const existingTimer = scrollSaveTimers.get(panelId);
  const dirtyOnStart = existingTimer ? existingTimer.dirtyOnStart : isDirty;

  if (existingTimer) {
    clearTimeout(existingTimer.id);
  }

  const id = setTimeout(() => {
    scrollSaveTimers.delete(panelId);
    persistTransientPanelState(dirtyOnStart);
  }, 300);

  scrollSaveTimers.set(panelId, { id, dirtyOnStart });
}

function handleTextareaPaste(e) {
  const textarea = e.target;
  const pane = textarea.closest('.pane');
  const panelId = pane ? pane.dataset.panelId : null;

  if (!panelId) {
    return;
  }

  requestAnimationFrame(() => {
    textarea.selectionStart = 0;
    textarea.selectionEnd = 0;
    textarea.scrollTop = 0;
    updatePanelScroll(panelId, 'editor', 0);
  });
}

async function copyPanelById(panelId) {
  collectPanelValues();
  const panel = panels.find((item) => item.id === panelId);

  if (!panel) {
    return;
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(panel.text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = panel.text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function clearPanelById(panelId) {
  const panel = panels.find((item) => item.id === panelId);

  if (!panel) {
    return;
  }

  panel.text = '';
  panel.editorScrollTop = 0;
  panel.renderScrollTop = 0;

  const pane = elements.workspace.querySelector(`[data-panel-id="${panelId}"]`);
  const textarea = pane ? pane.querySelector('textarea') : null;

  if (textarea) {
    textarea.value = '';
    textarea.scrollTop = 0;
  }

  setDirty(true);

  if (viewMode === 'render') {
    performRender();
  }
}

function handlePanelActionClick(e) {
  const button = e.target.closest('.panel-action-btn');

  if (!button) {
    return;
  }

  e.preventDefault();
  e.stopPropagation();

  const pane = button.closest('.pane');
  const panelId = pane ? pane.dataset.panelId : null;

  if (!panelId) {
    return;
  }

  if (button.dataset.panelAction === 'copy') {
    copyPanelById(panelId).catch((error) => {
      console.warn('Unable to copy panel text.', error);
    });
  } else if (button.dataset.panelAction === 'clear') {
    clearPanelById(panelId);
  }
}

function createDividerMarkup(index) {
  return `
    <div class="divider-column" data-divider-index="${index}" role="separator" tabindex="0" aria-label="Resize panels" aria-orientation="vertical">
      <div class="divider-line"></div>
    </div>
  `;
}

function renderWorkspace() {
  updatePanelLayoutClasses();

  const markup = panels
    .map((panel, index) => {
      const divider = index < panels.length - 1 ? createDividerMarkup(index) : '';
      return `${createPaneMarkup(panel, index)}${divider}`;
    })
    .join('');

  elements.workspace.innerHTML = markup;

  panels.forEach((panel) => {
    const pane = elements.workspace.querySelector(`[data-panel-id="${panel.id}"]`);
    const textarea = pane.querySelector('textarea');
    const renderedView = pane.querySelector('.rendered-view');
    textarea.value = panel.text;
    textarea.addEventListener('input', () => setDirty(true));
    textarea.addEventListener('keydown', handleTextareaTab);
    textarea.addEventListener('paste', handleTextareaPaste);
    textarea.addEventListener('scroll', () => schedulePanelScrollSave(panel.id, 'editor', textarea.scrollTop));
    renderedView.addEventListener('scroll', () => schedulePanelScrollSave(panel.id, 'render', renderedView.scrollTop));
    pane.querySelectorAll('.panel-action-btn').forEach((button) => {
      button.addEventListener('click', handlePanelActionClick);
    });
    pane.addEventListener('mouseenter', handleDeletePanelHover);
    pane.addEventListener('mouseleave', handleDeletePanelLeave);
    pane.addEventListener('click', handleDeletePanelClick);
    restorePanelScroll(panel);
  });

  elements.workspace.querySelectorAll('.divider-column').forEach((divider) => {
    divider.addEventListener('pointerdown', startDividerDrag);
    divider.addEventListener('keydown', handleDividerKeyboard);
  });

  applyPaneSizes(false);

  if (viewMode === 'render') {
    performRender();
  }
}

function cancelDeleteMode() {
  isDeleteMode = false;
  elements.appContainer.classList.remove('delete-panel-mode');
  elements.btnDeletePanel.classList.remove('active');
  elements.workspace.querySelectorAll('.pane.delete-target').forEach((pane) => {
    pane.classList.remove('delete-target');
  });
}

function closeDeleteConfirmModal() {
  pendingDeletePanelId = null;
  elements.deleteConfirmModal.classList.add('hidden');
  elements.deleteConfirmSkip.checked = false;
  restoreFocusAfterModal();
}

function cancelPendingDelete() {
  closeDeleteConfirmModal();
  cancelDeleteMode();
}

function setViewMode(mode) {
  viewMode = mode === 'render' ? 'render' : 'edit';
  updatePanelLayoutClasses();

  if (viewMode === 'render') {
    cancelDeleteMode();
    performRender();
    elements.appContainer.classList.remove('edit-mode');
    elements.appContainer.classList.add('render-mode');
    elements.btnModeEdit.classList.remove('active');
    elements.btnModeRender.classList.add('active');
    elements.btnModeEdit.setAttribute('aria-pressed', 'false');
    elements.btnModeRender.setAttribute('aria-pressed', 'true');
  } else {
    elements.appContainer.classList.remove('render-mode');
    elements.appContainer.classList.add('edit-mode');
    elements.btnModeEdit.classList.add('active');
    elements.btnModeRender.classList.remove('active');
    elements.btnModeEdit.setAttribute('aria-pressed', 'true');
    elements.btnModeRender.setAttribute('aria-pressed', 'false');
  }

  elements.workspace.querySelectorAll('.editor-view').forEach((editor) => {
    editor.classList.toggle('hidden', viewMode === 'render');
  });

  elements.workspace.querySelectorAll('.rendered-view').forEach((rendered) => {
    rendered.classList.toggle('hidden', viewMode !== 'render');
  });

  panels.forEach(restorePanelScroll);
}

function addPanel() {
  cancelDeleteMode();
  collectPanelValues();

  const newPanelSize = 100 / (panels.length + 1);
  paneSizes = normalizePaneSizes(paneSizes).map((size) => size * ((100 - newPanelSize) / 100));
  paneSizes.push(newPanelSize);

  panels.push({
    id: createPanelId(),
    text: '',
    editorScrollTop: 0,
    renderScrollTop: 0
  });

  renderWorkspace();
  setViewMode('edit');
  setDirty(true);

  const newTextarea = elements.workspace.querySelector(`[data-panel-id="${panels[panels.length - 1].id}"] textarea`);
  if (newTextarea) {
    newTextarea.focus();
  }
}

function beginDeletePanelMode() {
  if (panels.length <= 1) {
    alert('At least one panel must remain.');
    return;
  }

  isDeleteMode = true;
  elements.appContainer.classList.add('delete-panel-mode');
  elements.btnDeletePanel.classList.add('active');
}

function handleDeletePanelHover(e) {
  if (!isDeleteMode) {
    return;
  }

  e.currentTarget.classList.add('delete-target');
}

function handleDeletePanelLeave(e) {
  e.currentTarget.classList.remove('delete-target');
}

function handleDeletePanelClick(e) {
  if (!isDeleteMode) {
    return;
  }

  e.preventDefault();
  e.stopPropagation();

  const panelId = e.currentTarget.dataset.panelId;
  const panelIndex = panels.findIndex((panel) => panel.id === panelId);

  if (panelIndex === -1) {
    cancelDeleteMode();
    return;
  }

  if (safeGetLocalStorageItem(STORAGE_KEYS.SKIP_DELETE_CONFIRM) === 'true') {
    deletePanelById(panelId);
    return;
  }

  saveFocusBeforeModal();
  pendingDeletePanelId = panelId;
  elements.deleteConfirmModal.classList.remove('hidden');
  elements.btnDeleteCancel.focus();
}

function deletePanelById(panelId) {
  const panelIndex = panels.findIndex((panel) => panel.id === panelId);

  if (panelIndex === -1) {
    cancelDeleteMode();
    return;
  }

  collectPanelValues();
  panels.splice(panelIndex, 1);
  paneSizes.splice(panelIndex, 1);
  paneSizes = normalizePaneSizes(paneSizes);

  cancelDeleteMode();
  renderWorkspace();
  setDirty(true);
}

function confirmPendingDelete() {
  if (!pendingDeletePanelId) {
    closeDeleteConfirmModal();
    cancelDeleteMode();
    return;
  }

  if (elements.deleteConfirmSkip.checked) {
    safeSetLocalStorageItem(STORAGE_KEYS.SKIP_DELETE_CONFIRM, 'true');
  }

  const panelId = pendingDeletePanelId;
  closeDeleteConfirmModal();
  deletePanelById(panelId);
}

function handleTextareaTab(e) {
  if (e.key !== 'Tab') {
    return;
  }

  e.preventDefault();

  const textarea = e.target;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;

  textarea.value = `${value.substring(0, start)}  ${value.substring(end)}`;
  textarea.selectionStart = textarea.selectionEnd = start + 2;
  setDirty(true);
}

function startDividerDrag(e) {
  if (isDeleteMode) {
    return;
  }

  e.preventDefault();

  const divider = e.currentTarget;
  const dividerIndex = Number(divider.dataset.dividerIndex);
  const isVertical = window.innerWidth <= 768;

  dragState = {
    divider,
    dividerIndex,
    startPosition: isVertical ? e.clientY : e.clientX,
    workspaceSize: getPanelLayoutSize(isVertical),
    startSizes: [...paneSizes],
    isVertical,
    hasChanged: false,
    dirtyOnStart: isDirty
  };

  divider.classList.add('dragging');
  document.body.style.cursor = isVertical ? 'row-resize' : 'col-resize';
}

function resizeAdjacentPanels(deltaPercent) {
  const { dividerIndex, startSizes } = dragState;
  const leftStart = startSizes[dividerIndex];
  const rightStart = startSizes[dividerIndex + 1];
  const minPanelPercent = getMinPanelPercent();
  const maxLeftDelta = rightStart - minPanelPercent;
  const maxRightDelta = leftStart - minPanelPercent;
  const constrainedDelta = Math.max(-maxRightDelta, Math.min(maxLeftDelta, deltaPercent));

  paneSizes = [...startSizes];
  paneSizes[dividerIndex] = leftStart + constrainedDelta;
  paneSizes[dividerIndex + 1] = rightStart - constrainedDelta;
  dragState.hasChanged = dragState.hasChanged || Math.abs(constrainedDelta) > 0.01;
  applyPaneSizes(false);
}

function handleDividerPointerMove(e) {
  if (!dragState) {
    return;
  }

  const currentPosition = dragState.isVertical ? e.clientY : e.clientX;
  const delta = currentPosition - dragState.startPosition;
  const deltaPercent = (delta / dragState.workspaceSize) * 100;
  resizeAdjacentPanels(deltaPercent);
}

function endDividerDrag() {
  if (!dragState) {
    return;
  }

  dragState.divider.classList.remove('dragging');
  document.body.style.cursor = '';
  const shouldSave = dragState.hasChanged && !dragState.dirtyOnStart;
  dragState = null;

  if (shouldSave) {
    triggerSaveButton();
  }
}

function handleDividerKeyboard(e) {
  const dividerIndex = Number(e.currentTarget.dataset.dividerIndex);
  const isVertical = window.innerWidth <= 768;
  const step = e.shiftKey ? 10 : 5;
  let delta = 0;

  if ((!isVertical && e.key === 'ArrowLeft') || (isVertical && e.key === 'ArrowUp')) {
    delta = -step;
  } else if ((!isVertical && e.key === 'ArrowRight') || (isVertical && e.key === 'ArrowDown')) {
    delta = step;
  } else {
    return;
  }

  e.preventDefault();
  dragState = {
    dividerIndex,
    startSizes: [...paneSizes],
    hasChanged: false,
    dirtyOnStart: isDirty
  };
  resizeAdjacentPanels(delta);
  const shouldSave = dragState.hasChanged && !dragState.dirtyOnStart;
  dragState = null;

  if (shouldSave) {
    triggerSaveButton();
  }
}

function clearAllData() {
  cancelDeleteMode();
  collectPanelValues();
  panels = panels.map((panel) => ({
    ...panel,
    text: '',
    editorScrollTop: 0,
    renderScrollTop: 0
  }));

  renderWorkspace();
  setViewMode(viewMode);
  setDirty(true);
}

function renderLibrarySelectors() {
  const activeGroup = getActiveGroup();
  const activeEntry = activeGroup.entries.find((entry) => entry.id === activeGroup.activeEntryId) || activeGroup.entries[0];

  elements.groupSelect.innerHTML = library.groups
    .map((group) => `<option value="${group.id}">${escapeOptionText(group.name)}</option>`)
    .join('');
  elements.groupSelect.value = activeGroup.id;

  elements.entrySelect.innerHTML = activeGroup.entries
    .map((entry) => `<option value="${entry.id}">${escapeOptionText(entry.name)}</option>`)
    .join('');
  elements.entrySelect.value = activeGroup.activeEntryId;
  elements.btnRemoveGroup.disabled = library.groups.length <= 1;
  elements.btnRemoveEntry.disabled = activeGroup.entries.length <= 1;
  updateDocumentTitle(activeGroup, activeEntry);
  updateCurrentUrlSelection();
  renderLibraryDropdowns(activeGroup);
}

function updateDocumentTitle(group, entry) {
  document.title = `${group.name} / ${entry.name} - Comparator`;
}

function escapeOptionText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function getLibraryDropdownElements(kind) {
  return kind === 'group'
    ? {
      dropdown: elements.groupDropdown,
      button: elements.groupDropdownButton,
      label: elements.groupDropdownLabel,
      menu: elements.groupDropdownMenu
    }
    : {
      dropdown: elements.entryDropdown,
      button: elements.entryDropdownButton,
      label: elements.entryDropdownLabel,
      menu: elements.entryDropdownMenu
    };
}

function setLibraryDropdownOpen(kind, open) {
  const dropdown = getLibraryDropdownElements(kind);
  dropdown.dropdown.classList.toggle('open', open);
  dropdown.menu.classList.toggle('hidden', !open);
  dropdown.button.setAttribute('aria-expanded', open ? 'true' : 'false');

  if (open) {
    showTopbar();
  }
}

function closeAllLibraryDropdowns() {
  setLibraryDropdownOpen('group', false);
  setLibraryDropdownOpen('entry', false);
}

function isAnyLibraryDropdownOpen() {
  return !elements.groupDropdownMenu.classList.contains('hidden')
    || !elements.entryDropdownMenu.classList.contains('hidden');
}

function toggleLibraryDropdown(kind) {
  const dropdown = getLibraryDropdownElements(kind);
  const shouldOpen = dropdown.menu.classList.contains('hidden');
  closeAllLibraryDropdowns();
  setLibraryDropdownOpen(kind, shouldOpen);
}

function getLibraryTargetUrl(groupId, entryId) {
  const url = new URL(window.location.href);
  url.searchParams.set('group', groupId);
  url.searchParams.set('entry', entryId);
  return url.toString();
}

function updateCurrentUrlSelection() {
  if (!window.history || !window.history.replaceState) {
    return;
  }

  const { groupId, entryId } = getSelectionIds();
  const url = new URL(window.location.href);
  url.searchParams.set('group', groupId);
  url.searchParams.set('entry', entryId);
  window.history.replaceState(null, '', url.toString());
}

function selectLibraryDropdownOption(option) {
  closeAllLibraryDropdowns();

  if (option.dataset.kind === 'group') {
    elements.groupSelect.value = option.dataset.groupId;
    handleGroupChange();
  } else if (option.dataset.kind === 'entry') {
    elements.entrySelect.value = option.dataset.entryId;
    handleEntryChange();
  }

  renderLibrarySelectors();
}

function handleLibraryOptionClick(e) {
  const option = e.target.closest('.library-dropdown-option');

  if (!option) {
    return;
  }

  e.preventDefault();
  selectLibraryDropdownOption(option);
}

function handleLibraryOptionKeydown(e) {
  const option = e.target.closest('.library-dropdown-option');

  if (!option) {
    return;
  }

  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    selectLibraryDropdownOption(option);
  } else if (e.key === 'Escape') {
    closeAllLibraryDropdowns();
  }
}

function renderLibraryDropdowns(activeGroup) {
  const activeEntry = activeGroup.entries.find((entry) => entry.id === activeGroup.activeEntryId) || activeGroup.entries[0];

  elements.groupDropdownLabel.textContent = activeGroup.name;
  elements.entryDropdownLabel.textContent = activeEntry.name;
  elements.groupDropdownButton.title = activeGroup.name;
  elements.entryDropdownButton.title = activeEntry.name;

  elements.groupDropdownMenu.innerHTML = library.groups
    .map((group) => {
      const isActive = group.id === activeGroup.id;
      const href = getLibraryTargetUrl(group.id, group.activeEntryId);
      return `<a class="library-dropdown-option${isActive ? ' active' : ''}" href="${escapeOptionText(href)}" target="_blank" rel="noopener" role="option" tabindex="0" aria-selected="${isActive ? 'true' : 'false'}" data-kind="group" data-group-id="${escapeOptionText(group.id)}" data-entry-id="${escapeOptionText(group.activeEntryId)}">${escapeOptionText(group.name)}</a>`;
    })
    .join('');

  elements.entryDropdownMenu.innerHTML = activeGroup.entries
    .map((entry) => {
      const isActive = entry.id === activeEntry.id;
      const href = getLibraryTargetUrl(activeGroup.id, entry.id);
      return `<a class="library-dropdown-option${isActive ? ' active' : ''}" href="${escapeOptionText(href)}" target="_blank" rel="noopener" role="option" tabindex="0" aria-selected="${isActive ? 'true' : 'false'}" data-kind="entry" data-group-id="${escapeOptionText(activeGroup.id)}" data-entry-id="${escapeOptionText(entry.id)}">${escapeOptionText(entry.name)}</a>`;
    })
    .join('');
}

function confirmDiscardChanges() {
  return !isDirty || confirm('Discard unsaved changes?');
}

function switchToActiveEntry() {
  renderLibrarySelectors();
  applyEntry(getActiveEntry());
}

function handleGroupChange() {
  const previousGroupId = library.activeGroupId;

  flushPendingScrollSaves();

  if (!confirmDiscardChanges()) {
    elements.groupSelect.value = previousGroupId;
    return;
  }

  const selectedGroup = library.groups.find((group) => group.id === elements.groupSelect.value);
  if (!selectedGroup) {
    elements.groupSelect.value = previousGroupId;
    return;
  }

  cancelDeleteMode();
  library.activeGroupId = selectedGroup.id;
  switchToActiveEntry();
}

function handleEntryChange() {
  const group = getActiveGroup();
  const previousEntryId = group.activeEntryId;

  flushPendingScrollSaves();

  if (!confirmDiscardChanges()) {
    elements.entrySelect.value = previousEntryId;
    return;
  }

  const selectedEntry = group.entries.find((entry) => entry.id === elements.entrySelect.value);
  if (!selectedEntry) {
    elements.entrySelect.value = previousEntryId;
    return;
  }

  cancelDeleteMode();
  group.activeEntryId = selectedEntry.id;
  switchToActiveEntry();
}

function openNameModal(mode) {
  flushPendingScrollSaves();

  if (!confirmDiscardChanges()) {
    return;
  }

  saveFocusBeforeModal();
  pendingNameMode = mode;
  elements.nameModalTitle.textContent = mode === 'group' ? 'New group' : 'New entry';
  elements.nameModalLabel.textContent = mode === 'group' ? 'Group name' : 'Entry name';
  elements.nameModalInput.value = '';
  elements.nameModal.classList.remove('hidden');
  elements.nameModalInput.focus();
}

function closeNameModal() {
  pendingNameMode = null;
  elements.nameModal.classList.add('hidden');
  elements.nameModalInput.value = '';
  restoreFocusAfterModal();
}

function confirmNameModal() {
  const name = elements.nameModalInput.value.trim();

  if (!name) {
    elements.nameModalInput.focus();
    return;
  }

  if (pendingNameMode === 'group') {
    createNamedGroup(name);
  } else if (pendingNameMode === 'entry') {
    createNamedEntry(name);
  }

  closeNameModal();
}

function addGroup() {
  openNameModal('group');
}

function addEntry() {
  openNameModal('entry');
}

function createNamedGroup(name) {
  cancelDeleteMode();
  syncLibraryFromStorage({ preserveCurrentEntry: true });
  const group = createGroup(name);
  library.groups.push(group);
  library.activeGroupId = group.id;
  writeLibraryToStorage();
  switchToActiveEntry();
}

function createNamedEntry(name) {
  cancelDeleteMode();
  syncLibraryFromStorage({ preserveCurrentEntry: true });
  const group = getActiveGroup();
  const entry = createEntry(name);
  group.entries.push(entry);
  group.activeEntryId = entry.id;
  writeLibraryToStorage();
  switchToActiveEntry();
}

function loadLibrary() {
  return readStoredLibrary() || createDefaultLibrary();
}

function applyUrlLibrarySelection() {
  const params = new URLSearchParams(window.location.search);
  const groupId = params.get('group');
  const entryId = params.get('entry');

  if (!groupId) {
    return;
  }

  const group = library.groups.find((item) => item.id === groupId);

  if (!group) {
    return;
  }

  library.activeGroupId = group.id;

  if (entryId && group.entries.some((entry) => entry.id === entryId)) {
    group.activeEntryId = entryId;
  }
}

function handleLibraryStorageChange(e) {
  if (e.key !== STORAGE_KEYS.LIBRARY || isDirty || scrollSaveTimers.size) {
    return;
  }

  const storedLibrary = readStoredLibrary();

  if (!storedLibrary) {
    return;
  }

  library = storedLibrary;
  applyUrlLibrarySelection();
  renderLibrarySelectors();
  applyEntry(getActiveEntry());
}

function removeActiveGroup() {
  if (library.groups.length <= 1) {
    return;
  }

  flushPendingScrollSaves();

  if (!confirmDiscardChanges()) {
    return;
  }

  syncLibraryFromStorage({ preserveCurrentEntry: false });
  if (library.groups.length <= 1) {
    renderLibrarySelectors();
    return;
  }

  const group = getActiveGroup();
  if (!confirm(`Remove group "${group.name}"?`)) {
    return;
  }

  cancelDeleteMode();
  const groupIndex = library.groups.findIndex((item) => item.id === group.id);
  library.groups.splice(groupIndex, 1);
  library.activeGroupId = library.groups[Math.max(0, groupIndex - 1)].id;
  writeLibraryToStorage();
  switchToActiveEntry();
}

function removeActiveEntry() {
  const group = getActiveGroup();

  if (group.entries.length <= 1) {
    return;
  }

  flushPendingScrollSaves();

  if (!confirmDiscardChanges()) {
    return;
  }

  syncLibraryFromStorage({ preserveCurrentEntry: false });
  const latestGroup = getActiveGroup();
  const entry = getActiveEntry();

  if (latestGroup.entries.length <= 1 || !latestGroup.entries.some((item) => item.id === entry.id)) {
    renderLibrarySelectors();
    return;
  }

  if (!confirm(`Remove entry "${entry.name}"?`)) {
    return;
  }

  cancelDeleteMode();
  const entryIndex = latestGroup.entries.findIndex((item) => item.id === entry.id);
  latestGroup.entries.splice(entryIndex, 1);
  latestGroup.activeEntryId = latestGroup.entries[Math.max(0, entryIndex - 1)].id;
  writeLibraryToStorage();
  switchToActiveEntry();
}

function setupListeners() {
  elements.btnSave.addEventListener('click', saveAllData);
  elements.groupSelect.addEventListener('change', handleGroupChange);
  elements.entrySelect.addEventListener('change', handleEntryChange);
  elements.groupDropdownButton.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleLibraryDropdown('group');
  });
  elements.entryDropdownButton.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleLibraryDropdown('entry');
  });
  [elements.groupDropdownMenu, elements.entryDropdownMenu].forEach((menu) => {
    menu.addEventListener('click', handleLibraryOptionClick);
    menu.addEventListener('keydown', handleLibraryOptionKeydown);
  });
  elements.btnAddGroup.addEventListener('click', addGroup);
  elements.btnAddEntry.addEventListener('click', addEntry);
  elements.btnRemoveGroup.addEventListener('click', removeActiveGroup);
  elements.btnRemoveEntry.addEventListener('click', removeActiveEntry);
  elements.btnNameCancel.addEventListener('click', closeNameModal);
  elements.btnNameConfirm.addEventListener('click', confirmNameModal);
  elements.nameModal.addEventListener('click', (e) => {
    if (e.target === elements.nameModal) {
      closeNameModal();
    }
  });
  elements.nameModalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmNameModal();
    }
  });
  elements.btnAddPanel.addEventListener('click', addPanel);
  elements.btnDeletePanel.addEventListener('click', beginDeletePanelMode);
  elements.btnDeleteCancel.addEventListener('click', cancelPendingDelete);
  elements.btnDeleteConfirm.addEventListener('click', confirmPendingDelete);
  elements.deleteConfirmModal.addEventListener('click', (e) => {
    if (e.target === elements.deleteConfirmModal) {
      cancelPendingDelete();
    }
  });
  elements.deleteConfirmModal.addEventListener('keydown', (e) => {
    handleModalFocusTrap(e, elements.deleteConfirmModal);
  });
  elements.nameModal.addEventListener('keydown', (e) => {
    handleModalFocusTrap(e, elements.nameModal);
  });
  elements.btnModeEdit.addEventListener('click', () => setViewMode('edit'));
  elements.btnModeRender.addEventListener('click', () => setViewMode('render'));
  elements.btnResetLayout.addEventListener('click', resetLayout);

  elements.btnClear.addEventListener('click', () => {
    if (confirm('Clear all contents?')) {
      clearAllData();
    }
  });

  elements.topbarRevealZone.addEventListener('pointerenter', () => {
    if (!usesMobileTopbarReveal()) {
      showTopbar();
    }
  });
  elements.topbarRevealZone.addEventListener('pointerleave', () => {
    if (!usesMobileTopbarReveal()) {
      scheduleTopbarHide(350);
    }
  });
  elements.appHeader.addEventListener('pointerenter', () => {
    if (!usesMobileTopbarReveal()) {
      showTopbar();
    }
  });
  elements.appHeader.addEventListener('pointerleave', () => {
    if (!usesMobileTopbarReveal() && !isAnyLibraryDropdownOpen()) {
      hideTopbar();
    }
  });

  document.addEventListener('pointermove', handleTopbarPointerMove);
  document.addEventListener('pointermove', handleDividerPointerMove);
  document.addEventListener('pointerup', endDividerDrag);
  document.addEventListener('pointercancel', endDividerDrag);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.library-dropdown')) {
      closeAllLibraryDropdowns();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (isAnyLibraryDropdownOpen()) {
        closeAllLibraryDropdowns();
      } else if (!elements.nameModal.classList.contains('hidden')) {
        closeNameModal();
      } else if (!elements.deleteConfirmModal.classList.contains('hidden')) {
        cancelPendingDelete();
      } else {
        cancelDeleteMode();
      }
    }
  });

  window.addEventListener('resize', () => {
    updatePanelLayoutClasses();
    applyPaneSizes(false);

    if (usesMobileTopbarReveal()) {
      hideTopbar();
    }
  });
  window.addEventListener('storage', handleLibraryStorageChange);
}

function init() {
  checkForAppUpdate();
  library = loadLibrary();
  applyUrlLibrarySelection();
  const activeEntry = getActiveEntry();
  panels = clonePanels(activeEntry.panels);
  paneSizes = Array.isArray(activeEntry.layout) ? [...activeEntry.layout] : equalPaneSizes(panels.length);
  viewMode = activeEntry.viewMode === 'render' ? 'render' : 'edit';

  setupListeners();
  renderLibrarySelectors();
  renderWorkspace();
  setViewMode(viewMode);
  setDirty(false);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
