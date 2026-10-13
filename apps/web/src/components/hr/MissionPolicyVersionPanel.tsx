'use client';

import * as React from 'react';

import { useReloadToken } from '@/hooks/use-reload-token';
import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  archiveMissionPolicyVersion,
  createMissionPolicyVersion,
  fetchMissionPolicyVersions,
  publishMissionPolicyVersion,
  validateMissionPolicyVersion,
  type CreateMissionPolicyVersionInput,
  type HrMissionPolicyVersion,
  type HrMissionPolicyVersionActions,
} from '@/lib/hr-mission-api';
import type {
  MissionRuleAction,
  MissionRuleComparisonCondition,
  MissionRuleComparisonOperator,
  MissionRuleConditionNode,
  MissionRuleConditionOperand,
  MissionRuleCountCondition,
  MissionRuleCountOperator,
  MissionRuleFieldCatalogueEntry,
  MissionRuleFieldDeclaration,
  MissionRuleScalarFieldType,
  MissionRuleSetVersion,
} from '@/lib/mission-rule-set-version';
import {
  missionPolicyVersionStatusLabel,
  missionPolicyVersionStatusMeaning,
  missionPolicyVersionStatusTone,
} from '@/lib/hr-mission-labels';
import { HrBadge, HrCard, HrField, HrNotice } from './hr-ui';

/**
 * Phase 55 Step 8D-P: DOMAIN 3 — the Mission POLICY VERSION surface, and nothing else.
 */

/**
 * Phase 55 Step 8D-P: DOMAIN 3 — the Mission POLICY VERSION surface, and nothing else.
 *
 * WHAT CHANGED, AND WHY IT WAS SAFE TO CHANGE
 * -------------------------------------------
 * The previous step rendered the versions as an OBSERVED list, because `configuration` was `unknown`
 * and eligibility had to be derived from `status` — which is the one thing a client may never do.
 * Both halves of that blocker are gone: `configuration` IS the Rule Engine's `RuleSetVersion`
 * (transcribed field-for-field into `mission-rule-set-version.ts` from the server's own declaration),
 * and every version arrives carrying the SERVER's `actions`.
 *
 * So this panel does exactly two things, and neither of them is an engine:
 *
 *   1. it RENDERS a stored document faithfully — every fact, every condition node, every action, and
 *      every "this field is not in the request DTO" fact — and
 *   2. it CALLS the frozen client's five policy functions and then RE-READS the authoritative list.
 *
 * WHAT IT IS NOT ALLOWED TO BE, AND ISN'T
 * ---------------------------------------
 *   * NOT a validator. `validateMissionPolicyVersion` exists precisely because validity is the
 *     engine's verdict; nothing here decides whether a document is valid, whole or effective.
 *   * NOT a lifecycle matrix. Every button below is bound to `version.actions.can…` — the same
 *     predicate the server's own write guards use. `status` is RENDERED and never INSPECTED.
 *   * NOT an editor of stored versions. `mission.controller.ts` exposes NO update route for a policy
 *     version — only `GET policy-versions`, `POST policy-versions`, and the three transitions — and
 *     `CreateMissionPolicyVersionDto` is the only policy DTO that exists. A version is therefore
 *     AUTHORED ONCE and thereafter only transitions. That is the backend's shape, not a shortcut here,
 *     and no `PATCH` route was invented to make this screen feel more like the other two domains.
 *   * NOT an approximation of the request DTO. `CreateMissionPolicyVersionDto` carries exactly
 *     `version`, `label`, `ruleSetId?` and `configuration`. The document's OWN `version`, `status` and
 *     `rules[].version` are IN THE STORED DOCUMENT AND IN NO REQUEST, so they are MIRRORED from the row
 *     the operator is authoring and are never free-typed. In particular this panel does NOT
 *     auto-number: `version` is a number an operator states, and `rules[].version` is echoed from the
 *     DTO field the API accepted, because the request carries no separate revision for a rule.
 *
 * WHAT THE OPERATOR CANNOT CHOOSE, BECAUSE THE FRAMEWORK WOULD HAVE TO GUESS
 * -------------------------------------------------------------------------
 * The engine INFERS a fact's type (`enumValues` present ⇒ `enum`) and `collection` is a whole node
 * kind, so no request carries a type beyond the declared scalar type: a fact is edited by NAME and
 * TYPE, and only an `enum` names its values, because that is the one combination the validator accepts.
 * The condition OPERAND SHAPE is likewise a function of the OPERATOR (`isEmpty` takes nothing,
 * `dateBetween` takes exactly `[from, to]`, `in` takes a list) and is validated at publish, so the form
 * BUILDS the operand from the chosen operator instead of asking a human to pick a JSON shape.
 * `approverRuleRef` and every other `…Ref` is an OPAQUE SERVER REFERENCE with no client catalogue, so
 * it is a text input — the panel does not pretend to know which refs exist.
 *
 * THE THREE MISSION FACTS ARE STATED, NOT OFFERED. `HrMissionConfigurationView` owns that wording and
 * keeps it; this panel states that each version declares its OWN `fields` list, and lets the operator
 * author it, because `fields` is part of the document the API accepts.
 *
 * LABELS. Nothing below invents Persian for a node kind, an operator, an action type, a field name, a
 * comparison value or a window boundary: those are DEVELOPER-FACING IDENTIFIERS and are rendered as
 * the engine's own tokens, monospaced, beside a Persian structural title (e.g. «گره همه» for `all`) —
 * which is how this component renders them and no vocabulary file was touched to say so. Every Persian
 * string that DOES appear is either an established Mission word
 * (`missionPolicyVersionStatusLabel` / `…Meaning` / `…Tone` for the four states, and «خط‌مشی ماموریت»
 * for the document — both already used on this screen) or a plain structural or form sentence.
 */

/**
 * The lifecycle transitions, in the order the server's routes list them, each bound to the flag the
 * SERVER sets for it.
 *
 * The flag NAME is the server's own contract member (`MissionPolicyVersionActions`), so a rename there
 * breaks this file at compile time instead of silently rendering the wrong button — and because the
 * binding IS `actions[flag]`, no reading of `status` can leak into whether a button exists.
 */
const LIFECYCLE_ACTIONS: readonly {
  flag: keyof HrMissionPolicyVersionActions;
  label: string;
  run: (versionId: string) => Promise<HrMissionPolicyVersion>;
}[] = [
  { flag: 'canValidate', label: 'اعتبارسنجی', run: validateMissionPolicyVersion },
  { flag: 'canPublish', label: 'انتشار', run: publishMissionPolicyVersion },
  { flag: 'canArchive', label: 'بایگانی', run: archiveMissionPolicyVersion },
];

/** The Mission rule set these versions configure — `MissionPolicyService.RULE_SET_ID`. */
const MISSION_RULE_SET_ID = 'hr.mission.approval';

/** The only payload schema this engine implements — `RULE_ENGINE_SCHEMA_VERSION`. */
const SCHEMA_VERSION = 1;

/** The API's own message when it gave one, and this panel's Persian sentence otherwise. */
function describe(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.length > 0 ? err.message : fallback;
}

/**
 * The five condition node kinds, in the order `rule-condition.interface.ts` declares them, each with
 * the LITERAL KEY the engine discriminates by.
 *
 * The keys are not decoration: `rule-validator.ts` tells the node kinds apart BY KEY, so the union has
 * no `kind` member to switch on. Typing this list as a closed union is what makes the renderer's
 * `switch` exhaustive by construction — a sixth node kind stops compiling.
 */
const CONDITION_KINDS = ['all', 'any', 'not', 'field', 'count'] as const;
type ConditionKind = (typeof CONDITION_KINDS)[number];

/** The Persian structural title for each node kind. The engine's own token is printed beside it. */
const CONDITION_KIND_LABELS: Record<ConditionKind, string> = {
  all: 'گره همه (AND)',
  any: 'گره هرکدام (OR)',
  not: 'گره نقیض (NOT)',
  field: 'مقایسهٔ یک واقعیت',
  count: 'شمارش روی یک مجموعه',
};

/** The thirteen frozen comparison operators, verbatim from `RuleComparisonOperator`. */
const COMPARISON_OPERATORS: readonly MissionRuleComparisonOperator[] = [
  'equals',
  'notEquals',
  'in',
  'notIn',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
  'isEmpty',
  'isNotEmpty',
  'dateBefore',
  'dateAfter',
  'dateBetween',
];

/** The four frozen count operators, verbatim from `RuleCountOperator` — ordering only, on purpose. */
const COUNT_OPERATORS: readonly MissionRuleCountOperator[] = [
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
];

/** The scalar fact types the catalogue may declare. `collection` is a node kind, not a scalar type. */
const SCALAR_FIELD_TYPES: readonly MissionRuleScalarFieldType[] = [
  'string',
  'number',
  'boolean',
  'date',
  'enum',
];

/** The two values `RuleCountingBasis` declares. */
const COUNTING_BASES = ['REQUEST_COUNT', 'DAY_COUNT'] as const;
type CountingBasis = (typeof COUNTING_BASES)[number];

/** The three values `RuleApproverResolutionReason` declares. */
const RESOLUTION_REASONS = ['PRIMARY', 'SUBSTITUTE', 'UNAVAILABLE'] as const;
type ResolutionReason = (typeof RESOLUTION_REASONS)[number];

/** The three values `RuleNotifyRecipientRole` declares. The engine sends nothing. */
const RECIPIENT_ROLES = ['EMPLOYEE', 'MANAGER', 'HR_ADMIN'] as const;
type RecipientRole = (typeof RECIPIENT_ROLES)[number];

/**
 * The seven frozen action types, in the order `RULE_ACTION_TYPES` declares them.
 *
 * A closed union, and a closed union on the SERVER too — `isRuleActionType` refuses an eighth — so this
 * list cannot silently gain a member the engine would reject.
 */
const ACTION_TYPES = [
  'REQUIRED_APPROVAL_STEP',
  'AUTO_APPROVE',
  'AUTO_REJECT',
  'LIMIT_REFUSAL',
  'STEP_ACTIVATION',
  'APPROVER_RESOLUTION',
  'NOTIFY',
] as const;

type ActionType = (typeof ACTION_TYPES)[number];

/**
 * The Persian structural title for each action type, and the sentence naming its own parameters.
 *
 * WHAT IS RENDERED AND WHAT IS NOT. The engine's token (`REQUIRED_APPROVAL_STEP`, …) is printed as
 * itself, monospaced, beside a structural Persian title — the tokens are the engine's identifiers and
 * have no Persian equivalent to invent. The `parameters` sentence then names, in Persian, the fields
 * the action carries, so an operator reading a stored version sees WHY a row has the inputs it does.
 */
const ACTION_TYPE_LABELS: Record<ActionType, string> = {
  REQUIRED_APPROVAL_STEP: 'مرحلهٔ تأیید الزامی',
  AUTO_APPROVE: 'تأیید خودکار',
  AUTO_REJECT: 'رد خودکار',
  LIMIT_REFUSAL: 'رد به دلیل سقف',
  STEP_ACTIVATION: 'فعال‌سازی مرحله',
  APPROVER_RESOLUTION: 'تعیین تأییدکننده',
  NOTIFY: 'اعلان',
};

