const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomBytes } = require('crypto');
const { execFile } = require('child_process');

// Promise wrapper for execFile (used by system-memory and process listing)
function execFileP(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 5 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// ── Config ──
const PORT = 3001;
const MARKER_FILE = '.openclaw.json';
const DASHBOARD_FILE = path.join(__dirname, 'dashboard.html');

// Local data directory for config and datastores (gitignored)
const LOCAL_DIR = path.join(__dirname, 'local');
if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR);

let CONFIG_FILE = path.join(LOCAL_DIR, 'openclaw.config.json');
let config = { projectRoots: [] };

// Default config values for LLM + OC Control
const LLM_DEFAULTS = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',
  model: 'gemma3',
  timeoutMs: 90000,
  ceiling: 75776,
  models: {}, // map of modelName → { numCtx, label? }
};

const OC_CONTROL_DEFAULTS = {
  enabled: false,
  scriptsDir: path.join(__dirname, 'scripts', 'oc-control'),
  allowedActions: {
    restart_oc_5s: {
      label: 'Restart OpenClaw gateway (5s delay)',
      script: 'restart-oc-5s.sh',
      description: 'Stop the OpenClaw gateway, wait 5 seconds, then restart it.',
    },
    stop_oc_gateway: {
      label: 'Stop OpenClaw gateway',
      script: 'stop-oc-gateway.sh',
      description: 'Stop the OpenClaw gateway and leave it stopped.',
    },
    no_action: {
      label: 'No action required',
      script: null,
      description: 'The model determined no action is needed.',
    },
  },
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } else {
      // Default: scan parent directory
      config = { projectRoots: [path.dirname(__dirname)] };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    }
    // Ensure LLM and ocControl sections have defaults
    config.llm = { ...LLM_DEFAULTS, ...(config.llm || {}) };
    config.ocControl = { ...OC_CONTROL_DEFAULTS, ...(config.ocControl || {}) };
    // Merge any missing allowedActions
    config.ocControl.allowedActions = {
      ...OC_CONTROL_DEFAULTS.allowedActions,
      ...(config.ocControl.allowedActions || {}),
    };
  } catch (e) {
    console.error('Error loading config:', e.message);
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ── Helpers ──
function generateId() {
  return 'oc_' + randomBytes(4).toString('hex');
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function sendHTML(res, filePath) {
  try {
    const html = fs.readFileSync(filePath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } catch (e) {
    res.writeHead(404);
    res.end('Not found');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ── Project Discovery ──
// Scan all configured root directories for folders containing .openclaw.json
function discoverProjects() {
  const projects = [];
  for (const root of config.projectRoots) {
    if (!fs.existsSync(root)) continue;
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const markerPath = path.join(root, entry.name, MARKER_FILE);
        if (fs.existsSync(markerPath)) {
          try {
            const data = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
            data._folderPath = path.join(root, entry.name);
            data._markerPath = markerPath;
            projects.push(data);
          } catch (e) {
            console.error(`Error reading ${markerPath}:`, e.message);
          }
        }
      }
    } catch (e) {
      console.error(`Error scanning ${root}:`, e.message);
    }
  }
  return projects;
}

function findProjectById(id) {
  const projects = discoverProjects();
  return projects.find(p => p.id === id);
}

// ── Route Handlers ──

// GET /api/projects — list all projects
function handleGetProjects(req, res) {
  const projects = discoverProjects();
  // Strip internal paths from response
  const cleaned = projects.map(({ _markerPath, ...p }) => p);
  sendJSON(res, 200, cleaned);
}

// GET /api/projects/:id — get single project
function handleGetProject(req, res, id) {
  const project = findProjectById(id);
  if (!project) return sendJSON(res, 404, { error: 'Project not found' });
  const { _markerPath, ...cleaned } = project;
  sendJSON(res, 200, cleaned);
}

// PUT /api/projects/:id — update a project
async function handleUpdateProject(req, res, id) {
  const project = findProjectById(id);
  if (!project) return sendJSON(res, 404, { error: 'Project not found' });

  const updates = await readBody(req);
  const markerPath = project._markerPath;

  // Merge updates into existing data (preserve id and folderPath)
  const existing = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
  const merged = {
    ...existing,
    ...updates,
    id: existing.id, // never overwrite id
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(markerPath, JSON.stringify(merged, null, 2));
  sendJSON(res, 200, merged);
}

// POST /api/projects — create a new project in a specified folder
async function handleCreateProject(req, res) {
  const body = await readBody(req);
  const { folderPath, ...projectData } = body;

  if (!folderPath) {
    return sendJSON(res, 400, { error: 'folderPath is required' });
  }

  // Create folder if it doesn't exist
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  const markerPath = path.join(folderPath, MARKER_FILE);
  if (fs.existsSync(markerPath)) {
    return sendJSON(res, 409, { error: 'Project already exists in this folder' });
  }

  const now = new Date().toISOString();
  const project = {
    id: generateId(),
    name: projectData.name || path.basename(folderPath),
    description: projectData.description || '',
    status: projectData.status || 'planning',
    priority: projectData.priority || 'medium',
    color: projectData.color || null,
    components: projectData.components || [],
    notes: projectData.notes || [],
    createdAt: now,
    updatedAt: now,
  };

  fs.writeFileSync(markerPath, JSON.stringify(project, null, 2));

  // Add parent directory to roots if not already tracked
  const parentDir = path.dirname(folderPath);
  if (!config.projectRoots.includes(parentDir)) {
    config.projectRoots.push(parentDir);
    saveConfig();
  }

  sendJSON(res, 201, { ...project, _folderPath: folderPath });
}

// DELETE /api/projects/:id — remove the marker file (not the folder)
function handleDeleteProject(req, res, id) {
  const project = findProjectById(id);
  if (!project) return sendJSON(res, 404, { error: 'Project not found' });

  try {
    fs.unlinkSync(project._markerPath);
    sendJSON(res, 200, { message: 'Project marker removed', id });
  } catch (e) {
    sendJSON(res, 500, { error: 'Failed to delete marker: ' + e.message });
  }
}

// GET /api/config — return current config
function handleGetConfig(req, res) {
  sendJSON(res, 200, config);
}

// PUT /api/config — update config (add/remove project roots)
async function handleUpdateConfig(req, res) {
  const updates = await readBody(req);
  if (updates.projectRoots) {
    config.projectRoots = updates.projectRoots;
    saveConfig();
  }
  sendJSON(res, 200, config);
}

// POST /api/config/roots — add a new project root directory
async function handleAddRoot(req, res) {
  const { path: rootPath } = await readBody(req);
  if (!rootPath) return sendJSON(res, 400, { error: 'path is required' });
  if (!config.projectRoots.includes(rootPath)) {
    config.projectRoots.push(rootPath);
    saveConfig();
  }
  sendJSON(res, 200, config);
}

// GET /api/browse?dir=/some/path&showHidden=true — list subdirectories for folder picker
function handleBrowse(req, res, url) {
  const os = require('os');
  let dir = url.searchParams.get('dir') || os.homedir();
  const showHidden = url.searchParams.get('showHidden') === 'true';

  // Resolve ~ to home directory
  if (dir.startsWith('~')) dir = path.join(os.homedir(), dir.slice(1));

  // Resolve to absolute
  dir = path.resolve(dir);

  if (!fs.existsSync(dir)) {
    return sendJSON(res, 404, { error: 'Directory not found', path: dir });
  }

  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) {
      return sendJSON(res, 400, { error: 'Not a directory', path: dir });
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const folders = entries
      .filter(e => {
        if (!e.isDirectory()) return false;
        if (e.name.startsWith('.') && !showHidden) return false;
        return true;
      })
      .map(e => ({
        name: e.name,
        path: path.join(dir, e.name),
        hasMarker: fs.existsSync(path.join(dir, e.name, MARKER_FILE)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    sendJSON(res, 200, {
      current: dir,
      parent: path.dirname(dir) !== dir ? path.dirname(dir) : null,
      folders,
      pinnedDirs: config.pinnedDirs || [],
    });
  } catch (e) {
    sendJSON(res, 500, { error: 'Cannot read directory: ' + e.message });
  }
}

// POST /api/pinned — add a pinned directory
async function handleAddPinned(req, res) {
  const { path: dirPath } = await readBody(req);
  if (!dirPath) return sendJSON(res, 400, { error: 'path is required' });
  if (!config.pinnedDirs) config.pinnedDirs = [];
  if (!config.pinnedDirs.includes(dirPath)) {
    config.pinnedDirs.push(dirPath);
    saveConfig();
  }
  sendJSON(res, 200, { pinnedDirs: config.pinnedDirs });
}

// DELETE /api/pinned — remove a pinned directory
async function handleRemovePinned(req, res) {
  const { path: dirPath } = await readBody(req);
  if (!config.pinnedDirs) config.pinnedDirs = [];
  config.pinnedDirs = config.pinnedDirs.filter(p => p !== dirPath);
  saveConfig();
  sendJSON(res, 200, { pinnedDirs: config.pinnedDirs });
}

// PUT /api/projects/:id/move — move a project to a new folder
async function handleMoveProject(req, res, id) {
  const project = findProjectById(id);
  if (!project) return sendJSON(res, 404, { error: 'Project not found' });

  const { newFolderPath } = await readBody(req);
  if (!newFolderPath) return sendJSON(res, 400, { error: 'newFolderPath is required' });

  const newMarkerPath = path.join(newFolderPath, MARKER_FILE);
  if (fs.existsSync(newMarkerPath)) {
    return sendJSON(res, 409, { error: 'A project already exists in the target folder' });
  }

  // Create new folder if needed
  if (!fs.existsSync(newFolderPath)) {
    fs.mkdirSync(newFolderPath, { recursive: true });
  }

  try {
    // Read current marker, write to new location, delete old
    const data = JSON.parse(fs.readFileSync(project._markerPath, 'utf-8'));
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(newMarkerPath, JSON.stringify(data, null, 2));
    fs.unlinkSync(project._markerPath);

    // Add new parent to roots if not tracked
    const parentDir = path.dirname(newFolderPath);
    if (!config.projectRoots.includes(parentDir)) {
      config.projectRoots.push(parentDir);
      saveConfig();
    }

    sendJSON(res, 200, { ...data, _folderPath: newFolderPath });
  } catch (e) {
    sendJSON(res, 500, { error: 'Failed to move project: ' + e.message });
  }
}

// ── Upgrade Reticulator ──
const RETIC_FILE = config.reticulatorPath || path.join(LOCAL_DIR, 'upgrade-reticulator.json');

// Canonical vocabularies (kept in sync with dashboard.html)
const RETIC_CATEGORY_MIGRATIONS = {
  process_improvement: 'workflow_note',
  config_watch: 'config_check',
};
const RETIC_VALID_CATEGORIES = new Set([
  'local_patch', 'config_check', 'manual_test', 'watch_item', 'workflow_note',
]);
const RETIC_VALID_LIFECYCLE = new Set(['active', 'monitoring', 'retired']);
const RETIC_VALID_UPGRADE_STATUS = new Set([
  'pending', 'in_progress', 'todo', 'blocked', 'verified', 'complete',
]);
const RETIC_VALID_REVIEW_STATUS = new Set([
  'pending_upgrade_check', 'still_needed', 'upstream_reported',
  'needs_retest', 'verified', 'blocked', 'not_reviewed',
]);
// Legacy status/reviewStatus → upgradeStatus/reviewStatus mappings
const RETIC_LEGACY_STATUS_TO_LIFECYCLE = {
  active: 'active',
  monitoring: 'monitoring',
  retired: 'retired',
  resolved: 'retired',
};
const RETIC_LEGACY_STATUS_TO_UPGRADE = {
  todo: 'todo',
  in_progress: 'in_progress',
  complete: 'complete',
  verified: 'verified',
  pending: 'pending',
};
const RETIC_LEGACY_REVIEW = {
  not_started: 'pending_upgrade_check',
  reviewed: 'still_needed', // generic "reviewed" best-mapped to "still_needed"
  in_progress: 'pending_upgrade_check', // upgradeStatus value crept into reviewStatus — treat as pending
};

function _emptyStore() {
  return { upgrade: null, history: [], items: [] };
}

// Migrate an item shape in-place (mutates and returns). Idempotent.
function _migrateItem(item, historyBucket) {
  if (!item || typeof item !== 'object') return null;

  // Category: merge process_improvement / config_watch into canonical
  if (RETIC_CATEGORY_MIGRATIONS[item.category]) {
    item.category = RETIC_CATEGORY_MIGRATIONS[item.category];
  }
  // upgrade_summary items get pulled out entirely — caller handles bucket
  if (item.category === 'upgrade_summary') {
    if (Array.isArray(historyBucket)) historyBucket.push({ _migratedFromItem: item.id, item });
    return null;
  }

  // Status split: legacy `status` might contain either lifecycle or upgradeStatus values.
  // If `upgradeStatus` is already present, trust it and coerce `status` to a lifecycle value.
  // Otherwise, infer from the legacy value.
  const legacy = item.status;
  if (item.upgradeStatus) {
    if (!RETIC_VALID_LIFECYCLE.has(item.status)) {
      // status is stale or missing; default to active (most patches are active)
      item.status = RETIC_LEGACY_STATUS_TO_LIFECYCLE[legacy] || 'active';
    }
  } else if (RETIC_LEGACY_STATUS_TO_UPGRADE[legacy]) {
    // Legacy value was a cycle-progress value — split it
    item.upgradeStatus = RETIC_LEGACY_STATUS_TO_UPGRADE[legacy];
    item.status = 'active';
  } else if (RETIC_LEGACY_STATUS_TO_LIFECYCLE[legacy]) {
    item.status = RETIC_LEGACY_STATUS_TO_LIFECYCLE[legacy];
    if (!item.upgradeStatus) item.upgradeStatus = 'pending';
  } else {
    item.status = item.status || 'active';
    item.upgradeStatus = item.upgradeStatus || 'pending';
  }

  // reviewStatus legacy mapping
  if (RETIC_LEGACY_REVIEW[item.reviewStatus]) {
    item.reviewStatus = RETIC_LEGACY_REVIEW[item.reviewStatus];
  }
  if (!item.reviewStatus) item.reviewStatus = 'pending_upgrade_check';

  // Semantic-flip fix: `not_reviewed` used to mean "haven't checked yet"
  // (pre-cycle default). Now it means "intentionally skipped this cycle".
  // If the item isn't done, an old `not_reviewed` value almost certainly
  // meant the old default — migrate it to pending_upgrade_check.
  if (item.reviewStatus === 'not_reviewed' && item.upgradeStatus !== 'complete') {
    item.reviewStatus = 'pending_upgrade_check';
  }

  // Coerce unknowns to safe defaults so the UI can always render
  if (!RETIC_VALID_CATEGORIES.has(item.category)) item.category = 'watch_item';
  if (!RETIC_VALID_LIFECYCLE.has(item.status)) item.status = 'active';
  if (!RETIC_VALID_UPGRADE_STATUS.has(item.upgradeStatus)) item.upgradeStatus = 'pending';
  if (!RETIC_VALID_REVIEW_STATUS.has(item.reviewStatus)) item.reviewStatus = 'pending_upgrade_check';

  return item;
}

function loadReticulatorStore() {
  try {
    if (fs.existsSync(RETIC_FILE)) {
      const raw = JSON.parse(fs.readFileSync(RETIC_FILE, 'utf-8'));
      const store = {
        upgrade: raw.upgrade || null,
        history: Array.isArray(raw.history) ? raw.history : [],
        items: Array.isArray(raw.items) ? raw.items : [],
      };
      const extracted = [];
      store.items = store.items.map(i => _migrateItem(i, extracted)).filter(Boolean);
      // Any extracted upgrade_summary rows become history entries (one-time migration).
      // Preserve the full original item under `legacyItem` so nothing is lost.
      if (extracted.length) {
        for (const entry of extracted) {
          store.history.push({
            from: entry.item.from || null,
            to: entry.item.to || null,
            title: entry.item.title || null,
            summary: entry.item.summary || null,
            status: 'complete',
            archivedAt: entry.item.updatedAt || new Date().toISOString(),
            migratedFromItem: entry._migratedFromItem,
            legacyItem: entry.item, // full original item preserved
          });
        }
      }
      return store;
    }
  } catch (e) {
    console.error('Error loading reticulator:', e.message);
  }
  return _emptyStore();
}

function saveReticulatorStore(store) {
  const toWrite = {
    upgrade: store.upgrade || null,
    history: Array.isArray(store.history) ? store.history : [],
    items: Array.isArray(store.items) ? store.items : [],
  };
  fs.writeFileSync(RETIC_FILE, JSON.stringify(toWrite, null, 2));
}

// Legacy helpers — preserved for any call site, now delegate to the store
function loadReticulatorItems() { return loadReticulatorStore().items; }
function saveReticulatorItems(items) {
  const store = loadReticulatorStore();
  store.items = items;
  saveReticulatorStore(store);
}

function handleGetUpgradeItems(req, res) {
  // Return the full store so the UI gets upgrade + history + items
  sendJSON(res, 200, loadReticulatorStore());
}

async function handleCreateUpgradeItem(req, res) {
  const body = await readBody(req);
  // Reject deprecated category at the boundary (see RETICULATOR.md).
  // Cycle records belong on the `upgrade` object / `history` array, not items.
  if (body.category === 'upgrade_summary') {
    return sendJSON(res, 400, {
      error: "Category 'upgrade_summary' is deprecated. Write cycle metadata to the `upgrade` object via PUT /api/upgrade-cycle, and archive past cycles via POST /api/upgrade-cycle/start.",
    });
  }
  const now = new Date().toISOString();
  const item = {
    id: 'ur_' + randomBytes(4).toString('hex'),
    title: body.title || 'Untitled',
    category: body.category || 'watch_item',
    area: body.area || 'general',
    status: body.status || 'active',
    upgradeStatus: body.upgradeStatus || 'pending',
    priority: body.priority || 'medium',
    summary: body.summary || '',
    whyItMatters: body.whyItMatters || '',
    checklist: body.checklist || [],
    verification: body.verification || '',
    tags: body.tags || [],
    notes: body.notes || [],
    reviewStatus: body.reviewStatus || 'pending_upgrade_check',
    reviewedForVersion: body.reviewedForVersion || null,
    lastReviewedAt: body.lastReviewedAt || null,
    currentFinding: body.currentFinding || null,
    // Patch-specific fields
    patchFile: body.patchFile || null,
    patchTarget: body.patchTarget || null,
    batchGroup: body.batchGroup ?? null,
    upstreamIssue: body.upstreamIssue || null,
    upstreamFixedIn: body.upstreamFixedIn || null,
    reportedUpstream: body.reportedUpstream || false,
    lastCheckedAt: body.lastCheckedAt || null,
    cycleUpdatedAt: body.cycleUpdatedAt || now,
    createdAt: now,
    updatedAt: now,
  };
  _migrateItem(item); // normalize / coerce
  const store = loadReticulatorStore();
  store.items.push(item);
  saveReticulatorStore(store);
  sendJSON(res, 201, item);
}

async function handleUpdateUpgradeItem(req, res, id) {
  const store = loadReticulatorStore();
  const idx = store.items.findIndex(i => i.id === id);
  if (idx === -1) return sendJSON(res, 404, { error: 'Item not found' });

  const updates = await readBody(req);
  // Reject attempts to retag items into the deprecated category.
  if (updates.category === 'upgrade_summary') {
    return sendJSON(res, 400, {
      error: "Category 'upgrade_summary' is deprecated. Write cycle metadata to the `upgrade` object via PUT /api/upgrade-cycle, and archive past cycles via POST /api/upgrade-cycle/start.",
    });
  }
  const merged = {
    ...store.items[idx],
    ...updates,
    id: store.items[idx].id,
    createdAt: store.items[idx].createdAt,
    updatedAt: new Date().toISOString(),
  };
  _migrateItem(merged);
  store.items[idx] = merged;
  saveReticulatorStore(store);
  sendJSON(res, 200, merged);
}

function handleDeleteUpgradeItem(req, res, id) {
  const store = loadReticulatorStore();
  const idx = store.items.findIndex(i => i.id === id);
  if (idx === -1) return sendJSON(res, 404, { error: 'Item not found' });
  store.items.splice(idx, 1);
  saveReticulatorStore(store);
  sendJSON(res, 200, { message: 'Item removed', id });
}

// ── Upgrade cycle management ──

async function handleStartUpgradeCycle(req, res) {
  const body = await readBody(req);
  if (!body.from || !body.to) {
    return sendJSON(res, 400, { error: 'Missing required fields: from, to' });
  }
  const store = loadReticulatorStore();
  const now = new Date().toISOString();

  // Archive the existing active cycle (if any) into history
  if (store.upgrade) {
    const archived = {
      ...store.upgrade,
      status: store.upgrade.status === 'complete' ? 'complete' : (store.upgrade.status || 'archived'),
      completedAt: store.upgrade.completedAt || now,
      archivedAt: now,
    };
    store.history = Array.isArray(store.history) ? store.history : [];
    store.history.unshift(archived);
  }

  // Write the new active cycle
  store.upgrade = {
    from: body.from,
    to: body.to,
    commits: body.commits ?? null,
    filesChanged: body.filesChanged ?? null,
    startedAt: body.startedAt || now,
    status: body.status || 'in_progress',
    completedAt: null,
    phases: body.phases || {
      check_updates: { status: 'pending' },
      download_verify: { status: 'pending' },
      risk_analysis: { status: 'pending' },
      executive_summary: { status: 'pending' },
      backup: { status: 'pending' },
      upgrade: { status: 'pending' },
      post_verify: { status: 'pending' },
      aar: { status: 'pending' },
    },
  };

  // Reset all items for the new cycle
  let resetCount = 0;
  for (const item of store.items) {
    // Retired items stay retired — don't wake them up
    if (item.status === 'retired') continue;
    item.upgradeStatus = 'pending';
    item.reviewStatus = 'pending_upgrade_check';
    item.updatedAt = now;
    resetCount++;
  }

  saveReticulatorStore(store);
  sendJSON(res, 200, {
    message: 'Upgrade cycle started',
    upgrade: store.upgrade,
    itemsReset: resetCount,
    historyLength: store.history.length,
  });
}

async function handleUpdateUpgradeCycle(req, res) {
  const updates = await readBody(req);
  const store = loadReticulatorStore();
  if (!store.upgrade) {
    return sendJSON(res, 404, { error: 'No active upgrade cycle to update' });
  }
  // Merge top-level fields
  const merged = { ...store.upgrade, ...updates };
  // Deep-merge phases if provided
  if (updates.phases) {
    merged.phases = { ...(store.upgrade.phases || {}) };
    for (const [k, v] of Object.entries(updates.phases)) {
      merged.phases[k] = { ...(merged.phases[k] || {}), ...v };
    }
  }
  // If status is flipping to complete, stamp completedAt
  if (updates.status === 'complete' && !merged.completedAt) {
    merged.completedAt = new Date().toISOString();
  }
  store.upgrade = merged;
  saveReticulatorStore(store);
  sendJSON(res, 200, store.upgrade);
}

function handleGetUpgradeCycle(req, res) {
  const store = loadReticulatorStore();
  sendJSON(res, 200, {
    upgrade: store.upgrade,
    history: store.history,
  });
}

// ── OC Control: Ollama Integration ──

// Make a request to the local Ollama API
function ollamaGenerate(prompt) {
  return new Promise((resolve, reject) => {
    const { baseUrl, model, timeoutMs } = config.llm;
    const urlObj = new URL('/api/generate', baseUrl);
    const transport = urlObj.protocol === 'https:' ? https : http;

    const payload = JSON.stringify({
      model,
      prompt,
      stream: false,
      format: 'json',
      keep_alive: '5m',
      options: { temperature: 0.1 },
    });

    const reqOpts = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    };

    const request = transport.request(reqOpts, (resp) => {
      let body = '';
      resp.on('data', chunk => body += chunk);
      resp.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data);
        } catch (e) {
          reject(new Error('Invalid JSON response from Ollama: ' + body.slice(0, 200)));
        }
      });
    });

    request.on('timeout', () => {
      request.destroy();
      reject(new Error(`Ollama request timed out after ${timeoutMs}ms`));
    });

    request.on('error', (e) => {
      reject(new Error('Ollama connection failed: ' + e.message));
    });

    request.write(payload);
    request.end();
  });
}

// POST /api/oc-control/plan — Ask Gemma to choose a bounded action
async function handleOcControlPlan(req, res) {
  if (!config.ocControl.enabled) {
    return sendJSON(res, 403, { error: 'OC Control is disabled. Set ocControl.enabled = true in config.' });
  }

  const { userIntent } = await readBody(req);
  if (!userIntent || !userIntent.trim()) {
    return sendJSON(res, 400, { error: 'userIntent is required' });
  }

  const actionKeys = Object.keys(config.ocControl.allowedActions);
  const actionDescriptions = actionKeys.map(key => {
    const a = config.ocControl.allowedActions[key];
    return `  - "${key}": ${a.description}`;
  }).join('\n');

  const systemPrompt = `You are a bounded action selector for the OpenClaw control system.
Your ONLY job is to select exactly one action from the allowed list below based on the user's intent.
You MUST respond with valid JSON only. No markdown, no explanation, no extra text.

Allowed actions:
${actionDescriptions}

Respond with this exact JSON schema:
{"action": "<action_key>", "reason": "<one sentence reason>"}

If the user's intent does not clearly match any destructive/operational action, choose "no_action".
Be conservative — only choose a real action if the intent is unmistakably clear.`;

  const fullPrompt = `${systemPrompt}\n\nUser intent: "${userIntent.trim()}"`;

  try {
    const ollamaResp = await ollamaGenerate(fullPrompt);
    const rawText = (ollamaResp.response || '').trim();

    // Parse the JSON response from the model
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      // Try to extract JSON from the response
      const jsonMatch = rawText.match(/\{[^}]+\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        return sendJSON(res, 502, {
          error: 'Model did not return valid JSON',
          raw: rawText,
        });
      }
    }

    // Validate that the chosen action is in the allowlist
    const chosenAction = parsed.action;
    if (!actionKeys.includes(chosenAction)) {
      return sendJSON(res, 422, {
        error: `Model chose invalid action: "${chosenAction}"`,
        allowed: actionKeys,
        raw: rawText,
      });
    }

    sendJSON(res, 200, {
      action: chosenAction,
      reason: parsed.reason || '',
      actionMeta: config.ocControl.allowedActions[chosenAction],
      model: config.llm.model,
    });
  } catch (e) {
    sendJSON(res, 502, { error: e.message });
  }
}

// POST /api/oc-control/run — Execute an approved action script
async function handleOcControlRun(req, res) {
  if (!config.ocControl.enabled) {
    return sendJSON(res, 403, { error: 'OC Control is disabled. Set ocControl.enabled = true in config.' });
  }

  const { action } = await readBody(req);
  if (!action) {
    return sendJSON(res, 400, { error: 'action is required' });
  }

  // Validate action is in the allowlist
  const actionDef = config.ocControl.allowedActions[action];
  if (!actionDef) {
    return sendJSON(res, 403, {
      error: `Action "${action}" is not in the allowlist`,
      allowed: Object.keys(config.ocControl.allowedActions),
    });
  }

  // no_action is a valid choice but has no script
  if (!actionDef.script) {
    return sendJSON(res, 200, {
      action,
      status: 'no_op',
      message: 'No script to execute for this action.',
      exitCode: 0,
    });
  }

  // Resolve the script path and validate it lives inside scriptsDir
  const scriptsDir = path.resolve(config.ocControl.scriptsDir);
  const scriptPath = path.resolve(scriptsDir, actionDef.script);

  if (!scriptPath.startsWith(scriptsDir + path.sep) && scriptPath !== scriptsDir) {
    return sendJSON(res, 403, { error: 'Script path escapes scriptsDir — blocked.' });
  }

  if (!fs.existsSync(scriptPath)) {
    return sendJSON(res, 404, {
      error: `Script not found: ${actionDef.script}`,
      expectedAt: scriptPath,
    });
  }

  // Execute the script with a timeout
  const scriptTimeout = config.llm.timeoutMs + 30000; // give extra time for the actual operation
  execFile('/bin/bash', [scriptPath], { timeout: scriptTimeout }, (error, stdout, stderr) => {
    const exitCode = error ? (error.code || 1) : 0;
    sendJSON(res, exitCode === 0 ? 200 : 500, {
      action,
      status: exitCode === 0 ? 'success' : 'error',
      exitCode,
      stdout: stdout || '',
      stderr: stderr || '',
      script: actionDef.script,
    });
  });
}

// ── OC Control: Model Management & Chat ──

// Generic Ollama HTTP helper (GET or POST)
function ollamaRequest(method, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const { baseUrl, timeoutMs } = config.llm;
    const urlObj = new URL(urlPath, baseUrl);
    const transport = urlObj.protocol === 'https:' ? https : http;

    const reqOpts = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: timeoutMs,
    };

    const request = transport.request(reqOpts, (resp) => {
      let body = '';
      resp.on('data', chunk => body += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (_) { resolve({ _raw: body }); }
      });
    });

    request.on('timeout', () => { request.destroy(); reject(new Error('Ollama request timed out')); });
    request.on('error', (e) => reject(new Error('Ollama connection failed: ' + e.message)));

    if (payload) {
      const data = JSON.stringify(payload);
      request.setHeader('Content-Length', Buffer.byteLength(data));
      request.write(data);
    }
    request.end();
  });
}

