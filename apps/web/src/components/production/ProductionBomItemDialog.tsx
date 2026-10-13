'use client';

import * as React from 'react';

import { CoreApiError } from '@/lib/core-http';
import {
  createProductionBomItem,
  updateProductionBomItem,
  type CreateProductionBomItemInput,
  type ProductionBomItem,
  type ProductionPartType,
  type ProductionControlPlan,
} from '@/lib/production-api';
import {
  PRODUCTION_CONTROL_PLANS,
  PRODUCTION_PART_TYPES,
  productionControlPlanLabel,
  productionErrorCode,
  productionErrorMessage,
  productionPartTypeLabel,
  productionServerMessage,
} from '@/lib/production-labels';

/**
 * Phase PRODUCTION-BOM: the add/edit item dialog.
 *
 * ONLY THE FIELDS THE ITEM DTO ACCEPTS. The five REQUIRED ones carry the source's own `*`
 * (`*نام قطعه`, `*نوع قطعه در پروژه`, `*جنس قطعه`, `*واحد اندازه گیری`, and the two
 * coefficients), and the optional ones are optional because the source never validated
 * them. Nothing here is invented.
 *
 * `standardPartCode` IS SHOWN, READ-ONLY AND DISABLED. It is the DEFERRED column
 * (`CodeStandardDarSanat`): the Product Tree code source that would drive it is BLOCKED
 * (RB-1-P), so there is no generation button, no auto-fill and no required marker — but the
 * field is VISIBLE (with a note that it is deferred) rather than hidden, because a migrated
 * value may exist and an admin should be able to see that it is not yet assigned.
 *
 * THE COEFFICIENTS ARE INTEGERS. The source `parseInt`s every arithmetic use and floors at
 * 0, so the inputs are `type="number" step="1" min="0"` and the wire carries a number. A
 * blank required field is refused here; a fraction or a negative would be a 400 from the
 * server's own `BOM_ITEM_COEFFICIENT_INVALID`, which this dialog renders by code.
 */
export interface ProductionBomItemDialogProps {
  bomId: string;
  /** `null` means "add"; an item means "edit". */
  item: ProductionBomItem | null;
  onClose: () => void;
  onSaved: () => void;
}

interface DraftState {
  partName: string;
  industryPartName: string;
  partType: ProductionPartType;
  material: string;
  measurementUnit: string;
  specifications: string;
  manufacturer: string;
  drawingConsumptionCoefficient: string;
  spareConsumptionCoefficient: string;
  suggestedSupplier: string;
  suggestedSupplierPrice: string;
  controlPlan: '' | ProductionControlPlan;
  notes: string;
}

function emptyDraft(): DraftState {
  return {
    partName: '',
    industryPartName: '',
    partType: PRODUCTION_PART_TYPES[0],
    material: '',
    measurementUnit: '',
    specifications: '',
    manufacturer: '',
    drawingConsumptionCoefficient: '',
    spareConsumptionCoefficient: '',
    suggestedSupplier: '',
    suggestedSupplierPrice: '',
    controlPlan: '',
    notes: '',
  };
}

function draftFrom(item: ProductionBomItem): DraftState {
  return {
    partName: item.partName,
    industryPartName: item.industryPartName ?? '',
    partType: item.partType,
    material: item.material,
    measurementUnit: item.measurementUnit,
    specifications: item.specifications ?? '',
    manufacturer: item.manufacturer ?? '',
    drawingConsumptionCoefficient: String(item.drawingConsumptionCoefficient),
    spareConsumptionCoefficient: String(item.spareConsumptionCoefficient),
    suggestedSupplier: item.suggestedSupplier ?? '',
    suggestedSupplierPrice: item.suggestedSupplierPrice ?? '',
    controlPlan: item.controlPlan ?? '',
    notes: item.notes ?? '',
  };
}

