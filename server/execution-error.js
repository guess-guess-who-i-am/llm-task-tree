// Explicit JSON contract: Error.message/cause are non-enumerable, and each
// wrapper must preserve diagnostic identity rather than concatenate labels.
const fields = ['code','stage','failureCategory','causeCode','maintenanceOnly',
  'maintenanceIssues','nonMaintenanceBlockers','hookReports','hookEvent','hookSource',
  'review','workspacePath','threadId'];
export function executionErrorDetails(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return {};
  seen.add(error);
  const details = {};
  for (const field of fields) if (error[field] !== undefined) details[field] = error[field];
  if (error.cause && typeof error.cause === 'object' && !seen.has(error.cause)) {
    details.cause = {message: String(error.cause.message || error.cause), ...executionErrorDetails(error.cause, seen)};
  }
  return details;
}
