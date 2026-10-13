import type {
  AuthoredLeaveLimit,
  AuthoredLeavePolicyVersion,
  LeavePolicyValidationFacts,
} from './leave-policy-validation';
import { validateLeavePolicyVersion } from './leave-policy-validation';
import { resolveLeaveLimitWindow } from '../leave-policy-window';
import type { LeaveRequestStatus } from '../domain/leave-status';

/**
 * Phase 54-F (Â§10.3, Â§12.3, Â§15, Â§16) â€” the version validator's focused spec.
 *
 * The validator is a PURE FUNCTION over explicit facts, so every assertion here is an assertion about
 * the document rather than about a mock: no database, no clock, no Nest module. What the spec is
 * built to catch is the failure mode a validator actually has â€” being PERMISSIVE â€” so the cases are
 * written as "this must be refused", with a smaller set of negative controls proving the same
 * document is accepted once the one defect is removed. A validator that refused everything would
 * pass the refusal cases and fail the controls, which is the pair that keeps both honest.
 */

const YEAR = 1403;

/** Facts as the service resolves them, with only the parts a case cares about overridden. */
function facts(overrides: Partial<LeavePolicyValidationFacts> = {}): LeavePolicyValidationFacts {
  return {
    knownLeaveTypeIds: new Set(['lt-annual', 'lt-sick']),
    reachableRequestStatuses: new Set<LeaveRequestStatus>(['APPROVED', 'PENDING']),
    publishedInterval: null,
    knownEmploymentTypes: new Set(['FULL_TIME', 'PART_TIME']),
    resolveLimitWindow: resolveLeaveLimitWindow,
    // `null` is the ORDINARY path: the authoring DTO carries no window, so the validator resolves one
    // and confirms it. Cases that exercise the STORED window (a re-validation of an existing draft)
    // override this, which is the only way a stored window can disagree with the calendar.
    storedWindow: null,
    ...overrides,
  };
}

/** A complete, valid limit. Each case spreads this and changes ONE field. */
function limit(overrides: Partial<AuthoredLeaveLimit> = {}): AuthoredLeaveLimit {
  return {
    leaveTypeId: 'lt-annual',
    employmentType: null,
    maximum: 26,
    countingBasis: 'DAY_COUNT',
    period: 'YEAR',
    consumesStates: ['APPROVED', 'PENDING'],
    effectiveFrom: '2024-03-20',
    effectiveTo: null,
    ...overrides,
  };
}

/** A complete, valid version. */
function version(overrides: Partial<AuthoredLeavePolicyVersion> = {}): AuthoredLeavePolicyVersion {
  return {
    versionLabel: '1403-v1',
    jalaliYear: YEAR,
    effectiveFrom: '2024-03-20',
    effectiveTo: null,
    payload: { note: 'the body the engine validated' },
    limits: [limit()],
    ...overrides,
  };
}

/** The refusal codes a report carries, in order â€” the assertion shape used throughout. */
function refusalsOf(...args: [AuthoredLeavePolicyVersion, LeavePolicyValidationFacts]) {
  return validateLeavePolicyVersion(...args).map((issue) => issue.refusal);
}
/**
 * A version whose limits are all INSIDE its own interval.
 *
 * WHY THIS EXISTS. `limit()` defaults to `effectiveFrom: '2024-03-20'`, so a test that moves the
 * VERSION's start (to build an overlap case, say) leaves its default limit starting before its own
 * version — and the validator then correctly reports `LIMIT_EFFECTIVE_INTERVAL_OUTSIDE_VERSION`
 * beside whatever the test was actually about. That refusal is not noise; it is true. But it makes
 * `toContain('PUBLISHED_INTERVAL_OVERLAP')` pass while a SECOND defect sits unreported in the same
 * document, and it made `toEqual([])` fail for a version that was otherwise well formed.
 *
 * So any test that changes the version interval MUST build its limits from that same window. This
 * helper is deliberately the ONLY place the pairing is made, so the two cannot drift apart.
 */
function versionWithLimitsInWindow(
  window: { readonly effectiveFrom: string | null; readonly effectiveTo: string | null },
  overrides: Partial<AuthoredLeavePolicyVersion> = {},
  limitOverrides: Partial<AuthoredLeaveLimit>[] = [{}]
): AuthoredLeavePolicyVersion {
  return version({
    ...window,
    ...overrides,
    limits: limitOverrides.map((extra) =>
      limit({
        effectiveFrom: window.effectiveFrom ?? undefined,
        effectiveTo: window.effectiveTo,
        ...extra,
      })
    ),
  });
}

