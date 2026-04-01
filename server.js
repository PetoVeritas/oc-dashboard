const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

// ── Config ──
const PORT = 3001;
const MARKER_FILE = '.openclaw.json';
const DASHBOARD_FILE = path.join(__dirname, 'dashboard.html');

// Local data directory for config and datastores (gitignored)
const LOCAL_DIR = path.join(__dirname, 'local');
if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR);

let CONFIG_FILE = path.join(LOCAL_DIR, 'openclaw.config.json');
let config = { projectRoots: [] };

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } else {
      // Default: scan parent directory
      config = { projectRoots: [path.dirname(__dirname)] };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    }
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

function loadReticulatorItems() {
  try {
    if (fs.existsSync(RETIC_FILE)) {
      const data = JSON.parse(fs.readFileSync(RETIC_FILE, 'utf-8'));
      return data.items || [];
    }
  } catch (e) {
    console.error('Error loading reticulator:', e.message);
  }
  return [];
}

function saveReticulatorItems(items) {
  fs.writeFileSync(RETIC_FILE, JSON.stringify({ items }, null, 2));
}

function handleGetUpgradeItems(req, res) {
  sendJSON(res, 200, loadReticulatorItems());
}

async function handleCreateUpgradeItem(req, res) {
  const body = await readBody(req);
  const now = new Date().toISOString();
  const item = {
    id: 'ur_' + randomBytes(4).toString('hex'),
    title: body.title || 'Untitled',
    category: body.category || 'watch_item',
    area: body.area || 'general',
    status: body.status || 'active',
    priority: body.priority || 'medium',
    summary: body.summary || '',
    whyItMatters: body.whyItMatters || '',
    checklist: body.checklist || [],
    verification: body.verification || '',
    tags: body.tags || [],
    notes: body.notes || [],
    reviewStatus: body.reviewStatus || 'not_reviewed',
    reviewedForVersion: body.reviewedForVersion || null,
    lastReviewedAt: body.lastReviewedAt || null,
    currentFinding: body.currentFinding || null,
    reportedUpstream: body.reportedUpstream || false,
    lastCheckedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const items = loadReticulatorItems();
  items.push(item);
  saveReticulatorItems(items);
  sendJSON(res, 201, item);
}

async function handleUpdateUpgradeItem(req, res, id) {
  const items = loadReticulatorItems();
  const idx = items.findIndex(i => i.id === id);
  if (idx === -1) return sendJSON(res, 404, { error: 'Item not found' });

  const updates = await readBody(req);
  const merged = {
    ...items[idx],
    ...updates,
    id: items[idx].id,
    createdAt: items[idx].createdAt,
    updatedAt: new Date().toISOString(),
  };
  items[idx] = merged;
  saveReticulatorItems(items);
  sendJSON(res, 200, merged);
}

function handleDeleteUpgradeItem(req, res, id) {
  let items = loadReticulatorItems();
  const idx = items.findIndex(i => i.id === id);
  if (idx === -1) return sendJSON(res, 404, { error: 'Item not found' });
  items.splice(idx, 1);
  saveReticulatorItems(items);
  sendJSON(res, 200, { message: 'Item removed', id });
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
  console.log(`  Reticulator: ${RETIC_FILE} (${loadReticulatorItems().length} items)\n`);
});
