'use client';

import * as React from 'react';
import { HrBadge, HrCard, HrField, HrNotice } from '@/components/hr/hr-ui';
import {
  HR_LEAVE_LIMIT_RULE_SET_ID,
  hrLeaveLimitCountingBasisLabel,
  hrLeavePolicyVersionStatusLabel,
  hrLeavePolicyVersionStatusMeaning,
  hrLeavePolicyVersionStatusTone,
  hrSimulationDecisionLabel,
  simulateLeavePolicyVersion,
  type HrLeavePolicySimulationResult,
  type HrLeavePolicyVersion,
  type HrSimulatedLimitGrounds,
  type HrSimulationExplanation,
} from '@/lib/hr-leave-policy-api';

/**
 * Phase 54-I (§13, §14, §27, §32): the SIMULATION PANEL.
 *
 * WHAT THIS COMPONENT IS ALLOWED TO DO, AND WHAT IT MUST NOT
 * ----------------------------------------------------------
 * It collects the coordinates of a question, sends them, and RENDERS THE ANSWER IT RECEIVES. It does
 * not compute rule outcomes, does not re-run any limit arithmetic, and does not reconstruct a single
 * withheld field.
 *
 * The explanation arrives ALREADY PROJECTED to this surface's evidence level (§27.2). A field that is
 * `null`, `[]` or absent did not merely fail to arrive — the server WITHHELD it, because this HR
 * configuration surface is not the platform-administrator surface (§31). So the renderer states "not
 * available at this level" and stops; filling that gap by inference is exactly the behaviour §27.2's
 * "role-appropriate projection, not client-side filtering of a fat response" forbids.
 *
 * THE BANNER COMES FROM THE RESPONSE. §14.5 makes the label part of the API *and* of the UI so that "a
 * screenshot of a simulation must be impossible to mistake for a real decision", and a client that
 * composed the sentence itself would be asserting a guarantee the response had not made. When a
 * response somehow carries no banner, this renders a neutral fallback rather than inventing the frozen
 * literal — an absent guarantee is not a guarantee.
 *
 * THERE IS NO EVIDENCE-LEVEL CONTROL HERE, AND THAT IS A SECURITY PROPERTY rather than a preference: a
 * selector would reintroduce the client-chosen-disclosure defect 54-I closed.
 */

/**
 * §14.5's frozen banner — known ONLY so the panel can recognise when a response is NOT carrying it. It
 * is never used to fill the label in.
 */
const EXPECTED_BANNER = 'SIMULATION — NO DATA CHANGED';

/** The coordinates of the question. Every field maps to one member of §14's `context` or `subject`. */
interface QuestionForm {
  leaveTypeId: string;
  employmentType: string;
  requestedFrom: string;
  requestedTo: string;
  employeeId: string;
}

const EMPTY_QUESTION: QuestionForm = {
  leaveTypeId: '',
  employmentType: '',
  requestedFrom: '',
  requestedTo: '',
  employeeId: '',
};

