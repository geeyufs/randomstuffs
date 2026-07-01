// Default Texts
const DEFAULT_LEFT_TEXT = '';
const DEFAULT_RIGHT_TEXT = '';

// LocalStorage Keys
const STORAGE_KEYS = {
  LEFT_TEXT: 'text_comp_left_text',
  RIGHT_TEXT: 'text_comp_right_text',
  VIEW_MODE: 'text_comp_view_mode',
  SPLIT_PERCENT: 'text_comp_split_percent'
};

// DOM Elements
const elements = {
  appContainer: document.getElementById('app-container'),
  workspace: document.querySelector('.workspace'),
  leftPane: document.getElementById('left-pane'),
  rightPane: document.getElementById('right-pane'),
  dragDivider: document.getElementById('drag-divider'),
  
  leftEditor: document.getElementById('left-editor'),
  rightEditor: document.getElementById('right-editor'),
  leftRenderTarget: document.getElementById('left-render-target'),
  rightRenderTarget: document.getElementById('right-render-target'),
  
  leftEditorContainer: document.getElementById('left-editor-container'),
  rightEditorContainer: document.getElementById('right-editor-container'),
  leftRenderContainer: document.getElementById('left-render-container'),
  rightRenderContainer: document.getElementById('right-render-container'),
  
  // Navigation / Actions
  btnModeEdit: document.getElementById('btn-mode-edit'),
  btnModeRender: document.getElementById('btn-mode-render'),
  btnResetLayout: document.getElementById('btn-reset-layout'),
  btnClear: document.getElementById('btn-clear'),
  saveStatus: document.getElementById('save-status')
};

// Global variables
let saveTimeout = null;
let isDragging = false;
let currentSplitPercent = 50;

// Initialize Markdown library configuration
if (typeof marked !== 'undefined') {
  marked.setOptions({
    breaks: true,
    gfm: true
  });
}

// Set status indicator
function setSaveStatus(status) {
  const text = elements.saveStatus.querySelector('.status-text');
  if (status === 'saving') {
    elements.saveStatus.classList.add('saving');
    text.textContent = 'Saving...';
  } else {
    elements.saveStatus.classList.remove('saving');
    text.textContent = 'Saved';
  }
}

// Render markdown logic
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
  const leftMarkdown = elements.leftEditor.value;
  const rightMarkdown = elements.rightEditor.value;
  
  renderMarkdown(leftMarkdown, elements.leftRenderTarget);
  renderMarkdown(rightMarkdown, elements.rightRenderTarget);
}

// View toggle controller
function setViewMode(mode) {
  if (mode === 'render') {
    performRender();
    elements.appContainer.classList.remove('edit-mode');
    elements.appContainer.classList.add('render-mode');
    
    elements.leftEditorContainer.classList.add('hidden');
    elements.rightEditorContainer.classList.add('hidden');
    elements.leftRenderContainer.classList.remove('hidden');
    elements.rightRenderContainer.classList.remove('hidden');
    
    elements.btnModeEdit.classList.remove('active');
    elements.btnModeRender.classList.add('active');
    elements.btnModeEdit.setAttribute('aria-pressed', 'false');
    elements.btnModeRender.setAttribute('aria-pressed', 'true');
  } else {
    elements.appContainer.classList.remove('render-mode');
    elements.appContainer.classList.add('edit-mode');
    
    elements.leftEditorContainer.classList.remove('hidden');
    elements.rightEditorContainer.classList.remove('hidden');
    elements.leftRenderContainer.classList.add('hidden');
    elements.rightRenderContainer.classList.add('hidden');
    
    elements.btnModeEdit.classList.add('active');
    elements.btnModeRender.classList.remove('active');
    elements.btnModeEdit.setAttribute('aria-pressed', 'true');
    elements.btnModeRender.setAttribute('aria-pressed', 'false');
  }
  
  localStorage.setItem(STORAGE_KEYS.VIEW_MODE, mode);
}

// Auto-save debounced handler
function queueAutoSave() {
  setSaveStatus('saving');
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  
  saveTimeout = setTimeout(() => {
    localStorage.setItem(STORAGE_KEYS.LEFT_TEXT, elements.leftEditor.value);
    localStorage.setItem(STORAGE_KEYS.RIGHT_TEXT, elements.rightEditor.value);
    setSaveStatus('saved');
  }, 400);
}

// Enable support for indenting code blocks via Tab inside textarea
function handleTextareaTab(e) {
  if (e.key === 'Tab') {
    e.preventDefault();
    const textarea = e.target;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;
    
    textarea.value = value.substring(0, start) + '  ' + value.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + 2;
    
    queueAutoSave();
  }
}

// Set split-pane layout size
function applySplitPercentage(percent) {
  const isVertical = window.innerWidth <= 768;
  const constrainedPercent = Math.max(10, Math.min(90, percent));
  currentSplitPercent = constrainedPercent;
  
  if (isVertical) {
    elements.leftPane.style.flex = `0 0 ${constrainedPercent}%`;
    elements.rightPane.style.flex = `0 0 ${100 - constrainedPercent}%`;
    // Clear horizontal width overrides if window is resized/loaded vertically
    elements.leftPane.style.width = '';
    elements.rightPane.style.width = '';
  } else {
    elements.leftPane.style.flex = `0 0 ${constrainedPercent}%`;
    elements.rightPane.style.flex = `0 0 ${100 - constrainedPercent}%`;
    // Clear vertical height overrides
    elements.leftPane.style.height = '';
    elements.rightPane.style.height = '';
  }
  
  elements.dragDivider.setAttribute('aria-orientation', isVertical ? 'horizontal' : 'vertical');
  elements.dragDivider.setAttribute('aria-valuenow', Math.round(constrainedPercent));
  localStorage.setItem(STORAGE_KEYS.SPLIT_PERCENT, constrainedPercent);
}