// Generic HTTP JSON request — works with any base URL (for non-Ollama providers)
function httpJsonRequest(method, fullUrl, payload, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(fullUrl);
    const transport = urlObj.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: timeoutMs,
    };
    const request = transport.request(reqOpts, (resp) => {
      let body = '';
      resp.on('data', chunk => body += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (_) { resolve({ _raw: body }); }
      });
    });
    request.on('timeout', () => { request.destroy(); reject(new Error('Request timed out: ' + fullUrl)); });
    request.on('error', (e) => reject(new Error('Connection failed: ' + e.message)));
    if (payload) {
      const data = JSON.stringify(payload);
      request.setHeader('Content-Length', Buffer.byteLength(data));
      request.write(data);
    }
    request.end();
  });
}

// In-memory chat session
let chatSession = {
  messages: [],
  model: null,
};

// Tracks num_ctx we last asked Ollama to load each model with.
// Used so Extend can refresh keep_alive without triggering a re-spin.
const loadedCtxMap = new Map();

// Fetch a model's native context_length from /api/show, cached in ctxCache.
async function fetchNativeContext(modelName) {
  if (ctxCache.has(modelName)) {
    const v = ctxCache.get(modelName);
    return (v && v > 0) ? v : null;
  }
  try {
    const showData = await ollamaRequest('POST', '/api/show', { name: modelName });
    const info = showData.model_info || {};
    for (const key of Object.keys(info)) {
      if (key.endsWith('.context_length') || key === 'context_length') {
        const v = info[key];
        if (typeof v === 'number' && v > 0) {
          ctxCache.set(modelName, v);
          return v;
        }
      }
    }
  } catch (_) { /* swallow */ }
  ctxCache.set(modelName, null);
  return null;
}

