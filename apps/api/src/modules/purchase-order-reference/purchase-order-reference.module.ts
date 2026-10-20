import { Module } from '@nestjs/common';
import { CommerceModule } from '../commerce/commerce.module';
import { CommerceOrderReferenceFacade } from '../commerce/integration/purchase-order-reference.facade';
import {
  PURCHASE_ORDER_REFERENCE_PORT,
  PurchaseOrderReferencePort,
} from '../financial/purchase-order-reference.port';

/**
 * PHASE W2-C — the NEUTRAL BRIDGE that binds Financial's
 * `PurchaseOrderReferencePort` to Commerce's `CommerceOrderReferenceFacade`.
 *
 * WHY THIS MODULE EXISTS OUTSIDE BOTH CONTEXTS: the Phase B3 boundary rule
 * forbids a file under `modules/financial/**` from importing
 * `modules/commerce/**`, and vice versa — so neither `FinancialModule` nor
 * `CommerceModule` can carry this binding. A module that lives under NEITHER
 * directory may import both, so the seam lands here: this directory is not a
 * bounded context (it owns no database, no routes, no domain), it is a
 * composition detail — the same role the composition root's `imports` list
 * plays, one level down.
 *
 * WHAT IT WIRES, concretely: `FinancialModule` imports THIS module and gets
 * `PURCHASE_ORDER_REFERENCE_PORT` resolved; the port's implementation is a
 * pass-through to the facade CommerceModule exports, so the only thing crossing
 * the boundary is a tenant-scoped read contract — no Commerce repository,
 * service, Prisma client or generated type is referenced from here, and none
 * is reachable from Financial.
 */
@Module({
  imports: [CommerceModule],
  providers: [
    {
      provide: PURCHASE_ORDER_REFERENCE_PORT,
      useFactory: (facade: CommerceOrderReferenceFacade): PurchaseOrderReferencePort => ({
        resolve: (tenantId, orderReference) => facade.resolve(tenantId, orderReference),
      }),
      inject: [CommerceOrderReferenceFacade],
    },
  ],
  exports: [PURCHASE_ORDER_REFERENCE_PORT],
})
export class PurchaseOrderReferenceModule {}
