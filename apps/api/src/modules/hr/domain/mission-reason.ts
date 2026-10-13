/**
 * Phase 55: Mission reason validation.
 *
 * WHY NO IMPORTS
 * --------------
 * A reason is a string with a length. The rule does not need a database.
 *
 * CORRECTION vs REJECTION
 * -----------------------
 * Correction and rejection reasons are MANDATORY when the act is performed.
 * Approval reasons remain OPTIONAL. Keeping the two mandatory paths distinct
 * prevents a blank rejection from being stored.
 */

/** Maximum length shared with `MissionRequest.correctionReason` and `rejectionReason`. */
export const MISSION_REASON_MAX_LENGTH = 500;

export type MissionReasonValidationResult =
  { readonly ok: true; readonly reason: string } | { readonly ok: false; readonly reason: string };

function trimReason(raw: string): string {
  return raw.replace(/^\s+|\s+$/g, '');
}

function validateMandatoryReason(raw: string | null | undefined): MissionReasonValidationResult {
  const value = raw === undefined || raw === null ? '' : trimReason(raw);

  if (value.length === 0) {
    return { ok: false, reason: 'reason-required' };
  }
  if (value.length > MISSION_REASON_MAX_LENGTH) {
    return { ok: false, reason: 'reason-too-long' };
  }
  return { ok: true, reason: value };
}

/** Validate a correction reason. Empty/whitespace-only values are rejected. */
export function validateMissionCorrectionReason(
  raw: string | null | undefined
): MissionReasonValidationResult {
  return validateMandatoryReason(raw);
}

/** Validate a rejection reason. Empty/whitespace-only values are rejected. */
export function validateMissionRejectionReason(
  raw: string | null | undefined
): MissionReasonValidationResult {
  return validateMandatoryReason(raw);
}

/**
 * Validate an optional approval reason.
 * Missing, empty or whitespace-only values are treated as no reason.
 * If a non-empty value is supplied it must fit the length limit.
 */
export function validateMissionApprovalReason(
  raw?: string | null
):
  | { readonly ok: true; readonly reason: string | null }
  | { readonly ok: false; readonly reason: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, reason: null };
  }
  const value = trimReason(raw);
  if (value.length === 0) {
    return { ok: true, reason: null };
  }
  if (value.length > MISSION_REASON_MAX_LENGTH) {
    return { ok: false, reason: 'reason-too-long' };
  }
  return { ok: true, reason: value };
}