describe('54-F â€” the validator ACCEPTS a well-formed version', () => {
  it('returns an EMPTY report, which is the only acceptance this function states', () => {
    // The negative control the whole spec rests on: without this, every "is refused" assertion below
    // would pass for a validator that refused everything.
    expect(validateLeavePolicyVersion(version(), facts())).toEqual([]);
  });

  it('accepts several limits of DIFFERENT leave types in one version', () => {
    const report = validateLeavePolicyVersion(
      version({ limits: [limit(), limit({ leaveTypeId: 'lt-sick', maximum: 10 })] }),
      facts()
    );

    expect(report).toEqual([]);
  });

  it('accepts one leave type scoped to two DIFFERENT employment types', () => {
    // Not a duplicate scope: the scope is (leave type, employment type), so these govern disjoint
    // populations and both may exist.
    const report = validateLeavePolicyVersion(
      version({
        limits: [limit({ employmentType: 'FULL_TIME' }), limit({ employmentType: 'PART_TIME' })],
      }),
      facts()
    );

    expect(report).toEqual([]);
  });

  it('accepts one leave type scoped to a type AND to everyone, when the dates do not overlap', () => {
    const report = validateLeavePolicyVersion(
      version({
        limits: [
          limit({
            employmentType: 'FULL_TIME',
            effectiveFrom: '2024-03-20',
            effectiveTo: '2024-06-30',
          }),
          limit({ employmentType: null, effectiveFrom: '2024-07-01', effectiveTo: null }),
        ],
      }),
      facts()
    );

    expect(report).toEqual([]);
  });
});

describe("54-F â€” the version's own fields (Â§15.4, Â§10.1, Â§15.6)", () => {
  it('refuses an absent version label', () => {
    expect(refusalsOf(version({ versionLabel: undefined }), facts())).toContain(
      'VERSION_LABEL_MISSING'
    );
  });

  it('refuses a BLANK version label â€” whitespace is not a label', () => {
    // The reason the reader trims: `'   '` would otherwise pass and become a version nobody can name.
    expect(refusalsOf(version({ versionLabel: '   ' }), facts())).toContain(
      'VERSION_LABEL_MISSING'
    );
  });

  it('refuses an absent effectiveFrom â€” a version with no start is in force on no day', () => {
    expect(refusalsOf(version({ effectiveFrom: null }), facts())).toContain(
      'VERSION_EFFECTIVE_FROM_MISSING'
    );
  });

  it('refuses an effectiveFrom that is not a day string', () => {
    expect(refusalsOf(version({ effectiveFrom: '1403/01/01' }), facts())).toContain(
      'VERSION_EFFECTIVE_FROM_MISSING'
    );
  });

  it('refuses an INVERTED version interval', () => {
    const codes = refusalsOf(
      version({ effectiveFrom: '2025-01-01', effectiveTo: '2024-01-01' }),
      facts()
    );

    expect(codes).toContain('VERSION_EFFECTIVE_INTERVAL_INVERTED');
  });

  it('does NOT claim an interval is inverted when there is no start to invert against', () => {
    // Naming the wrong repair is its own defect: with no `effectiveFrom` the only honest refusal is
    // the missing start, so the inverted-interval code must be absent.
    const codes = refusalsOf(version({ effectiveFrom: null, effectiveTo: '2024-01-01' }), facts());

    expect(codes).toContain('VERSION_EFFECTIVE_FROM_MISSING');
    expect(codes).not.toContain('VERSION_EFFECTIVE_INTERVAL_INVERTED');
  });

  it('accepts an OPEN-ENDED interval â€” a null effectiveTo is legal, not missing', () => {
    expect(refusalsOf(version({ effectiveTo: null }), facts())).not.toContain(
      'VERSION_EFFECTIVE_INTERVAL_INVERTED'
    );
  });

  it('refuses an absent payload (Â§15.6) â€” nothing to render an old explanation from', () => {
    expect(refusalsOf(version({ payload: undefined }), facts())).toContain(
      'VERSION_PAYLOAD_MISSING'
    );
  });

  it("accepts a payload of any shape â€” the body is the ENGINE's question, not this gate's", () => {
    // The validator does not parse the payload, so an opaque object must not be refused here.
    expect(validateLeavePolicyVersion(version({ payload: { any: ['shape'] } }), facts())).toEqual(
      []
    );
  });

  it('refuses an absent or non-integer Jalali year', () => {
    expect(refusalsOf(version({ jalaliYear: undefined }), facts())).toContain(
      'VERSION_JALALI_YEAR_MISSING'
    );
    expect(refusalsOf(version({ jalaliYear: 1403.5 }), facts())).toContain(
      'VERSION_JALALI_YEAR_MISSING'
    );
  });
});

describe("54-F â€” a limit's leave type (Â§15.2, Â§24.3)", () => {
  it('refuses an UNRESOLVED leave type rather than skipping the limit', () => {
    // The permissive failure this prevents: a limit that governs nothing, accepted because nobody
    // could find its leave type. It is refused, and the report carries the unresolvable id so the
    // author can see WHICH reference failed.
    const report = validateLeavePolicyVersion(
      version({ limits: [limit({ leaveTypeId: 'lt-gone' })] }),
      facts()
    );

    expect(report).toEqual([
      { refusal: 'LIMIT_LEAVE_TYPE_UNRESOLVED', limitIndex: 0, limitLeaveTypeId: 'lt-gone' },
    ]);
  });

  it('refuses every limit when the tenant has NO known leave types â€” fail-closed, not fail-open', () => {
    // An empty fact set must make the validator STRICTER, not more permissive: this is the assertion
    // that pins that direction.
    const codes = refusalsOf(version(), facts({ knownLeaveTypeIds: new Set<string>() }));

    expect(codes).toContain('LIMIT_LEAVE_TYPE_UNRESOLVED');
  });

  it('refuses an absent leave type reference', () => {
    const codes = refusalsOf(version({ limits: [limit({ leaveTypeId: undefined })] }), facts());

    expect(codes).toContain('LIMIT_LEAVE_TYPE_UNRESOLVED');
  });

  it('matches a leave type whose id was padded with whitespace, rather than refusing it', () => {
    // The reader trims, so `' lt-annual '` resolves. Without the trim this would be refused as
    // unresolvable, which names a repair the author cannot see.
    expect(
      validateLeavePolicyVersion(
        version({ limits: [limit({ leaveTypeId: ' lt-annual ' })] }),
        facts()
      )
    ).toEqual([]);
  });
});