// GET /api/oc-control/model-status — Returns pure ollama ps mirror + OCDash's configured intent
async function handleModelStatus(req, res) {
  try {
    const psData = await ollamaRequest('GET', '/api/ps').catch(() => ({ models: [] }));
    const models = psData.models || [];
    const configModel = config.llm.model;
    const ceiling = config.llm.ceiling || 75776;
    const now = new Date();

    // Enrich each loaded Ollama model with /api/show metadata (native ctx + details)
    const loadedModels = await Promise.all(models.map(async (m) => {
      const expiresAt = m.expires_at ? new Date(m.expires_at) : null;
      const remainingMs = expiresAt ? Math.max(0, expiresAt.getTime() - now.getTime()) : null;
      const totalBytes = m.size || 0;
      const vramBytes = m.size_vram || 0;
      const gpuPct = totalBytes > 0 ? Math.round((vramBytes / totalBytes) * 100) : 0;
      const cpuPct = totalBytes > 0 ? 100 - gpuPct : 0;
      const details = m.details || {};
      const contextLength = await fetchNativeContext(m.name);

      // Did OCDash itself load this one? (for the "OCDash" badge)
      const loadedBy = loadedCtxMap.has(m.name) ? 'ocdash' : 'external';
      const loadedWithCtx = loadedCtxMap.get(m.name) || null;

      // Is this the currently "configured" model in OCDash?
      const nameLC = (m.name || '').toLowerCase();
      const cfgLC = (configModel || '').toLowerCase();
      const isConfigured = nameLC === cfgLC ||
                           nameLC === cfgLC + ':latest' ||
                           nameLC.startsWith(cfgLC + ':');

      return {
        name: m.name || 'unknown',
        provider: 'ollama',
        sizeMB: Math.round(totalBytes / 1024 / 1024),
        vramMB: Math.round(vramBytes / 1024 / 1024),
        gpuPct,
        cpuPct,
        contextLength,
        quantization: details.quantization_level || null,
        family: details.family || null,
        parameterSize: details.parameter_size || null,
        expiresAt: m.expires_at || null,
        remainingMs,
        remainingSec: remainingMs !== null ? Math.round(remainingMs / 1000) : null,
        loadedBy,
        loadedWithCtx,
        isConfigured,
      };
    }));

    // Check OpenAI-compatible providers (e.g. MLX local service)
    // /v1/models = model is configured/exposed (not proof it's in RAM)
    // /admin/stats = actual worker load state (worker.state, worker.loaded, worker.pid)
    // /ready = hot vs cold-load readiness
    const configuredModels = config.llm.models || {};
    for (const [name, entry] of Object.entries(configuredModels)) {
      if (entry.provider !== 'openai' || !entry.baseUrl) continue;
      // Derive root URL by stripping /v1 suffix for admin endpoints
      const rootUrl = entry.baseUrl.replace(/\/v1\/?$/, '');
      let serviceAlive = false;
      let remoteModelId = null;
      let workerState = null;   // e.g. 'ready', 'not_loaded'
      let workerLoaded = false;
      let workerPid = null;
      let readyState = null;    // e.g. 'actively_ready', 'cold_load_acceptable'
      let adminStats = null;

      // 1. Check /v1/models — is the supervisor/service running and model configured?
      try {
        const modelsData = await httpJsonRequest('GET', entry.baseUrl + '/models', null, 5000);
        const remoteModels = (modelsData.data || []);
        if (remoteModels.length > 0) {
          serviceAlive = true;
          remoteModelId = remoteModels[0].id || null;
        }
      } catch (_) { /* service not reachable */ }

      if (!serviceAlive) continue; // supervisor not running — skip entirely

      // 2. Check /admin/stats — actual worker load state
      try {
        adminStats = await httpJsonRequest('GET', rootUrl + '/admin/stats', null, 5000);
        const worker = adminStats.worker || adminStats;
        workerState = worker.state || null;
        workerLoaded = !!worker.loaded;
        workerPid = worker.pid || null;
      } catch (_) { /* admin endpoint not available */ }

      // 3. Check /ready — hot vs cold readiness + idle countdown
      let idleSeconds = null;
      let idleUnloadThresholdS = null;
      let idleUnloadEnabled = false;
      try {
        const readyData = await httpJsonRequest('GET', rootUrl + '/ready', null, 5000);
        readyState = readyData.status || readyData.state || (typeof readyData === 'string' ? readyData : null);
        const rw = readyData.worker || {};
        idleSeconds = typeof rw.idle_seconds === 'number' ? rw.idle_seconds : null;
        idleUnloadThresholdS = typeof rw.idle_unload_threshold_s === 'number' ? rw.idle_unload_threshold_s : null;
        idleUnloadEnabled = !!rw.idle_unload_enabled;
      } catch (_) { /* ready endpoint not available */ }

      const nameLC = name.toLowerCase();
      const cfgLC = (configModel || '').toLowerCase();
      const isConfigured = nameLC === cfgLC;

      loadedModels.push({
        name,
        provider: 'openai',
        label: entry.label || name,
        baseUrl: entry.baseUrl,
        sizeMB: null,
        vramMB: null,
        gpuPct: null,
        cpuPct: null,
        contextLength: null,
        quantization: null,
        family: null,
        parameterSize: null,
        expiresAt: null,
        remainingMs: null,
        remainingSec: null,
        loadedBy: 'external',
        loadedWithCtx: null,
        isConfigured,
        remoteModelId,
        // MLX-specific worker state
        serviceAlive,
        workerState,
        workerLoaded,
        workerPid,
        readyState,
        // Idle countdown (from /ready)
        idleSeconds,
        idleUnloadThresholdS,
        idleUnloadEnabled,
        idleRemainingSec: (idleUnloadEnabled && idleUnloadThresholdS != null && idleSeconds != null && workerLoaded)
          ? Math.max(0, idleUnloadThresholdS - idleSeconds)
          : null,
      });
    }

    // Compute what num_ctx OCDash WOULD send for the currently configured model
    const configuredCtx = resolveNumCtx(configModel);

    sendJSON(res, 200, {
      loadedModels,
      configuredModel: configModel,
      configuredCtx,
      ceiling,
      chatMessages: chatSession.messages.length,
    });
  } catch (e) {
    sendJSON(res, 502, { error: e.message, loadedModels: [] });
  }
}

