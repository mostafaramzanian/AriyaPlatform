'use client';

import {
  buildCommerceSimpleCondition,
  commerceRuleOperatorsFor,
  COMMERCE_WORKFLOW_DOCUMENT_FACTS,
  type CommerceRuleFact,
  type CommerceSimpleConditionDraft,
} from '@/lib/commerce-api';
import {
  commerceComparisonOperatorLabel,
  commerceRuleEnumValueLabel,
  commerceRuleFactLabel,
} from '@/lib/commerce-labels';

/**
 * PHASE UI-4 (§10/§11): the SIMPLE condition authoring surface — and deliberately
 * NOTHING MORE.
 *
 * WHAT IT AUTHORS: exactly one leaf of the platform engine's frozen grammar,
 * `{ field, op, value }`, over the frozen fact catalogue the backend validates against.
 * The field select offers ONLY the catalogue's facts, the operator select offers ONLY
 * the operators the engine pairs with that fact's TYPE, and the operand input follows
 * the operand's shape (none for `isEmpty`/`isNotEmpty`, one scalar otherwise). Nothing
 * here evaluates anything — the browser never decides business behaviour; the Rule
 * Engine remains the only evaluator, and publish re-validates everything server-side.
 *
 * WHAT IT DELIBERATELY DOES NOT AUTHOR: composite trees (`all`/`any`/`not`/`count`),
 * array operands (`in`/`notIn`) and date ranges. Those shapes are storable, so a stored
 * one is shown READ-ONLY as «شرط ترکیبی» — building a partial tree editor that might
 * mangle a real condition would be the fake rule builder the brief forbids. The honest
 * boundary: simple in, simple out; anything else is displayed and never rewritten.
 */

