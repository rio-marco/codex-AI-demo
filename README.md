# codex-AI-demo
Use CodexAI to multiple user task perform demo

This demo accepts prompts through an HTTP API. BullMQ + Redis queue the work. A worker starts a separate Codex CLI process for each task, with a separate workspace at `workspaces/<taskId>`. MongoDB stores task status and output.

It also provides:

- a **central Codex terminal** that shows live stdout/stderr for every task, separated by user ID and task ID;
- **independent user terminals** that only receive the task owned by their user;
- a three-user demo that submits three tasks at the same time and captures every terminal.

## Requirements
- Node.js 18+
- MongoDB and Redis running
- Codex CLI installed and logged in on the machine running the worker

## Setup
```bash
npm install
cp .env.example .env
```
Edit `.env` if MongoDB/Redis use different connection URLs. `MAX_CONCURRENCY` defaults to `3` so three demo tasks can run together.

Verify Codex:
```bash
codex --version
codex login status
```

## Start (two terminals)
Terminal 1:
```bash
npm start
```
Terminal 2:
```bash
npm run worker
```

## Central Codex terminal
The central terminal subscribes to all task events. Each task has its own state, output buffer, sequence number, and renderer section.

```bash
npm run central
```

Options:
```bash
node scripts/central-terminal.js --layout sections
node scripts/central-terminal.js --layout log --since 2026-10-30T16:00:00.000Z
node scripts/central-terminal.js --api http://127.0.0.1:3030 --no-color
```

- `sections` (default on a TTY) renders a live dashboard with one section per task. It moves the cursor to the top and redraws only the task sections; it does not clear the entire terminal on every chunk.
- `log` (default when piped) is a continuously appended, timestamped log. Every line is prefixed with `[time] [userId] [taskId] [stdout|stderr]`, so interleaved output can never be attributed to the wrong task.
- `--since` hides older tasks from the initial snapshot. This is useful when you want a clean demo run.

Each section shows:
- user ID;
- task ID;
- task prompt;
- status (`QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`);
- live Codex stdout and stderr.

ANSI escape sequences and control characters are stripped with a stateful sanitizer, including sequences split across chunks. Newlines are preserved, and long lines are wrapped in the dashboard so one task cannot corrupt another task's section.

## User terminal
Each user terminal creates a task and subscribes only to that task's Socket.IO room.

```bash
node scripts/user-terminal.js --user user-1 --prompt "Create a Node.js login API"
```

Attach to an existing task owned by the user:
```bash
node scripts/user-terminal.js --user user-1 --task TASK-...
```

The user terminal exits when its task reaches `COMPLETED` or `FAILED`.

## Run the three-task demonstration
With the server and worker already running:

```bash
npm run demo
```

The demo starts one central terminal and three user terminals at the same time:

| User | Prompt |
| --- | --- |
| user-1 | Create a Node.js login API |
| user-2 | Create a React dashboard |
| user-3 | Verify Data-Delete API |

Captured terminal logs are written to `demo-output/`:

```text
demo-output/central-terminal.log
demo-output/user-1.log
demo-output/user-2.log
demo-output/user-3.log
```

The central log contains all three tasks' live output. Each user log contains only that user's task.

## HTTP API
Submit a task:
```bash
curl -X POST http://127.0.0.1:3030/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-1","prompt":"Create a simple Node.js REST API with Express"}'
```

Check task:
```bash
curl "http://127.0.0.1:3030/api/tasks/TASK_ID?userId=user-1"
```

Get output:
```bash
curl "http://127.0.0.1:3030/api/tasks/TASK_ID/output?userId=user-1"
```

Central task snapshot (demo-only privileged endpoint):
```bash
curl "http://127.0.0.1:3030/api/central/tasks?limit=50"
```

## Socket.IO protocol
User client:
```js
socket.emit('task:subscribe', { taskId: 'TASK_ID', userId: 'user-1' });
```
Events: `task:subscribed`, `task:snapshot`, `task:output`, `task:status`, `task:error`.

Central client:
```js
socket.emit('central:subscribe');
```
Events: `central:subscribed`, `central:snapshot`, `task:created`, `task:output`, `task:status`.

Output events contain `taskId`, `userId`, `prompt`, `stream`, `chunk`, and a monotonically increasing `seq`. Sequence numbers let late subscribers merge the snapshot without duplicating live chunks.

## Implementation notes
- Every Codex child process has its own stdout and stderr handlers.
- Worker output writes are serialized per task with a promise queue, so concurrent data events cannot reorder or overwrite a task's buffer.
- Task state and output buffers are keyed by `taskId`; every event also carries `userId`.
- Redis pub/sub channels remain per task (`codex-task:<taskId>`), and the server fans events out to the task room and the central room.
- The central renderer never reuses one task's buffer for another task and never uses a global clear-screen escape on each chunk.

## Security limitations
This is a local demo, not production-ready multi-tenant infrastructure. The `userId` field is only a demo ownership identifier, not authentication. The central terminal and `/api/central/tasks` expose all users' output and must not be exposed publicly. Before exposing it to clients, add real authentication/authorization, rate limits, quotas, audit logs, and stronger workspace/process isolation. Never let an untrusted client choose arbitrary filesystem paths or executable arguments. Codex still uses the machine's local login and sandbox configuration; this demo does not disable sandboxing.
