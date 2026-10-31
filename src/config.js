require('dotenv').config();
const path = require('path');
module.exports = {
  port: Number(process.env.PORT || 3030),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/codex_multi_user_demo',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  codexBin: process.env.CODEX_BIN || 'codex',
  concurrency: Math.max(1, Number(process.env.MAX_CONCURRENCY || 3)),
  codexTimeoutMs: Math.max(1000, Number(process.env.CODEX_TIMEOUT_MS || 600000)),
  maxOutputChars: Math.max(10000, Number(process.env.MAX_OUTPUT_CHARS || 500000)),
  workspacesDir: path.resolve(process.env.WORKSPACES_DIR || './workspaces')
};
