import { Injectable, Logger } from '@nestjs/common';
import { NotificationPublisher } from '../../notifications/notification.publisher';
import { HrActor } from './hr-actor';

type MissionNotificationKind =
  | 'mission.submitted'
  | 'mission.resubmitted'
  | 'mission.approved'
  | 'mission.rejected'
  | 'mission.correction'
  | 'mission.next_approver';

/**
 * Phase 55: the HR Mission notification boundary.
 *
 * HR does NOT import Core's `NotificationService` or `PrismaService`. It emits
 * domain events through the platform's `NotificationPublisher` (RabbitMQ) so a
 * consumer in Core can create the actual in-app notifications. If no broker is
 * configured the publish is a no-op warning, and Mission state is never rolled
 * back by a notification failure.
 */
@Injectable()
export class HrNotificationGateway {
  private readonly logger = new Logger(HrNotificationGateway.name);

  constructor(private readonly publisher: NotificationPublisher) {}

  /**
   * Emit a Mission domain event. The recipient list is carried in the payload
   * as employee ids; the downstream consumer resolves user ids and creates
   * tenant-scoped notifications.
   */
  async notify(
    actor: HrActor,
    kind: MissionNotificationKind,
    input: {
      missionRequestId: string;
      employeeId: string;
      recipientEmployeeIds: readonly string[];
      reason?: string | null;
    }
  ): Promise<void> {
    await this.publisher.publish(kind, {
      correlationId: actor.correlationId ?? actor.requestId,
      tenantId: actor.tenantId,
      missionRequestId: input.missionRequestId,
      employeeId: input.employeeId,
      recipientEmployeeIds: [...input.recipientEmployeeIds],
      reason: input.reason ?? null,
      emittedAt: new Date().toISOString(),
    });
  }

  async notifySubmitted(
    actor: HrActor,
    missionRequestId: string,
    employeeId: string,
    approverEmployeeIds: readonly string[]
  ): Promise<void> {
    return this.notify(actor, 'mission.submitted', {
      missionRequestId,
      employeeId,
      recipientEmployeeIds: approverEmployeeIds,
    });
  }

  async notifyResubmitted(
    actor: HrActor,
    missionRequestId: string,
    employeeId: string,
    approverEmployeeIds: readonly string[]
  ): Promise<void> {
    return this.notify(actor, 'mission.resubmitted', {
      missionRequestId,
      employeeId,
      recipientEmployeeIds: approverEmployeeIds,
    });
  }

  async notifyApproved(
    actor: HrActor,
    missionRequestId: string,
    employeeId: string
  ): Promise<void> {
    return this.notify(actor, 'mission.approved', {
      missionRequestId,
      employeeId,
      recipientEmployeeIds: [employeeId],
    });
  }

  async notifyRejected(
    actor: HrActor,
    missionRequestId: string,
    employeeId: string,
    reason: string | null
  ): Promise<void> {
    return this.notify(actor, 'mission.rejected', {
      missionRequestId,
      employeeId,
      recipientEmployeeIds: [employeeId],
      reason,
    });
  }

  async notifyCorrection(
    actor: HrActor,
    missionRequestId: string,
    employeeId: string,
    reason: string | null
  ): Promise<void> {
    return this.notify(actor, 'mission.correction', {
      missionRequestId,
      employeeId,
      recipientEmployeeIds: [employeeId],
      reason,
    });
  }

  async notifyNextApprover(
    actor: HrActor,
    missionRequestId: string,
    employeeId: string,
    approverEmployeeIds: readonly string[]
  ): Promise<void> {
    return this.notify(actor, 'mission.next_approver', {
      missionRequestId,
      employeeId,
      recipientEmployeeIds: approverEmployeeIds,
    });
  }
}
