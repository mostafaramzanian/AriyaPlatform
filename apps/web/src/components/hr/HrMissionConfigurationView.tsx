'use client';

import * as React from 'react';

import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useReloadToken } from '@/hooks/use-reload-token';
import { fetchMissionPolicyVersions, type HrMissionPolicyVersion } from '@/lib/hr-mission-api';
import type { HrMissionPolicyVersionActions } from '@/lib/hr-mission-api';
import {
  missionPolicyVersionStatusLabel,
  missionPolicyVersionStatusMeaning,
  missionPolicyVersionStatusTone,
} from '@/lib/hr-mission-labels';
import { HrBadge, HrCard, HrPageHeading } from './hr-ui';
import { MissionApprovalDefinitionPanel } from './MissionApprovalDefinitionPanel';
import { MissionOptionCataloguePanel } from './MissionOptionCataloguePanel';

/**
 * Phase 55 Step 8D: the Mission ADMIN CONFIGURATION surface (`/admin/hr/missions/configuration`).
 *
 * ONE GRANT GOVERNS ALL THREE DOMAINS. `mission.controller.ts` decorates every catalogue route, every
 * approval-definition route and every policy-version route with `@Roles(Permissions.HR_MISSION_POLICY)`
 * — reads included. So this screen checks that ONE grant, and without it it issues NOTHING: no
 * catalogue read, no definitions read, no policy read. That is asserted as an ABSENT call rather than
 * as a hidden table, because a read that would 403 is a request the grants do not cover.
 *
 * `hr.mission.read` AND `hr.mission.approve` ARE DELIBERATELY NOT CONSULTED. They guard the register
 * and the manager queue, which are different surfaces answering different questions. Requiring either
 * here would make `hr.mission.policy` — the grant the backend actually demands — insufficient to do
 * the job it names.
 *
 * WHY DOMAIN 3 IS A LIST AND NOT AN EDITOR
 * ---------------------------------------
 * DOMAINS 1 AND 2 ARE CONFIGURED; DOMAIN 3 IS OBSERVED. The reason is the contract, not the schedule:
 * `CreateMissionPolicyVersionInput.configuration` is typed `unknown` in the frozen Step-8A client, and
 * the client's own doc comment says why — it is the Rule Engine's `RuleSetVersion` document, whose
 * interior this client has NO contract for. `mission-policy.service.ts` reads it as
 * `version.configuration as unknown as RuleSetVersion`, i.e. even the server treats it as an opaque
 * document it hands to the engine.
 *
 * A structured policy editor would therefore have to invent `rules`, `conditions`, `actions`, `facts`,
 * `operators` and ordering semantics — an entire schema — and ship it as though it were the real one.
 * That is the single thing this step forbids, so the policy surface lists versions, states the
 * lifecycle status with its consequence, and shows the three rule facts the Mission engine is given
 * (`durationMode`, `locationType`, `engagementType` under rule set `MISSION_RULE_SET_ID`). Creating a
 * version is NOT offered, because that would require authoring the opaque document.
 *
 * The lifecycle CONTROLS are not rendered either, for a reason that is a contract gap rather than a
 * style choice — see the doc comment on the versions card below.
 */

/** The ONE grant every route behind this screen answers to. */
const MISSION_POLICY = 'hr.mission.policy';

/**
 * The rule set these versions configure — `MissionPolicyService.RULE_SET_ID`.
 *
 * The value is `hr.mission.approval`, and it is asserted against the service in the spec rather than
 * trusted: the id is the key the server filters versions by (`{ ...filter, ruleSetId: RULE_SET_ID }`)
 * and the key the approval engine resolves a published document under, so a wrong literal here would
 * describe a rule set that governs nothing.
 */
const MISSION_RULE_SET_ID = 'hr.mission.approval';

/**
 * The three facts the Mission rule set speaks about — `mission-options.ts`'s own derivation.
 *
 * Shown as a statement of SCOPE rather than as an editable field: they are DERIVED from the selected
 * catalogue options, so an administrator changes them by configuring Domain 1, never by typing a fact
 * value here. No Project selector and no `projectId` appears anywhere in this step.
 */
