const {
    ANSI, OutputSanitizer, paint, statusColor, statusLabel, statusRank, terminalWidth
} = require('./output');

function nowStamp() {
    return new Date().toTimeString().slice(0, 8);
};

class CentralTerminal {
    constructor(options = {}) {
        this.layout = options.layout || 'sections';
        this.color = options.color !== false;
        this.maxLinesPerTask = Math.max(2, Number(options.maxLinesPerTask || 10));
        this.throttleMs = Math.max(0, Number(options.throttleMs || 80));
        this.sinceMs = options.since ? new Date(options.since).getTime() : 0;
        this.tasks = new Map();
        this.order = [];
        this.logBuffers = new Map();
        this.renderTimer = null;
        this.lastRenderAt = 0;
        this.headerPrinted = false;
        this.stopped = false;
    };

    start() {
        if (this.layout === 'sections') {
            if (process.stdout.isTTY) process.stdout.write('\x1b[?25l');
            this.renderNow();
        } else {
            this.printLogHeader();
        };
    };

    stop() {
        this.stopped = true;

        if (this.renderTimer) {
            clearTimeout(this.renderTimer);
            this.renderTimer = null;
        };

        if (this.layout === 'log') {
            for (const taskId of this.order) this.flushLogLine(taskId);
        };

        if (this.layout === 'sections' && process.stdout.isTTY) {
            process.stdout.write('\x1b[?25h\n');
        };
    };

    printLogHeader() {
        if (this.headerPrinted) return;

        this.headerPrinted = true;
        process.stdout.write('========== CODEX CENTRAL TERMINAL ==========\n');
        process.stdout.write('Live task output from every user. Lines are prefixed with user/task/stream.\n');
    };

    ensureTask(task) {
        const taskId = task.taskId;

        if (this.tasks.has(taskId)) {
            return this.tasks.get(taskId);
        };

        const state = {
            taskId,
            userId: task.userId || 'unknown-user',
            prompt: task.prompt || '',
            status: task.status || 'PENDING',
            output: '',
            outputSeq: 0,
            error: task.error || '',
            exitCode: task.exitCode ?? null,
            createdAt: task.createdAt || new Date().toISOString(),
            estimatedMs: task.estimatedMs || null,
            estimatedLabel: task.estimatedLabel || '',
            estimatedTokens: task.estimatedTokens || null,
            estimatedTokensLabel: task.estimatedTokensLabel || '',
            estimatedPrice: task.estimatedPrice || null,
            estimatedPriceLabel: task.estimatedPriceLabel || '',
            startedAt: task.startedAt || null,
            actualMs: null,
            actualLabel: '',
            sanitizer: new OutputSanitizer()
        };

        this.tasks.set(taskId, state);
        this.order.push(taskId);
        this.logBuffers.set(taskId, '');

        if (this.layout === 'log') {
            this.printTaskHeader(state);
        };

        return state;
    };

    printTaskHeader(state) {
        const status = statusLabel(state.status);
        const statusText = paint(status, statusColor(state.status), this.color);

        process.stdout.write(`\n[${state.userId}] [${state.taskId}] ${statusText}\n`);
        process.stdout.write('--------------------------------------------\n');
        process.stdout.write(`Task: ${state.prompt}\n`);

        if (state.estimatedLabel) {
            process.stdout.write(`${paint('\u23f1 Estimated Time:   ' + state.estimatedLabel, 'cyan', this.color)}\n`);
        };

        if (state.estimatedTokensLabel) {
            process.stdout.write(`${paint('\ud83d\udd22 Estimated Tokens: ' + state.estimatedTokensLabel, 'cyan', this.color)}\n`);
        };

        if (state.estimatedPriceLabel) {
            process.stdout.write(`${paint('\ud83d\udcb0 Estimated Price:  ' + state.estimatedPriceLabel, 'cyan', this.color)}\n`);
        };

        process.stdout.write('Codex Response:\n');
    };

    applySnapshot(tasks) {
        for (const task of tasks || []) {
            if (this.sinceMs) {
                const created = task.createdAt ? new Date(task.createdAt).getTime() : 0;
                if (created && created < this.sinceMs) continue;
            };

            this.applyTaskSnapshot(task);
        };

        this.scheduleRender(true);
    };

    applyTaskSnapshot(task) {
        const existed = this.tasks.has(task.taskId);
        const state = this.ensureTask(task);

        // Capture estimate from snapshot
        if (task.estimatedMs && !state.estimatedMs) {
            state.estimatedMs = task.estimatedMs;
            state.estimatedLabel = task.estimatedLabel || '';
        };

        if (task.estimatedTokens && !state.estimatedTokens) {
            state.estimatedTokens = task.estimatedTokens;
            state.estimatedTokensLabel = task.estimatedTokensLabel || '';
        };

        if (task.estimatedPrice && !state.estimatedPrice) {
            state.estimatedPrice = task.estimatedPrice;
            state.estimatedPriceLabel = task.estimatedPriceLabel || '';
        };

        if (task.startedAt && !state.startedAt) {
            state.startedAt = task.startedAt;
        };

        const snapshotSeq = Number(task.outputSeq || 0);
        if (!existed || snapshotSeq > state.outputSeq) {
            state.sanitizer = new OutputSanitizer();
            state.output = state.sanitizer.write(task.output || '');
            state.outputSeq = snapshotSeq;
            state.error = task.error || state.error;

            if (this.layout === 'log') {
                this.printSnapshotOutput(state);
                this.logBuffers.set(state.taskId, '');
            };
        };

        if (task.status && statusRank(task.status) >= statusRank(state.status)) {
            state.status = task.status;
        };

        state.error = task.error || state.error;
        state.exitCode = task.exitCode ?? state.exitCode;
    };

