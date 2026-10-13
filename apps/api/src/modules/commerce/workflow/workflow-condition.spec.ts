import { WORKFLOW_MAX_REPORTED_ISSUES } from './workflow-configuration';
import { describeWorkflowConditionIssues, findUnsafeWorkflowPayload } from './workflow-condition';

/**
 * Phase C1 Step M (§5.7, §9, §31, gate I20): the condition tree GRAMMAR, as the borrowed walk
 * judges it — and the payload scan that runs over a stored configuration.
 *
 * WHAT IS PINNED, AND WHY EACH PIN IS FALSIFIABLE
 * ----------------------------------------------
 *  A. the five node kinds of §8.1's frozen set are recognized, and a node stating NONE of them is
 *     refused — so a tree built from an invented kind cannot be stored;
 *  B. `all`/`any` require a NON-EMPTY array, `not` requires exactly ONE node (an array is refused by
 *     name), and the reported `path` locates the defect inside the tree;
 *  C. a well-formed tree reports NOTHING, at every kind — the negative case is what makes the
 *     refusals above mean something;
 *  D. the engine's operator vocabulary is enforced: an operator outside it, an operand the operator
 *     forbids or requires, and a field name the engine could not read are all refused — each is one
 *     of the checks this walk performs with NO field catalogue;
 *  E. the bounds come from `RULE_LIMITS`: nesting depth and string-operand length are enforced here
 *     because a tree this module accepts must be one the engine can accept later;
 *  F. the report is BOUNDED, and the payload scan refuses prototype keys and over-large payloads
 *     rather than passing them.
 *
 * The walk is exercised through its two exported functions only: everything else in the file is
 * private, deliberately, because these two are the whole surface the pure validator injects.
 */

/** The five kinds §8.1 freezes, and one node of each — the accepted baseline the refusals vary. */
const WELL_FORMED = {
  leaf: { field: 'amount', op: 'equals', value: 10 },
  none: { field: 'supplier', op: 'isEmpty' },
  all: { all: [{ field: 'amount', op: 'greaterThan', value: 5 }] },
  any: { any: [{ field: 'amount', op: 'lessThan', value: 100 }] },
  not: { not: { field: 'amount', op: 'isNotEmpty' } },
} as const;