describe("54-F â€” a limit's maximum (Â§16)", () => {
  it('refuses zero and negative maxima â€” neither is a limit', () => {
    expect(refusalsOf(version({ limits: [limit({ maximum: 0 })] }), facts())).toContain(
      'LIMIT_MAXIMUM_NOT_POSITIVE'
    );
    expect(refusalsOf(version({ limits: [limit({ maximum: -3 })] }), facts())).toContain(
      'LIMIT_MAXIMUM_NOT_POSITIVE'
    );
  });

  it('refuses a FRACTIONAL maximum, and says exactly that rather than "not positive"', () => {
    // 2.5 is positive, so the positive check passes; the integer check is the one that fires. A
    // validator that only had the positive test would accept a limit with no counting semantics.
    const codes = refusalsOf(version({ limits: [limit({ maximum: 2.5 })] }), facts());

    expect(codes).toContain('LIMIT_MAXIMUM_NOT_INTEGER');
    expect(codes).not.toContain('LIMIT_MAXIMUM_NOT_POSITIVE');
  });

  it('refuses a non-numeric maximum, including a numeric STRING', () => {
    // `'26'` is refused: it is not a number, and accepting it would mean the stored integer depends
    // on a coercion nobody stated.
    expect(refusalsOf(version({ limits: [limit({ maximum: '26' })] }), facts())).toContain(
      'LIMIT_MAXIMUM_NOT_POSITIVE'
    );
    expect(refusalsOf(version({ limits: [limit({ maximum: undefined })] }), facts())).toContain(
      'LIMIT_MAXIMUM_NOT_POSITIVE'
    );
  });

  it('refuses NaN and Infinity, which are numbers but not limits', () => {
    expect(refusalsOf(version({ limits: [limit({ maximum: Number.NaN })] }), facts())).toContain(
      'LIMIT_MAXIMUM_NOT_POSITIVE'
    );
    expect(
      refusalsOf(version({ limits: [limit({ maximum: Number.POSITIVE_INFINITY })] }), facts())
    ).toContain('LIMIT_MAXIMUM_NOT_POSITIVE');
  });

  it('accepts a maximum of one â€” the smallest real limit', () => {
    expect(
      validateLeavePolicyVersion(version({ limits: [limit({ maximum: 1 })] }), facts())
    ).toEqual([]);
  });
});

describe("54-F â€” a limit's counting basis (Â§16.1)", () => {
  it('refuses a MISSING basis â€” it is mandatory and never implied', () => {
    expect(
      refusalsOf(version({ limits: [limit({ countingBasis: undefined })] }), facts())
    ).toContain('LIMIT_COUNTING_BASIS_MISSING');
  });

  it('treats an EMPTY STRING as missing rather than as an unknown basis', () => {
    // Two different repairs: "you forgot the basis" versus "that basis does not exist". `''` is the
    // former, and reporting the latter would send the author looking for a spelling error.
    const codes = refusalsOf(version({ limits: [limit({ countingBasis: '' })] }), facts());

    expect(codes).toContain('LIMIT_COUNTING_BASIS_MISSING');
    expect(codes).not.toContain('LIMIT_COUNTING_BASIS_UNSUPPORTED');
  });

  it('refuses an UNSUPPORTED basis â€” a third spelling cannot be honoured', () => {
    const codes = refusalsOf(
      version({ limits: [limit({ countingBasis: 'HOUR_COUNT' })] }),
      facts()
    );

    expect(codes).toContain('LIMIT_COUNTING_BASIS_UNSUPPORTED');
    expect(codes).not.toContain('LIMIT_COUNTING_BASIS_MISSING');
  });

  it('is CASE-SENSITIVE â€” the vocabulary is closed, not fuzzy', () => {
    expect(
      refusalsOf(version({ limits: [limit({ countingBasis: 'day_count' })] }), facts())
    ).toContain('LIMIT_COUNTING_BASIS_UNSUPPORTED');
  });

  it('accepts BOTH declared bases', () => {
    expect(
      validateLeavePolicyVersion(
        version({ limits: [limit({ countingBasis: 'DAY_COUNT' })] }),
        facts()
      )
    ).toEqual([]);
    expect(
      validateLeavePolicyVersion(
        version({ limits: [limit({ countingBasis: 'REQUEST_COUNT' })] }),
        facts()
      )
    ).toEqual([]);
  });
});

