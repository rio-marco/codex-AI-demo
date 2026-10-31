const { Queue } = require('bullmq');
const { createRedisConnection } = require('./redis');

const connection = createRedisConnection();
const taskQueue = new Queue('codex-tasks', { connection });

module.exports = { taskQueue, connection };