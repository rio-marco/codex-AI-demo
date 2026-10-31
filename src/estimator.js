const KEYWORD_ESTIMATES = [
    { pattern: /\b(create|build|implement|develop|design|write)\b/i, ms: 210000 },  // ~3.5 min
    { pattern: /\b(setup|scaffold|initialize|bootstrap)\b/i, ms: 180000 },  // ~3 min
    { pattern: /\b(dashboard|full.?stack|app(lication)?)\b/i, ms: 300000 },  // ~5 min
    { pattern: /\b(api|endpoint|route|server)\b/i, ms: 180000 },  // ~3 min
    { pattern: /\b(auth|login|signup|register)\b/i, ms: 200000 },  // ~3.3 min
    { pattern: /\b(verify|check|test|validate)\b/i, ms: 120000 },  // ~2 min
    { pattern: /\b(fix|patch|debug|repair)\b/i, ms: 150000 },  // ~2.5 min
    { pattern: /\b(update|modify|change|refactor)\b/i, ms: 150000 },  // ~2.5 min
    { pattern: /\b(delete|remove|clean)\b/i, ms: 90000 },   // ~1.5 min
    { pattern: /\b(react|vue|angular|frontend|ui|component)\b/i, ms: 240000 },  // ~4 min
    { pattern: /\b(database|mongo|sql|redis|migration)\b/i, ms: 180000 }   // ~3 min
];

const DEFAULT_ESTIMATE_MS = 180000; // ~3 min fallback
const BLEND_WEIGHT_HEURISTIC = 0.4;
const BLEND_WEIGHT_HISTORICAL = 0.6;

function promptComplexityFactor(prompt) {
    const words = prompt.trim().split(/\s+/).length;
    if (words <= 5) return 0.8;
    if (words <= 15) return 1.0;
    if (words <= 30) return 1.2;

    return 1.4;
};

function estimateTaskTime(prompt, historicalAvgMs) {
    // 1. Keyword-based heuristic
    let heuristicMs = 0;
    let matchCount = 0;

    for (const rule of KEYWORD_ESTIMATES) {
        if (rule.pattern.test(prompt)) {
            heuristicMs += rule.ms;
            matchCount += 1;
        };
    };

    if (matchCount === 0) {
        heuristicMs = DEFAULT_ESTIMATE_MS;
    } else {
        // Average matched keyword estimates, don't just sum
        heuristicMs = Math.round(heuristicMs / matchCount);
    };

    // 2. Apply prompt complexity factor
    heuristicMs = Math.round(heuristicMs * promptComplexityFactor(prompt));

    // 3. Blend with historical average if available
    let estimatedMs;
    let method;
    if (historicalAvgMs && historicalAvgMs > 0) {
        estimatedMs = Math.round(
            (BLEND_WEIGHT_HEURISTIC * heuristicMs) +
            (BLEND_WEIGHT_HISTORICAL * historicalAvgMs)
        );

        method = 'heuristic+historical';
    } else {
        estimatedMs = heuristicMs;
        method = 'heuristic';
    };

    // Clamp between 30 seconds and 15 minutes
    estimatedMs = Math.max(30000, Math.min(estimatedMs, 900000));

    return {
        estimatedMs,
        estimatedLabel: formatETA(estimatedMs),
        method
    };
};

function formatETA(ms) {
    const totalSec = Math.round(ms / 1000);

    if (totalSec < 60) {
        return `~${totalSec} sec`;
    };

    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;

    if (sec === 0) {
        return `~${min} min`;
    };

    return `~${min} min ${sec} sec`;
};

function formatDuration(ms) {
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 60) {
        return `${totalSec} sec`;
    };

    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (sec === 0) {
        return `${min} min`;
    };

    return `${min} min ${sec} sec`;
};

const TOKEN_ESTIMATES = [
    { pattern: /\b(create|build|implement|develop|design|write)\b/i, tokens: 12000 },
    { pattern: /\b(setup|scaffold|initialize|bootstrap)\b/i, tokens: 10000 },
    { pattern: /\b(dashboard|full.?stack|app(lication)?)\b/i, tokens: 25000 },
    { pattern: /\b(api|endpoint|route|server)\b/i, tokens: 10000 },
    { pattern: /\b(auth|login|signup|register)\b/i, tokens: 12000 },
    { pattern: /\b(verify|check|test|validate)\b/i, tokens: 6000 },
    { pattern: /\b(fix|patch|debug|repair)\b/i, tokens: 8000 },
    { pattern: /\b(update|modify|change|refactor)\b/i, tokens: 8000 },
    { pattern: /\b(delete|remove|clean)\b/i, tokens: 4000 },
    { pattern: /\b(react|vue|angular|frontend|ui|component)\b/i, tokens: 15000 },
    { pattern: /\b(database|mongo|sql|redis|migration)\b/i, tokens: 10000 }
];

const DEFAULT_TOKEN_ESTIMATE = 8000;

// Pricing per 1K tokens (OpenAI Codex / GPT-4o style)
const PRICE_PER_1K_INPUT = 0.003;
const PRICE_PER_1K_OUTPUT = 0.012;
const INPUT_TOKEN_RATIO = 0.10;  // ~10% of estimated tokens are input
const OUTPUT_TOKEN_RATIO = 0.90;  // ~90% are output (completion)

function estimateTaskTokens(prompt) {
    let heuristicTokens = 0;
    let matchCount = 0;

    for (const rule of TOKEN_ESTIMATES) {
        if (rule.pattern.test(prompt)) {
            heuristicTokens += rule.tokens;
            matchCount += 1;
        };
    };

    if (matchCount === 0) {
        heuristicTokens = DEFAULT_TOKEN_ESTIMATE;
    } else {
        heuristicTokens = Math.round(heuristicTokens / matchCount);
    };

    // Apply same prompt complexity factor
    heuristicTokens = Math.round(heuristicTokens * promptComplexityFactor(prompt));

    // Clamp between 1,000 and 50,000
    heuristicTokens = Math.max(1000, Math.min(heuristicTokens, 50000));

    return { estimatedTokens: heuristicTokens };
};

function estimateTaskPrice(estimatedTokens) {
    const inputTokens = estimatedTokens * INPUT_TOKEN_RATIO;
    const outputTokens = estimatedTokens * OUTPUT_TOKEN_RATIO;
    const price = (inputTokens / 1000) * PRICE_PER_1K_INPUT + (outputTokens / 1000) * PRICE_PER_1K_OUTPUT;

    return { estimatedPrice: Math.round(price * 10000) / 10000 }; // round to 4 decimals
};

function estimateTaskResources(prompt, historicalAvgMs) {
    const time = estimateTaskTime(prompt, historicalAvgMs);
    const tokens = estimateTaskTokens(prompt);
    const price = estimateTaskPrice(tokens.estimatedTokens);

    return {
        ...time,
        estimatedTokens: tokens.estimatedTokens,
        estimatedTokensLabel: formatTokens(tokens.estimatedTokens),
        estimatedPrice: price.estimatedPrice,
        estimatedPriceLabel: formatPrice(price.estimatedPrice)
    };
};

function formatTokens(tokens) {
    return `~${tokens.toLocaleString('en-US')} tokens`;
};

function formatPrice(price) {
    if (price < 0.01) {
        return `~$${price.toFixed(4)}`;
    };

    return `~$${price.toFixed(2)}`;
};

module.exports = {
    estimateTaskTime,
    estimateTaskResources,
    formatETA,
    formatDuration,
    formatTokens,
    formatPrice,
};