const MISSION_RULE_FACTS = [
  { key: 'durationMode', label: 'مدت (ساعتی/روزانه)' },
  { key: 'locationType', label: 'محل (درون‌شهری/برون‌شهری)' },
  { key: 'engagementType', label: 'ماهیت (پروژه‌ای/غیرپروژه‌ای)' },
] as const;

/** The API's own message when it gave one, and this screen's Persian sentence otherwise. */
function describe(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.length > 0 ? err.message : fallback;
}

/**
 * The three lifecycle transitions, in the order the server's routes list them, each bound to the flag
 * the SERVER sets for it.
 *
 * The flag NAMES are the server's contract (`MissionPolicyVersionActions`), so a rename there breaks
 * this file at compile time rather than silently rendering the wrong sentence.
 */
const POLICY_VERSION_ACTION_LABELS: readonly {
  flag: keyof HrMissionPolicyVersionActions;
  label: string;
}[] = [
  { flag: 'canValidate', label: 'اعتبارسنجی' },
  { flag: 'canPublish', label: 'انتشار' },
  { flag: 'canArchive', label: 'بایگانی' },
];

/**
 * The transitions the server says it will accept, as one sentence.
 *
 * IT IS A STATEMENT OF ELIGIBILITY AND NOT AN OFFER: this surface exposes no lifecycle write, so the
 * sentence names what the server would accept for the stored state instead of implying a button that
 * is not there. `ARCHIVED` has no successor — no route restores a version — and says exactly that.
 */
function describeAllowedTransitions(actions: HrMissionPolicyVersionActions): string {
  const allowed = POLICY_VERSION_ACTION_LABELS.filter((entry) => actions[entry.flag]).map(
    (entry) => entry.label
  );

  return allowed.length === 0
    ? 'گذار بعدی برای این نسخه مجاز نیست.'
    : `گذارهای مجاز: ${allowed.join('، ')}`;
}

/**
 * DOMAIN 3 — the rule-set versions, rendered as the server returns them.
 *
 * THE LIFECYCLE CONTROLS ARE NOT RENDERED, AND THAT IS STILL THE RIGHT ANSWER.
 * -------------------------------------------------------------------------
 * The contract that used to be missing is now closed: `configuration` is typed
 * (`MissionRuleSetVersion`), so a version COULD be authored from this client, and each version arrives
 * with the server's own `actions` — `canValidate` / `canPublish` / `canArchive` — so the screen no
 * longer has to derive the transition matrix from `status` at all.
 *
 * What is still NOT built here is the AUTHORING FORM, and shipping three lifecycle buttons on top of a
 * read-only list would be the same theatre in a new place: a Validate button on a DRAFT nothing can
 * produce, because this phase builds no Policy editor. The server's eligibility is therefore RENDERED
 * as the statement it is — which transitions the server would accept for each stored state — and the
 * remaining gap is named on the surface instead of being papered over.
 *
 * NOTHING IS OPTIMISTIC REGARDLESS: the list is re-read from the server after any change, so a status
 * shown here is always the stored one.
 */
