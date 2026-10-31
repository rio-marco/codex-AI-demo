/**
 * Task time estimator.
 *
 * Uses prompt keyword heuristics and optional historical averages to produce
 * an estimated completion time for a Codex task.
 */

// ---------------------------------------------------------------------------
// Keyword heuristics (milliseconds)
// ---------------------------------------------------------------------------

const KEYWORD_ESTIMATES = [
  { pattern: /\b(create|build|implement|develop|design|write)\b/i, ms: 210000 },  // ~3.5 min
  { pattern: /\b(setup|scaffold|initialize|bootstrap)\b/i,        ms: 180000 },  // ~3 min
  { pattern: /\b(dashboard|full.?stack|app(lication)?)\b/i,        ms: 300000 },  // ~5 min
  { pattern: /\b(api|endpoint|route|server)\b/i,                   ms: 180000 },  // ~3 min
  { pattern: /\b(auth|login|signup|register)\b/i,                  ms: 200000 },  // ~3.3 min
  { pattern: /\b(verify|check|test|validate)\b/i,                  ms: 120000 },  // ~2 min
  { pattern: /\b(fix|patch|debug|repair)\b/i,                      ms: 150000 },  // ~2.5 min
  { pattern: /\b(update|modify|change|refactor)\b/i,               ms: 150000 },  // ~2.5 min
  { pattern: /\b(delete|remove|clean)\b/i,                         ms: 90000 },   // ~1.5 min
  { pattern: /\b(react|vue|angular|frontend|ui|component)\b/i,     ms: 240000 },  // ~4 min
  { pattern: /\b(database|mongo|sql|redis|migration)\b/i,          ms: 180000 }   // ~3 min
];

const DEFAULT_ESTIMATE_MS = 180000; // ~3 min fallback
const BLEND_WEIGHT_HEURISTIC = 0.4;
const BLEND_WEIGHT_HISTORICAL = 0.6;

// ---------------------------------------------------------------------------
// Prompt complexity factor
// ---------------------------------------------------------------------------

function promptComplexityFactor(prompt) {
  const words = prompt.trim().split(/\s+/).length;
  if (words <= 5) return 0.8;
  if (words <= 15) return 1.0;
  if (words <= 30) return 1.2;
  return 1.4;
}

// ---------------------------------------------------------------------------
// Core estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the time a task will take.
 *
 * @param {string} prompt              The task prompt.
 * @param {number|null} historicalAvgMs  Average duration of past completed tasks (ms), or null.
 * @returns {{ estimatedMs: number, estimatedLabel: string, method: string }}
 */
function estimateTaskTime(prompt, historicalAvgMs) {
  // 1. Keyword-based heuristic
  let heuristicMs = 0;
  let matchCount = 0;
  for (const rule of KEYWORD_ESTIMATES) {
    if (rule.pattern.test(prompt)) {
      heuristicMs += rule.ms;
      matchCount += 1;
    }
  }
  if (matchCount === 0) {
    heuristicMs = DEFAULT_ESTIMATE_MS;
  } else {
    // Average matched keyword estimates, don't just sum
    heuristicMs = Math.round(heuristicMs / matchCount);
  }

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
  }

  // Clamp between 30 seconds and 15 minutes
  estimatedMs = Math.max(30000, Math.min(estimatedMs, 900000));

  return {
    estimatedMs,
    estimatedLabel: formatETA(estimatedMs),
    method
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format milliseconds into a human-readable ETA string.
 * @param {number} ms
 * @returns {string}  e.g. "~30 sec", "~2 min", "~3 min 30 sec"
 */
function formatETA(ms) {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `~${totalSec} sec`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (sec === 0) return `~${min} min`;
  return `~${min} min ${sec} sec`;
}

/**
 * Format a duration in milliseconds into a precise human-readable string.
 * @param {number} ms
 * @returns {string}  e.g. "2 min 34 sec", "45 sec"
 */
function formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec} sec`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (sec === 0) return `${min} min`;
  return `${min} min ${sec} sec`;
}

module.exports = { estimateTaskTime, formatETA, formatDuration };
