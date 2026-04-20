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
│       ├── restart-oc-5s.sh       # Restart gateway (5s delay)
│       └── stop-oc-gateway.sh    # Stop gateway
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
- **OC Control** — bounded decision engine using local Ollama/Gemma to plan and execute approved OpenClaw operations
- **Multi-provider model management** — supports Ollama and OpenAI-compatible providers (e.g. local MLX services) with per-model config, health checks, worker state tracking, idle countdown timers, and offload controls
- **Zero dependencies** — pure Node.js server, no npm install required

## API Endpoints

### Core

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
| POST | `/api/config/roots` | Add a project root directory |
| GET | `/api/upgrade-items` | Get the full reticulator store: `{ upgrade, history, items }` |
| POST | `/api/upgrade-items` | Create upgrade item |
| PUT | `/api/upgrade-items/:id` | Update upgrade item |
| DELETE | `/api/upgrade-items/:id` | Remove upgrade item |
| GET | `/api/upgrade-cycle` | Get the active upgrade cycle and history |
| POST | `/api/upgrade-cycle/start` | Start a new cycle: archive current → history, write new active, reset all items' `upgradeStatus`/`reviewStatus` |
| PUT | `/api/upgrade-cycle` | Update the active cycle (phases, status, completedAt) |

### OC Control

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/oc-control/status` | OC Control status + provider health checks |
| GET | `/api/oc-control/model-status` | Currently loaded models across all providers |
| GET | `/api/oc-control/models` | List configured models (JSON-driven, cross-referenced with providers) |
| POST | `/api/oc-control/switch-model` | Switch the active model at runtime |
| GET | `/api/oc-control/preview-ctx` | Preview what num_ctx OCDash would request for a model |
| GET | `/api/oc-control/system-memory` | System RAM usage |
| POST | `/api/oc-control/warm` | Prime a model (Ollama keep_alive) |
| POST | `/api/oc-control/extend` | Refresh keep_alive without re-spinning (Ollama) |
| POST | `/api/oc-control/unload` | Unload a model (routes to Ollama or provider admin endpoint) |
| POST | `/api/oc-control/plan` | Bounded action planning via the active model |
| POST | `/api/oc-control/run` | Execute an approved control script |
| POST | `/api/oc-control/chat` | Send a chat message to the active model |
| POST | `/api/oc-control/chat/clear` | Clear the chat session |
| GET | `/api/oc-control/chat/history` | Get current chat session messages |

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

OC Control lets OCDash use a local model as a **planner/selector** for OpenClaw operational actions. The model never gets shell access — it only picks from a strict allowlist, and OCDash maps the chosen action to an approved local script. Supports multiple providers: Ollama-hosted models and OpenAI-compatible local services (e.g. MLX).

### Architecture

```
  User intent
      │
      ▼
  OCDash server ──POST──▶ Model provider (Ollama / OpenAI-compat)
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
| `restart-oc-5s.sh` | `restart_oc_5s` | Stops the OC gateway, waits 5s, restarts it (resilient — works even if gateway is already stopped) |
| `stop-oc-gateway.sh` | `stop_oc_gateway` | Stops the OC gateway and leaves it stopped |

Scripts run via `/bin/bash` and must be `chmod +x`. They are never generated or modified by the LLM.

### Configuration

Add these sections to `local/openclaw.config.json`:

```json
{
  "llm": {
    "provider": "ollama",
    "baseUrl": "http://localhost:11434",
    "model": "gemma4:26b-a4b-it-q4_K_M-74k",
    "timeoutMs": 90000,
    "ceiling": 75776,
    "models": {
      "gemma4:26b-a4b-it-q4_K_M-74k": {
        "numCtx": 75776
      },
      "gemma4:e4b-it-q8_0-48k": {
        "numCtx": 49152
      }
    }
  },
  "ocControl": {
    "enabled": true,
    "scriptsDir": "/absolute/path/to/scripts/oc-control",
    "allowedActions": {
      "restart_oc_5s": {
        "label": "Restart OpenClaw gateway (5s delay)",
        "script": "restart-oc-5s.sh",
        "description": "Stop the OpenClaw gateway, wait 5 seconds, then restart it."
      },
      "stop_oc_gateway": {
        "label": "Stop OpenClaw gateway",
        "script": "stop-oc-gateway.sh",
        "description": "Stop the OpenClaw gateway and leave it stopped."
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

#### Multi-provider model config

Each model in `llm.models` defaults to the top-level Ollama provider. To add an OpenAI-compatible local service (e.g. an MLX worker), set `provider` and `baseUrl` on the model entry:

```json
{
  "llm": {
    "models": {
      "gemma-local-mlx-turboquant-26b-a4b-4bit": {
        "provider": "openai",
        "baseUrl": "http://127.0.0.1:<port>/v1",
        "label": "Gemma Local MLX TurboQuant 26B A4B 4bit"
      }
    }
  }
}
```

For OpenAI-compatible providers, OCDash checks three endpoints on the root URL (baseUrl with `/v1` stripped):

- `/v1/models` — is the supervisor alive and model configured?
- `/admin/stats` — actual worker load state (`worker.state`, `worker.loaded`, `worker.pid`)
- `/ready` — hot vs cold readiness, idle countdown (`worker.idle_seconds`, `worker.idle_unload_threshold_s`)

The unload button routes to `POST /admin/worker/unload` for these providers instead of Ollama's keep_alive mechanism.

### Why the model is decision-only

Giving an LLM unrestricted shell access is a security and reliability risk. Instead, the model operates within a strict boundary: it receives a natural-language intent, selects from a tiny allowlist of pre-approved actions, and returns structured JSON. OCDash validates the response and maps it to a known script. If the model hallucinates an action that isn't in the allowlist, the request is rejected. This keeps the blast radius small and the control flow auditable.

### Using the UI

Navigate to **OC Control** in the sidebar. The panel has three steps: describe your intent, review the model's chosen action, then confirm execution. Nothing runs until you explicitly click "Confirm & Execute."

### Prerequisites

- [Ollama](https://ollama.com) running locally with a Gemma model pulled (`ollama pull gemma4`), and/or an OpenAI-compatible local service (e.g. MLX) configured in the models map
- `ocControl.enabled` set to `true` in config

## Roadmap

See **[ROADMAP.md](ROADMAP.md)** for the full roadmap with details on each planned feature.

Highlights:
- [x] Upgrade Reticulator — operations dashboard for OC upgrade concerns
- [x] OC Control — bounded decision engine via local Ollama/Gemma
- [x] Multi-provider model management (Ollama + OpenAI-compatible/MLX)
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
