const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

// ── Config ──
const PORT = 3001;
const MARKER_FILE = '.openclaw.json';
const DASHBOARD_FILE = path.join(__dirname, 'dashboard.html');

// Root directories to scan for project folders containing .openclaw.json
// Add your project root paths here
let CONFIG_FILE = path.join(__dirname, 'openclaw.config.json');
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

    const projectMatch = pathname.match(/^\/api\/projects\/(.+)$/);
    if (projectMatch) {
      const id = decodeURIComponent(projectMatch[1]);
      if (req.method === 'GET') return handleGetProject(req, res, id);
      if (req.method === 'PUT') return await handleUpdateProject(req, res, id);
      if (req.method === 'DELETE') return handleDeleteProject(req, res, id);
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
  console.log(`  Projects:   ${discoverProjects().length} found\n`);
});
