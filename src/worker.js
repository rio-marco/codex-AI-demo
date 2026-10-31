const { Worker } = require('bullmq');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const config = require('./config');
const Task = require('./models/Task');
const { formatDuration } = require('./estimator');
const { createRedisConnection } = require('./redis');
const redis = createRedisConnection();

const CODEX_SESSIONS_DIR = path.join(
    process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    'sessions'
);

function findFilesRecursive(dir) {
    if (!fs.existsSync(dir)) return [];

    let files = [];

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            files = files.concat(findFilesRecursive(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            files.push(fullPath);
        };
    };

    return files;
};

function cleanupCodexSession(threadId) {
    if (!threadId) {
        console.log('[Codex Session] Thread ID not found');
        return false;
    };

    try {
        const files = findFilesRecursive(CODEX_SESSIONS_DIR);

        for (const file of files) {
            try {
                const firstLine = fs.readFileSync(file, 'utf8')
                    .split('\n')[0];

                const sessionMeta = JSON.parse(firstLine);

                if (
                    sessionMeta.type === 'session_meta' &&
                    sessionMeta.payload?.session_id === threadId
                ) {
                    fs.unlinkSync(file);

                    console.log(`[Codex Session Deleted] ${threadId}`);

                    return true;
                };

            } catch (err) {
                console.error(
                    `Session cleanup failed: ${err.message}`
                );
            };
        };

        console.log(`[Codex Session Not Found] ${threadId}`);

        return false;

    } catch (err) {
        console.error('Codex session cleanup error:', err.message);
        return false;
    };
};

function taskContext(task) {
    return { taskId: task.taskId, userId: task.userId, prompt: task.prompt };
};

async function emit(task, type, data) {
    const payload = { ...taskContext(task), ...data };
    await redis.publish(`codex-task:${task.taskId}`, JSON.stringify({ type, data: payload }));
};

