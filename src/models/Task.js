const mongoose = require('mongoose');
const schema = new mongoose.Schema(
    {
        taskId: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },
        userId: {
            type: String,
            required: true,
            index: true,
        },
        prompt: {
            type: String,
            required: true,
        },
        status: {
            type: String,
            enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'],
            default: 'PENDING',
            index: true,
        },
        output: {
            type: String,
            default: '',
        },
        outputSeq: {
            type: Number,
            default: 0,
        },
        workspacePath: {
            type: String,
            default: '',
        },
        exitCode: {
            type: Number,
            default: null,
        },
        error: {
            type: String,
            default: '',
        },
        estimatedMs: {
            type: Number,
            default: null,
        },
        estimatedLabel: {
            type: String,
            default: '',
        },
        estimatedTokens: {
            type: Number,
            default: null,
        },
        estimatedTokensLabel: {
            type: String,
            default: '',
        },
        estimatedPrice: {
            type: Number,
            default: null,
        },
        estimatedPriceLabel: {
            type: String,
            default: '',
        },
        threadId: {
            type: String,
            default: null
        },
        sessionDeleted: {
            type: Boolean,
            default: false
        },
        startedAt: {
            type: Date,
            default: null,
        },
        completedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
    },
);

module.exports = mongoose.model('Task', schema);