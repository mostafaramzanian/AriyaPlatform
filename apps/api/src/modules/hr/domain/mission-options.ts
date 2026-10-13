/**
 * Phase 55: Mission option catalogue and fact derivation.
 *
 * WHY NO IMPORTS
 * --------------
 * Which options are selected and what facts they represent is a pure rule over
 * data shapes. No database is needed to test it.
 *
 * WHY FACTS ARE DERIVED, NOT REQUESTED AS INPUT
 * ---------------------------------------------
 * `MissionRequest` stores `durationMode`, `locationType` and `engagementType`.
 * Those three values are the SELECTIONS, translated once. Re-asking the caller
 * for them would let the body contradict the selected options.
 *
 * NO PROJECT LOOKUP
 * -----------------
 * `PROJECT` / `NON_PROJECT` is classification only. No `Project` model,
 * foreign key, membership or metadata is consulted here.
 */

export type MissionDurationMode = 'HOURLY' | 'DAILY';
export type MissionLocationType = 'IN_CITY' | 'OUT_OF_CITY';
export type MissionEngagementType = 'PROJECT' | 'NON_PROJECT';

export type MissionFacts = {
  readonly durationMode: MissionDurationMode;
  readonly locationType: MissionLocationType;
  readonly engagementType: MissionEngagementType;
};

export type MissionOptionSelection = {
  readonly groupCode: string;
  readonly optionCode: string;
};

export type MissionOptionDefinition = {
  readonly code: string;
  readonly active: boolean;
};

export type MissionOptionGroupDefinition = {
  readonly code: string;
  readonly required: boolean;
  readonly options: readonly MissionOptionDefinition[];
};

export type MissionOptionValidationResult =
  | { readonly ok: true; readonly facts: MissionFacts }
  | { readonly ok: false; readonly reason: string };

const MISSION_FACT_GROUPS: Readonly<Record<string, keyof MissionFacts>> = {
  DURATION: 'durationMode',
  LOCATION: 'locationType',
  ENGAGEMENT: 'engagementType',
};

const MISSION_FACT_OPTIONS: Readonly<Record<string, Record<string, string>>> = {
  DURATION: { HOURLY: 'HOURLY', DAILY: 'DAILY' },
  LOCATION: { IN_CITY: 'IN_CITY', OUT_OF_CITY: 'OUT_OF_CITY' },
  ENGAGEMENT: { PROJECT: 'PROJECT', NON_PROJECT: 'NON_PROJECT' },
};

function trim(code: string): string {
  return code.trim();
}

/**
 * Validate selected options and derive the Mission facts they encode.
 *
 * Rules:
 *   - one selection per group (no duplicates for the same group)
 *   - each selected option must belong to its stated group
 *   - inactive options cannot be selected
 *   - every required group must have exactly one selection
 *   - optional groups may be absent
 */
export function validateMissionOptionSelections(
  selections: readonly MissionOptionSelection[],
  groupDefinitions: readonly MissionOptionGroupDefinition[]
): MissionOptionValidationResult {
  const seenGroups = new Set<string>();
  const facts: Partial<MissionFacts> = {};

  for (const selection of selections) {
    const groupCode = trim(selection.groupCode);
    const optionCode = trim(selection.optionCode);

    if (seenGroups.has(groupCode)) {
      return { ok: false, reason: 'duplicate-group-selection' };
    }
    seenGroups.add(groupCode);

    const group = groupDefinitions.find((g) => g.code === groupCode);
    if (!group) {
      return { ok: false, reason: 'unknown-option-group' };
    }

    const option = group.options.find((o) => o.code === optionCode);
    if (!option) {
      return { ok: false, reason: 'option-not-in-group' };
    }
    if (!option.active) {
      return { ok: false, reason: 'inactive-option-selected' };
    }

    const factKey = MISSION_FACT_GROUPS[groupCode];
    const factValue = MISSION_FACT_OPTIONS[groupCode]?.[optionCode] as string | undefined;
    if (!factKey || !factValue) {
      return { ok: false, reason: 'unmapped-option' };
    }

    (facts as Record<string, string>)[factKey] = factValue;
  }

  for (const group of groupDefinitions) {
    if (group.required && !seenGroups.has(group.code)) {
      return { ok: false, reason: 'missing-required-group' };
    }
  }

  if (!facts.durationMode || !facts.locationType || !facts.engagementType) {
    return { ok: false, reason: 'missing-required-group' };
  }

  return {
    ok: true,
    facts: {
      durationMode: facts.durationMode,
      locationType: facts.locationType,
      engagementType: facts.engagementType,
    },
  };
}
