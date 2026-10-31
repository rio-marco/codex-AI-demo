const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const config = require('./config');
const Task = require('./models/Task');
const { estimateTaskTime } = require('./estimator');
const { taskQueue, connection: queueRedis } = require('./queue');
const { createRedisConnection } = require('./redis');

const CENTRAL_ROOM = 'codex-central';
const TASK_FIELDS = {
  taskId: 1, userId: 1, prompt: 1, status: 1, output: 1, outputSeq: 1,
  workspacePath: 1, exitCode: 1, error: 1, estimatedMs: 1, estimatedLabel: 1,
  startedAt: 1, completedAt: 1, createdAt: 1, updatedAt: 1
};

function publicTask(task) {
  return {
    taskId: task.taskId,
    userId: task.userId,
    prompt: task.prompt,
    status: task.status,
    output: task.output || '',
    outputSeq: task.outputSeq || 0,
    workspacePath: task.workspacePath || '',
    exitCode: task.exitCode ?? null,
    error: task.error || '',
    estimatedMs: task.estimatedMs ?? null,
    estimatedLabel: task.estimatedLabel || '',
    startedAt: task.startedAt || null,
    completedAt: task.completedAt || null,
    createdAt: task.createdAt || null,
    updatedAt: task.updatedAt || null
  };
}

async function main() {
  await mongoose.connect(config.mongoUri);
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (req, res) => res.json({ success: true }));

  app.post('/api/tasks', async (req, res) => {
    try {
      const { userId, prompt } = req.body || {};
      if (typeof userId !== 'string' || !userId.trim() || typeof prompt !== 'string' || !prompt.trim()) {
        return res.status(400).json({ success: false, message: 'userId and prompt are required strings.' });
      }
      const taskId = `TASK-${crypto.randomUUID()}`;

      // Compute ETA from heuristic + historical average
      let historicalAvgMs = null;
      try {
        const stats = await Task.aggregate([
          { $match: { status: 'COMPLETED', startedAt: { $ne: null }, completedAt: { $ne: null } } },
          { $project: { duration: { $subtract: ['$completedAt', '$startedAt'] } } },
          { $group: { _id: null, avg: { $avg: '$duration' } } }
        ]);
        if (stats.length && stats[0].avg > 0) historicalAvgMs = stats[0].avg;
      } catch (_) { /* ignore aggregation errors */ }
      const estimate = estimateTaskTime(prompt.trim(), historicalAvgMs);

      const task = await Task.create({
        taskId,
        userId: userId.trim(),
        prompt: prompt.trim(),
        estimatedMs: estimate.estimatedMs,
        estimatedLabel: estimate.estimatedLabel
      });
      try {
        await taskQueue.add('execute-codex', { taskId }, {
          jobId: taskId, removeOnComplete: 100, removeOnFail: 100
        });
      } catch (err) {
        await Task.updateOne({ taskId }, { $set: { status: 'FAILED', error: err.message, completedAt: new Date() } });
        throw err;
      }
      const created = publicTask(task.toObject());
      io.to(CENTRAL_ROOM).emit('task:created', created);
      return res.status(202).json({
        success: true, taskId, status: task.status,
        estimatedMs: estimate.estimatedMs,
        estimatedLabel: estimate.estimatedLabel
      });
    } catch (err) {
      console.error('Create task error:', err.message);
      return res.status(500).json({ success: false, message: 'Unable to create task.' });
    }
  });

  app.get('/api/tasks/:taskId', async (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ success: false, message: 'userId query parameter is required.' });
    const task = await Task.findOne({ taskId: req.params.taskId, userId }, TASK_FIELDS).lean();
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
    return res.json({ success: true, task: publicTask(task) });
  });

  app.get('/api/tasks/:taskId/output', async (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ success: false, message: 'userId query parameter is required.' });
    const task = await Task.findOne({ taskId: req.params.taskId, userId }, TASK_FIELDS).lean();
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
    return res.json({ success: true, ...publicTask(task) });
  });

  app.get('/api/central/tasks', async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const tasks = await Task.find({}, TASK_FIELDS).sort({ createdAt: -1 }).limit(limit).lean();
    tasks.reverse();
    return res.json({ success: true, tasks: tasks.map(publicTask) });
  });

  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' } });
  const subscriber = createRedisConnection();
  await subscriber.psubscribe('codex-task:*');
  subscriber.on('pmessage', (pattern, channel, message) => {
    try {
      const taskId = channel.slice('codex-task:'.length);
      const event = JSON.parse(message);
      io.to(taskId).emit(event.type, event.data);
      io.to(CENTRAL_ROOM).emit(event.type, event.data);
    } catch (err) {
      console.error('Redis event error:', err.message);
    }
  });

  io.on('connection', socket => {
    socket.on('task:subscribe', async ({ taskId, userId } = {}) => {
      if (!taskId || !userId) {
        socket.emit('task:error', { message: 'taskId and userId are required.' });
        return;
      }
      socket.join(taskId);
      const task = await Task.findOne({ taskId, userId }, TASK_FIELDS).lean();
      if (!task) {
        socket.leave(taskId);
        socket.emit('task:error', { message: 'Task not found for this user.' });
        return;
      }
      socket.emit('task:subscribed', { taskId });
      socket.emit('task:snapshot', publicTask(task));
    });

    socket.on('central:subscribe', async () => {
      socket.join(CENTRAL_ROOM);
      const tasks = await Task.find({}, TASK_FIELDS).sort({ createdAt: -1 }).limit(50).lean();
      tasks.reverse();
      socket.emit('central:subscribed', { room: CENTRAL_ROOM });
      socket.emit('central:snapshot', { tasks: tasks.map(publicTask) });
    });
  });

  server.listen(config.port, '0.0.0.0', () => {
    console.log(`API listening on port ${config.port}`);
    console.log('Start worker separately: npm run worker');
  });

  const shutdown = async () => {
    server.close();
    await subscriber.quit();
    await taskQueue.close();
    await queueRedis.quit();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
main().catch(err => { console.error('Server startup failed:', err); process.exit(1); });
