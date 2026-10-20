import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Request as ExRequest } from 'express';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { Permissions } from '../../../auth/rbac/constants/permissions';
import { ModuleEntitlementGuard } from '../../../platform/entitlement/module-entitlement.guard';
import {
  RequiresFeature,
  RequiresModule,
} from '../../../platform/entitlement/entitlement.contract';
import { resolveCommerceActor } from '../commerce-actor';
import { COMMERCE_FEATURE, COMMERCE_MODULE_ID } from '../commerce.constants';
import { CommercePageQueryDto } from '../dto/commerce-query.dto';
import { SupplierService } from './supplier.service';
import {
  CreateSupplierDto,
  ListSuppliersQueryDto,
  UpdateSupplierDto,
} from './supplier.dto';

/**
 * The supplier directory's HTTP surface — seven routes under
 * `commerce/suppliers` (the purchase slice's `commerce/purchase-documents`
 * and the quotation slice's `commerce/price-quotations` establish the shape:
 * the path names the ROW the calls address).
 *
 * PERMISSIONS, THE SPLIT THAT IS THE POINT: reads answer `commerce.read` like
 * every other collection read in the module; create and update AND the
 * banking projection answer `commerce.supplier.manage` — the seventh Commerce
 * permission, seeded by `20261017140100_seed_commerce_supplier_permission`.
 * The banking route is SEPARATE from the ordinary detail precisely so the
 * sensitive five fields never ride along on a `commerce.read` projection: a
 * caller without the supplier remit cannot obtain them even by guessing the
 * detail URL, because the banking data is simply not on that route.
 *
 * WHAT THIS FILE DOES, AND WHAT IT MUST NEVER DO: resolve the actor from the
 * request and delegate — no rule, no duplicate decision, no normalization, no
 * audit call. Every ordering decision is a decorator, in the chain every
 * Commerce controller carries. `@HttpCode(200)` on the PATCH — it changes a
 * row but creates none, the module's posture for update routes.
 */
@Controller('commerce')
@RequiresModule(COMMERCE_MODULE_ID)
@RequiresFeature(COMMERCE_MODULE_ID, COMMERCE_FEATURE.PURCHASE)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class SupplierController {
  constructor(private readonly suppliers: SupplierService) {}

  /** One page of the directory, optionally filtered — a read. */
  @Get('suppliers')
  @Roles(Permissions.COMMERCE_READ)
  async list(@Request() req: ExRequest, @Query() query: ListSuppliersQueryDto) {
    return this.suppliers.list(resolveCommerceActor(req), query);
  }

  /** Create one supplier — `201` with the stored row. */
  @Post('suppliers')
  @Roles(Permissions.COMMERCE_SUPPLIER_MANAGE)
  async create(@Request() req: ExRequest, @Body() dto: CreateSupplierDto) {
    return this.suppliers.create(resolveCommerceActor(req), dto);
  }

  /**
   * PHASE W2-C — the supplier-reference reconciliation report («تطبیق
   * شناسه‌های تأمین‌کننده»). Declared BEFORE `suppliers/:id` deliberately: the
   * literal segment must not be swallowed as a UUID param. A read-only
   * diagnostic over the tenant's own rows — `commerce.read` like every other
   * collection read.
   */
  @Get('suppliers/reconciliation')
  @Roles(Permissions.COMMERCE_READ)
  async reconciliation(@Request() req: ExRequest) {
    return this.suppliers.reconcile(resolveCommerceActor(req));
  }

  /** One supplier's ordinary detail — NO banking fields, by contract. */
  @Get('suppliers/:id')
  @Roles(Permissions.COMMERCE_READ)
  async get(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.suppliers.get(resolveCommerceActor(req), id);
  }

  /** Partial update — `200`; absent fields are untouched. */
  @Patch('suppliers/:id')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_SUPPLIER_MANAGE)
  async update(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateSupplierDto
  ) {
    return this.suppliers.update(resolveCommerceActor(req), id, dto);
  }

  /**
   * The SENSITIVE banking projection (national code, SHEBA, card, bank) —
   * gated by `commerce.supplier.manage`, never reachable through
   * `commerce.read`.
   */
  @Get('suppliers/:id/banking')
  @Roles(Permissions.COMMERCE_SUPPLIER_MANAGE)
  async banking(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.suppliers.banking(resolveCommerceActor(req), id);
  }

  /** The purchase documents that name this supplier — a read. */
  @Get('suppliers/:id/purchases')
  @Roles(Permissions.COMMERCE_READ)
  async purchaseHistory(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: CommercePageQueryDto
  ) {
    return this.suppliers.purchaseHistory(resolveCommerceActor(req), id, query);
  }

  /** The quotations that name this supplier — a read. */
  @Get('suppliers/:id/quotations')
  @Roles(Permissions.COMMERCE_READ)
  async quotationHistory(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: CommercePageQueryDto
  ) {
    return this.suppliers.quotationHistory(resolveCommerceActor(req), id, query);
  }
}