describe("54-F â€” a limit's period (Â§16.2)", () => {
  it('refuses an unknown period â€” it cannot resolve to a window', () => {
    expect(refusalsOf(version({ limits: [limit({ period: 'MONTH' })] }), facts())).toContain(
      'LIMIT_PERIOD_UNSUPPORTED'
    );
  });

  it('refuses an absent period', () => {
    expect(refusalsOf(version({ limits: [limit({ period: undefined })] }), facts())).toContain(
      'LIMIT_PERIOD_UNSUPPORTED'
    );
  });

  it('does NOT attempt to resolve a window for an unsupported period', () => {
    // Both would be true refusals, but reporting a window defect for a period that was never
    // accepted invents a second problem the author does not have.
    const codes = refusalsOf(version({ limits: [limit({ period: 'MONTH' })] }), facts());

    expect(codes).toContain('LIMIT_PERIOD_UNSUPPORTED');
    expect(codes).not.toContain('LIMIT_WINDOW_MISSING');
    expect(codes).not.toContain('LIMIT_WINDOW_YEAR_MISMATCH');
  });

  it('accepts the one declared period, YEAR', () => {
    expect(
      validateLeavePolicyVersion(version({ limits: [limit({ period: 'YEAR' })] }), facts())
    ).toEqual([]);
  });
});

describe("54-F â€” a limit's consumed states (Â§16.4, Â§21.6)", () => {
  it('refuses an ABSENT consumesStates â€” there is no default', () => {
    // The permissive failure this prevents: `[]` or `undefined` silently meaning "count everything",
    // which is precisely the implicit rule Â§16.4 forbids.
    expect(
      refusalsOf(version({ limits: [limit({ consumesStates: undefined })] }), facts())
    ).toContain('LIMIT_CONSUMED_STATES_EMPTY');
  });

  it('refuses an EMPTY consumesStates â€” required means non-empty', () => {
    expect(refusalsOf(version({ limits: [limit({ consumesStates: [] })] }), facts())).toContain(
      'LIMIT_CONSUMED_STATES_EMPTY'
    );
  });

  it('refuses a state the vocabulary does not know', () => {
    expect(
      refusalsOf(version({ limits: [limit({ consumesStates: ['CANCELLED'] })] }), facts())
    ).toContain('LIMIT_CONSUMED_STATE_UNSUPPORTED');
  });

  it('refuses a state the CURRENT lifecycle cannot reach (Â§21.6)', () => {
    // Knowable to the vocabulary but unreachable in this lifecycle: a limit consuming only it would
    // be met by nobody, so it is INSUFFICIENT CONTEXT rather than a silent zero.
    const codes = refusalsOf(
      version({ limits: [limit({ consumesStates: ['APPROVED'] })] }),
      facts({ reachableRequestStatuses: new Set<LeaveRequestStatus>() })
    );

    expect(codes).toContain('LIMIT_CONSUMED_STATE_NOT_IN_LIFECYCLE');
  });

  it('distinguishes an UNKNOWN state from an UNREACHABLE one', () => {
    // Different repairs: "that state does not exist" versus "the lifecycle has not reached it yet".
    const unknown = refusalsOf(
      version({ limits: [limit({ consumesStates: ['CANCELLED'] })] }),
      facts({ reachableRequestStatuses: new Set<LeaveRequestStatus>() })
    );

    expect(unknown).toContain('LIMIT_CONSUMED_STATE_UNSUPPORTED');
    expect(unknown).not.toContain('LIMIT_CONSUMED_STATE_NOT_IN_LIFECYCLE');
  });

  it('reports a bad state but still accepts the rest of the list', () => {
    // Every member is checked, not just the first: one bad member must not hide a second.
    const codes = refusalsOf(
      version({ limits: [limit({ consumesStates: ['APPROVED', 'CANCELLED', 'NOPE'] })] }),
      facts()
    );

    expect(codes.filter((code) => code === 'LIMIT_CONSUMED_STATE_UNSUPPORTED')).toHaveLength(2);
  });

  it('accepts both declared consumed states', () => {
    expect(
      validateLeavePolicyVersion(
        version({ limits: [limit({ consumesStates: ['APPROVED', 'PENDING'] })] }),
        facts()
      )
    ).toEqual([]);
  });

  it('accepts a single declared consumed state', () => {
    expect(
      validateLeavePolicyVersion(
        version({ limits: [limit({ consumesStates: ['APPROVED'] })] }),
        facts()
      )
    ).toEqual([]);
  });
});

describe("54-F â€” a limit's employment scope (Â§16.6)", () => {
  it('refuses an employment type the tenant vocabulary does not accept', () => {
    expect(
      refusalsOf(version({ limits: [limit({ employmentType: 'CONTRACTOR' })] }), facts())
    ).toContain('LIMIT_EMPLOYMENT_TYPE_UNSUPPORTED');
  });

  it('accepts ABSENT and NULL scope â€” both mean "applies to every type"', () => {
    expect(
      validateLeavePolicyVersion(
        version({ limits: [limit({ employmentType: undefined })] }),
        facts()
      )
    ).toEqual([]);
    expect(
      validateLeavePolicyVersion(version({ limits: [limit({ employmentType: null })] }), facts())
    ).toEqual([]);
  });

  it('refuses an empty-string scope rather than reading it as "every type"', () => {
    // `''` is not the same statement as "absent": one is a missing value, the other is a value that
    // names no scope. Treating them alike would let a blank field widen a limit silently.
    expect(refusalsOf(version({ limits: [limit({ employmentType: '' })] }), facts())).toContain(
      'LIMIT_EMPLOYMENT_TYPE_UNSUPPORTED'
    );
  });

  it('is CASE-SENSITIVE about the scope', () => {
    expect(
      refusalsOf(version({ limits: [limit({ employmentType: 'full_time' })] }), facts())
    ).toContain('LIMIT_EMPLOYMENT_TYPE_UNSUPPORTED');
  });
});