function MissionPolicyVersionsCard() {
  const [versions, setVersions] = React.useState<HrMissionPolicyVersion[]>([]);
  const [isLoading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Re-arms loading/cleared in the retry handler (same commit as the token
  // bump), so the effect needs no in-effect setter resets. First mount is
  // covered by the initial `isLoading: true`.
  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);

  React.useEffect(() => {
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
  }, [reloadToken]);

  return (
    <HrCard title="نسخه‌های خط‌مشی ماموریت" testId="hr-mission-policy-versions">
      {error !== null ? (
        <CoreError message={error} onRetry={reload} />
      ) : isLoading ? (
        <CoreLoading lines={4} />
      ) : versions.length === 0 ? (
        <CoreEmpty message="هیچ نسخه‌ای از خط‌مشی ماموریت ثبت نشده است." />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="hr-mission-policy-version-list">
          {versions.map((version) => (
            <li
              key={version.id}
              className="flex flex-col gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2"
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
                <span className="text-xs text-muted-foreground">
                  مجموعه قواعد: {version.ruleSetId}
                </span>
              </div>
              {/* The consequence sentence travels WITH the badge, because «منتشرشده» alone does not
                  tell an operator whether the version governs today's decisions. */}
              <p
                className="text-xs text-muted-foreground"
                data-testid={`hr-mission-policy-version-meaning-${version.version}`}
              >
                {missionPolicyVersionStatusMeaning(version.status)}
              </p>
              {/* WHAT THE SERVER WILL ACCEPT NEXT, rendered from `actions` and never derived from
                  `status` here. A version with no legal transition says so explicitly: an ARCHIVED
                  version offers none, and silence would read as "unknown" rather than "none". */}
              <p
                className="text-xs text-muted-foreground"
                data-testid={`hr-mission-policy-version-actions-${version.version}`}
              >
                {describeAllowedTransitions(version.actions)}
              </p>
            </li>
          ))}
        </ul>
      )}

      {/* THE UNDOCUMENTED CONTRACT, STATED ON THE SURFACE rather than papered over with a JSON box. */}
      <div className="mt-4 flex flex-col gap-2 rounded-xl border border-border bg-muted/60 p-3">
        <p className="text-xs text-muted-foreground" data-testid="hr-mission-policy-scope">
          این نسخه‌ها بر سه واقعیت ماموریت اعمال می‌شوند که از گزینه‌های انتخاب‌شده استخراج می‌شوند؛
          مقدار هر واقعیت از پیکربندی «فهرست گزینه‌ها» تعیین می‌شود، نه با ورود دستی در این صفحه.
        </p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {MISSION_RULE_FACTS.map((fact) => (
            <li key={fact.key} data-testid={`hr-mission-policy-fact-${fact.key}`}>
              <span className="font-mono">{fact.key}</span> — {fact.label}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground" data-testid="hr-mission-policy-editor-gap">
          شکل سند پیکربندی مشخص است، اما فرم ایجاد یا ویرایش نسخه در این رابط کاربری ارائه نمی‌شود؛
          تا آن زمان، گذارهای مجاز هر نسخه همان است که سرور گزارش می‌کند.
        </p>
      </div>
    </HrCard>
  );
}

/**
 * THE MISSION ADMIN CONFIGURATION SCREEN.
 *
 * THE GRANT IS CHECKED HERE, BEFORE ANY PANEL IS MOUNTED, and the panels issue their own reads only
 * once they are rendered — so a caller without `hr.mission.policy` produces a screen and ZERO
 * requests. That ordering is the whole security claim of this surface: it is not that the controls
 * are hidden, it is that nothing is asked for.
 */
export function HrMissionConfigurationView() {
  const { permissions, isLoading: isPermissionsLoading } = useCorePermissions(true);

  const canConfigure = permissions.includes(MISSION_POLICY);

  if (isPermissionsLoading) return <CoreLoading lines={5} />;

  if (!canConfigure) {
    return (
      <CoreForbidden message="برای پیکربندی ماموریت‌ها به مجوز hr.mission.policy نیاز دارید." />
    );
  }

  return (
    <div className="flex flex-col gap-6" data-testid="hr-mission-configuration">
      <HrPageHeading
        title="پیکربندی ماموریت‌ها"
        description="فهرست گزینه‌های ماموریت، تعریف‌های گردش تأیید و نسخه‌های خط‌مشی"
      />

      {/* DOMAIN 1 — the catalogue. The panel owns its own read and its own forbidden state, because
          the grant is the same one this view already holds. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-foreground">فهرست گزینه‌های ماموریت</h2>
        <MissionOptionCataloguePanel />
      </section>

      {/* DOMAIN 2 — the flow definitions. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-foreground">تعریف‌های گردش تأیید</h2>
        <MissionApprovalDefinitionPanel canWrite={canConfigure} />
      </section>

      {/* DOMAIN 3 — the rule-set versions. A LIST, not an editor: see the card's doc comment for the
          exact contract that stops the editor. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-foreground">خط‌مشی ماموریت</h2>
        <MissionPolicyVersionsCard />
      </section>

      <p className="text-xs text-muted-foreground" data-testid="hr-mission-configuration-rule-set">
        مجموعه قواعد ماموریت: <span className="font-mono">{MISSION_RULE_SET_ID}</span>
      </p>
    </div>
  );
}
