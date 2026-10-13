/**
 * Phase 55: THE WIRE PROJECTION OF A MISSION POLICY VERSION.
 *
 * WHY A PROJECTION IS NEEDED AT ALL
 * ---------------------------------
 * Every policy route returned the RAW `MissionPolicyVersion` Prisma row, which has exactly two
 * problems for a Web client:
 *
 *   1. The row carries `tenantId`. This module's client states — and its spec asserts — that NO
 *      Mission response hands a tenant id to the browser (§2). A column that happens to be on the row
 *      is not a contract, and the list route was the last place the boundary leaked.
 *   2. `createdAt`/`updatedAt` are `Date` objects on the row. They serialise to ISO strings, so the
 *      wire was never wrong — but the TYPE the client consumes should say `string`, not `Date`.
 *
 * WHAT IS ADDED: THE LIFECYCLE, AS THE SERVER'S OWN ANSWER
 * --------------------------------------------------------
 * `configuration` is now TYPED on the client (`MissionRuleSetVersion`, transcribed from the Rule
 * Engine's own declaration), which makes authoring possible. The obvious next step would be for the
 * Web surface to draw its own transition matrix from `status` — and that would be a SECOND authority
 * that can disagree with the one guarding the writes.
 *
 * So the eligibility is computed HERE, once, from the SAME predicate the writes use: each method
 * below is the exact negation of the guard in `validateVersion` / `publishVersion` / `archiveVersion`.
 * The Web surface renders `actions` as received and never re-derives it.
 *
 * THE PROJECTION DOES NOT WEAKEN THE GUARDS. It reports what the transition would do; the POST
 * routes still re-run their own `if (version.status !== …) throw` before mutating, so a client that
 * ignored `actions` would get the same `409` it always got.
 */

/** The stored lifecycle of a policy version. Mirrors `MissionPolicyVersionStatus` in the HR schema. */
export type MissionPolicyVersionStatus = 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'ARCHIVED';

/**
 * What the caller may do to ONE version, as the server computes it.
 *
 * Each flag is `true` in EXACTLY the one state the corresponding route accepts, so the three flags
 * are mutually exclusive and each state offers at most one action:
 *
 *   * `DRAFT`      — `canValidate`, because `validateVersion` refuses unless `status === 'DRAFT'`
 *   * `VALIDATED`  — `canPublish`,  because `publishVersion`  refuses unless `status === 'VALIDATED'`
 *   * `PUBLISHED`  — `canArchive`,  because `archiveVersion`  refuses unless `status === 'PUBLISHED'`
 *   * `ARCHIVED`   — no action; all three routes refuse, and no route restores a version
 */
export interface MissionPolicyVersionActions {
  readonly canValidate: boolean;
  readonly canPublish: boolean;
  readonly canArchive: boolean;
}

/** The row shape this projection consumes — structurally, whatever the repository loaded. */
interface MissionPolicyVersionRow {
  readonly id: string;
  readonly version: number;
  readonly status: MissionPolicyVersionStatus;
  readonly ruleSetId: string;
  readonly configuration: unknown;
  readonly publishedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The wire shape of one policy version. No `tenantId`, and no lifecycle the caller must not act on. */
export interface MissionPolicyVersionResponse {
  readonly id: string;
  readonly version: number;
  readonly status: MissionPolicyVersionStatus;
  readonly ruleSetId: string;
  /** The Rule Engine's own document, stored and returned verbatim. */
  readonly configuration: unknown;
  readonly publishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The server's own answer to "may the caller transition this version, and how?". */
  readonly actions: MissionPolicyVersionActions;
}

/**
 * The one place the transition matrix lives, expressed as what each state ALLOWS.
 *
 * A `switch` with an exhaustive union comes with no `default` on purpose: if a fifth status is ever
 * added to the schema, this stops compiling rather than silently reporting "no actions available" for
 * a state somebody can in fact act on.
 */
export function missionPolicyVersionActions(
  status: MissionPolicyVersionStatus
): MissionPolicyVersionActions {
  switch (status) {
    case 'DRAFT':
      return { canValidate: true, canPublish: false, canArchive: false };
    case 'VALIDATED':
      return { canValidate: false, canPublish: true, canArchive: false };
    case 'PUBLISHED':
      return { canValidate: false, canPublish: false, canArchive: true };
    case 'ARCHIVED':
      return { canValidate: false, canPublish: false, canArchive: false };
  }
}

/**
 * One stored row, as the wire may see it.
 *
 * The field list is written out rather than spread (`{ ...row, tenantId: undefined }`) so that a
 * column added to `MissionPolicyVersion` later CANNOT appear on the wire by default. A spread would
 * leak every future column automatically; an unexplained new field would then be invisible in review.
 */
export function toMissionPolicyVersionResponse(
  row: MissionPolicyVersionRow
): MissionPolicyVersionResponse {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    ruleSetId: row.ruleSetId,
    configuration: row.configuration,
    publishedAt: row.publishedAt === null ? null : row.publishedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    actions: missionPolicyVersionActions(row.status),
  };
}