export function CommerceWorkflowConditionEditor({
  kind,
  simple,
  complexPresent,
  onKindChange,
  onSimpleChange,
  disabled = false,
  facts = COMMERCE_WORKFLOW_DOCUMENT_FACTS,
  allowNone = true,
  testId,
}: {
  /** What the stored condition IS: none / simple leaf / composite (read-only). */
  kind: 'none' | 'simple' | 'complex';
  simple: CommerceSimpleConditionDraft | null;
  /** True when a composite condition exists on the stored row. */
  complexPresent: boolean;
  onKindChange: (kind: 'none' | 'simple' | 'complex') => void;
  onSimpleChange: (draft: CommerceSimpleConditionDraft) => void;
  disabled?: boolean;
  /** The catalogue this condition speaks (document facts by default, line facts for rules). */
  facts?: readonly CommerceRuleFact[];
  /** `false` hides «بدون شرط» — a CONDITIONAL step must state a condition (backend rule). */
  allowNone?: boolean;
  testId?: string;
}) {
  const fact = facts.find((candidate) => candidate.name === (simple?.field ?? facts[0]?.name)) ?? facts[0];
  const operators = fact ? commerceRuleOperatorsFor(fact) : [];

  const currentOp = fact && simple && operators.includes(simple.op) ? simple.op : (operators[0] ?? '');
  const opTakesValue = currentOp !== '' && currentOp !== 'isEmpty' && currentOp !== 'isNotEmpty';

  return (
    <fieldset className="space-y-2" data-testid={testId}>
      <legend className="text-sm font-medium text-foreground">شرط فعال‌سازی</legend>

      <div className="flex flex-wrap gap-3 text-xs text-foreground">
        {allowNone && (
          <label className="inline-flex items-center gap-1.5">
            <input
              type="radio"
              name={`${testId ?? 'condition'}-kind`}
              value="none"
              checked={kind === 'none'}
              disabled={disabled}
              onChange={() => onKindChange('none')}
              data-testid={testId ? `${testId}-none` : undefined}
            />
            بدون شرط (همیشه)
          </label>
        )}
        <label className="inline-flex items-center gap-1.5">
          <input
            type="radio"
            name={`${testId ?? 'condition'}-kind`}
            value="simple"
            checked={kind === 'simple'}
            disabled={disabled || (complexPresent && kind === 'complex')}
            onChange={() => onKindChange('simple')}
            data-testid={testId ? `${testId}-simple` : undefined}
          />
          شرط ساده
        </label>
        {complexPresent && (
          <label className="inline-flex items-center gap-1.5">
            <input
              type="radio"
              name={`${testId ?? 'condition'}-kind`}
              value="complex"
              checked={kind === 'complex'}
              disabled={disabled}
              onChange={() => onKindChange('complex')}
              data-testid={testId ? `${testId}-complex` : undefined}
            />
            شرط ترکیبی (فقط نمایش)
          </label>
        )}
      </div>

      {kind === 'complex' && (
        <p
          className="rounded-xl border border-dashed border-border px-3 py-2 text-xs text-muted-foreground"
          data-testid={testId ? `${testId}-complex-note` : undefined}
        >
          این مرحله شرط ترکیبی دارد که ویرایش آن از رابط کاربری پشتیبانی نمی‌شود؛ مقدار ثبت‌شده
          دست‌نخورده می‌ماند و تنها با جایگزینی صریح تغییر می‌کند.
        </p>
      )}

      {kind === 'simple' && fact && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <label
              htmlFor={`${testId ?? 'condition'}-field`}
              className="block text-xs font-medium text-foreground"
            >
              ویژگی
            </label>
            <select
              id={`${testId ?? 'condition'}-field`}
              value={fact.name}
              disabled={disabled}
              onChange={(event) => {
                const field = event.target.value;
                const target = facts.find((candidate) => candidate.name === field);
                const allowed = target ? commerceRuleOperatorsFor(target) : [];
                const op = allowed.includes(currentOp) ? currentOp : (allowed[0] ?? '');
                const takesValue = op !== 'isEmpty' && op !== 'isNotEmpty';
                onSimpleChange({
                  field,
                  op,
                  ...(takesValue
                    ? { value: simple?.value ?? (target?.type === 'number' ? 0 : '') }
                    : {}),
                });
              }}
              data-testid={testId ? `${testId}-field` : undefined}
              className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
            >
              {facts.map((candidate) => (
                <option key={candidate.name} value={candidate.name}>
                  {commerceRuleFactLabel(candidate.name)}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label
              htmlFor={`${testId ?? 'condition'}-op`}
              className="block text-xs font-medium text-foreground"
            >
              شرط
            </label>
            <select
              id={`${testId ?? 'condition'}-op`}
              value={currentOp}
              disabled={disabled}
              onChange={(event) => {
                const op = event.target.value;
                const takesValue = op !== 'isEmpty' && op !== 'isNotEmpty';
                onSimpleChange({
                  field: fact.name,
                  op,
                  ...(takesValue
                    ? { value: simple?.value ?? (fact.type === 'number' ? 0 : '') }
                    : {}),
                });
              }}
              data-testid={testId ? `${testId}-op` : undefined}
              className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
            >
              {operators.map((operator) => (
                <option key={operator} value={operator}>
                  {commerceComparisonOperatorLabel(operator)}
                </option>
              ))}
            </select>
          </div>

          {opTakesValue && (
            <div className="space-y-1">
              <label
                htmlFor={`${testId ?? 'condition'}-value`}
                className="block text-xs font-medium text-foreground"
              >
                مقدار
              </label>
              {fact.type === 'enum' && fact.enumValues ? (
                <select
                  id={`${testId ?? 'condition'}-value`}
                  value={String(simple?.value ?? fact.enumValues[0] ?? '')}
                  disabled={disabled}
                  onChange={(event) =>
                    onSimpleChange({ field: fact.name, op: currentOp, value: event.target.value })
                  }
                  data-testid={testId ? `${testId}-value` : undefined}
                  className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
                >
                  {fact.enumValues.map((member) => (
                    <option key={member} value={member}>
                      {commerceRuleEnumValueLabel(member)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`${testId ?? 'condition'}-value`}
                  type={fact.type === 'number' ? 'number' : 'text'}
                  value={simple?.value !== undefined ? String(simple.value) : ''}
                  disabled={disabled}
                  onChange={(event) =>
                    onSimpleChange({
                      field: fact.name,
                      op: currentOp,
                      value:
                        fact.type === 'number'
                          ? event.target.value === ''
                            ? ''
                            : Number(event.target.value)
                          : event.target.value,
                    })
                  }
                  data-testid={testId ? `${testId}-value` : undefined}
                  className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
                />
              )}
            </div>
          )}
        </div>
      )}

      {kind === 'simple' && simple && !opTakesValue && (
        <p className="text-xs text-muted-foreground">
          این شرط مقدار نمی‌گیرد؛ فقط وجود مقدار برای «{commerceRuleFactLabel(simple.field)}»
          بررسی می‌شود.
        </p>
      )}
    </fieldset>
  );
}

/**
 * Build the wire payload for the editor's current state — `null` for «بدون شرط» and the
 * engine's own leaf for «شرط ساده». Exported so the step editor and its tests share ONE
 * mapping (and no caller re-implements the shape).
 */
export function conditionPayloadFor(
  kind: 'none' | 'simple' | 'complex',
  simple: CommerceSimpleConditionDraft | null
): Record<string, unknown> | null {
  if (kind === 'simple' && simple) return buildCommerceSimpleCondition(simple);
  return null;
}
