export const CONTEXT_SOFT_THRESHOLD = 0.70;
export const CONTEXT_ROTATE_THRESHOLD = 0.90;

export function contextUsagePercent(value) {
  const percent = Number(value?.percent ?? value);
  return Number.isFinite(percent) ? Math.max(0, Math.min(1, percent)) : null;
}

export function contextPressureStatus(tokenUsage) {
  const percent = contextUsagePercent(tokenUsage);
  if (percent === null || percent < CONTEXT_SOFT_THRESHOLD) return "active";
  return percent >= CONTEXT_ROTATE_THRESHOLD ? "ready_to_rotate" : "near_limit";
}

export function automaticRotationReason({ tokenUsage = null, contextCompactions = 0 } = {}) {
  if (Number(contextCompactions) > 0) return "context_compaction";
  const percent = contextUsagePercent(tokenUsage);
  return percent !== null && percent >= CONTEXT_ROTATE_THRESHOLD ? "context_threshold" : "";
}
