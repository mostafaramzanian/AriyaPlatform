import { readFileSync } from 'fs';
import { join } from 'path';
import {
  WORKFLOW_VERSION_EDITABLE_STATUSES,
  WORKFLOW_VERSION_STATUSES,
  WORKFLOW_VERSION_TRANSITIONS,
  isWorkflowVersionEditable,
  isWorkflowVersionStatus,
  isWorkflowVersionTransitionAllowed,
  workflowVersionSourcesFor,
} from './workflow-status';
import type { WorkflowVersionStatus } from './workflow-status';

/**
 * Phase C1 Step M (§5.5, §6, gate I20): the version lifecycle, pinned TWICE — as §5.5's own members
 * and edges, and against the Prisma schema READ AS TEXT.
 *
 * WHY THE SCHEMA IS READ RATHER THAN IMPORTED
 * -------------------------------------------
 * The four strings below are the same four the schema's `WorkflowDefinitionVersionStatus` declares,
 * and nothing can make the two agree at compile time: a `.prisma` file is not a module, so no import
 * exists to type-check. The module's own doc says this spec is the reader that closes that gap —
 * "reads the Prisma schema as TEXT and fails if the two spellings ever diverge" — and this is that
 * reader. Without it, a member renamed in the schema would leave the pure module accepting a status
 * the database can no longer store, which is a defect no unit test of the module could see.
 *
 * THE EDGES ARE PINNED AS LITERALS, and that is deliberate: a test that derived the permitted moves
 * from `WORKFLOW_VERSION_TRANSITIONS` would prove only that the table equals itself. The three
 * edges here are §5.5's one-way door as the design records it, so an edge added or removed in code
 * alone fails.
 */

const SCHEMA_FILE = join(__dirname, '..', '..', '..', '..', 'prisma', 'commerce', 'schema.prisma');

/** The schema's `enum WorkflowDefinitionVersionStatus` block, split into member names. */
function schemaMembers(enumName: string): string[] {
  const schema = readFileSync(SCHEMA_FILE, 'utf8');
  const block = schema.match(new RegExp(`enum ${enumName} \\{([^}]*)\\}`));
  expect(block).not.toBeNull();

  return (block?.[1] ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('@@'));
}

describe('Phase C1 Step M — the version vocabulary and its edges', () => {
  it('declares exactly §5.5’s four states, in the section’s order', () => {
    expect(WORKFLOW_VERSION_STATUSES).toEqual(['DRAFT', 'VALIDATED', 'PUBLISHED', 'ARCHIVED']);
  });

  it('states the SAME four members as the schema, compared as text', () => {
    // Falsifiable in both directions: a member added, removed or renamed on either side fails —
    // and so does a member that only ever existed in a migration, because the enum the generated
    // client speaks is this block.
    expect(schemaMembers('WorkflowDefinitionVersionStatus')).toEqual([
      ...WORKFLOW_VERSION_STATUSES,
    ]);
  });

  it('narrows an arbitrary value with the guard, and refuses anything outside the vocabulary', () => {
    // Non-vacuity: the guard accepts every member and nothing else.
    for (const status of WORKFLOW_VERSION_STATUSES) {
      expect({ status, accepted: isWorkflowVersionStatus(status) }).toEqual({
        status,
        accepted: true,
      });
    }

    for (const value of ['PENDING', 'draft', '', null, undefined, 4, {}]) {
      expect({ value, accepted: isWorkflowVersionStatus(value) }).toEqual({
        value,
        accepted: false,
      });
    }
  });

  it('states ONE editable status, and the guard agrees for every member of the vocabulary', () => {
    expect(WORKFLOW_VERSION_EDITABLE_STATUSES).toEqual(['DRAFT']);

    const editable = WORKFLOW_VERSION_STATUSES.filter((status) =>
      isWorkflowVersionEditable(status)
    );
    // §6: "Configuration changes create new immutable versions" — a VALIDATED version is already
    // frozen, because an edit after the check would discard the verdict the row advertises.
    expect(editable).toEqual(['DRAFT']);
  });
});