function handleDividerKeyboard(e) {
  const isVertical = window.innerWidth <= 768;
  const step = e.shiftKey ? 10 : 5;
  let nextPercent = currentSplitPercent;

  if ((!isVertical && e.key === 'ArrowLeft') || (isVertical && e.key === 'ArrowUp')) {
    nextPercent -= step;
  } else if ((!isVertical && e.key === 'ArrowRight') || (isVertical && e.key === 'ArrowDown')) {
    nextPercent += step;
  } else if (e.key === 'Home') {
    nextPercent = 10;
  } else if (e.key === 'End') {
    nextPercent = 90;
  } else {
    return;
  }

  e.preventDefault();
  applySplitPercentage(nextPercent);
}

// Initialize dragging resizer logic
function setupDragResizer() {
  const divider = elements.dragDivider;
  const workspace = elements.workspace;
  
  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isDragging = true;
    divider.classList.add('dragging');
    document.body.style.cursor = window.innerWidth <= 768 ? 'row-resize' : 'col-resize';
  });
  
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    
    const isVertical = window.innerWidth <= 768;
    const rect = workspace.getBoundingClientRect();
    let percentage;
    
    if (isVertical) {
      const topHeight = e.clientY - rect.top;
      percentage = (topHeight / rect.height) * 100;
    } else {
      const leftWidth = e.clientX - rect.left;
      percentage = (leftWidth / rect.width) * 100;
    }
    
    applySplitPercentage(percentage);
  });
  
  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      divider.classList.remove('dragging');
      document.body.style.cursor = '';
    }
  });
  
  // Touch support for mobile devices
  divider.addEventListener('touchstart', (e) => {
    e.preventDefault();
    isDragging = true;
    divider.classList.add('dragging');
  });
  
  document.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    e.preventDefault();
    const touch = e.touches[0];
    const isVertical = window.innerWidth <= 768;
    const rect = workspace.getBoundingClientRect();
    let percentage;
    
    if (isVertical) {
      const topHeight = touch.clientY - rect.top;
      percentage = (topHeight / rect.height) * 100;
    } else {
      const leftWidth = touch.clientX - rect.left;
      percentage = (leftWidth / rect.width) * 100;
    }
    
    applySplitPercentage(percentage);
  });
  
  document.addEventListener('touchend', () => {
    if (isDragging) {
      isDragging = false;
      divider.classList.remove('dragging');
    }
  });
  
  // Clean sizes on resize if layout direction changes
  window.addEventListener('resize', () => {
    const savedPercent = parseFloat(localStorage.getItem(STORAGE_KEYS.SPLIT_PERCENT)) || 50;
    applySplitPercentage(savedPercent);
  });

  divider.addEventListener('keydown', handleDividerKeyboard);
}

// Setup Event Listeners
function setupListeners() {
  elements.leftEditor.addEventListener('input', queueAutoSave);
  elements.rightEditor.addEventListener('input', queueAutoSave);
  
  elements.leftEditor.addEventListener('keydown', handleTextareaTab);
  elements.rightEditor.addEventListener('keydown', handleTextareaTab);
  
  elements.btnModeEdit.addEventListener('click', () => setViewMode('edit'));
  elements.btnModeRender.addEventListener('click', () => setViewMode('render'));
  
  elements.btnResetLayout.addEventListener('click', () => {
    applySplitPercentage(50);
  });
  
  elements.btnClear.addEventListener('click', () => {
    if (confirm('Clear all contents?')) {
      clearAllData();
    }
  });
}

// Initialize Empty State
function loadEmptyState() {
  elements.leftEditor.value = '';
  elements.rightEditor.value = '';
  
  setViewMode('edit');
  
  localStorage.setItem(STORAGE_KEYS.LEFT_TEXT, '');
  localStorage.setItem(STORAGE_KEYS.RIGHT_TEXT, '');
  localStorage.setItem(STORAGE_KEYS.VIEW_MODE, 'edit');
  
  applySplitPercentage(50);
  
  setSaveStatus('saved');
}

// Clear All Data
function clearAllData() {
  elements.leftEditor.value = '';
  elements.rightEditor.value = '';
  
  setViewMode('edit');
  
  localStorage.setItem(STORAGE_KEYS.LEFT_TEXT, '');
  localStorage.setItem(STORAGE_KEYS.RIGHT_TEXT, '');
  localStorage.setItem(STORAGE_KEYS.VIEW_MODE, 'edit');
  
  setSaveStatus('saved');
}

// Application startup
function init() {
  const savedLeft = localStorage.getItem(STORAGE_KEYS.LEFT_TEXT);
  const savedRight = localStorage.getItem(STORAGE_KEYS.RIGHT_TEXT);
  const savedViewMode = localStorage.getItem(STORAGE_KEYS.VIEW_MODE);
  const savedSplit = localStorage.getItem(STORAGE_KEYS.SPLIT_PERCENT);
  
  setupListeners();
  setupDragResizer();
  
  if (savedLeft === null && savedRight === null) {
    loadEmptyState();
  } else {
    elements.leftEditor.value = savedLeft || '';
    elements.rightEditor.value = savedRight || '';
    
    // Apply split percentage
    const splitVal = savedSplit ? parseFloat(savedSplit) : 50;
    applySplitPercentage(splitVal);
    
    const modeToSet = savedViewMode === 'render' ? 'render' : 'edit';
    setViewMode(modeToSet);
  }
}

document.addEventListener('DOMContentLoaded', init);
