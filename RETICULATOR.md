# Upgrade Reticulator — Schema & Agent Guide

> **Read this before changing Reticulator code, data, or vocabularies.**
> The Reticulator schema is small but easy to drift if you treat the three status
> axes as interchangeable or invent new categories on the fly. This doc is the
> source of truth for what the fields mean and how cycles work.

## What the Reticulator is

A standalone watchlist for OpenClaw upgrade concerns: local patches we maintain,
config we re-check each upgrade, manual smoke tests, things to watch upstream,
and workflow notes. Each item has a long-lived **lifecycle** and gets reviewed
once per **upgrade cycle**.

## Datastore

- **Location:** `<project root>/local/upgrade-reticulator.json`
- **Git-ignored:** the entire `local/` directory is excluded from version control
- **Override:** set `reticulatorPath` in `local/openclaw.config.json` to an
  absolute path (e.g. shared drive)
- **Top-level shape:**
  ```json
  {
    "upgrade":  { ... } | null,
    "history":  [ { ... }, ... ],
    "items":    [ { ... }, ... ]
  }
  ```
  - `upgrade` — the active upgrade cycle (phases, version, started date, etc.)
  - `history` — archived previous cycles, oldest → newest
  - `items` — the actual watchlist entries

**Never write a bare array to this file.** That wipes `upgrade` and `history`.
The internal helpers `loadReticulatorStore()` / `saveReticulatorStore()` in
`server.js` enforce the envelope. See [Write paths](#write-paths) below for
how agents and external tools should write.

## Item shape

```json
{
  "id":              "ur_a1b2c3d4",
  "title":           "Short headline",
  "category":        "local_patch",
  "status":          "active",
  "upgradeStatus":   "pending",
  "reviewStatus":    "pending_upgrade_check",
  "priority":        "medium",

  "area":            "free-text grouping (e.g. 'gateway', 'mlx-worker')",
  "summary":         "what the concern is",
  "whyItMatters":    "stakes / context",
  "checklist":       [ { "text": "...", "checked": false } ],
  "verification":    "how to confirm it's still OK",
  "tags":            [ "string", ... ],
  "notes":           [ { "text": "...", "date": "ISO string" } ],

  "reviewedForVersion": "OC vX.Y.Z this review is against",
  "lastReviewedAt":     "ISO string",
  "cycleUpdatedAt":     "ISO string for last this-cycle field/check/review update",
  "currentFinding":     "free-text verdict for this cycle",
  "reportedUpstream":   true,

  "patchFile":       "src/worker/foo.py",
  "patchTarget":     "shouldEmitSignalReactionNotification",
  "batchGroup":      1,
  "upstreamIssue":   "https://github.com/.../issues/123",
  "upstreamFixedIn": "v1.2.3",
  "lastCheckedAt":   "ISO string",

  "createdAt":       "ISO string",
  "updatedAt":       "ISO string"
}
```

**Notes on specific fields:**
- **`id`** — opaque unique key. Format is legacy-tolerant: both `ur_<hex>`
  (the current default from `POST /api/upgrade-items`) and `retic_<hex>`
  are valid. Don't rewrite existing IDs.
- **`patchTarget`** — the **search anchor** for the reapply script to locate
  where the patch goes in the dist file (e.g. a unique function name or
  symbol like `"shouldEmitSignalReactionNotification"`). NOT an upstream
  commit hash — upstream tracking goes in `upstreamIssue` /
  `upstreamFixedIn`.
- **`batchGroup`** — reapply batch grouping. Integer (`1`, `2`, `3`) or
  string (`"batch-1"`, `"hotfix-q2"`) both accepted; integers preferred for
  sequential batches. `null` means ungrouped.

### Always present
`id`, `title`, `category`, `status`, `upgradeStatus`, `reviewStatus`,
`priority`, `createdAt`, `updatedAt`.

### Optional content
`area`, `summary`, `whyItMatters`, `checklist`, `verification`, `tags`,
`notes`, `reviewedForVersion`, `lastReviewedAt`, `cycleUpdatedAt`,
`currentFinding`, `reportedUpstream`.

### Patch-specific (only meaningful when `category === "local_patch"`)
`patchFile`, `patchTarget`, `batchGroup`, `upstreamIssue`, `upstreamFixedIn`,
`lastCheckedAt`. The Patch Details panel in the modal shows/hides based on
category — these fields are still stored on non-patch items, but the UI
ignores them.

## The three status axes

Three orthogonal fields. **Do not merge them.** Each answers a different
question.

### 1. `status` — lifecycle (persists across cycles)

> "Is this concern still in play at all?"

| Value         | Meaning |
|---------------|---------|
| `active`      | Live concern. Include in this cycle. |
| `monitoring`  | Not actively worked. Watching for upstream change. |
| `retired`     | No longer needed. Excluded from cycle resets and default filters. |

### 2. `upgradeStatus` — per-cycle progress (resets each cycle)

> "Where is this in the *current* upgrade cycle's workflow?"

| Value         | Meaning |
|---------------|---------|
| `pending`     | Not yet triaged this cycle (default after cycle reset). |
| `todo`        | Triaged, queued. |
| `in_progress` | Actively being worked. |
| `blocked`     | Stuck waiting on something. |
| `verified`    | Patch applied and retested OK. |
| `complete`    | Fully resolved for this cycle. |


### Cycle Date column

The Reticulator list shows **Cycle Date** next to **This Cycle**. It is not a
generic item modified date. It reflects the last time this-cycle review/progress
state changed: `upgradeStatus`, `reviewStatus`, `reviewedForVersion`,
`currentFinding`, `lastCheckedAt`, or `lastReviewedAt`. New items initialize it
on create. Older items may fall back visually to `lastReviewedAt` /
`lastCheckedAt` until they are saved again.

### 3. `reviewStatus` — review verdict (resets each cycle)

> "What did we find when we looked at this for the current upgrade?"

| Value                   | Meaning |
|-------------------------|---------|
| `pending_upgrade_check` | Not yet reviewed (default after cycle reset). |
| `still_needed`          | Upstream hasn't fixed it; keep the local patch. |
| `upstream_reported`     | Filed upstream; awaiting fix. |
| `needs_retest`          | Code changed; retest required. |
| `verified`              | Retested OK for this release. |
| `blocked`               | Can't make a determination. |
| `not_reviewed`          | Intentionally skipped this cycle. |

> **Migration note on `not_reviewed`.** This value used to be the pre-cycle
> default before `pending_upgrade_check` existed. The load-time migration
> auto-corrects: any item with `reviewStatus = "not_reviewed"` AND
> `upgradeStatus !== "complete"` is rewritten to `pending_upgrade_check`,
> since the old default semantics no longer apply to in-flight items. Set
> `not_reviewed` only on items you genuinely meant to skip.

## Categories

Five canonical categories. **Do not invent new ones.** If you think you need
one, propose it and update both code constants AND this doc together.

| Key             | Use when... |
|-----------------|-------------|
| `local_patch`   | We maintain a modification not in upstream. Use the patch-specific fields. |
| `config_check`  | A setting that needs to be verified each upgrade. |
| `manual_test`   | A manual smoke test to perform each cycle. |
| `watch_item`    | Something to keep an eye on; no action yet. |
| `workflow_note` | Process / workflow guidance that applies each cycle. |

Legacy values that are auto-migrated on load:
- `process_improvement` → `workflow_note`
- `config_watch` → `config_check`

**`upgrade_summary` (deprecated category) — extracted to `history`.** Older
data used `upgrade_summary` items as a poor-man's history of past cycles.
On load, any item with `category: "upgrade_summary"` is removed from
`items` and pushed onto `history` with the full original item preserved
under `legacyItem`. Don't create new `upgrade_summary` items — use
`POST /api/upgrade-cycle/start` to write proper cycle records to history.

## The `upgrade` object (active cycle)

The top-level `upgrade` object holds everything about the currently in-flight
upgrade cycle. It is the one and only place cycle metadata should live —
never create items in the `items` array to hold cycle-level information.

```json
{
  "from":             "2026.4.11",
  "to":               "2026.4.15",
  "commits":          1234,
  "filesChanged":     567,
  "startedAt":        "ISO string",
  "completedAt":      "ISO string | null",
  "status":           "in_progress" | "complete",
  "executiveSummary": "free-text rollup of the cycle",
  "phases": {
    "check_updates":     { "status": "pending" | "in_progress" | "complete" | "skipped", "notes": "..." },
    "download_verify":   { ... },
    "risk_analysis":     { ... },
    "executive_summary": { ... },
    "backup":            { ... },
    "upgrade":           { ... },
    "post_verify":       { ... },
    "aar":               { ... }
  }
}
```

**Declared fields:**
- `from`, `to` — version strings (required when calling
  `POST /api/upgrade-cycle/start`).
- `commits`, `filesChanged` — counts surfaced in the cycle banner.
- `startedAt`, `completedAt` — ISO timestamps. `completedAt` is
  auto-stamped when `status` flips to `complete` via
  `PUT /api/upgrade-cycle`.
- `status` — overall cycle status (`in_progress` or `complete`).
- `executiveSummary` — free-text summary of the cycle. Write it here
  mid-cycle (draft) or at close (final). This replaces the old pattern
  of creating `category: "upgrade_summary"` items.
- `phases` — the 8 canonical phase keys. Each phase can have `status`
  and arbitrary extra fields (notes, links, counts) merged in.

`PUT /api/upgrade-cycle` **deep-merges** whatever you send, so you can
update a single phase or a single field without resending the whole
object. Any extra fields you include are preserved verbatim — use this
for cycle-specific metadata that isn't (yet) a declared field.

## Cycle lifecycle

`POST /api/upgrade-cycle/start` does, in order:
1. Archives the current `upgrade` block onto the end of `history`.
2. Writes a new `upgrade` block with phases reset.
3. For every item where `status !== "retired"`:
   - `upgradeStatus` → `pending`
   - `reviewStatus` → `pending_upgrade_check`
   - `currentFinding` is cleared
4. Retired items are untouched.

Cycle phases (the dots in the banner), in order:
`check_updates → download_verify → risk_analysis → executive_summary →
backup → upgrade → post_verify → aar`.

Informal operator alias: the banner of phase lights can be referred to as the
**Ret phase tracker**. If Mauricio says "move the Ret phase tracker forward" or
"the Ret phase tracker is stuck on Risk," treat that as referring to this
canonical ordered phase sequence.

`PUT /api/upgrade-cycle` deep-merges phase changes and auto-stamps
`completedAt` when overall status flips to `complete`.

`GET /api/upgrade-cycle` returns `{ upgrade, history }`.
`GET /api/upgrade-items` returns the full store `{ upgrade, history, items }`.

## Write paths

How you should modify the datastore depends on whether OCDash's server is
running.

**When the server is running (preferred):** use the HTTP API. Every endpoint
runs the item through the server's normalization and validation before
writing, so you can't accidentally corrupt the schema.

| Action | Endpoint |
|--------|----------|
| Create item | `POST /api/upgrade-items` |
| Update item | `PUT /api/upgrade-items/:id` |
| Delete item | `DELETE /api/upgrade-items/:id` |
| Start a new cycle (archives + resets) | `POST /api/upgrade-cycle/start` |
| Update active cycle (phases, status) | `PUT /api/upgrade-cycle` |

**When the server is stopped:** direct file edits are acceptable, but you
must follow these rules:
1. Preserve the `{upgrade, history, items}` envelope. Never write a bare
   array — that erases the active cycle and history.
2. Write through a read-modify-write pattern: load the file, modify the
   field you care about, write it back. No partial structures.
3. Run your new/edited items through the same normalization logic the
   server uses (or at minimum keep values within the canonical vocabularies
   listed above). Anything invalid will be coerced or moved on next load.
4. Avoid concurrent writes (don't edit the file while the server is coming
   up).

**The server's load-time migration is idempotent.** Even if a direct file
edit lands invalid values, the next server start will coerce them back to
canonical values. That safety net is not a license to skip validation —
but it does mean one-off data repairs are safe.

## Where the canonical lists live in code

If this doc and code disagree, **code wins** — but you should fix the doc in
the same PR.

- **UI** (`dashboard.html`):
  `RETIC_CATEGORIES`, `RETIC_LIFECYCLE`, `RETIC_UPGRADE_STATUSES`,
  `RETIC_REVIEW_STATUSES`, `RETIC_PHASES`, `RETIC_LEGACY_*`.
  Normalization happens in `normalizeReticItem`.
- **Server** (`server.js`):
  `RETIC_VALID_CATEGORIES`, `RETIC_VALID_LIFECYCLE`,
  `RETIC_VALID_UPGRADE_STATUS`, `RETIC_VALID_REVIEW_STATUS`,
  `RETIC_CATEGORY_MIGRATIONS`. Normalization happens in `_migrateItem`.

Any change to a vocabulary or to the item shape MUST update:
1. This file (`RETICULATOR.md`)
2. The constants in `dashboard.html`
3. The constants and validators in `server.js`
4. The migration maps if you're renaming a value

## Agent do's and don'ts

**DO:**
- Read this doc before touching Reticulator code or data.
- Run `normalizeReticItem` (UI) and `_migrateItem` (server) when in doubt —
  they are the canonical migration paths.
- Preserve the `{upgrade, history, items}` envelope on every write.
- Keep `status`, `upgradeStatus`, and `reviewStatus` as separate axes.
- When adding a category-specific field, gate the UI on category but still
  persist the field on all items (cheap, prevents data loss on category
  change).

**DON'T:**
- Invent new categories, lifecycle values, upgrade statuses, or review
  statuses without updating all three layers (this doc + UI constants +
  server validators).
- Merge lifecycle and upgrade progress back into a single `status` field.
- Treat `upgradeStatus` and `reviewStatus` as interchangeable. One is
  workflow progress; the other is a finding.
- Write a bare items array to `upgrade-reticulator.json` — that erases the
  active cycle and history.
- Skip the load-time migration. Old data may still carry legacy values
  (`resolved`, `process_improvement`, `not_started`, etc.).
- Auto-clear `currentFinding` outside of `POST /api/upgrade-cycle/start`.
  Findings should persist within a cycle.
