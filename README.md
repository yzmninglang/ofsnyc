# ofsync

`ofsync` is a local-first synchronization daemon for self-hosted ShareLaTeX / Overleaf Community Edition projects.

It keeps a real local directory for VS Code, Codex, Claude Code, Git, language servers, and ordinary command-line tools. A background daemon watches that directory, safely synchronizes it with ShareLaTeX, compiles remotely, and exposes a local HTTP API for a future PDF UI and editor integrations.

## MVP capabilities

- Bootstrap a ShareLaTeX project into a normal local folder without downloading a project ZIP.
- Watch local changes, debounce rapid writes, and run serialized synchronization passes.
- Store per-file baselines and conflict snapshots under `.ofsync/`.
- Poll ShareLaTeX history/file-tree-diff endpoints when available, with a conservative full metadata scan fallback.
- Use the legacy Socket.IO XHR-polling project handshake to read project trees.
- Compile remotely and cache the generated PDF locally.

## Commands

```text
ofsync projects List active remote projects without writing local state.
ofsync init    Create .ofsync/config.json and verify the remote project.
ofsync sync    Run one safe synchronization pass.
ofsync watch   Watch local files, poll remote changes, and expose localhost APIs.
ofsync status  Print the project state as JSON.
ofsync resolve Resolve a recorded conflict with the local or remote version.
```

Authentication is provided through a browser Cookie header in an environment variable, `OFSYNC_COOKIE` by default. Passwords are never stored.

## Safety model

For each path, the daemon compares the current local bytes, current remote bytes, and a baseline from the last successful synchronization:

- only local changed: upload;
- only remote changed: download;
- both changed: keep snapshots and report a conflict;
- new file on one side: copy it to the other side;
- deletions: are not propagated unless explicitly enabled in config.
- The .git/ and .ofsync/ directories are always excluded. By default, .gitignore and optional .ofsyncignore files also exclude paths from both upload and download; common LaTeX build products such as *.aux, *.log, and *.synctex.gz are excluded automatically.

Use .ofsyncignore for files that should remain in Git but must never be synchronized to ShareLaTeX. The .gitignore and .ofsyncignore files themselves remain eligible for synchronization. Pass --no-gitignore during init to stop reading .gitignore; hard safety exclusions and .ofsyncignore still apply.

The first MVP deliberately does not silently auto-merge text or send OT edits. It favors retained snapshots and explicit conflict resolution.

## Using a self-hosted server

The daemon reads credentials from environment variables only; it never writes them to `.ofsync/config.json`.

Start with `projects` to verify the server connection and choose the exact project name. It is read-only and does not create a local directory:

```powershell
$env:OFSYNC_EMAIL = 'you@example.com'
$env:OFSYNC_PASSWORD = '...'
npm run dev -- projects --server http://your-sharelatex-host:8189 --email-env OFSYNC_EMAIL --password-env OFSYNC_PASSWORD
```

```powershell
$env:OFSYNC_COOKIE = 'overleaf.sid=...'
npm run dev -- init --server http://your-sharelatex-host:8189 --project-name "My project" --path D:\Projects\my-project
npm run dev -- watch --path D:\Projects\my-project
```

If cookie login is not available, configure variable names at initialization and provide values only for the current process:

```powershell
$env:OFSYNC_EMAIL = 'you@example.com'
$env:OFSYNC_PASSWORD = '...'
npm run dev -- init --server http://your-sharelatex-host:8189 --project-name "My project" --path D:\Projects\my-project --email-env OFSYNC_EMAIL --password-env OFSYNC_PASSWORD
```

The local dashboard is served only on `127.0.0.1` (default `http://127.0.0.1:43821`). It exposes status, manual sync, compile, cached PDF, conflict resolution, and SyncTeX HTTP endpoints for a future VS Code extension.

## Manager API (`ofsync ui`)

`ofsync ui` hosts every mapped project in one process on one port. Project-scoped routes are namespaced by the mapping id from `~/.ofsync/manager.json` (not the remote project id), so PDF, SyncTeX, file, and upload traffic for different projects never collide:

```text
GET    /api/projects/:pid/status
GET    /api/projects/:pid/conflicts
POST   /api/projects/:pid/conflicts/:cid/resolve   { "choice": "local" | "remote" }
POST   /api/projects/:pid/sync                      optional { "paths": ["main.tex"] }
POST   /api/projects/:pid/compile
GET    /api/projects/:pid/pdf
GET    /api/projects/:pid/file?path=main.tex
PUT    /api/projects/:pid/file?path=main.tex        raw body
POST   /api/projects/:pid/synctex/code
POST   /api/projects/:pid/synctex/pdf
```

An unknown mapping id returns 404. Paused mappings return 409 for sync, compile, conflict resolution, and SyncTeX, but their cached PDF and local files remain readable. `PUT .../file` writes inside the project directory only (absolute paths, Windows drive letters, `..`, and `.ofsync/` are rejected) and leaves uploading to the normal watcher/reconcile path, so conflict detection and `.gitignore` filtering still apply. The older `/api/manage/mappings/:id/...` routes remain available for the dashboard.

### Automatic sign-in from environment variables

`ofsync ui` signs in to every server that has an active mapping when it starts, so restarting the process (or the computer) does not require retyping credentials:

```powershell
# email and password (works with self-hosted ShareLaTeX)
setx OFSYNC_EMAIL 'you@example.com'
setx OFSYNC_PASSWORD '...'

# or a browser cookie (required for hosted overleaf.com)
setx OFSYNC_COOKIE 'overleaf_session2=...'
```

Variable names are resolved per server in this order:

1. `OFSYNC_<HOST>_<PORT>_EMAIL` / `_PASSWORD` / `_COOKIE`, for example `OFSYNC_192_168_1_16_8189_EMAIL`;
2. the names recorded in the project's `.ofsync/config.json` (from `ofsync init`);
3. `OFSYNC_EMAIL` / `OFSYNC_PASSWORD` / `OFSYNC_COOKIE`.

A cookie always wins over an email and password. `setx` only affects processes started afterwards, so restart `ofsync ui` after changing a value. A server that cannot be reached or rejects the credentials is reported and stays in `awaiting-auth` without blocking the UI or other projects; `POST /api/manage/connect` remains the manual fallback. ofsync never writes these values itself — they stay visible to other processes running as the same Windows user, so use the per-server names when several servers with different accounts are mapped.

Hosted Overleaf passwords are blocked by reCAPTCHA and its session cookie lasts about five days, so that server needs a fresh `setx OFSYNC_COOKIE` roughly weekly even with automatic sign-in.

Request logging is disabled by default. Add `--request-log` to `watch` or `sync` to write sanitized JSON Lines to `.ofsync/requests.log`. Entries include method, endpoint, status, duration, and errors, but never cookies, passwords, or request bodies. SyncTeX positions without a remote mapping are returned as HTTP 422 with code `SYNCTEX_NOT_FOUND`.

After a successful remote compile, the compile response and status API include the Build ID associated with the cached PDF. Editor clients should use this Build ID for matching SyncTeX requests rather than keeping a manual value. The value is intentionally in-memory and resets when the daemon restarts, so the next successful compile establishes a fresh PDF/Build ID pair.