export function LeavePolicySimulationPanel({
  policyId,
  versions,
  defaultLeaveTypeId,
}: {
  policyId: string;
  /** Every version the operator may name. Empty means "simulate whatever governs now". */
  versions: HrLeavePolicyVersion[];
  /** The leave type the version was reached through, pre-filled so the common case needs no typing. */
  defaultLeaveTypeId: string;
}) {
  const [versionId, setVersionId] = React.useState('');
  const [form, setForm] = React.useState<QuestionForm>({
    ...EMPTY_QUESTION,
    leaveTypeId: defaultLeaveTypeId,
  });

  const [result, setResult] = React.useState<HrLeavePolicySimulationResult | null>(null);
  const [isSubmitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const set = <K extends keyof QuestionForm>(key: K, value: QuestionForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  /**
   * ONE SIMULATION PER SUBMISSION, AND NOTHING IS WRITTEN.
   *
   * The `isSubmitting` guard is what makes "exactly one request per intended action" true even under a
   * double click: the button is disabled while in flight AND the handler returns early, because a
   * disabled attribute alone is not a guarantee against an already-queued event.
   *
   * NOTHING MUTATES. The only endpoint this panel can reach is the simulation one — it holds no write
   * client at all — so "simulation cannot trigger a mutation" is a property of the imports rather than
   * of a check.
   */
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting || form.leaveTypeId === '') return;

    setSubmitting(true);
    setError(null);

    try {
      const answer = await simulateLeavePolicyVersion(policyId, {
        ruleSetId: HR_LEAVE_LIMIT_RULE_SET_ID,
        // ABSENT unless the operator NAMED a version, because the server branches on presence to tell
        // "the currently effective published configuration" from "this exact version" (§14, Choice 1B).
        ...(versionId === '' ? {} : { versionId }),
        context: {
          leaveTypeId: form.leaveTypeId,
          ...(form.employmentType === '' ? {} : { employmentType: form.employmentType }),
          ...(form.requestedFrom === '' ? {} : { requestedFrom: form.requestedFrom }),
          ...(form.requestedTo === '' ? {} : { requestedTo: form.requestedTo }),
        },
        ...(form.employeeId === '' ? {} : { subject: { employeeId: form.employeeId } }),
      });

      setResult(answer);
    } catch (err: unknown) {
      setResult(null);
      setError(err instanceof Error ? err.message : 'شبیه‌سازی با خطا مواجه شد.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <HrCard title="شبیه‌سازی" testId="hr-policy-simulation">
      {/*
        §32.1/§32.2: the panel explains itself in place, in the operator's own vocabulary, and states
        what the act does NOT do — because the difference between a simulation and a decision is the one
        thing an operator must not have to infer.
      */}
      <p className="mb-4 text-xs text-muted-foreground" data-testid="hr-policy-simulation-help">
        شبیه‌سازی هیچ داده‌ای را تغییر نمی‌دهد: هیچ درخواست مرخصی ساخته یا تغییر نمی‌کند، هیچ
        نسخه‌ای را منتشر نمی‌کند، و هیچ رویداد کسب‌وکاری ثبت نمی‌کند. اگر نسخه‌ای انتخاب نکنید، نسخه
        منتشرشده‌ای که اکنون اعمال می‌شود بررسی می‌شود.
      </p>

      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="hr-sim-version">
            نسخه
          </label>
          <select
            id="hr-sim-version"
            data-testid="hr-sim-version"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
            value={versionId}
            onChange={(event) => setVersionId(event.target.value)}
          >
            <option value="">نسخه منتشرشده فعلی</option>
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                {version.versionLabel} — {hrLeavePolicyVersionStatusLabel(version.status)}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            انتخاب یک نسخه مشخص، بررسی یک پیکربندی است و بر تصمیم‌های جدید اثری ندارد.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="hr-sim-leave-type">
            نوع مرخصی
          </label>
          <input
            id="hr-sim-leave-type"
            data-testid="hr-sim-leave-type"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
            value={form.leaveTypeId}
            onChange={(event) => set('leaveTypeId', event.target.value)}
            required
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="hr-sim-employment-type">
            نوع استخدام (اختیاری)
          </label>
          <input
            id="hr-sim-employment-type"
            data-testid="hr-sim-employment-type"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
            value={form.employmentType}
            onChange={(event) => set('employmentType', event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            خالی بماند، دامنه استخدام نامشخص در نظر گرفته می‌شود و محدودیت‌های دامنه‌دار رد می‌شوند.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="hr-sim-employee">
            شناسه کارمند (اختیاری)
          </label>
          <input
            id="hr-sim-employee"
            data-testid="hr-sim-employee"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
            value={form.employeeId}
            onChange={(event) => set('employeeId', event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            برای شمارش سوابق یک نفر؛ خالی بماند، همه سوابق این نوع مرخصی در نظر گرفته می‌شود.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="hr-sim-from">
            شروع بازه درخواست (اختیاری)
          </label>
          <input
            id="hr-sim-from"
            data-testid="hr-sim-from"
            type="date"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
            value={form.requestedFrom}
            onChange={(event) => set('requestedFrom', event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="hr-sim-to">
            پایان بازه درخواست (اختیاری)
          </label>
          <input
            id="hr-sim-to"
            data-testid="hr-sim-to"
            type="date"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
            value={form.requestedTo}
            onChange={(event) => set('requestedTo', event.target.value)}
          />
        </div>

        <div className="sm:col-span-2">
          <button
            type="submit"
            data-testid="hr-sim-submit"
            disabled={isSubmitting || form.leaveTypeId === ''}
            className="rounded-lg border border-border bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {isSubmitting ? 'در حال شبیه‌سازی…' : 'اجرای شبیه‌سازی'}
          </button>
        </div>
      </form>

      {error !== null && <HrNotice tone="error" message={error} />}

      {result !== null && <SimulationResultPanel result={result} />}
    </HrCard>
  );
}

/**
 * THE ANSWER, AS THE SERVER STATED IT (§13, §14.5, §27.2, §32.4).
 *
 * THE BANNER IS THE RESPONSE'S OWN STRING. §14.5 requires it to be un-mistakable in a screenshot, so if
 * the response carries no banner this says so honestly rather than printing the expected literal — a
 * client-side banner would be the UI vouching for a guarantee the API omitted.
 *
 * A WITHHELD FIELD IS RENDERED AS WITHHELD, NOT AS ABSENT-BY-NATURE. §27.2 makes the projection a server
 * decision, so `null`/`[]` here means "not disclosed at this level". Printing "—" or omitting the row
 * would read as "there is nothing to disclose", which is a different and false statement.
 */
function SimulationResultPanel({ result }: { result: HrLeavePolicySimulationResult }) {
  const simulation = result.simulation;
  /**
   * The explanation panel reads the PROJECTED explanation, which is the response's own narrowing —
   * not `simulation.matchHistory`/`orderingBasis`, which are the engine's raw values. §27.2's whole
   * point is that the projection is what a level may see, so that is what a level renders.
   */
  const explanation = result.explanation;
  /**
   * THE BANNER IS READ FOR PRESENCE BY VALUE, NOT BY NULLISHNESS.
   *
   * The wire type declares `banner: string` — not `string | null` — because the engine's
   * `RULE_SIMULATION_BANNER` is always populated on the server side. So the realistic way a guarantee
   * can be MISSING is an EMPTY string, and `?? null` would wave that through as though the response had
   * made a promise it did not make. Blank is therefore treated as absent.
   */
  const banner = simulation.banner.length > 0 ? simulation.banner : null;
  const isBannerTrustworthy = banner === EXPECTED_BANNER;

  return (
    <div className="mt-6 flex flex-col gap-4" data-testid="hr-sim-result">
      {/*
        role="status" so the outcome is ANNOUNCED rather than only drawn: the result replaces the form's
        surroundings without navigation, and a screen-reader user must learn it happened (§33.7).

        THE TONE IS NEVER THE ONLY SIGNAL. §14.5's whole purpose is that the simulation marker survives
        greyscale and screenshots, so the banner is set in words, with colour only reinforcing it.
      */}
      <div
        role="status"
        data-testid="hr-sim-banner"
        data-banner-from-server={banner === null ? 'NO' : 'YES'}
        className={
          isBannerTrustworthy
            ? 'rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm font-medium text-amber-700'
            : 'rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground'
        }
      >
        {banner ?? 'پاسخ سرور نشانه شبیه‌سازی همراه نداشت؛ این نتیجه صرفاً اطلاعاتی است.'}
      </div>

      <dl className="grid gap-4 sm:grid-cols-2">
        <HrField label="نسخه شبیه‌سازی‌شده">
          <span className="flex flex-wrap items-center gap-2">
            <span data-testid="hr-sim-version-label">{result.versionLabel}</span>
            <HrBadge
              tone={hrLeavePolicyVersionStatusTone(result.status)}
              testId={`hr-sim-status-${result.status}`}
            >
              {hrLeavePolicyVersionStatusLabel(result.status)}
            </HrBadge>
            {result.historical && (
              <span data-testid="hr-sim-historical" className="text-xs text-muted-foreground">
                بررسی تاریخی
              </span>
            )}
          </span>
        </HrField>
        <HrField label="شناسه مجموعه قواعد">{result.ruleSetId}</HrField>
        <HrField label="زمان ارزیابی">{result.evaluationInstant}</HrField>
        <HrField label="تصمیم">{hrSimulationDecisionLabel(simulation.decision)}</HrField>
      </dl>

      {/* §30.4 again: a state is never rendered as a bare word. */}
      <p className="text-xs text-muted-foreground" data-testid="hr-sim-status-meaning">
        {hrLeavePolicyVersionStatusMeaning(result.status)}
      </p>

      {/*
        THE HISTORICAL MARKER IS §14.5's "visibly distinguishable" requirement, and it is why an ARCHIVED
        version may be simulated at all: it is a QUESTION ABOUT THE PAST, never a statement about what
        governs next. The sentence says which of the two the operator is looking at.
      */}
      {result.historical && (
        <p className="text-xs text-muted-foreground" data-testid="hr-sim-historical-note">
          این نسخه بایگانی‌شده است؛ بررسی آن تاریخی است و نشان نمی‌دهد چه چیزی بر تصمیم‌های جدید
          حاکم است.
        </p>
      )}

      {/*
        §14.5's MODE is rendered as the response stated it. It is what marks this screen as a simulation
        rather than a decision, so it is never replaced with a client-side equivalent.
      */}
      <HrField label="حالت">
        <span data-testid="hr-sim-mode">{simulation.mode}</span>
      </HrField>

      <HrNotice tone="ok" message={explanation.explanationText} />

      <HrField label="اعتبارسنجی پیکربندی">
        {simulation.validation.valid ? (
          <span data-testid="hr-sim-validation-valid">پیکربندی معتبر است.</span>
        ) : (
          <span data-testid="hr-sim-validation-invalid" role="alert">
            پیکربندی این نسخه معتبر نیست و قابل انتشار نخواهد بود.
          </span>
        )}
      </HrField>

      {result.limits.length > 0 && <LimitRefusalList refusals={result.limits} />}

      <ExplanationFacts explanation={explanation} />
    </div>
  );
}

/**
 * A LIMIT THAT WOULD REFUSE, WITH ITS GROUNDS (§16.7, §32.4).
 *
 * THE WORDING IS DELIBERATELY "REFUSED", NOT "REJECTED". Nothing was rejected: no request exists, no
 * approver was involved, and no state changed. §14.5's distinction between a simulation result and a
 * business decision depends on the interface not borrowing the vocabulary of the latter, because a
 * user who reads "rejected" will believe a decision was taken about them.
 *
 * THE GROUNDS ARE THE SERVER'S OWN. `maximum`, `countingBasis` and the window are rendered together,
 * since §16.7 requires the refusal to CARRY its grounds — a bare "limit exceeded" would be unusable for
 * the operator trying to understand which configuration produced it.
 */
function LimitRefusalList({ refusals }: { refusals: HrSimulatedLimitGrounds[] }) {
  return (
    <HrCard title="محدودیت‌هایی که رد می‌کنند" testId="hr-sim-refusals">
      <ul className="flex flex-col gap-3">
        {refusals.map((refusal, index) => (
          <li
            key={`${refusal.limitRef}-${index}`}
            data-testid={`hr-sim-refusal-${refusal.limitRef}`}
            className="rounded-xl border border-border px-4 py-3"
          >
            <p className="text-sm font-medium">
              سقف {refusal.maximum} {hrLeaveLimitCountingBasisLabel(refusal.countingBasis)} در بازه{' '}
              {refusal.windowStart} — {refusal.windowEnd} رعایت نشده است.
            </p>
            {/*
              THE OBSERVED COUNT IS THE SERVER'S OWN NUMBER (§16.7), printed beside the maximum so the
              operator can see the comparison the engine actually made. It is NOT recomputed here: the
              count is a statement about the tenant's rows, which only the server can make.
            */}
            <p
              className="mt-1 text-xs text-muted-foreground"
              data-testid={`hr-sim-refusal-observed-${refusal.limitRef}`}
            >
              شمارش‌شده: {refusal.observed}
              {refusal.exceeded ? ' — بیش از سقف' : ''}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">محدودیت: {refusal.limitRef}</p>
          </li>
        ))}
      </ul>
    </HrCard>
  );
}

/**
 * WHAT THE ENGINE ACTUALLY RETURNED (§13, §27.2).
 *
 * EVERY ROW IS A FIELD THE RESPONSE CARRIES. Rows for withheld fields are rendered EXPLICITLY as
 * withheld, because §27.2 makes the narrowing a server decision taken to protect a lower evidence
 * level — and a UI that showed nothing at all would let an operator conclude the engine had no
 * ordering basis or no conflicts, when in fact it had them and declined to disclose them.
 *
 * NOTHING IS DERIVED. Counts are printed as returned; no arithmetic is performed on them and no missing
 * count is inferred from anything else.
 */
function ExplanationFacts({ explanation }: { explanation: HrSimulationExplanation }) {
  const withheld = 'در این سطح دسترسی نمایش داده نمی‌شود.';

  return (
    <HrCard title="توضیح" testId="hr-sim-explanation">
      <dl className="grid gap-4 sm:grid-cols-2">
        <HrField label="قاعده اعمال‌شده">
          {explanation.winningRuleId === null ? (
            <span data-testid="hr-sim-winning-rule-withheld">{withheld}</span>
          ) : (
            <span data-testid="hr-sim-winning-rule">{explanation.winningRuleId}</span>
          )}
        </HrField>

        <HrField label="پایه ترتیب">
          {explanation.orderingBasis === null ? (
            <span data-testid="hr-sim-ordering-basis-withheld">{withheld}</span>
          ) : (
            /*
              A NON-NULL ordering basis is itself the disclosure: §13.3 withholds priority/specificity
              at lower levels, so its PRESENCE at this level is what the operator may be told. Its
              structure is deliberately not printed — it is engine vocabulary, not HR vocabulary (§13.4
              forbids rendering the internals), and §27.2's projection already decided what is legible.
            */
            <span data-testid="hr-sim-ordering-basis">پایه ترتیب اعلام شده است.</span>
          )}
        </HrField>

        <HrField label="سطح جزئیات">{explanation.detailLevel}</HrField>

        <HrField label="وضعیت قاعده">{explanation.status}</HrField>
      </dl>

      {explanation.observedCounts.length > 0 && (
        <div className="mt-4">
          <p className="text-xs text-muted-foreground">شمارش‌های مشاهده‌شده</p>
          <ul className="mt-2 flex flex-col gap-1" data-testid="hr-sim-observed-counts">
            {explanation.observedCounts.map((count) => (
              <li key={count.over} className="text-sm" data-testid={`hr-sim-count-${count.over}`}>
                <span className="font-medium">{count.over}</span>: {count.count}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
        A NON-EMPTY FAILED-LEAF LIST IS ITSELF A DISCLOSED FACT (§13.4): "the rule was not applicable" is
        different from "there was no rule", and the engine distinguishes the two by ordering. Rendering
        them separately keeps that distinction visible instead of sounding the same.
      */}
      {explanation.failedLeaves.length > 0 && (
        <div className="mt-4">
          <p className="text-xs text-muted-foreground">شاخه‌هایی که برقرار نشدند</p>
          <ul className="mt-2 flex flex-col gap-1" data-testid="hr-sim-failed-leaves">
            {explanation.failedLeaves.map((leaf) => (
              <li key={leaf} className="text-sm">
                {leaf}
              </li>
            ))}
          </ul>
        </div>
      )}

      {explanation.conflicts.length > 0 && (
        <div className="mt-4">
          <p className="text-xs text-muted-foreground">تعارض‌ها</p>
          <ul className="mt-2 flex flex-col gap-1" data-testid="hr-sim-conflicts">
            {explanation.conflicts.map((conflict, index) => (
              <li key={index} className="text-sm" data-value={String(conflict)}>
                تعارض گزارش شده است.
              </li>
            ))}
          </ul>
        </div>
      )}
    </HrCard>
  );
}