describe('Phase C1 Step M — the condition tree grammar', () => {
  it('reports NOTHING for `null` or `undefined` — an unconditional step has no tree at all', () => {
    // §5.7: whether a step may be unconditional is decided by its execution mode, not by this walk.
    expect(describeWorkflowConditionIssues(null)).toEqual([]);
    expect(describeWorkflowConditionIssues(undefined)).toEqual([]);
  });

  it('accepts a well-formed tree of every kind', () => {
    // The negative case: five trees, each using one of the five kinds, none of them refused.
    for (const [kind, tree] of Object.entries(WELL_FORMED)) {
      expect({ kind, findings: describeWorkflowConditionIssues(tree) }).toEqual({
        kind,
        findings: [],
      });
    }

    // And they COMPOSE: an `all` of an `all`, a `not` and a leaf is still well formed.
    expect(
      describeWorkflowConditionIssues({
        all: [WELL_FORMED.all, WELL_FORMED.not, WELL_FORMED.leaf],
      })
    ).toEqual([]);
  });

  it('refuses a node that states no kind, and a value that is not an object at all', () => {
    for (const value of [{}, 'amount', 5, [], true]) {
      const findings = describeWorkflowConditionIssues(value);
      expect({ value, refused: findings.length > 0 }).toEqual({ value, refused: true });
    }
  });

  it('requires `all`/`any` to hold a NON-EMPTY array of conditions', () => {
    for (const kind of ['all', 'any'] as const) {
      for (const held of [[], 'x', {}, 3]) {
        const findings = describeWorkflowConditionIssues({ [kind]: held });
        expect({ kind, held, findings }).toEqual({
          kind,
          held,
          findings: [{ path: kind, reason: `${kind} holds a non-empty array of conditions` }],
        });
      }
    }
  });

  it('requires `not` to hold exactly ONE node — an array is refused by name', () => {
    expect(describeWorkflowConditionIssues({ not: [] })).toEqual([
      { path: 'not', reason: 'not holds ONE condition node, not an array' },
    ]);
    expect(describeWorkflowConditionIssues({ not: [WELL_FORMED.leaf] })).toEqual([
      { path: 'not', reason: 'not holds ONE condition node, not an array' },
    ]);
  });

  it('locates a defect INSIDE the tree, by the path the node sits at', () => {
    const findings = describeWorkflowConditionIssues({
      all: [WELL_FORMED.leaf, { all: [] }],
    });

    expect(findings).toEqual([
      { path: 'all[1].all', reason: 'all holds a non-empty array of conditions' },
    ]);
  });

  it('refuses keys beside the kind — a node states its kind and nothing else', () => {
    const findings = describeWorkflowConditionIssues({
      field: 'amount',
      op: 'equals',
      value: 1,
      extra: true,
    });

    expect(findings.length).toBe(1);
    expect(findings[0].reason).toContain('extra');
  });

  it('refuses an operand the operator forbids or requires, and a scalar where an array belongs', () => {
    const cases = [
      { node: { field: 'amount', op: 'equals' }, why: 'required operand missing' },
      { node: { field: 'amount', op: 'isEmpty', value: 'x' }, why: 'forbidden operand stated' },
      { node: { field: 'amount', op: 'in', value: 'x' }, why: 'array required, scalar sent' },
      { node: { field: 'amount', op: 'in', value: [] }, why: 'a non-empty array is required' },
      {
        node: { field: 'dueOn', op: 'dateBetween', value: ['2026-01-01'] },
        why: 'a range needs both ends',
      },
    ] as const;

    for (const { node, why } of cases) {
      const findings = describeWorkflowConditionIssues(node);
      expect({ why, refused: findings.length > 0 }).toEqual({ why, refused: true });
    }
  });

  it('refuses an operator outside §8.2’s frozen vocabulary', () => {
    // `eval` is deliberately the example: §9 names it as the shape this module never grows.
    expect(
      describeWorkflowConditionIssues({ field: 'amount', op: 'eval', value: 1 }).length
    ).toBeGreaterThan(0);
  });

  it('refuses a field name the engine could not read: a `..`, and a reserved name', () => {
    for (const field of ['amount..value', '__proto__', 'constructor']) {
      const findings = describeWorkflowConditionIssues({ field, op: 'equals', value: 1 });
      expect({ field, refused: findings.length > 0 }).toEqual({ field, refused: true });
    }
  });

  it('refuses a tree past the engine’s own depth bound, rather than storing one it could not read', () => {
    let tree: unknown = WELL_FORMED.leaf;
    for (let depth = 0; depth < 20; depth += 1) {
      tree = { not: tree };
    }

    expect(describeWorkflowConditionIssues(tree).length).toBeGreaterThan(0);
  });

  it('refuses a string operand past the engine’s own length bound', () => {
    const findings = describeWorkflowConditionIssues({
      field: 'comment',
      op: 'equals',
      value: 'x'.repeat(300),
    });

    expect(findings.length).toBeGreaterThan(0);
  });

  it('bounds the report, so a tree of hundreds of defects cannot answer with all of them', () => {
    const findings = describeWorkflowConditionIssues({
      all: Array.from({ length: 200 }, () => ({})),
    });

    expect(findings.length).toBe(WORKFLOW_MAX_REPORTED_ISSUES);
  });

  it('refuses a `count` node that is not an object, and descends into its `where`', () => {
    expect(describeWorkflowConditionIssues({ count: 'lines' }).length).toBeGreaterThan(0);

    // §8.4's `where` is an ARRAY of per-item conditions, and the defect here is inside it: the walk
    // descends rather than stopping at the node's own shape.
    const findings = describeWorkflowConditionIssues({
      count: { over: 'lines', where: [{ all: [] }], op: 'greaterThanOrEqual', value: 2 },
    });

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((finding) => finding.path.includes('where'))).toBe(true);
  });
});

describe('Phase C1 Step M — the stored payload scan', () => {
  it('passes an ordinary payload, including nested arrays and objects', () => {
    expect(
      findUnsafeWorkflowPayload({
        thresholds: { cash: 1000 },
        tags: ['a', 'b'],
        nested: { x: true },
      })
    ).toBeNull();
  });

  it('refuses the three names that could turn a stored value into a behaviour, with their path', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const payload = JSON.parse(`{"${key}": {"a": 1}}`);
      const finding = findUnsafeWorkflowPayload(payload);

      expect({ key, finding }).toEqual({
        key,
        finding: { path: key, reason: 'a payload key names a prototype member' },
      });
    }
  });

  it('refuses a payload too large to scan FULLY, rather than scanning part of it', () => {
    // A scan that silently stopped at a bound would be a check a large payload turns off.
    const finding = findUnsafeWorkflowPayload(Array.from({ length: 5000 }, (_, index) => index));

    expect(finding).not.toBeNull();
    expect(finding?.reason).toContain('4096');
  });
});