// Resolve num_ctx for a given model — purely JSON-driven.
// Reads config.llm.models[name].numCtx and caps at config.llm.ceiling.
// No regex, no /api/show lookups. Ollama is reality; JSON is intent.
const ctxCache = new Map(); // still used by fetchNativeContext() for UI display only

function resolveNumCtx(modelName = null) {
  modelName = modelName || config.llm.model || '';
  const ceiling = config.llm.ceiling || 75776;
  const entry = (config.llm.models || {})[modelName];
  if (entry && typeof entry.numCtx === 'number' && entry.numCtx > 0) {
    return Math.min(entry.numCtx, ceiling);
  }
  // Model not declared in config.llm.models — fall back to ceiling (conservative)
  return ceiling;
}

// POST /api/oc-control/warm — Prime the model by sending a trivial request with a long keep_alive
async function handleWarmModel(req, res) {
  try {
    const body = await readBody(req).catch(() => ({}));
    const targetModel = (body && body.model) || config.llm.model;
    const keepAlive = '30m';
    const numCtx = resolveNumCtx(targetModel);

    // Load the model with the resolved context window
    const result = await ollamaRequest('POST', '/api/generate', {
      model: targetModel,
      prompt: 'Respond with the single word: ready',
      stream: false,
      keep_alive: keepAlive,
      options: { num_predict: 5, num_ctx: numCtx },
    });

    // Remember what ctx we loaded it with so Extend can safely refresh
    loadedCtxMap.set(targetModel, numCtx);

    sendJSON(res, 200, {
      status: 'warm',
      model: targetModel,
      keepAlive,
      numCtx,
      response: ((result.response || '')).trim(),
    });
  } catch (e) {
    sendJSON(res, 502, { error: e.message });
  }
}

