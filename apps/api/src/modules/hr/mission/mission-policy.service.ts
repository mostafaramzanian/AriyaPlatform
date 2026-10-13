import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { RuleEngineService } from '../../../rules/rule-engine.service';
import type { RuleSetVersion } from '../../../rules/rule-spec.interface';
import type { RuleAction } from '../../../rules/rule-action.interface';
import { MissionPolicyRepository } from './mission-policy.repository';
import {
  toMissionPolicyVersionResponse,
  type MissionPolicyVersionResponse,
} from './mission-policy-version.projection';
import { MissionApprovalRepository } from './mission-approval.repository';
import { HrAuditGateway } from '../hr-audit.gateway';
import { HrActor } from '../hr-actor';
import { HR_AUDIT_ACTION, HR_AUDIT_RESOURCE } from '../hr.constants';
import type { MissionFacts } from '../domain/mission-options';
import type { EvaluationContext } from '../../../rules/rule-evaluation.interface';

export type MissionRuleDecision =
  | { readonly kind: 'AUTO_APPROVE'; readonly versionLabel: string }
  | { readonly kind: 'AUTO_REJECT'; readonly reasonCode: string; readonly versionLabel: string }
  | {
      readonly kind: 'REQUIRED_APPROVAL';
      readonly approvalDefinitionId: string;
      readonly versionLabel: string;
    }
  | { readonly kind: 'NO_DECISION'; readonly versionLabel: string };

/**
 * Phase 55: the Mission policy runtime and authoring surface.
 *
 * The service resolves the effective PUBLISHED Mission rule-set version, evaluates
 * the request facts through the existing Rule Engine, and turns the typed outcome
 * into the approval action the application layer applies. It also owns the policy
 * version lifecycle: validate, publish and archive.
 */
@Injectable()
export class MissionPolicyService {
  constructor(
    private readonly policyRepo: MissionPolicyRepository,
    private readonly approvalRepo: MissionApprovalRepository,
    private readonly ruleEngine: RuleEngineService,
    private readonly audit: HrAuditGateway
  ) {}

  /** The Mission Rule Set ID frozen in Phase 55. */
  static readonly RULE_SET_ID = 'hr.mission.approval';

  // -------------------------------------------------------------------------
  // Runtime
  // -------------------------------------------------------------------------

  /**
   * Resolve the effective PUBLISHED policy and evaluate the Mission facts.
   *
   * No published version is a real configuration state, but it is REFUSED rather
   * than silently approved, because an ungoverned request is not the same as a
   * permitted one.
   */
  async resolveDecision(actor: HrActor, facts: MissionFacts): Promise<MissionRuleDecision> {
    const version = await this.policyRepo.findPublishedVersion(
      actor.tenantId,
      MissionPolicyService.RULE_SET_ID
    );
    if (!version) {
      throw new ConflictException('No published Mission policy governs this request.');
    }

    const ruleSetVersion = version.configuration as unknown as RuleSetVersion;
    const context: EvaluationContext = {
      facts: {
        durationMode: facts.durationMode,
        locationType: facts.locationType,
        engagementType: facts.engagementType,
      },
      evaluationInstant: new Date().toISOString(),
    };

    const result = this.ruleEngine.evaluateSync(ruleSetVersion, context);
    const versionLabel = `${version.version}`;

    if (result.status !== 'DECIDED' || result.decision === 'NONE') {
      return { kind: 'NO_DECISION', versionLabel };
    }

    const action = result.decision;

    if (action.type === 'AUTO_APPROVE') {
      return { kind: 'AUTO_APPROVE', versionLabel };
    }

    if (action.type === 'AUTO_REJECT') {
      return { kind: 'AUTO_REJECT', reasonCode: action.reasonCode, versionLabel };
    }

    if (action.type === 'REQUIRED_APPROVAL_STEP') {
      const approvalDefinitionId = this.parseApprovalDefinitionId(action);
      return { kind: 'REQUIRED_APPROVAL', approvalDefinitionId, versionLabel };
    }

    return { kind: 'NO_DECISION', versionLabel };
  }

  private parseApprovalDefinitionId(action: RuleAction): string {
    if (action.type !== 'REQUIRED_APPROVAL_STEP') {
      throw new ConflictException('Mission policy produced a non-approval action.');
    }
    const prefix = 'mission-approval-definition:';
    const ref = action.approverRuleRef;
    if (!ref.startsWith(prefix)) {
      throw new ConflictException(
        `Mission policy approval step must reference a Mission approval definition (${prefix}<id>).`
      );
    }
    const id = ref.slice(prefix.length);
    if (!id || id.length === 0) {
      throw new ConflictException(
        'Mission policy approval step references an empty approval definition.'
      );
    }
    return id;
  }

  // -------------------------------------------------------------------------
  // Authoring
  // -------------------------------------------------------------------------

