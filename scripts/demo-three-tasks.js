#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
    const args = {};

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--api') {
            args.api = argv[++i];
        } else if (arg === '--out') {
            args.out = argv[++i];
        } else if (arg === '--timeout') {
            args.timeout = Number(argv[++i]);
        } else if (arg === '--help') {
            args.help = true;
        };
    };

    return args;
};

function usage() {
    process.stdout.write([
        'Usage: node scripts/demo-three-tasks.js [options]',
        '',
        'Starts the central terminal and three independent user terminals, then waits for all tasks.',
        'The server and worker must already be running.',
        '',
        'Options:',
        '  --api URL          Server URL (default: CODEX_API_URL or http://127.0.0.1:3030)',
        '  --out DIR          Directory for captured terminal logs (default: demo-output)',
        '  --timeout MS       Overall timeout (default: 900000)',
        ''
    ].join('\n'));
};

const args = parseArgs(process.argv.slice(2));
if (args.help) {
    usage();
    process.exit(0);
};

const api = args.api || process.env.CODEX_API_URL || `http://127.0.0.1:${process.env.PORT || 3030}`;
const outDir = path.resolve(args.out || 'demo-output');
const timeoutMs = Math.max(10000, Number(args.timeout || 900000));
fs.mkdirSync(outDir, { recursive: true });

const prompts = [
    { user: 'user-1', prompt: 'Create a Node.js register API' },
    { user: 'user-2', prompt: 'Create a Node.js login API' },
    { user: 'user-3', prompt: 'Create a Node.js forget-password API' },
];

function start(name, commandArgs, logFile) {
    const stream = fs.createWriteStream(logFile, { flags: 'w' });

    const child = spawn(process.execPath, commandArgs, {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, CODEX_API_URL: api, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
    child.on('exit', () => stream.end());

    return { name, child, logFile, stream };
};

function waitForExit(child) {
    return new Promise(resolve => {
        if (child.exitCode !== null) {
            return resolve(child.exitCode);
        };

        child.on('exit', code => resolve(code));
    });
};

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
};

async function main() {
    const centralLog = path.join(outDir, 'central-terminal.log');
    const since = new Date().toISOString();
    const central = start('central', ['scripts/central-terminal.js', '--layout', 'log', '--api', api, '--since', since], centralLog);
    process.stdout.write(`Central terminal log: ${centralLog}\n`);
    await delay(1200);

    const users = prompts.map((item, index) => {
        const logFile = path.join(outDir, `${item.user}.log`);

        const child = start(item.user, [
            'scripts/user-terminal.js', '--user', item.user, '--prompt', item.prompt, '--api', api
        ], logFile);
        process.stdout.write(`Started ${item.user} (${item.prompt}) -> ${logFile}\n`);

        return { ...item, child: child.child, logFile, index };
    });

    const timeout = new Promise(resolve => setTimeout(() => resolve('timeout'), timeoutMs));
    const result = await Promise.race([
        Promise.all(users.map(user => waitForExit(user.child))),
        timeout
    ]);

    if (result === 'timeout') {
        process.stderr.write(`Demo timed out after ${timeoutMs}ms; stopping child terminals.\n`);
        for (const user of users) {
            user.child.kill('SIGTERM');
        };
    };

    await delay(1500);
    central.child.kill('SIGTERM');
    await waitForExit(central.child);
    await delay(300);

    let failed = result === 'timeout';
    if (Array.isArray(result)) {
        result.forEach((code, index) => {
            process.stdout.write(`${users[index].user} exit code: ${code}\n`);
            if (code !== 0) {
                failed = true;
            };
        });
    };

    process.stdout.write(`\nCaptured output:\n`);
    process.stdout.write(`  ${centralLog}\n`);

    for (const user of users) {
        process.stdout.write(`  ${user.logFile}\n`);
    };

    process.stdout.write('\nCentral terminal transcript (last 240 lines):\n');

    const lines = fs.readFileSync(centralLog, 'utf8').split('\n');
    process.stdout.write(`${lines.slice(-240).join('\n')}\n`);
    process.exit(failed ? 1 : 0);
};

main().catch(err => {
    process.stderr.write(`Demo failed: ${err.stack || err.message}\n`);
    process.exit(1);
});