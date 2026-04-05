# OCdash Roadmap

This document tracks planned features, improvements, and long-term direction for OCdash. Items are grouped by area and roughly prioritized within each section.

## Shipped

### Upgrade Reticulator
Operations dashboard for tracking OC upgrade concerns: local patches, config checks, manual tests, watch items, and upstream gaps. Independent JSON datastore separate from project markers. Includes summary cards, filterable list, detail/edit modal with checklists and notes, and 7 seed items.

### Project Kanban Board
Drag-and-drop Kanban board with four columns (Planning → In Progress → In Review → Complete). Component chips with 4-step status cycle (todo → wip → review → done). Inline notes, search, undo system (30 levels), and offline fallback.

### Folder Browser
Browse-to-folder picker in the create/edit modal. Pinned directories, hidden file toggle, last-used directory memory. Project folder editing to relocate marker files.

### List View
Sortable table view with columns for name, status, priority, progress, components, and last updated. Clickable component chips and inline edit/delete actions.

### OC Control — Bounded Decision Engine
Local Ollama/Gemma integration as a bounded action planner for OpenClaw operations. The model selects from a strict allowlist of pre-approved actions — it never gets shell access or generates arbitrary commands. OCDash validates the model's choice and maps it to an approved local script. Three-step UI flow: describe intent, review chosen action, confirm execution. Allowed actions sidebar populated dynamically from config JSON. Ships with two approved scripts: gateway restart (5s delay, resilient) and gateway stop.

---

## In Progress

### Upgrade Reticulator — v2
- Bulk "mark all checked" for pre-upgrade sweeps
- Export/print a pre-upgrade checklist as a runbook
- Version tagging — associate items with specific OC versions
- Archive view for retired/resolved items
- Diff view showing what changed since last upgrade check

---

## Planned

### Electron Wrapper
Package OCdash as a standalone native desktop app. The Node server would launch automatically inside the Electron process, and the dashboard would render in a dedicated window instead of a browser tab. This would eliminate the need for `ocdash start/stop` and make the app feel like a first-class Mac application.

### Timeline / Gantt View
Visual timeline showing project duration, milestones, and overlapping work. Useful for understanding scheduling conflicts and dependencies across projects. Would live alongside the Board and List views as a third project visualization.

### Analytics Dashboard
Aggregate stats across all projects: completion trends over time, component velocity, status distribution charts, and time-in-status metrics. Likely built with simple inline SVG or a lightweight charting approach to keep the zero-dependency philosophy.

### Team Assignment & Collaboration
Add team members to projects with roles and assignments. Component-level ownership so individual contributors can be tracked. Would require extending the `.openclaw.json` schema and adding a team management UI. Multi-user access is a longer-term consideration that may tie into the Electron wrapper or a lightweight auth layer.

### Startup as System Service (launchd)
Register the OCdash server as a macOS launchd service so it starts automatically on boot and stays running in the background without needing Terminal. Would include an install/uninstall script and status indicator in the dashboard.

### Notification System
Toast-style or native notifications for upgrade items approaching their check interval, projects that haven't been updated in a configurable window, or checklist items that are overdue. Would integrate with macOS notification center when running in Electron.

---

## Ideas / Not Yet Scoped

- **Import/export** — bulk import projects or reticulator items from JSON/CSV
- **Keyboard shortcuts** — power-user navigation (j/k to move between items, e to edit, etc.)
- **Dark/light theme toggle** — currently dark-only, could add a light mode
- **Plugin system** — extensible modules for custom dashboards or data sources
- **Mobile-responsive layout** — make the dashboard usable on tablets/phones
- **Webhook integration** — trigger actions on status changes (post to Slack, update a ticket, etc.)
- **Search across all views** — unified search that spans projects, components, and reticulator items