// POST /api/oc-control/extend — Refresh keep_alive for an already-loaded model without re-spin
async function handleExtendModel(req, res) {
  try {
    const body = await readBody(req).catch(() => ({}));
    const targetModel = (body && body.model) || config.llm.model;
    const keepAlive = '30m';
    // Reuse the num_ctx we loaded it with to avoid triggering a re-spin.
    // If OCDash didn't load it, fall back to whatever the JSON map says.
    let numCtx = loadedCtxMap.get(targetModel);
    if (!numCtx) {
      numCtx = resolveNumCtx(targetModel);
    }

    await ollamaRequest('POST', '/api/generate', {
      model: targetModel,
      prompt: '.',
      stream: false,
      keep_alive: keepAlive,
      options: { num_predict: 1, num_ctx: numCtx },
    });

    loadedCtxMap.set(targetModel, numCtx);

    sendJSON(res, 200, {
      status: 'extended',
      model: targetModel,
      keepAlive,
      numCtx,
    });
  } catch (e) {
    sendJSON(res, 502, { error: e.message });
  }
}

// POST /api/oc-control/unload — Force-unload a model (Ollama or OpenAI-compatible provider)
async function handleUnloadModel(req, res) {
  try {
    const body = await readBody(req).catch(() => ({}));
    const targetModel = (body && body.model) || config.llm.model;
    const entry = (config.llm.models || {})[targetModel];

    if (entry && entry.provider === 'openai' && entry.baseUrl) {
      // OpenAI-compatible provider (e.g. MLX) — use admin unload endpoint
      const rootUrl = entry.baseUrl.replace(/\/v1\/?$/, '');
      const result = await httpJsonRequest('POST', rootUrl + '/admin/worker/unload', null, 10000);
      sendJSON(res, 200, { status: 'unloaded', model: targetModel, provider: 'openai', result });
    } else {
      // Ollama provider — set keep_alive to 0
      await ollamaRequest('POST', '/api/generate', {
        model: targetModel,
        prompt: '',
        stream: false,
        keep_alive: '0',
      });
      loadedCtxMap.delete(targetModel);
      // Clear chat session only if we unloaded the currently-configured model
      if (targetModel === config.llm.model) {
        chatSession = { messages: [], model: config.llm.model };
      }
      sendJSON(res, 200, { status: 'unloaded', model: targetModel, provider: 'ollama' });
    }
  } catch (e) {
    sendJSON(res, 502, { error: e.message });
  }
}