    printSnapshotOutput(state) {
        const text = state.output || '';
        if (!text) return;

        const lines = text.split('\n');
        if (lines.length && lines[lines.length - 1] === '') {
            lines.pop();
        };

        for (const line of lines) {
            this.printLogLine(state, line, 'output');
        };
    };

    handleCreated(task) {
        const state = this.ensureTask(task);

        // Capture estimate from task:created event
        if (task.estimatedMs && !state.estimatedMs) {
            state.estimatedMs = task.estimatedMs;
            state.estimatedLabel = task.estimatedLabel || '';
        };

        if (task.estimatedTokens && !state.estimatedTokens) {
            state.estimatedTokens = task.estimatedTokens;
            state.estimatedTokensLabel = task.estimatedTokensLabel || '';
        };

        if (task.estimatedPrice && !state.estimatedPrice) {
            state.estimatedPrice = task.estimatedPrice;
            state.estimatedPriceLabel = task.estimatedPriceLabel || '';
        };

        const previous = state.status;
        if (task.status && statusRank(task.status) >= statusRank(state.status)) {
            state.status = task.status;
        };

        if (this.layout === 'log' && state.status !== previous) {
            this.printLogStatus(state);
        };

        this.scheduleRender(true);
    };

    handleEstimate(data) {
        if (!data || !data.taskId) return;

        const state = this.ensureTask(data);

        if (data.estimatedMs) {
            state.estimatedMs = data.estimatedMs;
        };

        if (data.estimatedLabel) {
            state.estimatedLabel = data.estimatedLabel;
        };

        if (data.estimatedTokens) {
            state.estimatedTokens = data.estimatedTokens;
        };

        if (data.estimatedTokensLabel) {
            state.estimatedTokensLabel = data.estimatedTokensLabel;
        };

        if (data.estimatedPrice) {
            state.estimatedPrice = data.estimatedPrice;
        };

        if (data.estimatedPriceLabel) {
            state.estimatedPriceLabel = data.estimatedPriceLabel;
        };

        this.scheduleRender(true);
    };

    handleOutput(data) {
        if (!data || !data.taskId) return;

        const state = this.ensureTask(data);

        const seq = Number(data.seq || 0);
        if (seq && seq <= state.outputSeq) return;

        const sanitizer = state.sanitizer;
        const clean = sanitizer.write(data.chunk || '');

        state.output = (state.output + clean).slice(-500000);
        if (seq) {
            state.outputSeq = seq;
        };

        if (this.layout === 'log') {
            this.printLogChunk(state, clean, data.stream || 'stdout');
        };

        this.scheduleRender(false);
    };

    handleStatus(data) {
        if (!data || !data.taskId) return;

        const state = this.ensureTask(data);
        const previous = state.status;

        if (data.status && statusRank(data.status) >= statusRank(state.status)) {
            state.status = data.status;
        };

        if (data.error) {
            state.error = data.error;
        };

        if (data.exitCode !== undefined) {
            state.exitCode = data.exitCode;
        };

        if (data.outputSeq) {
            state.outputSeq = Math.max(state.outputSeq, Number(data.outputSeq));
        };

        if (data.startedAt) {
            state.startedAt = data.startedAt;
        };

        if (data.actualMs) {
            state.actualMs = data.actualMs;
        };

        if (data.actualLabel) {
            state.actualLabel = data.actualLabel;
        };

        if (data.estimatedMs && !state.estimatedMs) {
            state.estimatedMs = data.estimatedMs;
        };

        if (data.estimatedLabel && !state.estimatedLabel) {
            state.estimatedLabel = data.estimatedLabel;
        };

        if (data.estimatedTokens && !state.estimatedTokens) {
            state.estimatedTokens = data.estimatedTokens;
        };

        if (data.estimatedTokensLabel && !state.estimatedTokensLabel) {
            state.estimatedTokensLabel = data.estimatedTokensLabel;
        };

        if (data.estimatedPrice && !state.estimatedPrice) {
            state.estimatedPrice = data.estimatedPrice;
        };

        if (data.estimatedPriceLabel && !state.estimatedPriceLabel) {
            state.estimatedPriceLabel = data.estimatedPriceLabel;
        };

        if (this.layout === 'log') {
            this.flushLogLine(state.taskId);
            if (state.status !== previous) {
                this.printLogStatus(state);
            };
        };

        this.scheduleRender(true);
    };

