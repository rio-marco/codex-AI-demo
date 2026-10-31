#!/usr/bin/env node
const { io } = require('socket.io-client');
const { CentralTerminal } = require('../src/terminal/central');

function parseArgs(argv) {
    const args = {};

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];

        if (arg === '--layout') {
            args.layout = argv[++i];
        } else if (arg === '--api') {
            args.api = argv[++i];
        } else if (arg === '--max-lines') {
            args.maxLines = Number(argv[++i]);
        } else if (arg === '--since') {
            args.since = argv[++i];
        } else if (arg === '--no-color') {
            args.color = false;
        } else if (arg === '--help') {
            args.help = true;
        };
    };

    return args;
};

function usage() {
    process.stdout.write([
        'Usage: node scripts/central-terminal.js [options]',
        '',
        'Options:',
        '  --api URL          Server URL (default: CODEX_API_URL or http://127.0.0.1:3030)',
        '  --layout MODE      sections (live dashboard, default on TTY) or log (append-only)',
        '  --max-lines N      Maximum output lines shown per task in sections mode',
        '  --since ISO_DATE   Only show tasks created at or after this time',
        '  --no-color         Disable ANSI colors',
        ''
    ].join('\n'));
};

const args = parseArgs(process.argv.slice(2));
if (args.help) {
    usage();
    process.exit(0);
};

const api = args.api || process.env.CODEX_API_URL || `http://127.0.0.1:${process.env.PORT || 3030}`;
const layout = args.layout || (process.stdout.isTTY ? 'sections' : 'log');
const terminal = new CentralTerminal({
    layout,
    color: args.color !== false && !process.env.NO_COLOR && Boolean(process.stdout.isTTY),
    maxLinesPerTask: args.maxLines || process.env.CENTRAL_MAX_LINES || 10,
    since: args.since
});

const socket = io(api, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000
});

socket.on('connect', () => {
    terminal.start();
    socket.emit('central:subscribe');
});

socket.on('central:subscribed', () => {
    if (layout === 'log') {
        process.stdout.write(`[${new Date().toTimeString().slice(0, 8)}] [central] connected to ${api}\n`);
    };
});

socket.on('central:snapshot', payload => terminal.applySnapshot(payload && payload.tasks));
socket.on('task:created', task => terminal.handleCreated(task));
socket.on('task:output', data => terminal.handleOutput(data));
socket.on('task:status', data => terminal.handleStatus(data));
socket.on('task:estimate', data => terminal.handleEstimate(data));

socket.on('connect_error', err => {
    if (layout === 'log') {
        process.stderr.write(`[central] connection error: ${err.message}\n`);
    };
});

let shuttingDown = false;
function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    terminal.stop();
    socket.disconnect();
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);