// GET /api/oc-control/preview-ctx?model=X — Show what num_ctx OCDash would request for a given model
async function handlePreviewCtx(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const modelName = url.searchParams.get('model') || config.llm.model;
  const ceiling = config.llm.ceiling || 75776;
  const entry = (config.llm.models || {})[modelName];

  let requestedCtx, source;
  if (entry && entry.provider === 'openai') {
    // OpenAI-compatible providers manage their own context — numCtx not applicable
    requestedCtx = null;
    source = 'openai-provider';
  } else if (entry && typeof entry.numCtx === 'number' && entry.numCtx > 0) {
    if (entry.numCtx > ceiling) {
      requestedCtx = ceiling;
      source = 'capped-at-ceiling';
    } else {
      requestedCtx = entry.numCtx;
      source = 'config';
    }
  } else {
    requestedCtx = ceiling;
    source = 'unknown-model';
  }

  // Native context is informational only — shown on the loaded card, not used for load decisions
  const nativeCtx = await fetchNativeContext(modelName);

  sendJSON(res, 200, {
    model: modelName,
    requestedCtx,
    nativeCtx,
    ceiling,
    source,
    label: (entry && entry.label) || null,
  });
}

// ── System memory + large process listing ──
// Generic observability: shows what's actually using your machine,
// including non-Ollama LLM processes (e.g. a custom llama.cpp fork) that OCDash
// otherwise has no knowledge of. Mac-specific (vm_stat, sysctl, ps).