/** The parameter NAMES an action type carries, in the order the interface declares them. */
const ACTION_TYPE_PARAMETERS: Record<ActionType, string> = {
  REQUIRED_APPROVAL_STEP: 'ترتیب مرحله، شناسهٔ قاعدهٔ تأییدکننده',
  AUTO_APPROVE: 'بدون پارامتر',
  AUTO_REJECT: 'کد دلیل',
  LIMIT_REFUSAL: 'شناسهٔ سقف، مبنای شمارش، حداکثر، آغاز و پایان بازه',
  STEP_ACTIVATION: 'ترتیب مرحله',
  APPROVER_RESOLUTION: 'شناسهٔ قاعدهٔ تأییدکننده، دلیل تعیین',
  NOTIFY: 'شناسهٔ قالب، نقش گیرنده',
};

/** The transitions the server says it will accept, so the absence of a button is never ambiguous. */
function describeAllowedTransitions(actions: HrMissionPolicyVersionActions): string {
  const allowed = LIFECYCLE_ACTIONS.filter((entry) => actions[entry.flag]).map(
    (entry) => entry.label
  );

  return allowed.length === 0
    ? 'گذار بعدی برای این نسخه مجاز نیست.'
    : `گذارهای مجاز: ${allowed.join('، ')}`;
}

// ---------------------------------------------------------------------------
// The create editor — one form, and the request DTO it becomes
// ---------------------------------------------------------------------------

/**
 * A fact being declared, as the EDITOR holds it.
 *
 * `enumValues` is a COMMA-SEPARATED string because it comes from one text input, and it is split once,
 * in `buildFields`. A `collection` is NOT offered: it requires `maxSize` and `itemFields`, and
 * `itemFields` are themselves declared facts — a second, nested form for a node kind the Mission rule
 * set does not use. The form declares SCALAR facts, which is what the engine's Mission context has, and
 * a collection is refused by the form's own type list rather than half-authored by it. A document that
 * DOES carry one is still rendered faithfully by `MissionPolicyFieldRow`, which reads the stored node.
 */
interface FieldDraft {
  draftId: number;
  name: string;
  type: MissionRuleScalarFieldType;
  enumValues: string;
}

/**
 * A `{ field, op, value }` leaf being authored. `value` is ONE text box whose MEANING is the operator's:
 * a scalar for equality/ordering/date operators, a comma-separated list for `in`/`notIn`, `from,to` for
 * `dateBetween`, and NOTHING AT ALL for `isEmpty`/`isNotEmpty`, whose box is not rendered.
 */
interface ComparisonDraft {
  draftId: number;
  field: string;
  op: MissionRuleComparisonOperator;
  value: string;
}

/** A `count` aggregate being authored. `over` is typed, because no client catalogue lists collections. */
interface CountDraft {
  draftId: number;
  over: string;
  op: MissionRuleCountOperator;
  value: string;
  where: ComparisonDraft[];
}

/** A rule being authored: identity, ranking, ONE condition tree, and its ordered actions. */
interface RuleDraft {
  draftId: number;
  id: string;
  name: string;
  priority: string;
  conditionKind: ConditionKind;
  /** Used when `conditionKind` is `all` or `any`. */
  members: ComparisonDraft[];
  /** Used when `conditionKind` is `not`: exactly one child, as the model declares. */
  not: ComparisonDraft;
  /** Used when `conditionKind` is `field`: a single leaf at the root. */
  leaf: ComparisonDraft;
  /** Used when `conditionKind` is `count`. */
  count: CountDraft;
  actions: ActionDraft[];
}

/**
 * One action being authored.
 *
 * EVERY PARAMETER OF EVERY TYPE IS PRESENT, which is deliberate: the draft is the union flattened into
 * text boxes, and `buildAction` reads ONLY the boxes its chosen `type` declares. Keeping one draft shape
 * rather than seven means switching an action's type back and forth does not discard what the operator
 * already typed — and it means the component holds no `unknown`, no partial and no cast.
 */
interface ActionDraft {
  draftId: number;
  type: ActionType;
  stepOrder: string;
  approverRuleRef: string;
  reasonCode: string;
  limitRef: string;
  countingBasis: CountingBasis;
  maximum: string;
  windowStart: string;
  windowEnd: string;
  resolutionReason: ResolutionReason;
  templateRef: string;
  recipientRole: RecipientRole;
}

let nextDraftId = 1;

const blankComparison = (): ComparisonDraft => ({
  draftId: nextDraftId++,
  field: '',
  op: 'equals',
  value: '',
});

const blankRule = (index: number): RuleDraft => ({
  draftId: nextDraftId++,
  id: `mission-rule-${index}`,
  name: '',
  priority: '10',
  conditionKind: 'all',
  members: [blankComparison()],
  not: blankComparison(),
  leaf: blankComparison(),
  count: {
    draftId: nextDraftId++,
    over: '',
    op: 'greaterThan',
    value: '0',
    where: [],
  },
  actions: [blankAction()],
});

function blankAction(): ActionDraft {
  return {
    draftId: nextDraftId++,
    type: 'REQUIRED_APPROVAL_STEP',
    stepOrder: '1',
    approverRuleRef: '',
    reasonCode: '',
    limitRef: '',
    countingBasis: 'DAY_COUNT',
    maximum: '1',
    windowStart: '',
    windowEnd: '',
    resolutionReason: 'PRIMARY',
    templateRef: '',
    recipientRole: 'EMPLOYEE',
  };
}

const blankField = (): FieldDraft => ({
  draftId: nextDraftId++,
  name: '',
  type: 'string',
  enumValues: '',
});

// ---------------------------------------------------------------------------
// The operator → operand-shape function, and the form checks
// ---------------------------------------------------------------------------

/** The two operators that carry NO operand. The engine accepts exactly these without a `value`. */
const OPERANDLESS_OPERATORS: readonly MissionRuleComparisonOperator[] = ['isEmpty', 'isNotEmpty'];

/** The two membership operators, whose operand is a LIST of the field's declared type. */
const MEMBERSHIP_OPERATORS: readonly MissionRuleComparisonOperator[] = ['in', 'notIn'];

/** The operators whose operand is a single number or date. */
const ORDERING_OPERATORS: readonly MissionRuleComparisonOperator[] = [
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
];

/** True when the operator takes no operand, so the form hides its value input entirely. */
function hasNoOperand(op: MissionRuleComparisonOperator): boolean {
  return OPERANDLESS_OPERATORS.includes(op);
}

/** A comma-separated list from one input, trimmed and with empties dropped. */
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * THE OPERAND, BUILT FROM THE OPERATOR — the whole reason the form asks for "a value" rather than for
 * a JSON shape.
 *
 * The pairing is the engine's own (§8.3) and is enforced at publish, so this function's ONLY job is to
 * produce the shape the chosen operator declares, and to return `undefined` when the operator declares
 * none at all:
 *
 *   isEmpty | isNotEmpty          → no operand at all, and the form's value box is not even rendered
 *   in | notIn                    → string[] (the declared scalar tokens, verbatim)
 *   dateBetween                   → [from, to] — two entries REQUIRED, taken in order
 *   ordering operators            → number when the text is numeric, otherwise the text itself, so a
 *                                   `date` fact's ordering comparison posts a DATE STRING and a
 *                                   numeric fact's posts a NUMBER — decided by what was typed, not by
 *                                   a field type this client would have to resolve from the catalogue
 *   equals | notEquals            → `true`/`false` as booleans, numerics as numbers, else the text
 *
 * NOTHING HERE DECIDES VALIDITY. A value the operator cannot accept (a `dateBetween` with one entry, a
 * non-numeric ordering operand) is produced as-is and the SERVER refuses the document at validate,
 * which is where the verdict belongs.
 */
function buildOperand(
  op: MissionRuleComparisonOperator,
  raw: string
): MissionRuleConditionOperand | undefined {
  if (hasNoOperand(op)) return undefined;

  if (MEMBERSHIP_OPERATORS.includes(op)) return splitList(raw);

  if (op === 'dateBetween') {
    const parts = splitList(raw);
    // The tuple is `readonly [from, to]`; a malformed pair is forwarded as `[from, '']` so the server
    // reports the missing `to`, rather than this client inventing a second date.
    return [parts[0] ?? '', parts[1] ?? ''] as const;
  }

  const trimmed = raw.trim();

  if (ORDERING_OPERATORS.includes(op)) {
    return /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : trimmed;
  }

  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

  return trimmed;
}

/**
 * The comparison node a draft becomes, omitting `value` ENTIRELY for an operand-less operator.
 *
 * Omitting it is not cosmetic: the engine's `isEmpty`/`isNotEmpty` take no operand, and a node carrying
 * `value: undefined` serialises without the key, which is the document the validator accepts.
 */
function buildComparisonNode(draft: ComparisonDraft): MissionRuleComparisonCondition {
  const operand = buildOperand(draft.op, draft.value);

  return operand === undefined
    ? { field: draft.field.trim(), op: draft.op }
    : { field: draft.field.trim(), op: draft.op, value: operand };
}

/** The condition tree a rule draft becomes, in the node kind the operator chose. */
function buildCondition(draft: RuleDraft): MissionRuleConditionNode {
  if (draft.conditionKind === 'all') {
    return { all: draft.members.map(buildComparisonNode) };
  }
  if (draft.conditionKind === 'any') {
    return { any: draft.members.map(buildComparisonNode) };
  }
  if (draft.conditionKind === 'not') {
    return { not: buildComparisonNode(draft.not) };
  }
  if (draft.conditionKind === 'count') {
    return {
      count: {
        over: draft.count.over.trim(),
        // `where` is sent ONLY when the operator added at least one clause: an empty array and an
        // absent key are different documents, and the engine's `where` is optional.
        ...(draft.count.where.length > 0
          ? { where: draft.count.where.map(buildComparisonNode) }
          : {}),
        op: draft.count.op,
        value: Number(draft.count.value.trim() === '' ? '0' : draft.count.value.trim()),
      },
    };
  }
  return buildComparisonNode(draft.leaf);
}

/**
 * THE ACTION, BUILT FROM ITS TYPE — the same discipline as the operand: every parameter that is a
 * function of the type is built here, so the form never asks a human for a JSON object.
 *
 * `stepOrder`/`maximum` are NUMBERS and are converted with `Number`, so a blank integer becomes `NaN`
 * and is caught by the form check below rather than silently posting `0` as a step position.
 */
