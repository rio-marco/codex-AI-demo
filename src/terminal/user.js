const { io } = require('socket.io-client');
const { OutputSanitizer, paint, statusColor, statusLabel, statusRank } = require('./output');

class UserTerminal {
    constructor(options = {}) {
        this.api = options.api || `http://127.0.0.1:${process.env.PORT || 3030}`;
        this.userId = options.userId;
        this.prompt = options.prompt || '';
        this.taskId = options.taskId || '';
        this.color = options.color !== false;
        this.sanitizer = new OutputSanitizer();
        this.lastSeq = 0;
        this.lastStatus = '';
        this.headerPrinted = false;
        this.estimatePrinted = false;
        this.ended = false;
        this.socket = null;
        this.estimatedMs = null;
        this.estimatedLabel = '';
        this.estimatedTokens = null;
        this.estimatedTokensLabel = '';
        this.estimatedPrice = null;
        this.estimatedPriceLabel = '';
        this.startedAt = null;
        this.estimator = options.estimator || null;
        this.createdByThisTerminal = false;
        this.startRequested = false;
    };

    async start() {
        process.stdout.write(`========== USER TERMINAL: ${this.userId} ==========\n`);
        process.stdout.write(`Connecting to ${this.api}\n`);
        this.socket = io(this.api, {
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionDelay: 1000
        });

        this.socket.on('connect', async () => {
            try {
                if (!this.taskId) {
                    this.createdByThisTerminal = true;
                    await this.createTask();
                };

                this.socket.emit('task:subscribe', {
                    taskId: this.taskId,
                    userId: this.userId,
                });
            } catch (err) {
                this.fail(`Unable to create task: ${err.message}`);
            };
        });

        this.socket.on('task:subscribed', () => {
            process.stdout.write(`Subscribed to ${this.taskId} as ${this.userId}\n`);
        });

        this.socket.on('task:snapshot', task => this.applySnapshot(task));
        this.socket.on('task:output', data => this.handleOutput(data));
        this.socket.on('task:status', data => this.handleStatus(data));
        this.socket.on('task:estimate', data => this.handleEstimate(data));
        this.socket.on('task:error', data => this.fail(data && data.message ? data.message : 'Task subscription failed.'));
        this.socket.on('connect_error', err => {
            process.stderr.write(`[${this.userId}] connection error: ${err.message}\n`);
        });
    };