async function getSystemMemory() {
  try {
    const [vmStat, hwMem, swap] = await Promise.all([
      execFileP('vm_stat').then(r => r.stdout).catch(() => ''),
      execFileP('sysctl', ['-n', 'hw.memsize']).then(r => r.stdout).catch(() => '0'),
      execFileP('sysctl', ['-n', 'vm.swapusage']).then(r => r.stdout).catch(() => ''),
    ]);

    // Page size: read from vm_stat header so we work on both Apple Silicon (16K) and Intel (4K)
    const pageSizeMatch = vmStat.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 16384;

    const pages = (label) => {
      const m = vmStat.match(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s+(\\d+)'));
      return m ? parseInt(m[1], 10) * pageSize : 0;
    };

    const totalBytes = parseInt((hwMem || '0').trim(), 10) || 0;
    const wiredBytes = pages('Pages wired down');
    const activeBytes = pages('Pages active');
    const inactiveBytes = pages('Pages inactive');
    const compressedBytes = pages('Pages occupied by compressor');
    const freeBytes = pages('Pages free') + pages('Pages speculative');
    // "Memory used" matches what Activity Monitor reports
    const usedBytes = wiredBytes + activeBytes + compressedBytes;

    // Swap: "vm.swapusage: total = 2048.00M  used = 102.50M  free = 1945.50M  (encrypted)"
    let swapUsedMB = 0, swapTotalMB = 0;
    const swapUsedM = swap.match(/used\s*=\s*([\d.]+)M/);
    const swapTotalM = swap.match(/total\s*=\s*([\d.]+)M/);
    if (swapUsedM) swapUsedMB = parseFloat(swapUsedM[1]);
    if (swapTotalM) swapTotalMB = parseFloat(swapTotalM[1]);

    const toMB = (b) => Math.round(b / 1024 / 1024);
    return {
      totalMB: toMB(totalBytes),
      usedMB: toMB(usedBytes),
      wiredMB: toMB(wiredBytes),
      activeMB: toMB(activeBytes),
      inactiveMB: toMB(inactiveBytes),
      compressedMB: toMB(compressedBytes),
      freeMB: toMB(freeBytes),
      swapUsedMB,
      swapTotalMB,
    };
  } catch (e) {
    return { error: e.message };
  }
}

// macOS system processes/users to filter out so the list highlights actual user/inference apps
const SYSTEM_USERS = new Set(['root', 'daemon', 'nobody']);
const SYSTEM_COMMS = new Set([
  'WindowServer', 'loginwindow', 'Dock', 'Finder', 'SystemUIServer', 'launchd',
  'kernel_task', 'mds', 'mds_stores', 'corespotlightd', 'mdworker', 'mdworker_shared',
  'cloudd', 'syncdefaultsd', 'sharingd', 'nsurlsessiond', 'bird', 'parsecd',
  'CoreServicesUIAgent', 'TextInputMenuAgent', 'iconservicesagent', 'photoanalysisd',
  'mediaanalysisd', 'powerd', 'hidd', 'distnoted', 'opendirectoryd', 'syslogd',
]);

async function getLargeProcesses(thresholdMB = 2560) {
  try {
    // ps -axo with trailing '=' suppresses headers; we get raw rows.
    // pid, rss (KB), user, comm. comm is last so we capture full path with spaces.
    const { stdout } = await execFileP('ps', ['-axo', 'pid=,rss=,user=,comm=']);
    const lines = stdout.split('\n').filter(Boolean);

    const procs = lines.map(line => {
      // Right-justified columns; comm can contain spaces (e.g. ".../Google Chrome Helper")
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!m) return null;
      const pid = parseInt(m[1], 10);
      const rssKB = parseInt(m[2], 10);
      const user = m[3];
      const comm = m[4].trim();
      return { pid, rssMB: Math.round(rssKB / 1024), user, comm };
    }).filter(Boolean);

    const isSystem = (p) => {
      if (SYSTEM_USERS.has(p.user)) return true;
      if (p.user.startsWith('_')) return true; // _coreaudiod, _windowserver, etc.
      const base = p.comm.split('/').pop();
      if (SYSTEM_COMMS.has(base)) return true;
      return false;
    };

    // Skip Ollama-managed processes — they're already shown in the Ollama section
    const isOllama = (p) => /\bollama/i.test(p.comm);

    return procs
      .filter(p => p.rssMB >= thresholdMB)
      .filter(p => !isSystem(p))
      .filter(p => !isOllama(p))
      .sort((a, b) => b.rssMB - a.rssMB)
      .slice(0, 10);
  } catch (e) {
    return [];
  }
}

