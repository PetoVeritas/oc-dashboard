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
├── openclaw.config.json   # Local config (git-ignored)
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

## Roadmap

- [ ] Electron wrapper for native desktop app
- [ ] Team assignment and collaboration
- [ ] Timeline / Gantt view
- [ ] Analytics dashboard
- [ ] Startup script as a system service (launchd)

## License

MIT