describe('Phase C1 Step M — the version transition table', () => {
  it('is TOTAL over the vocabulary, so a fifth state cannot be silently unreachable', () => {
    // The `Record<WorkflowVersionStatus, …>` type makes this a compile error; the assertion is
    // what keeps the compile-time claim honest at runtime as well.
    expect(Object.keys(WORKFLOW_VERSION_TRANSITIONS).sort()).toEqual(
      [...WORKFLOW_VERSION_STATUSES].sort()
    );
  });

  it('permits exactly §5.5’s three edges, and refuses every other pair', () => {
    const legal = WORKFLOW_VERSION_STATUSES.flatMap((from) =>
      WORKFLOW_VERSION_STATUSES.filter(
        (to) => isWorkflowVersionTransitionAllowed(from, to) === true
      ).map((to) => `${from}->${to}`)
    );

    // The one-way door, edge by edge: publishing an unchecked version (DRAFT→PUBLISHED), archiving
    // a version that was never in force (VALIDATED→ARCHIVED) and reviving an archived one are all
    // ABSENT from this list rather than merely discouraged.
    expect(legal).toEqual(['DRAFT->VALIDATED', 'VALIDATED->PUBLISHED', 'PUBLISHED->ARCHIVED']);
  });

  it('refuses every self-transition, which is what makes a second publish impossible', () => {
    for (const status of WORKFLOW_VERSION_STATUSES) {
      expect({
        status,
        allowed: isWorkflowVersionTransitionAllowed(status, status),
      }).toEqual({ status, allowed: false });
    }
  });

  it('answers `null` — never `false` — for a status outside the vocabulary', () => {
    // The distinction is the module's own contract: `false` means "the lifecycle forbids this
    // move", `null` means "there is no such state". Collapsing them would report a row carrying an
    // unrecognized status as an illegal transition instead of as the data defect it is.
    expect(isWorkflowVersionTransitionAllowed('PENDING', 'VALIDATED')).toBeNull();
    expect(isWorkflowVersionTransitionAllowed('DRAFT', 'PENDING')).toBeNull();
    expect(isWorkflowVersionTransitionAllowed('PENDING', 'PENDING')).toBeNull();
  });

  it('derives the acceptable SOURCES of each target from the table, never a second list', () => {
    expect(workflowVersionSourcesFor('VALIDATED')).toEqual(['DRAFT']);
    expect(workflowVersionSourcesFor('PUBLISHED')).toEqual(['VALIDATED']);
    expect(workflowVersionSourcesFor('ARCHIVED')).toEqual(['PUBLISHED']);
    // A state nothing reaches has no sources: DRAFT is where a version BEGINS rather than where
    // one arrives, and ARCHIVED is terminal.
    expect(workflowVersionSourcesFor('DRAFT')).toEqual([]);

    // And the derivation AGREES with the predicate it is read from, pair by pair.
    for (const to of WORKFLOW_VERSION_STATUSES) {
      for (const from of workflowVersionSourcesFor(to)) {
        expect({ from, to, allowed: isWorkflowVersionTransitionAllowed(from, to) }).toEqual({
          from,
          to,
          allowed: true,
        });
      }
    }
  });

  it('is frozen, so a caller cannot widen the lifecycle at runtime', () => {
    const transitions: Record<WorkflowVersionStatus, readonly WorkflowVersionStatus[]> =
      WORKFLOW_VERSION_TRANSITIONS;

    expect(Object.isFrozen(WORKFLOW_VERSION_TRANSITIONS)).toBe(true);
    for (const status of WORKFLOW_VERSION_STATUSES) {
      expect({ status, frozen: Object.isFrozen(transitions[status]) }).toEqual({
        status,
        frozen: true,
      });
    }
  });
});
