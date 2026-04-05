# OpenClaw Dashboard (OCdash)

A local project dashboard for tracking and managing ongoing projects orchestrated with OpenClaw. Built as a single-page web app backed by a lightweight Node.js server that uses `.openclaw.json` marker files for per-project persistence.

> **Note:** This app will eventually be branded and released as **OCdash**.

## Quick Start

**Requirements:** Node.js v18+

### Option A: Shell alias (recommended)

Add this function to your `~/.zshrc` (or `~/.bashrc`):

```sh
ocdash() {
  case "$1" in
    start)
      cd "/path/to/My Project Dashboard" && nohup node server.js > /dev/null 2>&1 &
      disown
      open http://localhost:3001
      echo "  🦞 OpenClaw Dashboard running on http://localhost:3001"
      ;;
    stop)
      kill $(lsof -ti:3001) 2>/dev/null && echo "  🛑 Dashboard stopped" || echo "  Dashboard not running"
      ;;
    *)
      echo "Usage: ocdash start | stop"
      ;;
  esac
}
```

Then reload your shell (`source ~/.zshrc`) and use:

```sh
ocdash start   # launch server + open browser
ocdash stop    # shut down server
```

### Option B: Manual launch

```sh
cd "/path/to/My Project Dashboard"
node server.js &
open http://localhost:3001
```

### Option C: npm

```sh
cd "/path/to/My Project Dashboard"
npm start
```

The dashboard opens at **http://localhost:3001**.

## How It Works

Each project you track gets a `.openclaw.json` marker file placed inside its own folder. The server scans configured root directories for these markers and serves them to the dashboard. All edits — status changes, component updates, notes, drag-and-drop — are saved back to the marker file automatically.

### Project structure

```
My Project Dashboard/
├── server.js              # Node.js HTTP server (no dependencies)
├── dashboard.html         # Single-page dashboard UI
├── package.json           # npm metadata
├── start.sh               # Quick-launch script
├── local/
│   └── openclaw.config.json  # Local config (git-ignored)
├── scripts/
│   └── oc-control/
│       └── restart-oc-15s.sh  # Approved OC Control script
├── .gitignore
└── README.md
```

### Marker file format

Each tracked project folder contains a `.openclaw.json`:

```json
{
  "id": "oc_a1b2c3d4",
  "name": "Project Name",
  "description": "Brief description",
  "status": "in_progress",
  "priority": "high",
  "components": [
    { "name": "Backend API", "status": "done" },
    { "name": "Frontend UI", "status": "wip" }
  ],
  "notes": [
    { "text": "Shipped v1", "date": "2026-03-31T10:00:00Z" }
  ],
  "createdAt": "2026-03-01T09:00:00Z",
  "updatedAt": "2026-03-31T10:00:00Z"
}
```

## Features