    async createTask() {
        const response = await fetch(`${this.api}/api/tasks`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ userId: this.userId, prompt: this.prompt })
        });

        const body = await response.json();
        if (!response.ok || !body.success) {
            throw new Error(body.message || `HTTP ${response.status}`);
        };

        this.taskId = body.taskId;
        // Capture estimates from API response so they're available for printHeader
        if (body.estimatedMs) {
            this.estimatedMs = body.estimatedMs;
        };

        if (body.estimatedLabel) {
            this.estimatedLabel = body.estimatedLabel;
        };

        if (body.estimatedTokens) {
            this.estimatedTokens = body.estimatedTokens;
        };

        if (body.estimatedTokensLabel) {
            this.estimatedTokensLabel = body.estimatedTokensLabel;
        };
        if (body.estimatedPrice) {
            this.estimatedPrice = body.estimatedPrice;
        };

        if (body.estimatedPriceLabel) {
            this.estimatedPriceLabel = body.estimatedPriceLabel;
        };

        process.stdout.write(`Submitted task: ${this.taskId}\n`);
    };

    async startTask() {
        if (this.startRequested || this.ended) return;

        this.startRequested = true;

        try {
            const response = await fetch(`${this.api}/api/tasks/${this.taskId}/start`,
                {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json'
                    },
                    body: JSON.stringify({
                        userId: this.userId
                    }),
                },
            );

            const responseText = await response.text();

            let body;

            try {
                body = JSON.parse(responseText);
            } catch {
                throw new Error(`Invalid API response. HTTP ${response.status}. Response: ${responseText.slice(0, 200)}`);
            };

            if (!response.ok || !body.success) {
                throw new Error(body.message || `HTTP ${response.status}`);
            };
        } catch (err) {
            this.startRequested = false;
            this.fail(`Unable to start task: ${err.message}`);
        };
    };

    applySnapshot(task) {
        if (!task || task.taskId !== this.taskId) return;

        // Capture estimate from snapshot if available
        if (task.estimatedMs && !this.estimatedMs) {
            this.estimatedMs = task.estimatedMs;
            this.estimatedLabel = task.estimatedLabel || '';
        };

        if (task.estimatedTokens && !this.estimatedTokens) {
            this.estimatedTokens = task.estimatedTokens;
            this.estimatedTokensLabel = task.estimatedTokensLabel || '';
        };

        if (task.estimatedPrice && !this.estimatedPrice) {
            this.estimatedPrice = task.estimatedPrice;
            this.estimatedPriceLabel = task.estimatedPriceLabel || '';
        };

        // Fallback: compute estimate locally if server didn't provide one
        if (!this.estimatedMs && this.estimator && (task.prompt || this.prompt)) {
            const est = this.estimator(task.prompt || this.prompt, null);
            this.estimatedMs = est.estimatedMs;
            this.estimatedLabel = est.estimatedLabel;
            this.estimatedTokens = est.estimatedTokens;
            this.estimatedTokensLabel = est.estimatedTokensLabel;
            this.estimatedPrice = est.estimatedPrice;
            this.estimatedPriceLabel = est.estimatedPriceLabel;
        };

        if (task.startedAt && !this.startedAt) {
            this.startedAt = new Date(task.startedAt);
        };

        const hadHeader = this.headerPrinted;

        this.printHeader(task);

        if (this.createdByThisTerminal && !this.startRequested) {
            this.startTask();
        };

        const seq = Number(task.outputSeq || 0);
        if (seq > this.lastSeq || (!hadHeader && task.output)) {
            this.sanitizer = new OutputSanitizer();
            const clean = this.sanitizer.write(task.output || '');
            if (clean) {
                process.stdout.write(clean);
            };

            this.lastSeq = seq;
        };

        if (task.status) {
            this.updateStatus(task);
        };
    };

    printHeader(task) {
        if (this.headerPrinted) return;

        this.headerPrinted = true;

        const label = statusLabel(task.status || 'PENDING');

        this.lastStatus = task.status || 'PENDING';

        process.stdout.write(`\n[${this.userId}] [${this.taskId}] ${paint(label, statusColor(task.status), this.color)}\n`);
        process.stdout.write('--------------------------------------------\n');
        process.stdout.write(`Task: ${task.prompt || this.prompt}\n\n`);
        process.stdout.write('Estimate Response:\n');

        this.printEstimate();

        process.stdout.write('\n');
        process.stdout.write('Codex Response:\n');
    };

    printEstimate() {
        if (this.estimatePrinted) return;

        if (this.estimatedLabel || this.estimatedTokensLabel || this.estimatedPriceLabel) {
            this.estimatePrinted = true;
            if (this.estimatedLabel) {
                process.stdout.write(`${paint('⏱ Estimated Time:   ' + this.estimatedLabel, 'cyan', this.color)}\n`);
            };

            if (this.estimatedTokensLabel) {
                process.stdout.write(`${paint('🔢 Estimated Tokens: ' + this.estimatedTokensLabel, 'cyan', this.color)}\n`);
            };

            if (this.estimatedPriceLabel) {
                process.stdout.write(`${paint('💰 Estimated Price:  ' + this.estimatedPriceLabel, 'cyan', this.color)}\n`);
            };
        };
    };

    handleEstimate(data) {
        if (!data || data.taskId !== this.taskId) return;

        if (data.estimatedMs) {
            this.estimatedMs = data.estimatedMs;
        };

        if (data.estimatedLabel) {
            this.estimatedLabel = data.estimatedLabel;
        };

        if (data.estimatedTokens) {
            this.estimatedTokens = data.estimatedTokens;
        };

        if (data.estimatedTokensLabel) {
            this.estimatedTokensLabel = data.estimatedTokensLabel;
        };

        if (data.estimatedPrice) {
            this.estimatedPrice = data.estimatedPrice;
        };

        if (data.estimatedPriceLabel) {
            this.estimatedPriceLabel = data.estimatedPriceLabel;
        };

        if (data.startedAt) {
            this.startedAt = new Date(data.startedAt);
        };

        this.printEstimate();
    };

    handleOutput(data) {
        if (!data || data.taskId !== this.taskId) return;

        const seq = Number(data.seq || 0);

        if (seq && seq <= this.lastSeq) return;

        this.printHeader(data);

        const clean = this.sanitizer.write(data.chunk || '');
        if (!clean) return;

        if (seq) {
            this.lastSeq = seq;
        };
    };

    handleStatus(data) {
        if (!data || data.taskId !== this.taskId) return;

        this.printHeader(data);
        this.updateStatus(data);
    };

    updateStatus(task) {
        if (this.ended) return;

        if (task.status && statusRank(task.status) >= statusRank(this.lastStatus) && task.status !== this.lastStatus) {
            this.lastStatus = task.status;

            if (task.status !== 'COMPLETED' && task.status !== 'FAILED') {
                process.stdout.write(`[${this.userId}] [${this.taskId}] ${paint(statusLabel(task.status), statusColor(task.status), this.color)}\n`);
            };
        };

        if (task.status === 'COMPLETED' || task.status === 'FAILED') {
            this.ended = true;

            process.stdout.write('\n--------------------------------------------\n');
            process.stdout.write(`[${this.userId}] [${this.taskId}] ${paint(statusLabel(task.status), statusColor(task.status), this.color)}\n`);

            if (task.error) {
                process.stdout.write(`Error: ${task.error}\n`);
            };

            this.finish(task.status === 'COMPLETED' ? 0 : 1);
        };
    };

    fail(message) {
        if (this.ended) return;

        this.ended = true;
        process.stderr.write(`[${this.userId}] ${message}\n`);

        this.finish(1);
    };

    finish(code) {
        setTimeout(() => {
            if (this.socket) {
                this.socket.disconnect();
            };

            process.exit(code);
        }, 100);
    };
};

module.exports = { UserTerminal };