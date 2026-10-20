import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
import { INVENTORY_FEATURE, INVENTORY_MODULE_ID } from '../inventory.constants';
import { resolveInventoryActor } from '../inventory-actor';
import { StockService } from './stock.service';
import {
  CreateAdjustmentDto,
  CreateIssueDto,
  CreateStockCountDto,
  CreateTransferDto,
  EnterCountLineDto,
  ListBalancesQueryDto,
  ListMovementsQueryDto,
  PostReceiptDto,
  ReverseMovementDto,
} from './stock.dto';
import { InventoryPageQueryDto } from '../inventory.dto';

/**
 * Phase W1: the stock routes — the ledger read, the balance read, and every
 * posting act.
 *
 * PERMISSIONS: `inventory.read` for every GET; `inventory.manage` for
 * receipts, issues, adjustments, reversals, transfers and count data-entry;
 * `inventory.approve` for posting a count's variances — the act that writes
 * financial-effect ledger rows from another person's count, so the counter
 * and the poster are not the same privilege.
 *
 * NO `PATCH`, `PUT` or `DELETE` EXISTS on the ledger: a posted movement is
 * corrected by `POST …/movements/:id/reverse`, never by editing it. There is
 * no route that writes a balance directly — balances are derived.
 */
@Controller('inventory')
@RequiresModule(INVENTORY_MODULE_ID)
@RequiresFeature(INVENTORY_MODULE_ID, INVENTORY_FEATURE.STOCK)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class StockController {
  constructor(private readonly stock: StockService) {}

  // ---- reads ---------------------------------------------------------------

  @Get('stock/balances')
  @Roles(Permissions.INVENTORY_READ)
  balances(@Request() req: ExRequest, @Query() query: ListBalancesQueryDto) {
    const actor = resolveInventoryActor(req);
    return this.stock.listBalances(actor, query, query.page ?? 1, query.pageSize ?? 50);
  }

  @Get('stock/movements')
  @Roles(Permissions.INVENTORY_READ)
  movements(@Request() req: ExRequest, @Query() query: ListMovementsQueryDto) {
    const actor = resolveInventoryActor(req);
    return this.stock.listMovements(actor, query, query.page ?? 1, query.pageSize ?? 50);
  }

  @Get('stock/reconciliation')
  @Roles(Permissions.INVENTORY_READ)
  reconciliation(@Request() req: ExRequest, @Query('warehouseId') warehouseId?: string) {
    const actor = resolveInventoryActor(req);
    return this.stock.reconcile(actor, warehouseId);
  }

  // ---- postings ------------------------------------------------------------

  @Post('stock/receipts')
  @Roles(Permissions.INVENTORY_MANAGE)
  postReceipt(@Request() req: ExRequest, @Body() dto: PostReceiptDto) {
    const actor = resolveInventoryActor(req);
    return this.stock.postReceipt(actor, dto);
  }

  @Post('stock/issues')
  @Roles(Permissions.INVENTORY_MANAGE)
  createIssue(@Request() req: ExRequest, @Body() dto: CreateIssueDto) {
    const actor = resolveInventoryActor(req);
    return this.stock.createIssue(actor, dto);
  }

  @Get('stock/issues')
  @Roles(Permissions.INVENTORY_READ)
  listIssues(@Request() req: ExRequest, @Query() query: InventoryPageQueryDto) {
    const actor = resolveInventoryActor(req);
    return this.stock.listIssues(actor, {}, query.page ?? 1, query.pageSize ?? 50);
  }

  @Post('stock/adjustments')
  @Roles(Permissions.INVENTORY_MANAGE)
  createAdjustment(@Request() req: ExRequest, @Body() dto: CreateAdjustmentDto) {
    const actor = resolveInventoryActor(req);
    return this.stock.createAdjustment(actor, dto);
  }

  @Get('stock/adjustments')
  @Roles(Permissions.INVENTORY_READ)
  listAdjustments(@Request() req: ExRequest, @Query() query: InventoryPageQueryDto) {
    const actor = resolveInventoryActor(req);
    return this.stock.listAdjustments(actor, {}, query.page ?? 1, query.pageSize ?? 50);
  }

  @Post('stock/movements/:id/reverse')
  @Roles(Permissions.INVENTORY_MANAGE)
  reverse(
    @Request() req: ExRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReverseMovementDto
  ) {
    const actor = resolveInventoryActor(req);
    return this.stock.reverseMovement(actor, id, dto.note);
  }

  // ---- transfers -----------------------------------------------------------

  @Get('transfers')
  @Roles(Permissions.INVENTORY_READ)
  listTransfers(@Request() req: ExRequest, @Query() query: InventoryPageQueryDto) {
    const actor = resolveInventoryActor(req);
    return this.stock.listTransfers(actor, {}, query.page ?? 1, query.pageSize ?? 50);
  }

  @Post('transfers')
  @Roles(Permissions.INVENTORY_MANAGE)
  createTransfer(@Request() req: ExRequest, @Body() dto: CreateTransferDto) {
    const actor = resolveInventoryActor(req);
    return this.stock.createTransfer(actor, dto);
  }

  @Get('transfers/:id')
  @Roles(Permissions.INVENTORY_READ)
  findTransfer(@Request() req: ExRequest, @Param('id', ParseUUIDPipe) id: string) {
    const actor = resolveInventoryActor(req);
    return this.stock.findTransfer(actor, id);
  }

  @Post('transfers/:id/dispatch')
  @Roles(Permissions.INVENTORY_MANAGE)
  dispatchTransfer(@Request() req: ExRequest, @Param('id', ParseUUIDPipe) id: string) {
    const actor = resolveInventoryActor(req);
    return this.stock.dispatchTransfer(actor, id);
  }

  @Post('transfers/:id/receive')
  @Roles(Permissions.INVENTORY_MANAGE)
  receiveTransfer(@Request() req: ExRequest, @Param('id', ParseUUIDPipe) id: string) {
    const actor = resolveInventoryActor(req);
    return this.stock.receiveTransfer(actor, id);
  }

  @Post('transfers/:id/cancel')
  @Roles(Permissions.INVENTORY_MANAGE)
  cancelTransfer(@Request() req: ExRequest, @Param('id', ParseUUIDPipe) id: string) {
    const actor = resolveInventoryActor(req);
    return this.stock.cancelTransfer(actor, id);
  }

  // ---- stock counts ---------------------------------------------------------

  @Get('stock-counts')
  @Roles(Permissions.INVENTORY_READ)
  listCounts(@Request() req: ExRequest, @Query() query: InventoryPageQueryDto) {
    const actor = resolveInventoryActor(req);
    return this.stock.listCounts(actor, {}, query.page ?? 1, query.pageSize ?? 50);
  }

  @Post('stock-counts')
  @Roles(Permissions.INVENTORY_MANAGE)
  createCount(@Request() req: ExRequest, @Body() dto: CreateStockCountDto) {
    const actor = resolveInventoryActor(req);
    return this.stock.createCount(actor, dto);
  }

  @Get('stock-counts/:id')
  @Roles(Permissions.INVENTORY_READ)
  findCount(@Request() req: ExRequest, @Param('id', ParseUUIDPipe) id: string) {
    const actor = resolveInventoryActor(req);
    return this.stock.findCount(actor, id);
  }

  @Post('stock-counts/:id/lines/:lineId/count')
  @Roles(Permissions.INVENTORY_MANAGE)
  enterCountLine(
    @Request() req: ExRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() dto: EnterCountLineDto
  ) {
    const actor = resolveInventoryActor(req);
    return this.stock.enterCountLine(actor, id, lineId, dto.countedQty);
  }

  @Post('stock-counts/:id/post')
  @Roles(Permissions.INVENTORY_APPROVE)
  postCount(@Request() req: ExRequest, @Param('id', ParseUUIDPipe) id: string) {
    const actor = resolveInventoryActor(req);
    return this.stock.postCount(actor, id);
  }
}