async function executeTask(task) {
    let threadId = null;
    const { taskId } = task;
    const workspacePath = path.join(config.workspacesDir, taskId);
    fs.mkdirSync(workspacePath, { recursive: true });

    const startedAt = new Date();

    // First Emit estimate event so terminals show ETA before work begins
    if (task.estimatedMs || task.estimatedLabel) {
        await emit(task, 'task:estimate', {
            estimatedMs: task.estimatedMs,
            estimatedLabel: task.estimatedLabel,
            estimatedTokens: task.estimatedTokens || null,
            estimatedTokensLabel: task.estimatedTokensLabel || '',
            estimatedPrice: task.estimatedPrice || null,
            estimatedPriceLabel: task.estimatedPriceLabel || ''
        });
    };

    // Then update task status.
    await Task.updateOne({ taskId }, {
        $set: {
            status: 'PROCESSING',
            workspacePath,
            startedAt,
            output: '',
            outputSeq: 0,
            error: '',
        },
    });

    // Finally emit processing status.
    await emit(task, 'task:status', {
        status: 'PROCESSING',
        workspacePath,
        startedAt,
    });

    return new Promise(resolve => {
        let output = '';
        let seq = 0;
        let settled = false;
        let timedOut = false;
        let outputQueue = Promise.resolve();

        const child = spawn(config.codexBin, [
            'exec',
            '--json',
            '--color',
            'never',
            '--skip-git-repo-check',
            task.prompt
        ], {
            cwd: workspacePath,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        const append = (chunk, stream) => {
            const text = chunk.toString();
            outputQueue = outputQueue.then(async () => {
                seq += 1;
                output = (output + text).slice(-config.maxOutputChars);

                await Task.updateOne({ taskId }, { $set: { output, outputSeq: seq } });

                await emit(task, 'task:output', { stream, chunk: text, seq });
            }).catch(err => console.error(`Output write failed for ${taskId}:`, err.message));

            return outputQueue;
        };

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        }, config.codexTimeoutMs);

        let stdoutBuffer = '';

        function processCodexEvent(line) {
            if (!line.trim()) return;

            try {
                const event = JSON.parse(line);

                if (event.type === 'thread.started') {
                    threadId = event.thread_id;
                    task.threadId = event.thread_id;

                    Task.updateOne(
                        { taskId },
                        { $set: { threadId: event.thread_id } }
                    ).catch(console.error);

                    console.log(`[Codex Thread Created] ${event.thread_id}`);
                };

                // Only show Codex final/assistant messages.
                if (
                    event.type === 'item.completed' &&
                    event.item?.type === 'agent_message' &&
                    event.item.text
                ) {
                    append(Buffer.from(event.item.text + '\n'), 'stdout');
                };
            } catch (err) {
                console.error('Codex JSON parsing error:', err.message);
            };
        };

        child.stdout.on('data', chunk => {
            stdoutBuffer += chunk.toString();

            const lines = stdoutBuffer.split('\n');
            stdoutBuffer = lines.pop();

            for (const line of lines) {
                processCodexEvent(line);
            };
        });

        child.stderr.on('data', chunk => {
            // Keep actual CLI errors for debugging.
            console.error(`[Codex STDERR - ${taskId}] ${chunk.toString()}`);
        });

        child.on('error', async err => {
            if (settled) return;

            settled = true;
            clearTimeout(timer);

            await outputQueue;

            // Delete only the current task's Codex session
            console.log("threadId--------->", threadId);
            const sessionDeleted = threadId ? cleanupCodexSession(threadId, workspacePath) : false;
            console.log("sessionDeleted--------->", sessionDeleted);

            await Task.updateOne(
                { taskId },
                {
                    $set: {
                        sessionDeleted,
                    }
                }
            );

            const error = `Unable to start Codex CLI: ${err.message}`;

            output = (output + '\n' + error + '\n').slice(-config.maxOutputChars);
            seq += 1;

            await Task.updateOne({ taskId }, {
                $set: {
                    status: 'FAILED', output, outputSeq: seq, error, completedAt: new Date()
                },
            });

            await emit(task, 'task:status', {
                status: 'FAILED', error, outputSeq: seq, completedAt: new Date()
            });

            resolve();
        });

        child.on('close', async (code, signal) => {
            if (settled) return;

            if (stdoutBuffer.trim()) {
                processCodexEvent(stdoutBuffer);
                stdoutBuffer = '';
            };

            settled = true;
            clearTimeout(timer);

            await outputQueue;

            // Delete only the current task's Codex session
            const sessionDeleted = threadId ? cleanupCodexSession(threadId, workspacePath) : false;

            await Task.updateOne(
                { taskId },
                {
                    $set: {
                        sessionDeleted,
                    }
                }
            );

            const status = code === 0 && !timedOut ? 'COMPLETED' : 'FAILED';

            const error = timedOut ? `Codex timed out after ${config.codexTimeoutMs}ms.` :
                (code === 0 ? '' : `Codex exited with code ${code}${signal ? ` (${signal})` : ''}.`);

            if (error) {
                output = (output + '\n' + error + '\n').slice(-config.maxOutputChars);
                seq += 1;
            };

            // Calculate actual duration for timing comparison
            const completedAt = new Date();
            const actualMs = completedAt - startedAt;
            const actualLabel = formatDuration(actualMs);

            await Task.updateOne({ taskId }, {
                $set: {
                    status,
                    output,
                    outputSeq: seq,
                    exitCode: code,
                    error,
                    completedAt,
                },
            });

            await emit(task, 'task:status', {
                status,
                exitCode: code,
                error,
                workspacePath,
                outputSeq: seq,
                completedAt,
                actualMs,
                actualLabel,
                estimatedMs: task.estimatedMs || null,
                estimatedLabel: task.estimatedLabel || '',
                estimatedTokens: task.estimatedTokens || null,
                estimatedTokensLabel: task.estimatedTokensLabel || '',
                estimatedPrice: task.estimatedPrice || null,
                estimatedPriceLabel: task.estimatedPriceLabel || ''
            });

            resolve();
        });
    });
};

async function main() {
    await mongoose.connect(config.mongoUri);

    const worker = new Worker('codex-tasks', async job => {
        const task = await Task.findOne({ taskId: job.data.taskId }).lean();

        if (!task) {
            throw new Error(`Task not found: ${job.data.taskId}`);
        };

        await executeTask(task);
    }, { connection: redis, concurrency: config.concurrency });

    worker.on('completed', job => console.log(`Completed ${job.data.taskId}`));
    worker.on('failed', (job, err) => console.error(`Failed ${job?.data?.taskId}: ${err.message}`));

    console.log(`Codex worker started (concurrency: ${config.concurrency})`);
};

main().catch(err => { console.error('Worker startup failed:', err); process.exit(1); });