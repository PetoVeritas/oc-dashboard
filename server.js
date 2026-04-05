const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const { execFile } = require('child_process');

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

// GET /api/oc-control/status — Check OC Control config and Ollama reachability
async function handleOcControlStatus(req, res) {
  const status = {
    enabled: config.ocControl.enabled,
    model: config.llm.model,
    baseUrl: config.llm.baseUrl,
    allowedActions: config.ocControl.allowedActions,
    ollamaReachable: false,
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
    if (pathname === '/api/oc-control/plan' && req.method === 'POST') {
      return await handleOcControlPlan(req, res);
    }
    if (pathname === '/api/oc-control/run' && req.method === 'POST') {
      return await handleOcControlRun(req, res);
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