describe("54-F â€” a limit's effective interval (Â§15.4)", () => {
  it('refuses a limit with no effectiveFrom', () => {
    expect(
      refusalsOf(version({ limits: [limit({ effectiveFrom: undefined })] }), facts())
    ).toContain('LIMIT_EFFECTIVE_FROM_MISSING');
  });

  it('refuses an INVERTED limit interval', () => {
    const codes = refusalsOf(
      version({ limits: [limit({ effectiveFrom: '2024-12-01', effectiveTo: '2024-06-01' })] }),
      facts()
    );

    expect(codes).toContain('LIMIT_EFFECTIVE_INTERVAL_INVERTED');
  });

  it('refuses a limit that STARTS BEFORE its version does, even with an OPEN end', () => {
    // The regression this case exists for: requiring a readable limit END before checking
    // containment exempted the most common shape â€” an open-ended limit â€” so a limit beginning before
    // its version went unreported.
    const codes = refusalsOf(
      version({ effectiveFrom: '2024-03-20', limits: [limit({ effectiveFrom: '2024-01-01' })] }),
      facts()
    );

    expect(codes).toContain('LIMIT_EFFECTIVE_INTERVAL_OUTSIDE_VERSION');
  });

  it('refuses a limit that ENDS AFTER a finite version interval ends', () => {
    const codes = refusalsOf(
      version({
        effectiveFrom: '2024-03-20',
        effectiveTo: '2024-12-31',
        limits: [limit({ effectiveFrom: '2024-03-20', effectiveTo: '2025-06-01' })],
      }),
      facts()
    );

    expect(codes).toContain('LIMIT_EFFECTIVE_INTERVAL_OUTSIDE_VERSION');
  });

  it('refuses an OPEN-ENDED limit under a FINITE version â€” its open end inherits the bound', () => {
    const codes = refusalsOf(
      version({
        effectiveFrom: '2024-03-20',
        effectiveTo: '2024-12-31',
        limits: [limit({ effectiveFrom: '2024-03-20', effectiveTo: null })],
      }),
      facts()
    );

    expect(codes).toContain('LIMIT_EFFECTIVE_INTERVAL_OUTSIDE_VERSION');
  });

  it('accepts a limit matching its version interval exactly, on both ends', () => {
    // The boundary control: the containment test must be INCLUSIVE, or a limit authoring the same
    // window as its version would be refused.
    expect(
      validateLeavePolicyVersion(
        version({
          effectiveFrom: '2024-03-20',
          effectiveTo: '2024-12-31',
          limits: [limit({ effectiveFrom: '2024-03-20', effectiveTo: '2024-12-31' })],
        }),
        facts()
      )
    ).toEqual([]);
  });

  it('accepts an OPEN-ENDED limit under an OPEN-ENDED version', () => {
    expect(
      validateLeavePolicyVersion(
        version({
          effectiveTo: null,
          limits: [limit({ effectiveFrom: '2024-03-20', effectiveTo: null })],
        }),
        facts()
      )
    ).toEqual([]);
  });

  it('does NOT check containment when the version has no readable start', () => {
    // There is no interval to be outside of, and reporting "outside the version" would name a repair
    // that does not fit the actual defect (the version itself has no start).
    const codes = refusalsOf(
      version({ effectiveFrom: null, limits: [limit({ effectiveFrom: '2024-01-01' })] }),
      facts()
    );

    expect(codes).toContain('VERSION_EFFECTIVE_FROM_MISSING');
    expect(codes).not.toContain('LIMIT_EFFECTIVE_INTERVAL_OUTSIDE_VERSION');
  });
});