    printLogChunk(state, clean, stream) {
        if (!clean) return;

        const combined = (this.logBuffers.get(state.taskId) || '') + clean;
        const parts = combined.split('\n');
        const remainder = parts.pop();

        for (const line of parts) {
            this.printLogLine(state, line, stream);
        };

        this.logBuffers.set(state.taskId, remainder);
    };

    printLogLine(state, line, stream) {
        const safe = line.replace(/\t/g, '    ');
        process.stdout.write(`[${nowStamp()}] [${state.userId}] [${state.taskId}] [${stream}] ${safe}\n`);
    };

    flushLogLine(taskId) {
        const state = this.tasks.get(taskId);
        const remainder = this.logBuffers.get(taskId) || '';

        if (!state || !remainder) return;

        this.printLogLine(state, remainder, 'stdout');
        this.logBuffers.set(taskId, '');
    };

    printLogStatus(state) {
        const label = statusLabel(state.status);
        const detail = state.error ? ` error="${state.error}"` : '';

        process.stdout.write(`[${nowStamp()}] [${state.userId}] [${state.taskId}] STATUS ${label}${detail}\n`);

        if (state.status === 'COMPLETED' || state.status === 'FAILED') {
            process.stdout.write('--------------------------------------------\n');
        };
    };

    scheduleRender(immediate) {
        if (this.layout !== 'sections' || this.stopped) return;

        if (immediate) {
            if (this.renderTimer) {
                clearTimeout(this.renderTimer);
                this.renderTimer = null;
            };

            this.renderNow();
            return;
        };

        if (this.renderTimer) return;

        const wait = Math.max(0, this.throttleMs - (Date.now() - this.lastRenderAt));

        this.renderTimer = setTimeout(() => {
            this.renderTimer = null;
            this.renderNow();
        }, wait);
    };

    renderNow() {
        if (this.layout !== 'sections') return;

        this.lastRenderAt = Date.now();
        const rows = Math.max(12, process.stdout.rows || 40);
        const width = terminalWidth();
        const chromeLines = 6;
        const available = Math.max(2, rows - 1 - (this.order.length * chromeLines));
        const outputLines = Math.max(1, Math.min(
            this.maxLinesPerTask,
            Math.floor(available / Math.max(1, this.order.length))
        ));

        const lines = [];
        const title = '========== CODEX CENTRAL TERMINAL ==========';
        lines.push(paint(title, 'cyan', this.color));

        if (this.order.length === 0) {
            lines.push('Waiting for tasks...');
        };

        for (const taskId of this.order) {
            const state = this.tasks.get(taskId);
            const label = statusLabel(state.status);
            const header = `[${state.userId}] [${state.taskId}] ${label}`;

            lines.push('');
            lines.push(paint(header, statusColor(state.status), this.color));
            lines.push('--------------------------------------------');
            lines.push(`Task: ${this.singleLine(state.prompt, width - 6)}`);

            if (state.estimatedLabel) {
                lines.push(paint('\u23f1 Estimated Time:   ' + state.estimatedLabel, 'cyan', this.color));
            };

            if (state.estimatedTokensLabel) {
                lines.push(paint('\ud83d\udd22 Estimated Tokens: ' + state.estimatedTokensLabel, 'cyan', this.color));
            };

            if (state.estimatedPriceLabel) {
                lines.push(paint('\ud83d\udcb0 Estimated Price:  ' + state.estimatedPriceLabel, 'cyan', this.color));
            };

            lines.push('Codex Response:');
            const output = this.tailLines(state.output, outputLines);
            if (output.omitted > 0) {
                lines.push(paint(`... ${output.omitted} earlier line(s) ...`, 'gray', this.color));
            };

            if (output.lines.length === 0) {
                lines.push(paint(state.status === 'PENDING' ? '(queued, waiting for Codex...)' : '(waiting for Codex output...)', 'gray', this.color));
            } else {
                for (const line of output.lines) {
                    lines.push(`  ${this.singleLine(line, width - 2)}`);
                };
            };

            if (state.error && !state.output.includes(state.error)) {
                lines.push(paint(`Error: ${this.singleLine(state.error, width - 9)}`, 'red', this.color));
            };

            lines.push('--------------------------------------------');
        };

        while (lines.length > rows) lines.pop();
        const body = lines.join('\n');
        if (process.stdout.isTTY) {
            process.stdout.write(`\x1b[H${body}${ANSI.reset}\x1b[J`);
        } else {
            process.stdout.write(`${body}\n`);
        };
    };

    singleLine(text, maxWidth) {
        const clean = String(text || '').replace(/\s+/g, ' ').trim();
        if (!maxWidth || clean.length <= maxWidth) {
            return clean;
        };

        return `${clean.slice(0, Math.max(0, maxWidth - 3))}...`;
    };

    tailLines(text, count) {
        const all = String(text || '').split('\n');

        while (all.length && all[all.length - 1] === '') {
            all.pop();
        };

        const omitted = Math.max(0, all.length - count);

        return {
            lines: all.slice(omitted),
            omitted,
        };
    };
};

module.exports = { CentralTerminal };