/** Blanks are OMITTED rather than sent as `""`, so an optional field is genuinely unset. */
function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function ProductionBomItemDialog({
  bomId,
  item,
  onClose,
  onSaved,
}: ProductionBomItemDialogProps) {
  const isEdit = item !== null;
  const [draft, setDraft] = React.useState<DraftState>(() =>
    item ? draftFrom(item) : emptyDraft()
  );
  const [isSaving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const set = <K extends keyof DraftState>(key: K, value: DraftState[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);

    const payload: CreateProductionBomItemInput = {
      partName: draft.partName.trim(),
      partType: draft.partType,
      material: draft.material.trim(),
      measurementUnit: draft.measurementUnit.trim(),
      drawingConsumptionCoefficient: Number(draft.drawingConsumptionCoefficient),
      spareConsumptionCoefficient: Number(draft.spareConsumptionCoefficient),
      ...(optional(draft.industryPartName) ? { industryPartName: draft.industryPartName.trim() } : {}),
      ...(optional(draft.specifications) ? { specifications: draft.specifications.trim() } : {}),
      ...(optional(draft.manufacturer) ? { manufacturer: draft.manufacturer.trim() } : {}),
      ...(optional(draft.suggestedSupplier)
        ? { suggestedSupplier: draft.suggestedSupplier.trim() }
        : {}),
      ...(optional(draft.suggestedSupplierPrice)
        ? { suggestedSupplierPrice: Number(draft.suggestedSupplierPrice) }
        : {}),
      ...(draft.controlPlan ? { controlPlan: draft.controlPlan } : {}),
      ...(optional(draft.notes) ? { notes: draft.notes.trim() } : {}),
    };

    try {
      if (isEdit && item) {
        await updateProductionBomItem(bomId, item.id, payload);
      } else {
        await createProductionBomItem(bomId, payload);
      }
      onSaved();
    } catch (err: unknown) {
      const details = err instanceof CoreApiError ? err.details : undefined;
      setError(
        productionErrorMessage(
          productionErrorCode(details),
          productionServerMessage(details) ??
            (err instanceof Error ? err.message : undefined)
        )
      );
      setSaving(false);
    }
  };

  const inputClass =
    'h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring';

  return (
    <div
      data-testid="production-item-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={isEdit ? 'ویرایش قلم' : 'افزودن قلم'}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
    >
      <form
        onSubmit={submit}
        className="my-8 w-full max-w-3xl rounded-2xl border border-border bg-card p-6 shadow-xl"
      >
        <h2 className="mb-4 text-lg font-semibold text-foreground">
          {isEdit ? 'ویرایش قلم' : 'افزودن قلم'}
        </h2>

        {error && (
          <p
            data-testid="production-item-dialog-error"
            className="mb-4 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="item-part-name" className="text-xs text-muted-foreground">
              نام قطعه *
            </label>
            <input
              id="item-part-name"
              name="partName"
              value={draft.partName}
              onChange={(event) => set('partName', event.target.value)}
              required
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="item-industry-name" className="text-xs text-muted-foreground">
              نام قطعه در صنعت
            </label>
            <input
              id="item-industry-name"
              name="industryPartName"
              value={draft.industryPartName}
              onChange={(event) => set('industryPartName', event.target.value)}
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="item-standard-code" className="text-xs text-muted-foreground">
              کد استاندارد قطعه (به‌زودی)
            </label>
            <input
              id="item-standard-code"
              name="standardPartCode"
              data-testid="production-item-standard-code"
              value={item?.standardPartCode ?? ''}
              readOnly
              disabled
              placeholder="تولید کد در انتظار درخت محصول است"
              className={`${inputClass} cursor-not-allowed bg-muted text-muted-foreground`}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="item-part-type" className="text-xs text-muted-foreground">
              نوع قطعه در پروژه *
            </label>
            <select
              id="item-part-type"
              name="partType"
              value={draft.partType}
              onChange={(event) => set('partType', event.target.value as ProductionPartType)}
              className={inputClass}
            >
              {PRODUCTION_PART_TYPES.map((type) => (
                <option key={type} value={type}>
                  {productionPartTypeLabel(type)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="item-material" className="text-xs text-muted-foreground">
              جنس قطعه *
            </label>
            <input
              id="item-material"
              name="material"
              value={draft.material}
              onChange={(event) => set('material', event.target.value)}
              required
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="item-unit" className="text-xs text-muted-foreground">
              واحد اندازه‌گیری *
            </label>
            <input
              id="item-unit"
              name="measurementUnit"
              value={draft.measurementUnit}
              onChange={(event) => set('measurementUnit', event.target.value)}
              required
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="item-drawing-coeff" className="text-xs text-muted-foreground">
              ضریب مصرف (در نقشه) *
            </label>
            <input
              id="item-drawing-coeff"
              name="drawingConsumptionCoefficient"
              type="number"
              step="1"
              min="0"
              value={draft.drawingConsumptionCoefficient}
              onChange={(event) => set('drawingConsumptionCoefficient', event.target.value)}
              required
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="item-spare-coeff" className="text-xs text-muted-foreground">
              ضریب مصرف (یدکی/تست) *
            </label>
            <input
              id="item-spare-coeff"
              name="spareConsumptionCoefficient"
              type="number"
              step="1"
              min="0"
              value={draft.spareConsumptionCoefficient}
              onChange={(event) => set('spareConsumptionCoefficient', event.target.value)}
              required
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="item-manufacturer" className="text-xs text-muted-foreground">
              سازنده قطعه
            </label>
            <input
              id="item-manufacturer"
              name="manufacturer"
              value={draft.manufacturer}
              onChange={(event) => set('manufacturer', event.target.value)}
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="item-supplier" className="text-xs text-muted-foreground">
              تأمین‌کننده پیشنهادی
            </label>
            <input
              id="item-supplier"
              name="suggestedSupplier"
              value={draft.suggestedSupplier}
              onChange={(event) => set('suggestedSupplier', event.target.value)}
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="item-supplier-price" className="text-xs text-muted-foreground">
              قیمت تأمین‌کننده پیشنهادی
            </label>
            <input
              id="item-supplier-price"
              name="suggestedSupplierPrice"
              type="number"
              step="0.01"
              min="0"
              value={draft.suggestedSupplierPrice}
              onChange={(event) => set('suggestedSupplierPrice', event.target.value)}
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="item-control-plan" className="text-xs text-muted-foreground">
              طرح کنترل دارد؟
            </label>
            <select
              id="item-control-plan"
              name="controlPlan"
              value={draft.controlPlan}
              onChange={(event) =>
                set('controlPlan', event.target.value as '' | ProductionControlPlan)
              }
              className={inputClass}
            >
              <option value="">—</option>
              {PRODUCTION_CONTROL_PLANS.map((plan) => (
                <option key={plan} value={plan}>
                  {productionControlPlanLabel(plan)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-1">
          <label htmlFor="item-specifications" className="text-xs text-muted-foreground">
            مشخصات قطعه
          </label>
          <textarea
            id="item-specifications"
            name="specifications"
            value={draft.specifications}
            onChange={(event) => set('specifications', event.target.value)}
            rows={2}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition focus:border-ring"
          />
        </div>

        <div className="mt-4 flex flex-col gap-1">
          <label htmlFor="item-notes" className="text-xs text-muted-foreground">
            توضیحات قطعه در BOM
          </label>
          <textarea
            id="item-notes"
            name="notes"
            value={draft.notes}
            onChange={(event) => set('notes', event.target.value)}
            rows={2}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition focus:border-ring"
          />
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <button
            type="submit"
            data-testid="production-item-dialog-save"
            disabled={isSaving}
            className="inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isEdit ? 'ذخیرهٔ تغییرات' : 'افزودن قلم'}
          </button>
          <button
            type="button"
            data-testid="production-item-dialog-cancel"
            onClick={onClose}
            className="inline-flex h-10 items-center rounded-xl border border-border px-4 text-sm font-medium text-foreground transition hover:bg-secondary"
          >
            انصراف
          </button>
        </div>
      </form>
    </div>
  );
}