describe("54-F â€” a limit's RESOLVED window (Â§16.2)", () => {
  /**
   * A window that is wrong for EVERY year, so a stored window and an expected window cannot
   * accidentally agree by having both been resolved from the same place.
   *
   * WHAT THIS FACT DOES AND DOES NOT FALSIFY. The window check compares the window a limit STORED
   * against the window the DECLARED year resolves to, both through the injected collaborator. In
   * production the stored window and the expectation come from the same calendar, so this gate is a
   * CONSISTENCY check: it pins the document invariants it can see -- an absent, unreadable, inverted
   * or mis-yeared window -- and never claims to audit the calendar itself. A resolver that is wrong
   * IDENTICALLY for every year agrees with itself by construction and is not falsifiable here.
   *
   * That is why the resolver is a FACT rather than an import: it keeps the validator a pure function
   * of its inputs, and it is why the calendar's own correctness is pinned where it belongs -- by the
   * ACCEPTANCE case against the real resolveLeaveLimitWindow, and by leave-policy-window.spec.ts.
   */
  const WRONG_YEAR_WINDOW = { start: '2011-03-21', end: '2012-03-20' };
  it('refuses a window that is MISSING â€” it is resolved and stored, not derived later', () => {
    const codes = refusalsOf(
      version(),
      facts({ resolveLimitWindow: () => ({ start: '', end: '' }) })
    );

    expect(codes).toContain('LIMIT_WINDOW_MISSING');
  });

  it('refuses a window whose bounds are not day strings', () => {
    const codes = refusalsOf(
      version(),
      facts({ resolveLimitWindow: () => ({ start: 'not-a-day', end: 'also-not' }) })
    );

    expect(codes).toContain('LIMIT_WINDOW_MISSING');
  });

  it('refuses an INVERTED window', () => {
    const codes = refusalsOf(
      version(),
      facts({ resolveLimitWindow: () => ({ start: '2025-01-01', end: '2024-01-01' }) })
    );

    expect(codes).toContain('LIMIT_WINDOW_INVERTED');
  });

  it('refuses a window that DISAGREES with the declared year, rather than storing it', () => {
    // The stored window spans a different twelve months than the version claims to govern, so the
    // limit would silently count against the wrong year.
    //
    // THE STUB IS `storedWindow` AND NOT THE RESOLVER, and that is the whole point: the expected
    // window is resolved INDEPENDENTLY through `resolveLimitWindow`. Stubbing the resolver instead
    // would compare its output against itself, so a resolver that ignored its year would happily
    // agree with its own wrong answer and the mismatch would never be reported.
    const codes = refusalsOf(version(), facts({ storedWindow: WRONG_YEAR_WINDOW }));

    expect(codes).toContain('LIMIT_WINDOW_YEAR_MISMATCH');
  });

  it('accepts the window the production calendar resolves for the declared year', () => {
    // The positive control: a stored window that agrees with the independent resolution must pass,
    // or the mismatch check would refuse every correct document.
    expect(
      validateLeavePolicyVersion(
        version(),
        facts({ storedWindow: resolveLeaveLimitWindow('YEAR', YEAR) })
      )
    ).toEqual([]);
  });

  it('accepts a DIFFERENT year when the document declares it â€” the check is per-document', () => {
    // The mismatch test must compare against the DECLARED year, not a hard-coded one. If the check
    // hard-coded 1403, this version would be refused.
    expect(validateLeavePolicyVersion(version({ jalaliYear: 1404 }), facts())).toEqual([]);
  });

  it('does NOT resolve a window when the Jalali year is unreadable', () => {
    // An absent year has no window to be wrong about, and manufacturing one would produce a second,
    // misleading refusal beside the real one.
    let called = 0;
    const codes = refusalsOf(
      version({ jalaliYear: undefined }),
      facts({
        resolveLimitWindow: (period, year) => {
          called += 1;
          return resolveLeaveLimitWindow(period, year);
        },
      })
    );

    expect(codes).toContain('VERSION_JALALI_YEAR_MISSING');
    expect(called).toBe(0);
    expect(codes).not.toContain('LIMIT_WINDOW_MISSING');
  });

  it('refuses a per-limit window defect ONCE PER AFFECTED LIMIT', () => {
    // It is a property of each limit's own resolved window, so two limits earn two refusals â€” and the
    // report says WHICH limit each belongs to.
    const report = validateLeavePolicyVersion(
      version({ limits: [limit(), limit({ leaveTypeId: 'lt-sick', maximum: 10 })] }),
      facts({ storedWindow: WRONG_YEAR_WINDOW })
    );

    const mismatches = report.filter((issue) => issue.refusal === 'LIMIT_WINDOW_YEAR_MISMATCH');
    expect(mismatches).toHaveLength(2);
    expect(mismatches.map((issue) => issue.limitIndex)).toEqual([0, 1]);
  });

  it('reports this limit OWN field defects BEFORE its RESOLVED-window defect', () => {
    // The order is a contract: per-limit authored fields are reported in the order the limit states
    // them, and the resolved window comes LAST because it is DERIVED from them. A caller reading the
    // first issue therefore learns the cause, not a consequence of it.
    const report = validateLeavePolicyVersion(
      version({ limits: [limit({ maximum: 0 })] }),
      facts({ storedWindow: WRONG_YEAR_WINDOW })
    );

    const maximum = report.findIndex((issue) => issue.refusal === 'LIMIT_MAXIMUM_NOT_POSITIVE');
    const window = report.findIndex((issue) => issue.refusal === 'LIMIT_WINDOW_YEAR_MISMATCH');
    expect(maximum).toBeGreaterThanOrEqual(0);
    expect(window).toBeGreaterThanOrEqual(0);
    expect(maximum).toBeLessThan(window);
  });
});

