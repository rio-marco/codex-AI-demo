const IORedis = require('ioredis');
const { redisUrl } = require('./config');

function createRedisConnection() {
    return new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
};

module.exports = { createRedisConnection };