function buildAction(draft: ActionDraft): MissionRuleAction {
  if (draft.type === 'AUTO_APPROVE') return { type: 'AUTO_APPROVE' };

  if (draft.type === 'AUTO_REJECT') {
    return { type: 'AUTO_REJECT', reasonCode: draft.reasonCode.trim() };
  }

  if (draft.type === 'REQUIRED_APPROVAL_STEP') {
    return {
      type: 'REQUIRED_APPROVAL_STEP',
      stepOrder: Number(draft.stepOrder.trim()),
      approverRuleRef: draft.approverRuleRef.trim(),
    };
  }

  if (draft.type === 'LIMIT_REFUSAL') {
    return {
      type: 'LIMIT_REFUSAL',
      limitRef: draft.limitRef.trim(),
      countingBasis: draft.countingBasis,
      maximum: Number(draft.maximum.trim()),
      windowStart: draft.windowStart.trim(),
      windowEnd: draft.windowEnd.trim(),
    };
  }

  if (draft.type === 'STEP_ACTIVATION') {
    return { type: 'STEP_ACTIVATION', stepOrder: Number(draft.stepOrder.trim()) };
  }

  if (draft.type === 'APPROVER_RESOLUTION') {
    return {
      type: 'APPROVER_RESOLUTION',
      approverRuleRef: draft.approverRuleRef.trim(),
      resolutionReason: draft.resolutionReason,
    };
  }

  return {
    type: 'NOTIFY',
    templateRef: draft.templateRef.trim(),
    recipientRole: draft.recipientRole,
  };
}

/** The declared facts a document will carry, with `enumValues` split only for an `enum` type. */
function buildFields(drafts: FieldDraft[]): MissionRuleFieldDeclaration[] {
  return drafts.map((draft) =>
    draft.type === 'enum'
      ? {
          name: draft.name.trim(),
          type: draft.type,
          enumValues: splitList(draft.enumValues),
        }
      : { name: draft.name.trim(), type: draft.type }
  );
}

/**
 * THE REQUEST BODY — the only place the request DTO is constructed, so what the API accepts is stated
 * once, in one object literal, next to the comment naming what is deliberately absent from it.
 *
 * `supersedes`, `effectiveFrom`, `effectiveTo` and `configuration.rules[].version` are NOT here, and
 * cannot be: they are members of the STORED document and of NO request. The row's own `version` and the
 * document's `version` are the same value because the request states it once, and `rules[].version`
 * echoes it as a string, because the request carries no separate revision for a rule.
 */
function buildCreateInput(
  version: string,
  label: string,
  ruleSetId: string,
  fields: FieldDraft[],
  rules: RuleDraft[]
): CreateMissionPolicyVersionInput {
  return {
    version: Number(version.trim()),
    label: label.trim(),
    ruleSetId: ruleSetId.trim(),
    configuration: {
      ruleSetId: ruleSetId.trim(),
      version: version.trim(),
      // The row is created as a DRAFT by the server; the document's own `status` mirrors that one
      // domain constant rather than offering a choice the request has no field for.
      status: 'DRAFT',
      schemaVersion: SCHEMA_VERSION,
      fields: buildFields(fields),
      rules: rules.map((draft) => ({
        id: draft.id.trim(),
        version: version.trim(),
        name: draft.name.trim(),
        priority: Number(draft.priority.trim()),
        condition: buildCondition(draft),
        actions: draft.actions.map(buildAction),
      })),
    },
  };
}

/**
 * A FORM problem, or `null` when the row is complete enough to submit.
 *
 * THESE ARE FORM CHECKS, NOT VALIDATION. Each one names a REQUIRED INPUT THAT IS STILL BLANK, or a text
 * box that must hold an integer — never a claim about rule semantics, operator/type pairing or
 * satisfiability. Those are `validateRuleSetVersion`'s verdict on the server, reached through
 * `validateMissionPolicyVersion`, and a client that pre-empted them would be a second, weaker engine.
 */
function comparisonProblem(draft: ComparisonDraft, what: string): string | null {
  if (draft.field.trim() === '') return `${what}: نام واقعیت الزامی است.`;
  if (hasNoOperand(draft.op)) return null;
  if (draft.value.trim() === '') return `${what}: مقدار عملگر «${draft.op}» الزامی است.`;
  if (draft.op === 'dateBetween' && splitList(draft.value).length !== 2) {
    return `${what}: عملگر dateBetween دقیقاً دو تاریخ (از، تا) می‌خواهد.`;
  }
  if (MEMBERSHIP_OPERATORS.includes(draft.op) && splitList(draft.value).length === 0) {
    return `${what}: عملگر «${draft.op}» دست‌کم یک مقدار می‌خواهد.`;
  }
  return null;
}

/** True when the text box holds an integer ≥ 1 — the shape the DTO's own `@Min(1)` integers require. */
function isPositiveInteger(value: string): boolean {
  return /^[1-9]\d*$/.test(value.trim());
}

function actionProblem(draft: ActionDraft): string | null {
  if (draft.type === 'REQUIRED_APPROVAL_STEP') {
    if (!isPositiveInteger(draft.stepOrder)) return 'ترتیب مرحله باید عددی و حداقل ۱ باشد.';
    if (draft.approverRuleRef.trim() === '') return 'شناسهٔ قاعدهٔ تأییدکننده الزامی است.';
    return null;
  }
  if (draft.type === 'AUTO_REJECT') {
    return draft.reasonCode.trim() === '' ? 'کد دلیل الزامی است.' : null;
  }
  if (draft.type === 'LIMIT_REFUSAL') {
    if (draft.limitRef.trim() === '') return 'شناسهٔ سقف الزامی است.';
    if (!isPositiveInteger(draft.maximum)) return 'حداکثر باید عددی و حداقل ۱ باشد.';
    if (draft.windowStart.trim() === '') return 'آغاز بازه الزامی است.';
    if (draft.windowEnd.trim() === '') return 'پایان بازه الزامی است.';
    return null;
  }
  if (draft.type === 'STEP_ACTIVATION') {
    return isPositiveInteger(draft.stepOrder) ? null : 'ترتیب مرحله باید عددی و حداقل ۱ باشد.';
  }
  if (draft.type === 'APPROVER_RESOLUTION') {
    return draft.approverRuleRef.trim() === '' ? 'شناسهٔ قاعدهٔ تأییدکننده الزامی است.' : null;
  }
  if (draft.type === 'NOTIFY') {
    return draft.templateRef.trim() === '' ? 'شناسهٔ قالب الزامی است.' : null;
  }
  // `AUTO_APPROVE` declares no parameter at all, so it is complete the moment it is chosen.
  return null;
}

function ruleProblem(draft: RuleDraft): string | null {
  if (draft.id.trim() === '') return 'شناسهٔ قاعده الزامی است.';
  if (draft.name.trim() === '') return 'نام قاعده الزامی است.';
  if (!/^-?\d+$/.test(draft.priority.trim())) return 'اولویت باید عددی باشد.';

  if (draft.conditionKind === 'all' || draft.conditionKind === 'any') {
    if (draft.members.length === 0) return 'گره همه/هرکدام دست‌کم یک شرط می‌خواهد.';
    for (const member of draft.members) {
      const problem = comparisonProblem(member, 'شرط');
      if (problem !== null) return problem;
    }
  } else if (draft.conditionKind === 'not') {
    const problem = comparisonProblem(draft.not, 'نقیض');
    if (problem !== null) return problem;
  } else if (draft.conditionKind === 'field') {
    const problem = comparisonProblem(draft.leaf, 'شرط');
    if (problem !== null) return problem;
  } else {
    if (draft.count.over.trim() === '') return 'شمارش: نام مجموعه الزامی است.';
    if (!/^\d+$/.test(draft.count.value.trim())) return 'شمارش: مقدار باید عددی و نامنفی باشد.';
    for (const clause of draft.count.where) {
      const problem = comparisonProblem(clause, 'شرط درون شمارش');
      if (problem !== null) return problem;
    }
  }

  // A rule with no action can never decide anything, and the engine requires at least one.
  if (draft.actions.length === 0) return 'هر قاعده دست‌کم یک اقدام می‌خواهد.';
  for (const action of draft.actions) {
    const problem = actionProblem(action);
    if (problem !== null) return problem;
  }

  return null;
}

// ---------------------------------------------------------------------------
// The condition editors — one operator list, one operand box, no JSON
// ---------------------------------------------------------------------------

/** The operator list as `<option>`s, with the engine's token as the label. */
const OPERATOR_OPTIONS = COMPARISON_OPERATORS.map((op) => ({ value: op, label: op }));
const COUNT_OPERATOR_OPTIONS = COUNT_OPERATORS.map((op) => ({ value: op, label: op }));

/**
 * ONE leaf comparison, as a form row: a field name, an operator, and the operand box the OPERATOR
 * declares.
 *
 * THE OPERAND BOX IS NOT RENDERED AT ALL for `isEmpty`/`isNotEmpty`, because the engine takes no operand
 * for them — an empty box would invite a value the validator would then refuse. For the other operators
 * the box is rendered with the HINT that says what it expects, so the shape is stated rather than
 * guessed: a list is comma-separated and `dateBetween` is `from,to`, in that order.
 */
function MissionPolicyComparisonEditor({
  draft,
  onChange,
  disabled,
  testIdPrefix,
}: {
  draft: ComparisonDraft;
  onChange: (patch: Partial<ComparisonDraft>) => void;
  disabled: boolean;
  testIdPrefix: string;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <Input
        label="واقعیت"
        id={`${testIdPrefix}-field`}
        data-testid={`${testIdPrefix}-field`}
        value={draft.field}
        disabled={disabled}
        onChange={(event) => onChange({ field: event.target.value })}
      />
      <Select
        label="عملگر"
        id={`${testIdPrefix}-op`}
        data-testid={`${testIdPrefix}-op`}
        value={draft.op}
        disabled={disabled}
        onChange={(event) => onChange({ op: event.target.value as MissionRuleComparisonOperator })}
        options={OPERATOR_OPTIONS}
      />
      {hasNoOperand(draft.op) ? (
        <p
          className="self-end pb-2 text-xs text-muted-foreground"
          data-testid={`${testIdPrefix}-no-operand`}
        >
          عملگر «{draft.op}» مقدار نمی‌گیرد.
        </p>
      ) : (
        <Input
          label={draft.op === 'dateBetween' ? 'مقدار (از، تا)' : 'مقدار'}
          id={`${testIdPrefix}-value`}
          data-testid={`${testIdPrefix}-value`}
          value={draft.value}
          disabled={disabled}
          placeholder={
            MEMBERSHIP_OPERATORS.includes(draft.op)
              ? 'مقادیر با کاما جدا می‌شوند'
              : draft.op === 'dateBetween'
                ? 'YYYY-MM-DD, YYYY-MM-DD'
                : undefined
          }
          onChange={(event) => onChange({ value: event.target.value })}
        />
      )}
    </div>
  );
}