- **Kanban board** with four columns: Planning, In Progress, In Review, Complete
- **Drag-and-drop** to move projects between stages
- **Component tracking** with click-to-cycle status chips (todo → wip → done)
- **Inline notes** with full history
- **Folder browser** with pinned directories, hidden file toggle, and last-used memory
- **Project folder editing** — relocate a project's marker file from the edit modal
- **Undo system** — snapshot-based, up to 30 levels deep (Ctrl+Z supported)
- **Offline fallback** — works in-memory if the server is unreachable
- **Upgrade Reticulator** — operations watchlist for OC upgrade concerns, with its own independent datastore
- **Zero dependencies** — pure Node.js server, no npm install required

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects` | List all discovered projects |
| POST | `/api/projects` | Create a new project (requires `folderPath`) |
| PUT | `/api/projects/:id` | Update a project |
| DELETE | `/api/projects/:id` | Remove marker file (keeps folder) |
| PUT | `/api/projects/:id/move` | Move marker to a new folder |
| GET | `/api/browse?dir=...&showHidden=true` | Browse directories |
| POST | `/api/pinned` | Pin a directory |
| DELETE | `/api/pinned` | Unpin a directory |
| GET | `/api/config` | View config |
| PUT | `/api/config` | Update config |
| GET | `/api/upgrade-items` | List all reticulator items |
| POST | `/api/upgrade-items` | Create upgrade item |
| PUT | `/api/upgrade-items/:id` | Update upgrade item |
| DELETE | `/api/upgrade-items/:id` | Remove upgrade item |
| GET | `/api/oc-control/status` | OC Control status + Ollama health check |
| POST | `/api/oc-control/plan` | Bounded action planning via Ollama |
| POST | `/api/oc-control/run` | Execute an approved control script |

## Configuration

`openclaw.config.json` (auto-created on first run, git-ignored):

```json
{
  "projectRoots": ["/path/to/your/projects"],
  "pinnedDirs": ["/path/to/favorite/directory"]
}
```

- **projectRoots** — directories the server scans for folders containing `.openclaw.json`
- **pinnedDirs** — bookmarked directories shown at the top of the folder browser

## OC Control — Bounded Decision Engine

OC Control lets OCDash use a local Ollama-hosted model (e.g. Gemma) as a **planner/selector** for OpenClaw operational actions. The model never gets shell access — it only picks from a strict allowlist, and OCDash maps the chosen action to an approved local script.

### Architecture

```
  User intent
      │
      ▼
  OCDash server ──POST──▶ Ollama (Gemma)
      │                        │
      │◀── JSON: { action } ───┘
      │
      ▼
  Validate action ∈ allowlist
      │
      ▼
  Execute mapped script  (scripts/oc-control/*.sh)
      │
      ▼
  Return stdout/stderr/exit code to UI
```

The model is **decision-only**: it returns a bounded action key, never a raw shell command. OCDash is the **orchestrator/policy layer** that validates and executes.

### Where scripts live

All approved control scripts are in `scripts/oc-control/`. Currently:

| Script | Action Key | What it does |
|--------|------------|--------------|
| `restart-oc-15s.sh` | `restart_oc_15s` | Stops the OC gateway, waits 15s, restarts it |

Scripts run via `/bin/bash` and must be `chmod +x`. They are never generated or modified by the LLM.

### Configuration

Add these sections to `local/openclaw.config.json`:

```json
{
  "llm": {
    "provider": "ollama",
    "baseUrl": "http://localhost:11434",
    "model": "gemma3",
    "timeoutMs": 30000
  },
  "ocControl": {
    "enabled": true,
    "scriptsDir": "/absolute/path/to/scripts/oc-control",
    "allowedActions": {
      "restart_oc_15s": {
        "label": "Restart OpenClaw gateway (15s delay)",
        "script": "restart-oc-15s.sh",
        "description": "Stop the OpenClaw gateway, wait 15 seconds, then restart it."
      },
      "no_action": {
        "label": "No action required",
        "script": null,
        "description": "The model determined no action is needed."
      }
    }
  }
}
```

`ocControl.enabled` defaults to `false` — you must opt in. All other fields have sensible defaults.

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/oc-control/status` | Check config, Ollama reachability, allowed actions |
| POST | `/api/oc-control/plan` | Send `{ userIntent }`, get back the model's chosen action |
| POST | `/api/oc-control/run` | Send `{ action }`, execute the mapped script |

### Why Gemma is decision-only

Giving an LLM unrestricted shell access is a security and reliability risk. Instead, Gemma operates within a strict boundary: it receives a natural-language intent, selects from a tiny allowlist of pre-approved actions, and returns structured JSON. OCDash validates the response and maps it to a known script. If the model hallucinates an action that isn't in the allowlist, the request is rejected. This keeps the blast radius small and the control flow auditable.

### Using the UI

Navigate to **OC Control** in the sidebar. The panel has three steps: describe your intent, review the model's chosen action, then confirm execution. Nothing runs until you explicitly click "Confirm & Execute."

### Prerequisites

- [Ollama](https://ollama.com) running locally with a Gemma model pulled (`ollama pull gemma3`)
- `ocControl.enabled` set to `true` in config

## Roadmap

See **[ROADMAP.md](ROADMAP.md)** for the full roadmap with details on each planned feature.

Highlights:
- [x] Upgrade Reticulator — operations dashboard for OC upgrade concerns
- [x] Kanban board with drag-and-drop
- [x] List view with sortable columns
- [x] Folder browser with pinning
- [ ] Electron wrapper for native desktop app
- [ ] Timeline / Gantt view
- [ ] Analytics dashboard
- [ ] Team assignment and collaboration
- [ ] Startup as system service (launchd)

## License

MIT