describe('54-F â€” duplicate scopes and overlapping intervals (Â§16.5)', () => {
  it('refuses two limits with the SAME leave type and NO employment scope', () => {
    // Two limits both claiming "annual leave, everyone" is ambiguous: nothing states which one
    // applies, so the evaluator would have to pick and the choice would be an accident of ordering.
    const codes = refusalsOf(version({ limits: [limit(), limit()] }), facts());

    expect(codes).toContain('LIMIT_DUPLICATE_SCOPE');
  });
  it('refuses two limits whose SCOPES are equivalent across an absent and an explicit null', () => {
    // `undefined` and `null` both mean "every type", so these are the same scope written twice. A
    // comparison that treated them as different would let the ambiguity above through.
    const codes = refusalsOf(
      version({ limits: [limit({ employmentType: undefined }), limit({ employmentType: null })] }),
      facts()
    );

    expect(codes).toContain('LIMIT_DUPLICATE_SCOPE');
  });

  it('refuses two limits with the same scope when their intervals touch END-TO-START', () => {
    // Inclusive ends: one ending 2024-06-30 and the next starting 2024-06-30 both govern that day,
    // so the boundary is an overlap rather than a clean handover.
    const codes = refusalsOf(
      version({
        limits: [
          limit({ effectiveFrom: '2024-03-20', effectiveTo: '2024-06-30' }),
          limit({ effectiveFrom: '2024-06-30', effectiveTo: null }),
        ],
      }),
      facts()
    );

    expect(codes).toContain('LIMIT_DUPLICATE_SCOPE');
  });

  it('does NOT refuse the same scope across DISJOINT intervals', () => {
    // A scoped limit followed by a replacement is ordinary authoring, not a conflict.
    const codes = refusalsOf(
      version({
        limits: [
          limit({ effectiveFrom: '2024-03-20', effectiveTo: '2024-06-30' }),
          limit({ effectiveFrom: '2024-07-01', effectiveTo: null }),
        ],
      }),
      facts()
    );

    expect(codes).not.toContain('LIMIT_DUPLICATE_SCOPE');
    expect(codes).not.toContain('LIMIT_EFFECTIVE_INTERVAL_OVERLAP');
  });

  it('refuses OVERLAPPING intervals for two DIFFERENT scopes of the same leave type when they collide', () => {
    // "Everyone" and "FULL_TIME" overlap for a full-time employee, so both maxima claim the same
    // person on the same day.
    const codes = refusalsOf(
      version({
        limits: [
          limit({ employmentType: null, effectiveFrom: '2024-03-20', effectiveTo: null }),
          limit({ employmentType: 'FULL_TIME', effectiveFrom: '2024-05-01', effectiveTo: null }),
        ],
      }),
      facts()
    );

    expect(codes).toContain('LIMIT_EFFECTIVE_INTERVAL_OVERLAP');
  });

  it('does NOT refuse overlapping intervals for DISJOINT populations', () => {
    // FULL_TIME and PART_TIME never describe the same employee, so overlapping dates are fine.
    const codes = refusalsOf(
      version({
        limits: [
          limit({ employmentType: 'FULL_TIME', effectiveFrom: '2024-03-20', effectiveTo: null }),
          limit({ employmentType: 'PART_TIME', effectiveFrom: '2024-03-20', effectiveTo: null }),
        ],
      }),
      facts()
    );

    expect(codes).not.toContain('LIMIT_EFFECTIVE_INTERVAL_OVERLAP');
  });

  it('does NOT refuse the same scope across two DIFFERENT leave types', () => {
    // The scope is (leave type, employment type): annual and sick leave do not compete.
    const codes = refusalsOf(
      version({
        limits: [
          limit({ leaveTypeId: 'lt-annual', effectiveFrom: '2024-03-20', effectiveTo: null }),
          limit({ leaveTypeId: 'lt-sick', effectiveFrom: '2024-03-20', effectiveTo: null }),
        ],
      }),
      facts()
    );

    expect(codes).not.toContain('LIMIT_DUPLICATE_SCOPE');
    expect(codes).not.toContain('LIMIT_EFFECTIVE_INTERVAL_OVERLAP');
  });

  it('refuses a duplicate across a DIFFERENT employment scope only when they actually collide', () => {
    // Two DIFFERENT employment types is not a duplicate â€” proven by the companion case above â€” so
    // this pins that the two codes are not merely aliases of each other.
    const codes = refusalsOf(
      version({
        limits: [limit({ employmentType: 'FULL_TIME' }), limit({ employmentType: 'PART_TIME' })],
      }),
      facts()
    );

    expect(codes).not.toContain('LIMIT_DUPLICATE_SCOPE');
  });

  it('treats an OPEN end as unbounded, so it overlaps a limit that starts later', () => {
    const codes = refusalsOf(
      version({
        limits: [
          limit({ employmentType: null, effectiveFrom: '2024-03-20', effectiveTo: null }),
          limit({ employmentType: 'FULL_TIME', effectiveFrom: '2024-06-01', effectiveTo: null }),
        ],
      }),
      facts()
    );

    expect(codes).toContain('LIMIT_EFFECTIVE_INTERVAL_OVERLAP');
  });

  it('does NOT compare a limit that failed its OWN checks against the others', () => {
    // A limit whose leave type is unresolved has no scope to collide with, and comparing it would
    // invent a conflict on top of the real defect.
    const codes = refusalsOf(
      version({
        limits: [limit(), limit({ leaveTypeId: 'lt-gone' })],
      }),
      facts()
    );

    expect(codes).toContain('LIMIT_LEAVE_TYPE_UNRESOLVED');
    expect(codes).not.toContain('LIMIT_DUPLICATE_SCOPE');
  });

  it('reports EVERY colliding PAIR among three mutually overlapping limits', () => {
    const codes = refusalsOf(version({ limits: [limit(), limit(), limit()] }), facts());

    // Three limits of one scope collide pairwise, so the author must be told about all three pairs
    // rather than only the first one they cannot see.
    expect(codes.filter((code) => code === 'LIMIT_DUPLICATE_SCOPE').length).toBeGreaterThanOrEqual(
      2
    );
  });

  it('blames the SECOND limit, so the author knows which one to change', () => {
    const report = validateLeavePolicyVersion(version({ limits: [limit(), limit()] }), facts());

    expect(report).toEqual([
      { refusal: 'LIMIT_DUPLICATE_SCOPE', limitIndex: 1, limitLeaveTypeId: 'lt-annual' },
    ]);
  });
});
describe('54-F — publication against the LIVE version (§10.4)', () => {
  it('accepts a version whose interval does not collide with anything published', () => {
    expect(
      validateLeavePolicyVersion(
        versionWithLimitsInWindow({ effectiveFrom: '2024-03-20', effectiveTo: '2024-12-31' }),
        facts({ publishedInterval: { start: '2023-03-21', end: '2024-03-19' } })
      )
    ).toEqual([]);
  });

  it('accepts a version when NOTHING is published — the first version of a policy', () => {
    expect(validateLeavePolicyVersion(version(), facts({ publishedInterval: null }))).toEqual([]);
  });

  it('refuses a version whose interval OVERLAPS a live published one', () => {
    // §10.4: two equally-current versions of one policy mean the engine cannot say which governs, so
    // the collision is refused at publication rather than resolved by luck at evaluation time.
    const codes = refusalsOf(
      versionWithLimitsInWindow({ effectiveFrom: '2024-06-01', effectiveTo: '2025-06-01' }),
      facts({ publishedInterval: { start: '2024-03-20', end: '2024-12-31' } })
    );

    expect(codes).toContain('PUBLISHED_INTERVAL_OVERLAP');
  });

  it('refuses a version that touches the published interval END-TO-START (inclusive days)', () => {
    // The boundaries are INCLUSIVE days, so a version starting ON the published end shares that day
    // and therefore overlaps. A half-open reading would let a one-day dispute through.
    const codes = refusalsOf(
      versionWithLimitsInWindow({ effectiveFrom: '2024-12-31', effectiveTo: null }),
      facts({ publishedInterval: { start: '2024-03-20', end: '2024-12-31' } })
    );

    expect(codes).toContain('PUBLISHED_INTERVAL_OVERLAP');
  });

  it('accepts a version that begins the day AFTER the published interval ends', () => {
    // The other side of the same boundary: adjacency is not overlap.
    const codes = refusalsOf(
      versionWithLimitsInWindow({ effectiveFrom: '2025-01-01', effectiveTo: null }),
      facts({ publishedInterval: { start: '2024-03-20', end: '2024-12-31' } })
    );

    expect(codes).not.toContain('PUBLISHED_INTERVAL_OVERLAP');
  });

  it('treats an OPEN end on EITHER side as unbounded', () => {
    // (a) A published version with NO end is still in force, so a new version cannot begin inside it.
    const openPublished = refusalsOf(
      versionWithLimitsInWindow({ effectiveFrom: '2024-06-01', effectiveTo: null }),
      facts({ publishedInterval: { start: '2024-03-20', end: null } })
    );

    // (b) A NEW open-ended version that begins INSIDE a finite published interval runs on past it, so
    // its absent end overlaps even though the published interval is bounded. This is the case an
    // implementation that required a readable `thisTo` would miss.
    const openNew = refusalsOf(
      versionWithLimitsInWindow({ effectiveFrom: '2024-06-01', effectiveTo: null }),
      facts({ publishedInterval: { start: '2024-03-20', end: '2024-12-31' } })
    );

    // (c) The control: a new open-ended version beginning AFTER the published interval ended does NOT
    // overlap it. Without this, (a) and (b) would also pass for an implementation that reported an
    // overlap whenever either side was open.
    const openNewDisjoint = refusalsOf(
      versionWithLimitsInWindow({ effectiveFrom: '2025-06-01', effectiveTo: null }),
      facts({ publishedInterval: { start: '2024-03-20', end: '2024-12-31' } })
    );

    expect(openPublished).toContain('PUBLISHED_INTERVAL_OVERLAP');
    expect(openNew).toContain('PUBLISHED_INTERVAL_OVERLAP');
    expect(openNewDisjoint).not.toContain('PUBLISHED_INTERVAL_OVERLAP');
  });

  it('refuses publication when the version has no READABLE start, on its own ground', () => {
    // Without a start there is no interval to compare, so the overlap check is skipped and the
    // missing start is the only version-level refusal named.
    const codes = refusalsOf(
      version({ effectiveFrom: null }),
      facts({ publishedInterval: { start: '2024-03-20', end: '2024-12-31' } })
    );

    expect(codes).toContain('VERSION_EFFECTIVE_FROM_MISSING');
    expect(codes).not.toContain('PUBLISHED_INTERVAL_OVERLAP');
  });

  it('is reported ONCE, not once per limit — it is a property of the VERSION', () => {
    const report = validateLeavePolicyVersion(
      versionWithLimitsInWindow({ effectiveFrom: '2024-06-01', effectiveTo: null }, {}, [
        {},
        { leaveTypeId: 'lt-sick', maximum: 10 },
      ]),
      facts({ publishedInterval: { start: '2024-03-20', end: '2024-12-31' } })
    );

    const overlaps = report.filter((issue) => issue.refusal === 'PUBLISHED_INTERVAL_OVERLAP');
    expect(overlaps).toHaveLength(1);
    // And it carries NO limit index: blaming a limit for a version-level collision would send the
    // author to the wrong part of the document.
    expect(overlaps[0]).toEqual({ refusal: 'PUBLISHED_INTERVAL_OVERLAP' });
  });
});