// GET /api/oc-control/system-memory — Mac RAM stats + non-system processes >2.5 GB
async function handleSystemMemory(req, res) {
  try {
    const [memory, processes] = await Promise.all([
      getSystemMemory(),
      getLargeProcesses(2560),
    ]);
    sendJSON(res, 200, { memory, processes, thresholdMB: 2560, currentUser: os.userInfo().username });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
}

// POST /api/oc-control/chat — Send a message in the persistent chat session
async function handleChat(req, res) {
  const { message } = await readBody(req);
  if (!message || !message.trim()) {
    return sendJSON(res, 400, { error: 'message is required' });
  }

  // Reset session if model changed
  if (chatSession.model !== config.llm.model) {
    chatSession = { messages: [], model: config.llm.model };
  }

  chatSession.messages.push({ role: 'user', content: message.trim() });

  try {
    const result = await ollamaRequest('POST', '/api/chat', {
      model: config.llm.model,
      messages: chatSession.messages,
      stream: false,
      keep_alive: '30m',
      options: { num_ctx: resolveNumCtx() },
    });

    const reply = (result.message && result.message.content) || '(no response)';
    chatSession.messages.push({ role: 'assistant', content: reply });

    sendJSON(res, 200, {
      reply,
      messageCount: chatSession.messages.length,
      model: config.llm.model,
    });
  } catch (e) {
    // Remove the failed user message so session stays consistent
    chatSession.messages.pop();
    sendJSON(res, 502, { error: e.message });
  }
}

// POST /api/oc-control/chat/clear — Clear the chat session
function handleChatClear(req, res) {
  const count = chatSession.messages.length;
  chatSession = { messages: [], model: config.llm.model };
  sendJSON(res, 200, { status: 'cleared', previousMessages: count });
}

// GET /api/oc-control/chat/history — Return current chat session
function handleChatHistory(req, res) {
  sendJSON(res, 200, {
    messages: chatSession.messages,
    model: chatSession.model,
  });
}

// GET /api/oc-control/models — List models from config.llm.models, cross-referenced with their provider
// Returns ONLY what's declared in JSON. The dropdown is JSON-driven, not provider-driven.
async function handleListModels(req, res) {
  try {
    const tagsData = await ollamaRequest('GET', '/api/tags').catch(() => ({ models: [] }));
    const ollamaTagMap = new Map((tagsData.models || []).map(m => [m.name, m]));

    const configuredModels = config.llm.models || {};
    const ceiling = config.llm.ceiling || 75776;

    // Collect unique OpenAI-compatible base URLs so we can health-check each once
    const openaiBaseUrls = new Set();
    for (const entry of Object.values(configuredModels)) {
      if (entry.provider === 'openai' && entry.baseUrl) openaiBaseUrls.add(entry.baseUrl);
    }
    // Check reachability for each OpenAI-compatible endpoint
    const openaiReachable = new Map();
    await Promise.all([...openaiBaseUrls].map(async (baseUrl) => {
      try {
        const data = await httpJsonRequest('GET', baseUrl + '/models', null, 5000);
        openaiReachable.set(baseUrl, { reachable: true, models: (data.data || []).map(m => m.id) });
      } catch (_) {
        openaiReachable.set(baseUrl, { reachable: false, models: [] });
      }
    }));

    const models = Object.keys(configuredModels).map(name => {
      const entry = configuredModels[name] || {};
      const provider = entry.provider || 'ollama';

      if (provider === 'openai') {
        // OpenAI-compatible provider (e.g. MLX local service)
        const info = openaiReachable.get(entry.baseUrl) || { reachable: false, models: [] };
        return {
          name,
          numCtx: entry.numCtx || null,
          label: entry.label || null,
          provider,
          baseUrl: entry.baseUrl || null,
          available: info.reachable,
          size: null,
          sizeMB: null,
          family: null,
          parameterSize: null,
          quantization: null,
        };
      }

      // Default: Ollama provider
      const raw = ollamaTagMap.get(name) || {};
      const details = raw.details || {};
      return {
        name,
        numCtx: entry.numCtx || null,
        label: entry.label || null,
        provider,
        available: ollamaTagMap.has(name),
        size: raw.size || null,
        sizeMB: raw.size ? Math.round(raw.size / 1024 / 1024) : null,
        family: details.family || null,
        parameterSize: details.parameter_size || null,
        quantization: details.quantization_level || null,
      };
    });

    sendJSON(res, 200, {
      models,
      activeModel: config.llm.model,
      ceiling,
    });
  } catch (e) {
    sendJSON(res, 502, { error: e.message });
  }
}

// POST /api/oc-control/switch-model — Switch the active model at runtime
async function handleSwitchModel(req, res) {
  const { model } = await readBody(req);
  if (!model || !model.trim()) {
    return sendJSON(res, 400, { error: 'model is required' });
  }
  const prev = config.llm.model;
  config.llm.model = model.trim();
  saveConfig();
  // Clear chat session and context cache since the model changed
  chatSession = { messages: [], model: config.llm.model };
  ctxCache.clear();
  sendJSON(res, 200, {
    status: 'switched',
    previousModel: prev,
    activeModel: config.llm.model,
  });
}

// GET /api/oc-control/status — Check OC Control config and provider reachability
async function handleOcControlStatus(req, res) {
  const status = {
    enabled: config.ocControl.enabled,
    model: config.llm.model,
    baseUrl: config.llm.baseUrl,
    allowedActions: config.ocControl.allowedActions,
    ollamaReachable: false,
    providers: {},
  };

  // Quick health check against Ollama
  try {
    await new Promise((resolve, reject) => {
      const urlObj = new URL('/api/tags', config.llm.baseUrl);
      const transport = urlObj.protocol === 'https:' ? https : http;
      const request = transport.get(urlObj, { timeout: 5000 }, (resp) => {
        let body = '';
        resp.on('data', chunk => body += chunk);
        resp.on('end', () => {
          status.ollamaReachable = resp.statusCode === 200;
          resolve();
        });
      });
      request.on('timeout', () => { request.destroy(); resolve(); });
      request.on('error', () => resolve());
    });
  } catch (_) { /* leave false */ }

  // Health-check any OpenAI-compatible providers declared in config
  const configuredModels = config.llm.models || {};
  const openaiBaseUrls = new Set();
  for (const entry of Object.values(configuredModels)) {
    if (entry.provider === 'openai' && entry.baseUrl) openaiBaseUrls.add(entry.baseUrl);
  }
  await Promise.all([...openaiBaseUrls].map(async (baseUrl) => {
    try {
      await httpJsonRequest('GET', baseUrl + '/models', null, 5000);
      status.providers[baseUrl] = { type: 'openai', reachable: true };
    } catch (_) {
      status.providers[baseUrl] = { type: 'openai', reachable: false };
    }
  }));

  sendJSON(res, 200, status);
}

// ── Router ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  try {
    // Serve dashboard
    if (pathname === '/' || pathname === '/dashboard.html') {
      return sendHTML(res, DASHBOARD_FILE);
    }

    // API routes
    if (pathname === '/api/projects' && req.method === 'GET') {
      return handleGetProjects(req, res);
    }
    if (pathname === '/api/projects' && req.method === 'POST') {
      return await handleCreateProject(req, res);
    }

    // Project move route (must be before generic project match)
    const moveMatch = pathname.match(/^\/api\/projects\/(.+)\/move$/);
    if (moveMatch && req.method === 'PUT') {
      return await handleMoveProject(req, res, decodeURIComponent(moveMatch[1]));
    }

    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch) {
      const id = decodeURIComponent(projectMatch[1]);
      if (req.method === 'GET') return handleGetProject(req, res, id);
      if (req.method === 'PUT') return await handleUpdateProject(req, res, id);
      if (req.method === 'DELETE') return handleDeleteProject(req, res, id);
    }

    // Upgrade Reticulator routes
    if (pathname === '/api/upgrade-items' && req.method === 'GET') {
      return handleGetUpgradeItems(req, res);
    }
    if (pathname === '/api/upgrade-items' && req.method === 'POST') {
      return await handleCreateUpgradeItem(req, res);
    }
    const upgradeMatch = pathname.match(/^\/api\/upgrade-items\/([^/]+)$/);
    if (upgradeMatch) {
      const id = decodeURIComponent(upgradeMatch[1]);
      if (req.method === 'PUT') return await handleUpdateUpgradeItem(req, res, id);
      if (req.method === 'DELETE') return handleDeleteUpgradeItem(req, res, id);
    }

    // Upgrade cycle management
    if (pathname === '/api/upgrade-cycle' && req.method === 'GET') {
      return handleGetUpgradeCycle(req, res);
    }
    if (pathname === '/api/upgrade-cycle/start' && req.method === 'POST') {
      return await handleStartUpgradeCycle(req, res);
    }
    if (pathname === '/api/upgrade-cycle' && req.method === 'PUT') {
      return await handleUpdateUpgradeCycle(req, res);
    }

    if (pathname === '/api/browse' && req.method === 'GET') {
      return handleBrowse(req, res, url);
    }

    if (pathname === '/api/pinned' && req.method === 'POST') {
      return await handleAddPinned(req, res);
    }
    if (pathname === '/api/pinned' && req.method === 'DELETE') {
      return await handleRemovePinned(req, res);
    }

    if (pathname === '/api/config' && req.method === 'GET') {
      return handleGetConfig(req, res);
    }
    if (pathname === '/api/config' && req.method === 'PUT') {
      return await handleUpdateConfig(req, res);
    }
    if (pathname === '/api/config/roots' && req.method === 'POST') {
      return await handleAddRoot(req, res);
    }

    // OC Control routes
    if (pathname === '/api/oc-control/status' && req.method === 'GET') {
      return await handleOcControlStatus(req, res);
    }
    if (pathname === '/api/oc-control/model-status' && req.method === 'GET') {
      return await handleModelStatus(req, res);
    }
    if (pathname === '/api/oc-control/warm' && req.method === 'POST') {
      return await handleWarmModel(req, res);
    }
    if (pathname === '/api/oc-control/unload' && req.method === 'POST') {
      return await handleUnloadModel(req, res);
    }
    if (pathname === '/api/oc-control/extend' && req.method === 'POST') {
      return await handleExtendModel(req, res);
    }
    if (pathname === '/api/oc-control/preview-ctx' && req.method === 'GET') {
      return await handlePreviewCtx(req, res);
    }
    if (pathname === '/api/oc-control/system-memory' && req.method === 'GET') {
      return await handleSystemMemory(req, res);
    }
    if (pathname === '/api/oc-control/plan' && req.method === 'POST') {
      return await handleOcControlPlan(req, res);
    }
    if (pathname === '/api/oc-control/run' && req.method === 'POST') {
      return await handleOcControlRun(req, res);
    }
    if (pathname === '/api/oc-control/chat' && req.method === 'POST') {
      return await handleChat(req, res);
    }
    if (pathname === '/api/oc-control/chat/clear' && req.method === 'POST') {
      return handleChatClear(req, res);
    }
    if (pathname === '/api/oc-control/chat/history' && req.method === 'GET') {
      return handleChatHistory(req, res);
    }
    if (pathname === '/api/oc-control/models' && req.method === 'GET') {
      return handleListModels(req, res);
    }
    if (pathname === '/api/oc-control/switch-model' && req.method === 'POST') {
      return handleSwitchModel(req, res);
    }

    // 404
    sendJSON(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error('Error:', e.message);
    sendJSON(res, 500, { error: e.message });
  }
});

// ── Start ──
loadConfig();
server.listen(PORT, () => {
  console.log(`\n  🦞 OpenClaw Dashboard Server`);
  console.log(`  ────────────────────────────`);
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  API:        http://localhost:${PORT}/api/projects`);
  console.log(`  Config:     ${CONFIG_FILE}`);
  console.log(`  Scanning:   ${config.projectRoots.join(', ')}`);
  console.log(`  Projects:   ${discoverProjects().length} found`);
  console.log(`  Reticulator: ${RETIC_FILE} (${loadReticulatorItems().length} items)`);
  console.log(`  OC Control:  ${config.ocControl.enabled ? 'ENABLED' : 'disabled'} (${config.llm.model} @ ${config.llm.baseUrl})`);
  console.log(`  Scripts:     ${config.ocControl.scriptsDir}\n`);
});
