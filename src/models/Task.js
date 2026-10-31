const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  taskId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  prompt: { type: String, required: true },
  status: { type: String, enum: ['PENDING','PROCESSING','COMPLETED','FAILED'], default: 'PENDING', index: true },
  output: { type: String, default: '' },
  outputSeq: { type: Number, default: 0 },
  workspacePath: { type: String, default: '' },
  exitCode: { type: Number, default: null },
  error: { type: String, default: '' },
  estimatedMs: { type: Number, default: null },
  estimatedLabel: { type: String, default: '' },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null }
}, { timestamps: true });
module.exports = mongoose.model('Task', schema);