/** A LIST of leaf comparisons, with add/remove — the shape `all`, `any` and `count.where` share. */
function MissionPolicyComparisonList({
  drafts,
  onChange,
  disabled,
  testIdPrefix,
  addLabel,
}: {
  drafts: ComparisonDraft[];
  onChange: (next: ComparisonDraft[]) => void;
  disabled: boolean;
  testIdPrefix: string;
  addLabel: string;
}) {
  const update = (draftId: number, patch: Partial<ComparisonDraft>) => {
    onChange(drafts.map((draft) => (draft.draftId === draftId ? { ...draft, ...patch } : draft)));
  };

  return (
    <div className="flex flex-col gap-2">
      {drafts.map((draft) => (
        <div
          key={draft.draftId}
          className="rounded-xl border border-border bg-muted/30 p-2"
          data-testid={`${testIdPrefix}-${draft.draftId}`}
        >
          <MissionPolicyComparisonEditor
            draft={draft}
            onChange={(patch) => update(draft.draftId, patch)}
            disabled={disabled}
            testIdPrefix={`${testIdPrefix}-${draft.draftId}`}
          />
          <div className="mt-2">
            <Button
              type="button"
              data-testid={`${testIdPrefix}-remove-${draft.draftId}`}
              disabled={disabled || drafts.length === 1}
              className="bg-muted text-foreground hover:bg-muted/80"
              onClick={() => onChange(drafts.filter((row) => row.draftId !== draft.draftId))}
            >
              حذف این شرط
            </Button>
          </div>
        </div>
      ))}

      <div>
        <Button
          type="button"
          data-testid={`${testIdPrefix}-add`}
          disabled={disabled}
          className="bg-muted text-foreground hover:bg-muted/80"
          onClick={() => onChange([...drafts, blankComparison()])}
        >
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The condition TREE editor — a node kind, and the children that kind declares
// ---------------------------------------------------------------------------

/** The node kinds as `<option>`s: the engine's token as the value, the Persian title as the label. */
const CONDITION_KIND_OPTIONS = CONDITION_KINDS.map((kind) => ({
  value: kind,
  label: `${CONDITION_KIND_LABELS[kind]} — ${kind}`,
}));

/**
 * The `count` aggregate, edited as the four facts it declares plus its optional `where` list.
 *
 * `over` IS TYPED AND NOT CHOSEN. It names a COLLECTION in the evaluation context — e.g. the collection
 * `mission-options.ts` supplies — and this client holds no catalogue of those names, because that
 * catalogue belongs to the domain that supplies the context. Offering a dropdown of collections would
 * mean inventing the list here; a text box states exactly what the panel knows.
 *
 * `where` IS OPTIONAL AND IS NOT PRE-POPULATED WITH AN EMPTY CLAUSE. An empty `where` array and an
 * absent `where` are different documents (the first means "no record qualifies", the second means "no
 * per-item filter"), so the list starts EMPTY and a clause appears only when the operator adds one.
 */
function MissionPolicyCountEditor({
  draft,
  onChange,
  disabled,
  testIdPrefix,
}: {
  draft: CountDraft;
  onChange: (patch: Partial<CountDraft>) => void;
  disabled: boolean;
  testIdPrefix: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-2 sm:grid-cols-3">
        <Input
          label="مجموعه (over)"
          id={`${testIdPrefix}-over`}
          data-testid={`${testIdPrefix}-over`}
          value={draft.over}
          disabled={disabled}
          onChange={(event) => onChange({ over: event.target.value })}
        />
        <Select
          label="عملگر"
          id={`${testIdPrefix}-op`}
          data-testid={`${testIdPrefix}-op`}
          value={draft.op}
          disabled={disabled}
          onChange={(event) => onChange({ op: event.target.value as MissionRuleCountOperator })}
          options={COUNT_OPERATOR_OPTIONS}
        />
        <Input
          label="مقدار"
          id={`${testIdPrefix}-value`}
          data-testid={`${testIdPrefix}-value`}
          value={draft.value}
          inputMode="numeric"
          disabled={disabled}
          onChange={(event) => onChange({ value: event.target.value })}
        />
      </div>

      <div>
        <p className="mb-2 text-xs text-muted-foreground">
          شرط درون شمارش (where) — اختیاری؛ تا وقتی شرطی افزوده نشود، این کلید ارسال نمی‌شود.
        </p>
        {draft.where.length === 0 ? (
          <div className="flex flex-col gap-2">
            <p
              className="text-xs text-muted-foreground"
              data-testid={`${testIdPrefix}-where-empty`}
            >
              هیچ شرط درونی وجود ندارد؛ همهٔ اعضای مجموعه شمرده می‌شوند.
            </p>
            <div>
              <Button
                type="button"
                data-testid={`${testIdPrefix}-where-add-first`}
                disabled={disabled}
                className="bg-muted text-foreground hover:bg-muted/80"
                onClick={() => onChange({ where: [blankComparison()] })}
              >
                افزودن شرط درونی
              </Button>
            </div>
          </div>
        ) : (
          <MissionPolicyComparisonList
            drafts={draft.where}
            onChange={(where) => onChange({ where })}
            disabled={disabled}
            testIdPrefix={`${testIdPrefix}-where`}
            addLabel="افزودن شرط درونی"
          />
        )}
      </div>
    </div>
  );
}

/**
 * THE CONDITION TREE OF ONE RULE, edited by choosing a NODE KIND.
 *
 * The five kinds are the engine's five, and the editor renders exactly the children the chosen kind
 * declares: `all`/`any` take a list, `not` takes exactly ONE child (and offers no add control, because
 * the model allows exactly one), `field` takes a single leaf, `count` takes one aggregate. Nothing can be
 * authored here that the union has no member for, and no member of the union is unreachable.
 *
 * NESTING IS NOT AUTHORED HERE, AND THAT IS STATED RATHER THAN HIDDEN. The Mission rule set's own
 * conditions are flat comparisons against its facts, and an editor for arbitrary depth would be an
 * editor for recursion. Every node this form produces is one of the five kinds at the root with leaf
 * children, so the document it builds is a tree of depth two at most — and a DEEPER document, stored by
 * any other means, is still rendered in full by `MissionPolicyCondition`, which recurses without limit.
 */
function MissionPolicyConditionEditor({
  draft,
  onChange,
  disabled,
  testIdPrefix,
}: {
  draft: RuleDraft;
  onChange: (patch: Partial<RuleDraft>) => void;
  disabled: boolean;
  testIdPrefix: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/30 p-3">
      <Select
        label="نوع گره شرط"
        id={`${testIdPrefix}-kind`}
        data-testid={`${testIdPrefix}-kind`}
        value={draft.conditionKind}
        disabled={disabled}
        onChange={(event) => onChange({ conditionKind: event.target.value as ConditionKind })}
        options={CONDITION_KIND_OPTIONS}
      />

      {(draft.conditionKind === 'all' || draft.conditionKind === 'any') && (
        <MissionPolicyComparisonList
          drafts={draft.members}
          onChange={(members) => onChange({ members })}
          disabled={disabled}
          testIdPrefix={`${testIdPrefix}-member`}
          addLabel="افزودن شرط"
        />
      )}

      {draft.conditionKind === 'not' && (
        <div>
          <p className="mb-2 text-xs text-muted-foreground">
            گره نقیض دقیقاً یک شرط دارد و فقط همان یک شرط را می‌پذیرد.
          </p>
          <MissionPolicyComparisonEditor
            draft={draft.not}
            onChange={(patch) => onChange({ not: { ...draft.not, ...patch } })}
            disabled={disabled}
            testIdPrefix={`${testIdPrefix}-not`}
          />
        </div>
      )}

      {draft.conditionKind === 'field' && (
        <MissionPolicyComparisonEditor
          draft={draft.leaf}
          onChange={(patch) => onChange({ leaf: { ...draft.leaf, ...patch } })}
          disabled={disabled}
          testIdPrefix={`${testIdPrefix}-leaf`}
        />
      )}

      {draft.conditionKind === 'count' && (
        <MissionPolicyCountEditor
          draft={draft.count}
          onChange={(patch) => onChange({ count: { ...draft.count, ...patch } })}
          disabled={disabled}
          testIdPrefix={`${testIdPrefix}-count`}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The action editor — one action, and ONLY the parameters its type declares
// ---------------------------------------------------------------------------

/** The seven action types as `<option>`s: the engine's token as the value, the title as the label. */
const ACTION_TYPE_OPTIONS = ACTION_TYPES.map((type) => ({
  value: type,
  label: `${ACTION_TYPE_LABELS[type]} — ${type}`,
}));

const COUNTING_BASIS_OPTIONS = COUNTING_BASES.map((basis) => ({ value: basis, label: basis }));
const RESOLUTION_REASON_OPTIONS = RESOLUTION_REASONS.map((reason) => ({
  value: reason,
  label: reason,
}));
const RECIPIENT_ROLE_OPTIONS = RECIPIENT_ROLES.map((role) => ({ value: role, label: role }));

/**
 * ONE action, edited by TYPE — and then by EXACTLY the parameters the chosen type declares.
 *
 * THE PARAMETER CONTROLS ARE A FUNCTION OF THE TYPE, never a fixed panel of boxes. `AUTO_APPROVE`
 * declares no parameter at all, so it renders NONE and the form says so; the remaining six render only
 * their own fields. That is why switching the type cannot leave a stale value in the request:
 * `buildAction` reads the boxes of the chosen type and ignores every other box the draft still holds.
 *
 * `approverRuleRef` IS A TEXT INPUT, NOT A PICKER. It is an opaque server reference — the Mission domain
 * reads it as `mission-approval-definition:<uuid>` — and this client holds no catalogue of approval
 * definitions to offer, so a dropdown would mean inventing one. The placeholder names the form the
 * domain requires so an operator is not left guessing.
 */
function MissionPolicyActionEditor({
  draft,
  onChange,
  onRemove,
  canRemove,
  disabled,
  testIdPrefix,
}: {
  draft: ActionDraft;
  onChange: (patch: Partial<ActionDraft>) => void;
  onRemove: () => void;
  canRemove: boolean;
  disabled: boolean;
  testIdPrefix: string;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-border bg-muted/30 p-3"
      data-testid={testIdPrefix}
    >
      <Select
        label="نوع اقدام"
        id={`${testIdPrefix}-type`}
        data-testid={`${testIdPrefix}-type`}
        value={draft.type}
        disabled={disabled}
        onChange={(event) => onChange({ type: event.target.value as ActionType })}
        options={ACTION_TYPE_OPTIONS}
      />

      {draft.type === 'REQUIRED_APPROVAL_STEP' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            label="ترتیب مرحله"
            id={`${testIdPrefix}-step-order`}
            data-testid={`${testIdPrefix}-step-order`}
            value={draft.stepOrder}
            inputMode="numeric"
            disabled={disabled}
            onChange={(event) => onChange({ stepOrder: event.target.value })}
          />
          <Input
            label="شناسهٔ قاعدهٔ تأییدکننده"
            id={`${testIdPrefix}-approver-ref`}
            data-testid={`${testIdPrefix}-approver-ref`}
            value={draft.approverRuleRef}
            disabled={disabled}
            placeholder="mission-approval-definition:<uuid>"
            onChange={(event) => onChange({ approverRuleRef: event.target.value })}
          />
        </div>
      )}

      {draft.type === 'AUTO_APPROVE' && (
        <p className="text-xs text-muted-foreground" data-testid={`${testIdPrefix}-no-parameters`}>
          {ACTION_TYPE_PARAMETERS.AUTO_APPROVE}
        </p>
      )}

      {draft.type === 'AUTO_REJECT' && (
        <Input
          label="کد دلیل"
          id={`${testIdPrefix}-reason-code`}
          data-testid={`${testIdPrefix}-reason-code`}
          value={draft.reasonCode}
          disabled={disabled}
          onChange={(event) => onChange({ reasonCode: event.target.value })}
        />
      )}

      {draft.type === 'STEP_ACTIVATION' && (
        <Input
          label="ترتیب مرحله"
          id={`${testIdPrefix}-step-order`}
          data-testid={`${testIdPrefix}-step-order`}
          value={draft.stepOrder}
          inputMode="numeric"
          disabled={disabled}
          onChange={(event) => onChange({ stepOrder: event.target.value })}
        />
      )}

      {draft.type === 'LIMIT_REFUSAL' && (
        <div className="flex flex-col gap-2">
          <div className="grid gap-2 sm:grid-cols-3">
            <Input
              label="شناسهٔ سقف"
              id={`${testIdPrefix}-limit-ref`}
              data-testid={`${testIdPrefix}-limit-ref`}
              value={draft.limitRef}
              disabled={disabled}
              onChange={(event) => onChange({ limitRef: event.target.value })}
            />
            <Select
              label="مبنای شمارش"
              id={`${testIdPrefix}-counting-basis`}
              data-testid={`${testIdPrefix}-counting-basis`}
              value={draft.countingBasis}
              disabled={disabled}
              onChange={(event) => onChange({ countingBasis: event.target.value as CountingBasis })}
              options={COUNTING_BASIS_OPTIONS}
            />
            <Input
              label="حداکثر"
              id={`${testIdPrefix}-maximum`}
              data-testid={`${testIdPrefix}-maximum`}
              value={draft.maximum}
              inputMode="numeric"
              disabled={disabled}
              onChange={(event) => onChange({ maximum: event.target.value })}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              label="آغاز بازه"
              id={`${testIdPrefix}-window-start`}
              data-testid={`${testIdPrefix}-window-start`}
              value={draft.windowStart}
              disabled={disabled}
              placeholder="YYYY-MM-DD"
              onChange={(event) => onChange({ windowStart: event.target.value })}
            />
            <Input
              label="پایان بازه"
              id={`${testIdPrefix}-window-end`}
              data-testid={`${testIdPrefix}-window-end`}
              value={draft.windowEnd}
              disabled={disabled}
              placeholder="YYYY-MM-DD"
              onChange={(event) => onChange({ windowEnd: event.target.value })}
            />
          </div>
        </div>
      )}

      {draft.type === 'APPROVER_RESOLUTION' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            label="شناسهٔ قاعدهٔ تأییدکننده"
            id={`${testIdPrefix}-approver-ref`}
            data-testid={`${testIdPrefix}-approver-ref`}
            value={draft.approverRuleRef}
            disabled={disabled}
            placeholder="mission-approval-definition:<uuid>"
            onChange={(event) => onChange({ approverRuleRef: event.target.value })}
          />
          <Select
            label="دلیل تعیین"
            id={`${testIdPrefix}-resolution-reason`}
            data-testid={`${testIdPrefix}-resolution-reason`}
            value={draft.resolutionReason}
            disabled={disabled}
            onChange={(event) =>
              onChange({ resolutionReason: event.target.value as ResolutionReason })
            }
            options={RESOLUTION_REASON_OPTIONS}
          />
        </div>
      )}

      {draft.type === 'NOTIFY' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            label="شناسهٔ قالب"
            id={`${testIdPrefix}-template-ref`}
            data-testid={`${testIdPrefix}-template-ref`}
            value={draft.templateRef}
            disabled={disabled}
            onChange={(event) => onChange({ templateRef: event.target.value })}
          />
          <Select
            label="نقش گیرنده"
            id={`${testIdPrefix}-recipient-role`}
            data-testid={`${testIdPrefix}-recipient-role`}
            value={draft.recipientRole}
            disabled={disabled}
            onChange={(event) => onChange({ recipientRole: event.target.value as RecipientRole })}
            options={RECIPIENT_ROLE_OPTIONS}
          />
        </div>
      )}

      <div>
        <Button
          type="button"
          data-testid={`${testIdPrefix}-remove`}
          disabled={disabled || !canRemove}
          className="bg-muted text-foreground hover:bg-muted/80"
          onClick={onRemove}
        >
          حذف این اقدام
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The rule editor — identity, ranking, one condition tree, ordered actions
// ---------------------------------------------------------------------------

/**
 * ONE RULE being authored.
 *
 * `version` IS NOT HERE. `MissionRuleSpec.version` is the rule's OWN revision label and is a member of
 * the STORED document only — `CreateMissionPolicyVersionDto` has no field for it — so the form does not
 * offer it and `buildCreateInput` mirrors the version the operator typed for the row. Asking for it
 * would advertise a field the request cannot carry.
 *
 * THE ACTIONS ARE EDITED AS AN ORDERED LIST, and the order IS the document's order: the engine's
 * `ruleDecisionSignature` reads the action types in declared order, and §12.3 compares rules by that
 * signature — so the list is presented as ordered and the panel never re-sorts it.
 */
function MissionPolicyRuleEditor({
  draft,
  onChange,
  onRemove,
  canRemove,
  disabled,
  index,
}: {
  draft: RuleDraft;
  onChange: (patch: Partial<RuleDraft>) => void;
  onRemove: () => void;
  canRemove: boolean;
  disabled: boolean;
  index: number;
}) {
  const testIdPrefix = `hr-mission-policy-rule-draft-${index}`;
  const problem = ruleProblem(draft);

  return (
    <div
      className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-3"
      data-testid={testIdPrefix}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Input
          label="شناسهٔ قاعده"
          id={`${testIdPrefix}-id`}
          data-testid={`${testIdPrefix}-id`}
          value={draft.id}
          disabled={disabled}
          onChange={(event) => onChange({ id: event.target.value })}
        />
        <Input
          label="نام قاعده"
          id={`${testIdPrefix}-name`}
          data-testid={`${testIdPrefix}-name`}
          value={draft.name}
          disabled={disabled}
          onChange={(event) => onChange({ name: event.target.value })}
        />
        <Input
          label="اولویت"
          id={`${testIdPrefix}-priority`}
          data-testid={`${testIdPrefix}-priority`}
          value={draft.priority}
          inputMode="numeric"
          disabled={disabled}
          onChange={(event) => onChange({ priority: event.target.value })}
        />
      </div>

      <MissionPolicyConditionEditor
        draft={draft}
        onChange={onChange}
        disabled={disabled}
        testIdPrefix={`${testIdPrefix}-condition`}
      />

      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          اقدام‌های این قاعده — به همین ترتیب در سند ثبت می‌شوند.
        </p>
        {draft.actions.map((action, actionIndex) => (
          <MissionPolicyActionEditor
            key={action.draftId}
            draft={action}
            onChange={(patch) =>
              onChange({
                actions: draft.actions.map((row) =>
                  row.draftId === action.draftId ? { ...row, ...patch } : row
                ),
              })
            }
            onRemove={() =>
              onChange({ actions: draft.actions.filter((row) => row.draftId !== action.draftId) })
            }
            canRemove={draft.actions.length > 1}
            disabled={disabled}
            testIdPrefix={`${testIdPrefix}-action-${actionIndex}`}
          />
        ))}
        <div>
          <Button
            type="button"
            data-testid={`${testIdPrefix}-action-add`}
            disabled={disabled}
            className="bg-muted text-foreground hover:bg-muted/80"
            onClick={() => onChange({ actions: [...draft.actions, blankAction()] })}
          >
            افزودن اقدام
          </Button>
        </div>
      </div>

      {problem !== null && (
        <p
          className="text-xs text-destructive"
          role="alert"
          data-testid={`${testIdPrefix}-problem`}
        >
          {problem}
        </p>
      )}

      <div>
        <Button
          type="button"
          data-testid={`${testIdPrefix}-remove`}
          disabled={disabled || !canRemove}
          className="bg-muted text-foreground hover:bg-muted/80"
          onClick={onRemove}
        >
          حذف این قاعده
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The fact catalogue editor
// ---------------------------------------------------------------------------

/** The five scalar types as `<option>`s. `collection` is absent — see `FieldDraft`. */
const SCALAR_FIELD_TYPE_OPTIONS = SCALAR_FIELD_TYPES.map((type) => ({ value: type, label: type }));

/**
 * ONE declared fact: a name, a type, and — ONLY for `enum` — its allowed values.
 *
 * THE VALUES BOX APPEARS EXACTLY WHEN THE TYPE IS `enum`, which is the one combination the validator
 * accepts: `RuleFieldDeclaration.enumValues` is present precisely when the type is `enum`, and the
 * validator refuses any other pairing. Rendering the box unconditionally would let an operator type
 * values for a `string` fact and receive a `400` the form could have prevented by not asking.
 */
function MissionPolicyFieldEditor({
  draft,
  onChange,
  onRemove,
  canRemove,
  disabled,
  index,
}: {
  draft: FieldDraft;
  onChange: (patch: Partial<FieldDraft>) => void;
  onRemove: () => void;
  canRemove: boolean;
  disabled: boolean;
  index: number;
}) {
  const testIdPrefix = `hr-mission-policy-field-draft-${index}`;

  return (
    <div className="rounded-xl border border-border bg-muted/30 p-2" data-testid={testIdPrefix}>
      <div className="grid gap-2 sm:grid-cols-3">
        <Input
          label="نام واقعیت"
          id={`${testIdPrefix}-name`}
          data-testid={`${testIdPrefix}-name`}
          value={draft.name}
          disabled={disabled}
          onChange={(event) => onChange({ name: event.target.value })}
        />
        <Select
          label="نوع"
          id={`${testIdPrefix}-type`}
          data-testid={`${testIdPrefix}-type`}
          value={draft.type}
          disabled={disabled}
          onChange={(event) => onChange({ type: event.target.value as MissionRuleScalarFieldType })}
          options={SCALAR_FIELD_TYPE_OPTIONS}
        />
        {draft.type === 'enum' && (
          <Input
            label="مقادیر مجاز (با کاما)"
            id={`${testIdPrefix}-enum-values`}
            data-testid={`${testIdPrefix}-enum-values`}
            value={draft.enumValues}
            disabled={disabled}
            onChange={(event) => onChange({ enumValues: event.target.value })}
          />
        )}
      </div>

      <div className="mt-2">
        <Button
          type="button"
          data-testid={`${testIdPrefix}-remove`}
          disabled={disabled || !canRemove}
          className="bg-muted text-foreground hover:bg-muted/80"
          onClick={onRemove}
        >
          حذف این واقعیت
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The lifecycle controls, bound to the SERVER's flags and nothing else
// ---------------------------------------------------------------------------

/**
 * The three transition buttons for ONE version.
 *
 * A BUTTON EXISTS IF AND ONLY IF THE SERVER SET ITS FLAG. There is no `switch (status)` anywhere in
 * this file: `status` is rendered as a badge and never read to decide anything, because the guards that
 * protect the writes live in `mission-policy-version.projection.ts` and a second matrix here could
 * disagree with them. The flags are mutually exclusive today, but nothing below assumes that — if the
 * server ever set two, two buttons would render, which is exactly what the server said.
 *
 * A VERSION WITH NO FLAG SET SAYS SO. Silence would be indistinguishable from a control the panel
 * forgot to render, and an `ARCHIVED` version legitimately has no successor — no route restores one.
 */
function MissionPolicyLifecycleControls({
  version,
  isBusy,
  onTransition,
}: {
  version: HrMissionPolicyVersion;
  isBusy: boolean;
  onTransition: (
    run: (versionId: string) => Promise<HrMissionPolicyVersion>,
    label: string
  ) => void;
}) {
  const offered = LIFECYCLE_ACTIONS.filter((entry) => version.actions[entry.flag]);

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid={`hr-mission-policy-version-controls-${version.version}`}
    >
      {offered.length === 0 ? (
        <span
          className="text-xs text-muted-foreground"
          data-testid={`hr-mission-policy-version-actions-${version.version}`}
        >
          {describeAllowedTransitions(version.actions)}
        </span>
      ) : (
        offered.map((entry) => (
          <Button
            key={entry.flag}
            type="button"
            data-testid={`hr-mission-policy-version-${entry.flag}-${version.version}`}
            disabled={isBusy}
            className="bg-muted text-foreground hover:bg-muted/80"
            onClick={() => onTransition(entry.run, entry.label)}
          >
            {entry.label}
          </Button>
        ))
      )}

      {/* What the SERVER will accept is stated even when buttons are shown, so the absence of the
          other transitions is a statement rather than an omission. */}
      {offered.length > 0 && (
        <span
          className="text-xs text-muted-foreground"
          data-testid={`hr-mission-policy-version-actions-${version.version}`}
        >
          {describeAllowedTransitions(version.actions)}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One stored version
// ---------------------------------------------------------------------------

/**
 * ONE policy version: its stored facts, its declared transitions, and — on demand — its whole document.
 *
 * THE DOCUMENT IS RENDERED IN FULL, AND IT IS THE STORED ONE. `configuration` is what the server read
 * back out of its own `Json` column and what the engine validated, so the panel renders it without
 * summarising it into a count of rules or a list of action types. A summary would be this client's
 * reading of the document, which is the thing the previous step could not do honestly and this one must
 * not do at all.
 *
 * THE DOCUMENT IS NOT EDITABLE, BECAUSE NO ROUTE UPDATES IT. There is no `PATCH` for a policy version
 * in `mission.controller.ts`, so an edit control would open a form whose save button could not exist.
 */
function MissionPolicyVersionRow({
  version,
  isBusy,
  onTransition,
}: {
  version: HrMissionPolicyVersion;
  isBusy: boolean;
  onTransition: (
    run: (versionId: string) => Promise<HrMissionPolicyVersion>,
    label: string
  ) => void;
}) {
  const [isOpen, setOpen] = React.useState(false);

  return (
    <li
      className="flex flex-col gap-3 rounded-xl border border-border bg-muted/30 px-3 py-3"
      data-testid={`hr-mission-policy-version-${version.version}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">v{version.version}</span>
        <HrBadge
          tone={missionPolicyVersionStatusTone(version.status)}
          testId={`hr-mission-policy-version-status-${version.version}`}
        >
          {missionPolicyVersionStatusLabel(version.status)}
        </HrBadge>
        <span className="text-xs text-muted-foreground">مجموعه قواعد: {version.ruleSetId}</span>
      </div>

      {/* The consequence sentence travels WITH the badge, because «منتشرشده» alone does not tell an
          operator whether the version governs today's decisions. */}
      <p
        className="text-xs text-muted-foreground"
        data-testid={`hr-mission-policy-version-meaning-${version.version}`}
      >
        {missionPolicyVersionStatusMeaning(version.status)}
      </p>

      <MissionPolicyLifecycleControls
        version={version}
        isBusy={isBusy}
        onTransition={onTransition}
      />

      <div>
        <Button
          type="button"
          data-testid={`hr-mission-policy-version-document-toggle-${version.version}`}
          className="bg-muted text-foreground hover:bg-muted/80"
          onClick={() => setOpen((value) => !value)}
        >
          {isOpen ? 'بستن سند پیکربندی' : 'نمایش سند پیکربندی'}
        </Button>
      </div>

      {isOpen && <MissionPolicyDocument document={version.configuration} />}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The read-only document renderers
// ---------------------------------------------------------------------------

/**
 * One operand, rendered as the DATA it is.
 *
 * A `dateBetween` operand is a two-element array and a membership operand is a LIST, and both are
 * printed as such — never as a label, because an operand is a VALUE. The bracket form keeps the pair
 * visibly a pair: `dateBetween` is inclusive on both ends, so the two dates must never read as one
 * ambiguous string.
 */
function MissionPolicyOperand({ value }: { value: MissionRuleConditionOperand }) {
  if (Array.isArray(value)) {
    const items: readonly (string | number | boolean)[] = value;
    return (
      <span className="font-mono text-xs text-foreground">
        [{items.map((item) => String(item)).join(' | ')}]
      </span>
    );
  }

  return <span className="font-mono text-xs text-foreground">{String(value)}</span>;
}

/**
 * One `{ field, op, value }` leaf, rendered as the three facts it is.
 *
 * `isEmpty` / `isNotEmpty` carry NO operand — the engine's own rule, not this component's — so the
 * operand is rendered only when one was stored. Printing a placeholder for an absent operand would
 * describe a document the engine accepts as incomplete.
 */
function MissionPolicyComparison({ node }: { node: MissionRuleComparisonCondition }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-xs text-foreground">{node.field}</span>
      <span className="font-mono text-xs text-muted-foreground">{node.op}</span>
      {node.value !== undefined && <MissionPolicyOperand value={node.value} />}
    </span>
  );
}

/** One `{ count: { over, where?, op, value } }` aggregate, in the order the interface declares it. */
function MissionPolicyCount({ node }: { node: MissionRuleCountCondition }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-foreground">{node.count.over}</span>
        <span className="font-mono text-xs text-muted-foreground">{node.count.op}</span>
        <span className="font-mono text-xs text-foreground">{node.count.value}</span>
      </span>
      {/* `where` is OPTIONAL, and its presence changes what is being counted — so it is rendered as a
          nested condition list rather than summarised away. */}
      {node.count.where !== undefined && node.count.where.length > 0 && (
        <ul className="border-r border-border pr-3">
          {node.count.where.map((child, childIndex) => (
            <MissionPolicyCondition key={childIndex} node={child} index={childIndex} />
          ))}
        </ul>
      )}
    </span>
  );
}

/** One declared fact. `enumValues` is printed only when the type is `enum`, matching the validator. */
export function MissionPolicyFieldRow({
  entry,
  index,
}: {
  entry: MissionRuleFieldCatalogueEntry;
  index: number;
}) {
  const isCollection = entry.type === 'collection';

  return (
    <li
      className="flex flex-col gap-1 rounded-xl border border-border bg-muted/30 px-3 py-2 text-sm"
      data-testid={`hr-mission-policy-field-${index}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-foreground">{entry.name}</span>
        <HrBadge tone="muted" testId={`hr-mission-policy-field-type-${index}`}>
          {entry.type}
        </HrBadge>
        {/* `maxSize` is a COLLECTION field's own declaration: the hard maximum of records the
            application layer may supply. Printed because it is part of the accepted document, and
            never edited here — the client does not supply the records. */}
        {isCollection && (
          <span className="text-xs text-muted-foreground">
            حداکثر اندازه: <span className="font-mono">{entry.maxSize}</span>
          </span>
        )}
      </div>

      {entry.type === 'enum' && (
        <p
          className="text-xs text-muted-foreground"
          data-testid={`hr-mission-policy-field-enum-values-${index}`}
        >
          مقادیر مجاز: <span className="font-mono">{(entry.enumValues ?? []).join(' | ')}</span>
        </p>
      )}

      {/* A collection's `itemFields` are declared fields, one level deep and never nested — so this
          renders the SAME statement recursively rather than inventing a second shape. */}
      {isCollection && (
        <ul
          className="mt-1 flex flex-col gap-1 border-r border-border pr-3"
          data-testid={`hr-mission-policy-field-item-fields-${index}`}
        >
          {entry.itemFields.map((item, itemIndex) => (
            <MissionPolicyFieldRow
              key={`${entry.name}-${item.name}`}
              entry={item}
              index={itemIndex}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * ONE condition node, rendered by the LITERAL KEY it carries.
 *
 * The union has no `kind` member — the engine tells the node kinds apart by which key is present — so
 * this renderer reads the same keys and nothing else. It is a READER, not an evaluator: it never
 * decides whether a node holds, never orders nodes, never reports a count, and never compares an
 * operand against anything.
 */
function MissionPolicyCondition({
  node,
  index,
}: {
  node: MissionRuleConditionNode;
  index: number;
}) {
  if ('all' in node) {
    return (
      <li className="flex flex-col gap-1" data-testid={`hr-mission-policy-condition-${index}`}>
        <span className="text-xs text-muted-foreground">{CONDITION_KIND_LABELS.all}</span>
        <ul className="flex flex-col gap-1 border-r border-border pr-3">
          {node.all.map((child, childIndex) => (
            <MissionPolicyCondition key={childIndex} node={child} index={childIndex} />
          ))}
        </ul>
      </li>
    );
  }

  if ('any' in node) {
    return (
      <li className="flex flex-col gap-1" data-testid={`hr-mission-policy-condition-${index}`}>
        <span className="text-xs text-muted-foreground">{CONDITION_KIND_LABELS.any}</span>
        <ul className="flex flex-col gap-1 border-r border-border pr-3">
          {node.any.map((child, childIndex) => (
            <MissionPolicyCondition key={childIndex} node={child} index={childIndex} />
          ))}
        </ul>
      </li>
    );
  }

  if ('not' in node) {
    return (
      <li className="flex flex-col gap-1" data-testid={`hr-mission-policy-condition-${index}`}>
        <span className="text-xs text-muted-foreground">{CONDITION_KIND_LABELS.not}</span>
        <ul className="border-r border-border pr-3">
          <MissionPolicyCondition node={node.not} index={0} />
        </ul>
      </li>
    );
  }

  if ('count' in node) {
    return (
      <li className="flex flex-col gap-1" data-testid={`hr-mission-policy-condition-${index}`}>
        <span className="text-xs text-muted-foreground">{CONDITION_KIND_LABELS.count}</span>
        <MissionPolicyCount node={node} />
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-1" data-testid={`hr-mission-policy-condition-${index}`}>
      <span className="text-xs text-muted-foreground">{CONDITION_KIND_LABELS.field}</span>
      <MissionPolicyComparison node={node} />
    </li>
  );
}

/**
 * THE CONDITION-KIND CENSUS of one document, computed by LOOKING FOR KEYS and nothing else.
 *
 * WHY A CENSUS RATHER THAN A TREE WALK. A spec — and an operator — must be able to verify that a
 * document uses the node kinds the engine declares, including the kinds that appear only NESTED,
 * inside an `all`, a `not` or a `count.where`, where a top-level look would miss them. Counting by key
 * over the whole tree answers "is `count` represented here?" without evaluating anything: no operator
 * is applied, no fact is resolved, no ordering is inferred. The recursion descends exactly the
 * children the interface declares — `all`/`any` arrays, `not` single, `count.where` array — and stops
 * there, because there is no fifth child position in the model.
 */
export function conditionKindCounts(root: MissionRuleConditionNode): Record<ConditionKind, number> {
  const seen: Record<ConditionKind, number> = { all: 0, any: 0, not: 0, field: 0, count: 0 };

  const visit = (node: MissionRuleConditionNode) => {
    for (const kind of CONDITION_KINDS) {
      if (kind === 'all' && 'all' in node) seen.all += 1;
      if (kind === 'any' && 'any' in node) seen.any += 1;
      if (kind === 'not' && 'not' in node) seen.not += 1;
      if (kind === 'count' && 'count' in node) seen.count += 1;
      if (kind === 'field' && 'field' in node) seen.field += 1;
    }

    if ('all' in node) node.all.forEach(visit);
    if ('any' in node) node.any.forEach(visit);
    if ('not' in node) visit(node.not);
    if ('count' in node && node.count.where !== undefined) node.count.where.forEach(visit);
  };

  visit(root);

  return seen;
}

/**
 * ONE action, rendered by its `type` and then by ITS OWN parameters.
 *
 * EVERY BRANCH READS ONLY THE FIELDS ITS TYPE DECLARES. The union is discriminated by `type` and the
 * seven members carry different field sets, so a renderer that read `stepOrder` off an `AUTO_APPROVE`
 * would be describing a document the validator refuses. The `default` branch is therefore NOT dead
 * code: it is the exhaustiveness fence — a member whose fields this renderer does not know renders as
 * its token and nothing else, rather than as a guess.
 */
function MissionPolicyAction({ action, index }: { action: MissionRuleAction; index: number }) {
  if (action.type === 'REQUIRED_APPROVAL_STEP') {
    return (
      <ActionRow action={action} index={index}>
        <ActionField label="ترتیب مرحله" value={String(action.stepOrder)} />
        <ActionField label="شناسهٔ قاعدهٔ تأییدکننده" value={action.approverRuleRef} />
      </ActionRow>
    );
  }

  if (action.type === 'AUTO_APPROVE') {
    return <ActionRow action={action} index={index} />;
  }

  if (action.type === 'AUTO_REJECT') {
    return (
      <ActionRow action={action} index={index}>
        <ActionField label="کد دلیل" value={action.reasonCode} />
      </ActionRow>
    );
  }

  if (action.type === 'LIMIT_REFUSAL') {
    return (
      <ActionRow action={action} index={index}>
        <ActionField label="شناسهٔ سقف" value={action.limitRef} />
        <ActionField label="مبنای شمارش" value={action.countingBasis} />
        <ActionField label="حداکثر" value={String(action.maximum)} />
        <ActionField label="آغاز بازه" value={action.windowStart} />
        <ActionField label="پایان بازه" value={action.windowEnd} />
      </ActionRow>
    );
  }

  if (action.type === 'STEP_ACTIVATION') {
    return (
      <ActionRow action={action} index={index}>
        <ActionField label="ترتیب مرحله" value={String(action.stepOrder)} />
      </ActionRow>
    );
  }

  if (action.type === 'APPROVER_RESOLUTION') {
    return (
      <ActionRow action={action} index={index}>
        <ActionField label="شناسهٔ قاعدهٔ تأییدکننده" value={action.approverRuleRef} />
        <ActionField label="دلیل تعیین" value={action.resolutionReason} />
      </ActionRow>
    );
  }

  return (
    <ActionRow action={action} index={index}>
      <ActionField label="شناسهٔ قالب" value={action.templateRef} />
      <ActionField label="نقش گیرنده" value={action.recipientRole} />
    </ActionRow>
  );
}

/** One action's frame: the engine's TOKEN, its Persian title, and its own parameters beneath. */
function ActionRow({
  action,
  index,
  children,
}: {
  action: MissionRuleAction;
  index: number;
  children?: React.ReactNode;
}) {
  return (
    <li
      className="flex flex-col gap-1 rounded-xl border border-border bg-muted/30 px-3 py-2"
      data-testid={`hr-mission-policy-action-${index}`}
    >
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-foreground">{action.type}</span>
        <span className="text-xs text-muted-foreground">{ACTION_TYPE_LABELS[action.type]}</span>
      </span>
      {children !== undefined ? (
        <dl className="flex flex-wrap gap-x-4 gap-y-1">{children}</dl>
      ) : (
        /* `AUTO_APPROVE` declares NO parameters, and saying so is different from rendering nothing:
           an empty row would read as a field the panel forgot to show. */
        <span className="text-xs text-muted-foreground">{ACTION_TYPE_PARAMETERS[action.type]}</span>
      )}
    </li>
  );
}

/** One `label → value` pair of an action's own parameters. The value is DATA, printed verbatim. */
function ActionField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1">
      <dt className="text-xs text-muted-foreground">{label}:</dt>
      <dd className="font-mono text-xs text-foreground">{value}</dd>
    </div>
  );
}

/**
 * THE STORED DOCUMENT, rendered in full: the version frame, the fact catalogue, and every rule with
 * its condition tree and its ordered actions.
 *
 * WHAT IT STATES THAT THE REQUEST DOES NOT CARRY. `version`, `status`, `supersedes`, `effectiveFrom`,
 * `effectiveTo` and `rules[].version` are members of the STORED `RuleSetVersion` and of NO request DTO,
 * so they are rendered as the stored facts they are — muted, and beside the fields the request does
 * carry. Making them editable would advertise a write route that does not exist (there is no update
 * route for a policy version at all).
 *
 * THE RULE ORDER IS RENDERED AS DECLARED AND IS NOT INTERPRETED. `priority` is printed because it is
 * part of the document; nothing here derives which rule would win, which is the engine's answer.
 */
function MissionPolicyDocument({ document }: { document: MissionRuleSetVersion }) {
  return (
    <div className="flex flex-col gap-3" data-testid="hr-mission-policy-document">
      <dl className="grid gap-3 sm:grid-cols-3">
        <HrField label="شناسهٔ مجموعه قواعد">
          <span className="font-mono text-xs">{document.ruleSetId}</span>
        </HrField>
        <HrField label="نسخهٔ سند">
          <span className="font-mono text-xs">{document.version}</span>
        </HrField>
        <HrField label="نسخهٔ طرح‌واره">
          <span className="font-mono text-xs">{document.schemaVersion}</span>
        </HrField>
        <HrField label="وضعیت سند">
          <span className="font-mono text-xs">{document.status}</span>
        </HrField>
      </dl>

      <div data-testid="hr-mission-policy-fields">
        <p className="mb-2 text-xs text-muted-foreground">
          واقعیت‌های اعلام‌شده در این سند (نام و نوع آن‌ها همان است که موتور ارزیابی می‌شناسد):
        </p>
        {document.fields.length === 0 ? (
          <CoreEmpty message="این سند هیچ واقعیتی اعلام نکرده است." />
        ) : (
          <ul className="flex flex-col gap-2">
            {document.fields.map((entry, index) => (
              <MissionPolicyFieldRow key={entry.name} entry={entry} index={index} />
            ))}
          </ul>
        )}
      </div>

      <div data-testid="hr-mission-policy-rules">
        {document.rules.length === 0 ? (
          <CoreEmpty message="این سند هیچ قاعده‌ای ندارد." />
        ) : (
          <ol className="flex flex-col gap-3">
            {document.rules.map((rule, index) => (
              <li
                key={rule.id}
                className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3"
                data-testid={`hr-mission-policy-rule-${index}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-foreground">{rule.id}</span>
                  <span className="text-sm text-foreground">{rule.name}</span>
                  <HrBadge tone="muted" testId={`hr-mission-policy-rule-priority-${index}`}>
                    اولویت: {rule.priority}
                  </HrBadge>
                  {/* A rule's OWN revision label. Rendered as stored; the request has no field for
                      it, so it is never typed by anybody. */}
                  <span className="font-mono text-xs text-muted-foreground">
                    revision: {rule.version}
                  </span>
                </div>

                <div>
                  <p className="mb-1 text-xs text-muted-foreground">شرط:</p>
                  <ul className="flex flex-col gap-1">
                    <MissionPolicyCondition node={rule.condition} index={index} />
                  </ul>
                </div>

                <div>
                  <p className="mb-1 text-xs text-muted-foreground">اقدام‌ها (به ترتیب اعلام):</p>
                  <ul
                    className="flex flex-col gap-2"
                    data-testid={`hr-mission-policy-rule-actions-${index}`}
                  >
                    {rule.actions.map((action, actionIndex) => (
                      <MissionPolicyAction
                        key={`${rule.id}-${actionIndex}`}
                        action={action}
                        index={actionIndex}
                      />
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The create form's two list builders
// ---------------------------------------------------------------------------

/** The fact catalogue being authored, as an ordered list of declared facts. */
function MissionPolicyFieldsBuilder({
  fields,
  onChange,
  disabled,
}: {
  fields: FieldDraft[];
  onChange: (next: FieldDraft[]) => void;
  disabled: boolean;
}) {
  return (
    <div data-testid="hr-mission-policy-new-fields">
      <p className="mb-2 text-sm font-medium text-foreground">واقعیت‌های این نسخه (نام و نوع)</p>
      <div className="flex flex-col gap-2">
        {fields.map((field, index) => (
          <MissionPolicyFieldEditor
            key={field.draftId}
            draft={field}
            index={index}
            onChange={(patch) =>
              onChange(
                fields.map((row) => (row.draftId === field.draftId ? { ...row, ...patch } : row))
              )
            }
            onRemove={() => onChange(fields.filter((row) => row.draftId !== field.draftId))}
            canRemove={fields.length > 1}
            disabled={disabled}
          />
        ))}
      </div>
      <div className="mt-2">
        <Button
          type="button"
          data-testid="hr-mission-policy-new-field-add"
          disabled={disabled}
          className="bg-muted text-foreground hover:bg-muted/80"
          onClick={() => onChange([...fields, blankField()])}
        >
          افزودن واقعیت
        </Button>
      </div>
    </div>
  );
}

/** The rules being authored, in DECLARED ORDER — the order the engine reads their actions in. */
function MissionPolicyRulesBuilder({
  rules,
  onChange,
  disabled,
}: {
  rules: RuleDraft[];
  onChange: (next: RuleDraft[]) => void;
  disabled: boolean;
}) {
  return (
    <div data-testid="hr-mission-policy-new-rules">
      <p className="mb-2 text-sm font-medium text-foreground">قاعده‌ها</p>
      <div className="flex flex-col gap-3">
        {rules.map((rule, index) => (
          <MissionPolicyRuleEditor
            key={rule.draftId}
            draft={rule}
            index={index}
            onChange={(patch) =>
              onChange(
                rules.map((row) => (row.draftId === rule.draftId ? { ...row, ...patch } : row))
              )
            }
            onRemove={() => onChange(rules.filter((row) => row.draftId !== rule.draftId))}
            canRemove={rules.length > 1}
            disabled={disabled}
          />
        ))}
      </div>
      <div className="mt-2">
        <Button
          type="button"
          data-testid="hr-mission-policy-new-rule-add"
          disabled={disabled}
          className="bg-muted text-foreground hover:bg-muted/80"
          onClick={() => onChange([...rules, blankRule(rules.length + 1)])}
        >
          افزودن قاعده
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The create form
// ---------------------------------------------------------------------------

/**
 * The CREATE form: the four fields the request DTO carries, and nothing else.
 *
 * THE FOUR FIELDS ARE THE DTO'S OWN. `CreateMissionPolicyVersionDto` is
 * `{ version, label, ruleSetId?, configuration }`, so the form takes a version number, a label, the rule
 * set id, and the document's facts and rules. It does NOT take the document's `status` (the server
 * creates a `DRAFT`), its `supersedes`/`effectiveFrom`/`effectiveTo` (in no request), or a rule's
 * `version` (mirrored from the row's version) — each of those is stated in the form so the omission is
 * visible rather than surprising.
 *
 * IT CAN BE CANCELLED, AND CANCELLING DISCARDS THE DRAFT. A half-authored rule set is not a document
 * anybody wants kept, and no route stores a draft of one — so an open form never survives its own cancel,
 * and the panel creates a fresh one each time it is opened.
 */
function MissionPolicyCreateForm({
  isSaving,
  onSubmit,
  onCancel,
}: {
  isSaving: boolean;
  onSubmit: (input: CreateMissionPolicyVersionInput) => void;
  onCancel: () => void;
}) {
  const [version, setVersion] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [ruleSetId, setRuleSetId] = React.useState(MISSION_RULE_SET_ID);
  const [fields, setFields] = React.useState<FieldDraft[]>(() => [blankField()]);
  const [rules, setRules] = React.useState<RuleDraft[]>(() => [blankRule(1)]);

  const disabled = isSaving;

  const versionProblem = /^\d+$/.test(version.trim())
    ? null
    : 'شمارهٔ نسخه باید عددی و نامنفی باشد.';
  const labelProblem = label.trim() === '' ? 'عنوان نسخه الزامی است.' : null;
  const ruleSetProblem = ruleSetId.trim() === '' ? 'شناسهٔ مجموعه قواعد الزامی است.' : null;
  const fieldProblem = fields.some((field) => field.name.trim() === '')
    ? 'هر واقعیت به نام نیاز دارد.'
    : null;
  const ruleProblems = rules
    .map((rule) => ruleProblem(rule))
    .filter((problem): problem is string => problem !== null);

  const blocked =
    versionProblem !== null ||
    labelProblem !== null ||
    ruleSetProblem !== null ||
    fieldProblem !== null ||
    rules.length === 0 ||
    ruleProblems.length > 0;

  return (
    <HrCard title="نسخهٔ جدید خط‌مشی" testId="hr-mission-policy-create">
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Input
            label="شمارهٔ نسخه"
            id="hr-mission-policy-new-version"
            data-testid="hr-mission-policy-new-version"
            value={version}
            inputMode="numeric"
            disabled={disabled}
            onChange={(event) => setVersion(event.target.value)}
          />
          <Input
            label="عنوان نسخه"
            id="hr-mission-policy-new-label"
            data-testid="hr-mission-policy-new-label"
            value={label}
            disabled={disabled}
            onChange={(event) => setLabel(event.target.value)}
          />
          <Input
            label="شناسهٔ مجموعه قواعد"
            id="hr-mission-policy-new-rule-set"
            data-testid="hr-mission-policy-new-rule-set"
            value={ruleSetId}
            disabled={disabled}
            onChange={(event) => setRuleSetId(event.target.value)}
          />
        </div>

        {/* WHAT THE REQUEST CANNOT CARRY, STATED ON THE FORM. The stored document has a `status` the
            server sets, and STORED-only members beside it; a version is authored once and thereafter only
            transitions, because no route updates one. */}
        <p className="rounded-xl border border-border bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          نسخه به‌صورت «پیش‌نویس» ثبت می‌شود و وضعیت سند همان وضعیت ردیف است؛ پس از ثبت فقط گذارهای
          اعتبارسنجی، انتشار و بایگانی در دسترس‌اند و سند دیگر ویرایش نمی‌شود.
        </p>

        <MissionPolicyFieldsBuilder fields={fields} onChange={setFields} disabled={disabled} />

        <MissionPolicyRulesBuilder rules={rules} onChange={setRules} disabled={disabled} />

        {blocked && !disabled && (
          <p
            className="text-xs text-destructive"
            role="alert"
            data-testid="hr-mission-policy-new-problem"
          >
            {versionProblem ?? labelProblem ?? ruleSetProblem ?? fieldProblem ?? ruleProblems[0]}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            data-testid="hr-mission-policy-new-submit"
            disabled={disabled || blocked}
            onClick={() => onSubmit(buildCreateInput(version, label, ruleSetId, fields, rules))}
          >
            ثبت نسخه
          </Button>
          <Button
            type="button"
            data-testid="hr-mission-policy-new-cancel"
            disabled={disabled}
            className="bg-muted text-foreground hover:bg-muted/80"
            onClick={onCancel}
          >
            انصراف
          </Button>
        </div>
      </div>
    </HrCard>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/**
 * DOMAIN 3's surface: the Mission rule-set versions, the form that authors one, and the three
 * transitions the server declares for each stored row.
 *
 * THE PANEL IS THE SAME SHAPE AS THE OTHER TWO DOMAINS' PANELS, ON PURPOSE. `canWrite` is checked by the
 * caller — `HrMissionConfigurationView` holds `hr.mission.policy` for every route behind this screen,
 * reads included — so in production this is always `true`. The guard is kept because these specs mount
 * the panel directly and the FORBIDDEN state has to be provable ON THE SURFACE THE GRANT APPLIES TO: a
 * read that would 403 is a request the grants do not cover, so the panel issues NOTHING rather than
 * letting the server refuse it.
 *
 * AFTER EVERY WRITE THE LIST IS RE-READ, NEVER PATCHED. Creating a version, validating it, publishing it
 * and archiving it all change what the server reports — the status, the `actions`, and possibly which
 * version is in force — so the panel re-issues the SAME read that produced the rows. A client that
 * updated its own copy would be reporting its own guess about a lifecycle it does not own, and the
 * `actions` flags it renders would then be stale in exactly the way that matters.
 *
 * ERRORS AND SUCCESS ARE BOTH SPOKEN. A rejected create (a `400` naming a failing path) and a rejected
 * transition (a `409` naming the state guard) are different sentences, so each reports the API's own
 * message when it has one and the panel's own sentence otherwise.
 */
export function MissionPolicyVersionPanel({ canWrite }: { canWrite: boolean }) {
  const [versions, setVersions] = React.useState<HrMissionPolicyVersion[]>([]);
  const [isLoading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  // Re-arms loading/cleared in `refresh` (same commit as the token bump), so
  // the list effect needs no in-effect setter resets. First mount is covered
  // by `isLoading: true`, and the `!canWrite` render gate precedes the spinner.
  const { token: reloadToken, reload: refresh } = useReloadToken(setLoading, setError);

  const [isCreating, setCreating] = React.useState(false);
  const [isSavingNew, setSavingNew] = React.useState(false);
  const [isTransitioning, setTransitioning] = React.useState(false);

  /**
   * The list read: once per load and once per successful mutation — the SAME read that produced the
   * rows, re-issued. `active` guards the state writes so a slow response cannot land after unmount.
   */
  React.useEffect(() => {
    if (!canWrite) return;

    let active = true;

    fetchMissionPolicyVersions()
      .then((result) => {
        if (!active) return;
        setVersions(result.items);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setVersions([]);
        setError(describe(err, 'دریافت نسخه‌های خط‌مشی ماموریت با خطا مواجه شد.'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [canWrite, reloadToken]);

  const afterWrite = React.useCallback(
    (message: string) => {
      setNotice(message);
      refresh();
    },
    [refresh]
  );

  const createVersion = async (input: CreateMissionPolicyVersionInput) => {
    if (isSavingNew) return;
    setSavingNew(true);
    setError(null);
    setNotice(null);
    try {
      await createMissionPolicyVersion(input);
      // The form is CLOSED and rebuilt empty: a created version is a stored one, and the form holds no
      // draft of it — the row that now exists is rendered from the server's own answer.
      setCreating(false);
      afterWrite('نسخهٔ خط‌مشی ماموریت ثبت شد.');
    } catch (err: unknown) {
      setError(describe(err, 'ثبت نسخهٔ خط‌مشی ماموریت با خطا مواجه شد.'));
    } finally {
      setSavingNew(false);
    }
  };

  const transition = async (
    versionId: string,
    run: (versionId: string) => Promise<HrMissionPolicyVersion>,
    label: string
  ) => {
    if (isTransitioning) return;
    setTransitioning(true);
    setError(null);
    setNotice(null);
    try {
      // `run` is the SERVER's own client function for the flag the server set — never a locally chosen
      // one — and the id is the row the operator pressed it on.
      await run(versionId);
      afterWrite(`گذار «${label}» انجام شد.`);
    } catch (err: unknown) {
      setError(describe(err, `گذار «${label}» با خطا مواجه شد.`));
    } finally {
      setTransitioning(false);
    }
  };

  if (!canWrite) {
    return (
      <HrCard testId="hr-mission-policy-versions-forbidden">
        <CoreForbidden message="برای پیکربندی خط‌مشی ماموریت به مجوز hr.mission.policy نیاز دارید." />
      </HrCard>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="hr-mission-policy-panel">
      {notice !== null && <HrNotice tone="ok" message={notice} />}

      {error !== null && !isLoading && <CoreError message={error} onRetry={refresh} />}

      <HrCard title="نسخه‌های خط‌مشی ماموریت" testId="hr-mission-policy-versions">
        {isLoading ? (
          <CoreLoading lines={4} />
        ) : versions.length === 0 ? (
          <CoreEmpty message="هیچ نسخه‌ای از خط‌مشی ماموریت ثبت نشده است." />
        ) : (
          <ul className="flex flex-col gap-3" data-testid="hr-mission-policy-version-list">
            {versions.map((version) => (
              <MissionPolicyVersionRow
                key={version.id}
                version={version}
                isBusy={isTransitioning}
                onTransition={(run, label) => transition(version.id, run, label)}
              />
            ))}
          </ul>
        )}
      </HrCard>

      {isCreating ? (
        <MissionPolicyCreateForm
          isSaving={isSavingNew}
          onSubmit={createVersion}
          onCancel={() => setCreating(false)}
        />
      ) : (
        <div>
          <Button
            type="button"
            data-testid="hr-mission-policy-create-open"
            onClick={() => setCreating(true)}
          >
            نسخهٔ جدید
          </Button>
        </div>
      )}
    </div>
  );
}
