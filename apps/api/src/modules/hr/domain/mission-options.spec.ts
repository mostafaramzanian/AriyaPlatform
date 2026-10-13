import {
  type MissionOptionGroupDefinition,
  validateMissionOptionSelections,
} from './mission-options';

const GROUPS: readonly MissionOptionGroupDefinition[] = [
  {
    code: 'DURATION',
    required: true,
    options: [
      { code: 'HOURLY', active: true },
      { code: 'DAILY', active: true },
    ],
  },
  {
    code: 'LOCATION',
    required: true,
    options: [
      { code: 'IN_CITY', active: true },
      { code: 'OUT_OF_CITY', active: true },
    ],
  },
  {
    code: 'ENGAGEMENT',
    required: true,
    options: [
      { code: 'PROJECT', active: true },
      { code: 'NON_PROJECT', active: true },
    ],
  },
  {
    code: 'OPTIONAL',
    required: false,
    options: [{ code: 'X', active: true }],
  },
];

describe('HR domain — mission options', () => {
  it('accepts exactly one valid selection per required group and derives facts', () => {
    const result = validateMissionOptionSelections(
      [
        { groupCode: 'DURATION', optionCode: 'DAILY' },
        { groupCode: 'LOCATION', optionCode: 'OUT_OF_CITY' },
        { groupCode: 'ENGAGEMENT', optionCode: 'PROJECT' },
      ],
      GROUPS
    );

    expect(result).toEqual({
      ok: true,
      facts: {
        durationMode: 'DAILY',
        locationType: 'OUT_OF_CITY',
        engagementType: 'PROJECT',
      },
    });
  });

  it('rejects duplicate selection for the same group', () => {
    const result = validateMissionOptionSelections(
      [
        { groupCode: 'DURATION', optionCode: 'HOURLY' },
        { groupCode: 'DURATION', optionCode: 'DAILY' },
        { groupCode: 'LOCATION', optionCode: 'IN_CITY' },
        { groupCode: 'ENGAGEMENT', optionCode: 'NON_PROJECT' },
      ],
      GROUPS
    );

    expect(result).toEqual({ ok: false, reason: 'duplicate-group-selection' });
  });

  it('rejects a selected option that does not belong to the stated group', () => {
    const result = validateMissionOptionSelections(
      [
        { groupCode: 'DURATION', optionCode: 'DAILY' },
        { groupCode: 'LOCATION', optionCode: 'PROJECT' },
        { groupCode: 'ENGAGEMENT', optionCode: 'NON_PROJECT' },
      ],
      GROUPS
    );

    expect(result).toEqual({ ok: false, reason: 'option-not-in-group' });
  });

  it('rejects an inactive option', () => {
    const groups: MissionOptionGroupDefinition[] = [
      {
        code: 'DURATION',
        required: true,
        options: [{ code: 'HOURLY', active: false }],
      },
      { code: 'LOCATION', required: true, options: [{ code: 'IN_CITY', active: true }] },
      { code: 'ENGAGEMENT', required: true, options: [{ code: 'PROJECT', active: true }] },
    ];

    const result = validateMissionOptionSelections(
      [
        { groupCode: 'DURATION', optionCode: 'HOURLY' },
        { groupCode: 'LOCATION', optionCode: 'IN_CITY' },
        { groupCode: 'ENGAGEMENT', optionCode: 'PROJECT' },
      ],
      groups
    );

    expect(result).toEqual({ ok: false, reason: 'inactive-option-selected' });
  });

  it('rejects a missing required group', () => {
    const result = validateMissionOptionSelections(
      [
        { groupCode: 'DURATION', optionCode: 'DAILY' },
        { groupCode: 'LOCATION', optionCode: 'IN_CITY' },
      ],
      GROUPS
    );

    expect(result).toEqual({ ok: false, reason: 'missing-required-group' });
  });

  it('accepts an absent optional group', () => {
    const result = validateMissionOptionSelections(
      [
        { groupCode: 'DURATION', optionCode: 'DAILY' },
        { groupCode: 'LOCATION', optionCode: 'IN_CITY' },
        { groupCode: 'ENGAGEMENT', optionCode: 'NON_PROJECT' },
      ],
      GROUPS
    );

    expect(result.ok).toBe(true);
  });

  it('derives NON_PROJECT facts with no project metadata', () => {
    const result = validateMissionOptionSelections(
      [
        { groupCode: 'DURATION', optionCode: 'HOURLY' },
        { groupCode: 'LOCATION', optionCode: 'IN_CITY' },
        { groupCode: 'ENGAGEMENT', optionCode: 'NON_PROJECT' },
      ],
      GROUPS
    );

    if (!result.ok) fail('expected success');
    expect(result.facts.engagementType).toBe('NON_PROJECT');
    expect(Object.keys(result.facts)).toEqual(['durationMode', 'locationType', 'engagementType']);
  });
});