  async listVersions(
    actor: HrActor,
    filter: { status?: 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'ARCHIVED' },
    page: { skip: number; take: number }
  ): Promise<{
    items: MissionPolicyVersionResponse[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    // THE REPOSITORY RETURNS A POSITIONAL TUPLE, and every OTHER Mission list answers
    // `{ items, total, page, pageSize }` — `MissionService.list`, `listOptionGroups` and
    // `listApprovalDefinitions` all do. This endpoint is the last one that leaked the tuple, which
    // made it the single list a Web client could not type with the shared envelope rule.
    const [items, total] = await this.policyRepo.listVersionPage(
      actor.tenantId,
      { ...filter, ruleSetId: MissionPolicyService.RULE_SET_ID },
      page
    );

    // THE PAGE FACTS ARE DERIVED FROM THE WINDOW, NOT FROM A REQUEST OBJECT. This service receives
    // the already-computed `{ skip, take }` — the CONTROLLER builds it — so there is no `page` or
    // `pageSize` input here to echo back, and inventing one would mean duplicating the controller's
    // arithmetic in a second place where it could disagree.
    //
    // `take` IS the effective page size, so echoing it reports what was really served rather than
    // what was asked for. `skip / take + 1` is the inverse of the controller's
    // `(page - 1) * pageSize`, which recovers the page it meant. The guard keeps a non-positive
    // window (which no route produces, but which this method's own signature permits) from
    // answering `page: 0` or `Infinity`: such a window served the first page, so it says so.
    const pageNumber = page.take > 0 ? page.skip / page.take + 1 : 1;

    return {
      items: items.map(toMissionPolicyVersionResponse),
      total,
      page: pageNumber,
      pageSize: page.take,
    };
  }

  /**
   * The stored row, for internal use by the lifecycle transitions.
   *
   * IT IS NOT THE WIRE SHAPE ON PURPOSE, and it is deliberately NOT exposed by any route: the
   * transitions need `configuration` (to run the engine) and `status` (to apply their own guard), and
   * both are read BEFORE the projection exists. Each transition returns
   * `toMissionPolicyVersionResponse(row)` instead, so the tenant id and the raw `Date`s still never
   * reach a caller.
   */
  async getVersion(actor: HrActor, id: string) {
    const version = await this.policyRepo.findVersionById(actor.tenantId, id);
    if (!version) throw new NotFoundException('Mission policy version not found');
    return version;
  }

  /**
   * Author a DRAFT version.
   *
   * `input.configuration` is `unknown` on this boundary DELIBERATELY, and it is not a leftover: the
   * Web client now ships a typed `MissionRuleSetVersion`, but the SERVICE must not assume the caller
   * sent one. The document is stored verbatim and judged by `validateVersion`, which runs the Rule
   * Engine's own validator — so a malformed body is refused with a readable `400` naming the exact
   * path, instead of being rejected by a second, weaker check here that could disagree with the
   * engine about what a valid document is.
   */
  async createVersion(
    actor: HrActor,
    input: { version: number; label: string; ruleSetId?: string; configuration: unknown }
  ): Promise<MissionPolicyVersionResponse> {
    const row = await this.policyRepo.createVersion(actor.tenantId, {
      version: input.version,
      ruleSetId: input.ruleSetId ?? MissionPolicyService.RULE_SET_ID,
      configuration: input.configuration,
    });

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.CREATE,
      resource: HR_AUDIT_RESOURCE.MISSION_POLICY_VERSION,
      resourceId: row.id,
      newValue: { version: row.version, ruleSetId: row.ruleSetId },
    });

    return toMissionPolicyVersionResponse(row);
  }

  async validateVersion(actor: HrActor, id: string): Promise<MissionPolicyVersionResponse> {
    const version = await this.getVersion(actor, id);
    if (version.status !== 'DRAFT') {
      throw new ConflictException(`A ${version.status} version cannot be validated.`);
    }
    const ruleSetVersion = version.configuration as unknown as RuleSetVersion;
    const result = this.ruleEngine.simulateSync(ruleSetVersion, {
      facts: { durationMode: 'DAILY', locationType: 'IN_CITY', engagementType: 'NON_PROJECT' },
      evaluationInstant: new Date().toISOString(),
    });

    if (!result.validation.valid) {
      throw new BadRequestException(
        `Mission policy version is invalid: ${result.validation.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`
      );
    }

    const row = await this.policyRepo.updateVersionStatus(actor.tenantId, id, {
      status: 'VALIDATED',
    });
    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.VALIDATE,
      resource: HR_AUDIT_RESOURCE.MISSION_POLICY_VERSION,
      resourceId: row.id,
      newValue: { status: row.status },
    });
    return toMissionPolicyVersionResponse(row);
  }

  async publishVersion(actor: HrActor, id: string): Promise<MissionPolicyVersionResponse> {
    const version = await this.getVersion(actor, id);
    if (version.status !== 'VALIDATED') {
      throw new ConflictException(`A ${version.status} version cannot be published.`);
    }

    const current = await this.policyRepo.findPublishedVersion(
      actor.tenantId,
      MissionPolicyService.RULE_SET_ID
    );
    const publishedAt = new Date();

    if (current && current.id !== id) {
      await this.policyRepo.updateVersionStatus(actor.tenantId, current.id, {
        status: 'ARCHIVED',
        publishedAt: null,
      });
    }

    const row = await this.policyRepo.updateVersionStatus(actor.tenantId, id, {
      status: 'PUBLISHED',
      publishedAt,
    });

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.PUBLISH,
      resource: HR_AUDIT_RESOURCE.MISSION_POLICY_VERSION,
      resourceId: row.id,
      newValue: {
        status: row.status,
        publishedAt: publishedAt.toISOString(),
        archivedPredecessorId: current?.id ?? null,
      },
    });

    return toMissionPolicyVersionResponse(row);
  }

  async archiveVersion(actor: HrActor, id: string): Promise<MissionPolicyVersionResponse> {
    const version = await this.getVersion(actor, id);
    if (version.status !== 'PUBLISHED') {
      throw new ConflictException(`A ${version.status} version cannot be archived.`);
    }

    const row = await this.policyRepo.updateVersionStatus(actor.tenantId, id, {
      status: 'ARCHIVED',
      publishedAt: null,
    });

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.ARCHIVE,
      resource: HR_AUDIT_RESOURCE.MISSION_POLICY_VERSION,
      resourceId: row.id,
      newValue: { status: row.status },
    });

    return toMissionPolicyVersionResponse(row);
  }
}
