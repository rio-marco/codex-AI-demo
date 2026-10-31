#!/usr/bin/env node
const { UserTerminal } = require('../src/terminal/user');
const { estimateTaskTime } = require('../src/estimator');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--user') args.user = argv[++i];
    else if (arg === '--prompt') args.prompt = argv[++i];
    else if (arg === '--task') args.task = argv[++i];
    else if (arg === '--api') args.api = argv[++i];
    else if (arg === '--no-color') args.color = false;
    else if (arg === '--help') args.help = true;
  }
  return args;
}

function usage() {
  process.stdout.write([
    'Usage: node scripts/user-terminal.js --user USER_ID (--prompt PROMPT | --task TASK_ID) [options]',
    '',
    'Options:',
    '  --user ID          User identifier (required)',
    '  --prompt TEXT      Prompt to submit as a new task',
    '  --task ID          Attach to an existing task owned by the user',
    '  --api URL          Server URL (default: CODEX_API_URL or http://127.0.0.1:3030)',
    '  --no-color         Disable ANSI colors',
    ''
  ].join('\n'));
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.user || (!args.prompt && !args.task)) {
  usage();
  process.exit(args.help ? 0 : 1);
}

const terminal = new UserTerminal({
  api: args.api || process.env.CODEX_API_URL || `http://127.0.0.1:${process.env.PORT || 3030}`,
  userId: args.user,
  prompt: args.prompt,
  taskId: args.task,
  color: args.color !== false && !process.env.NO_COLOR && Boolean(process.stdout.isTTY),
  estimator: estimateTaskTime
});

terminal.start().catch(err => {
  process.stderr.write(`Unable to start user terminal: ${err.message}\n`);
  process.exit(1);
});
