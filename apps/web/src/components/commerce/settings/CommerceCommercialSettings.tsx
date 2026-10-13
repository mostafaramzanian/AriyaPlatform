'use client';

import { CommerceSectionHeading } from '../commerce-ui';
import { CommerceCommercialGroupSettings } from './CommerceCommercialGroupSettings';
import { CommerceCommercialConfigurationSettings } from './CommerceCommercialConfigurationSettings';

/**
 * PHASE UI-4: «تنظیمات بازرگانی» — the SECOND (and last) branch of the domain.
 *
 * Two sibling sections, both backed by confirmed C1-P routes:
 *   • گروه‌های بازرگانی — `GET/POST/PATCH /commerce/commercial-groups`
 *   • پیکربندی بازرگانی — the six configuration lifecycle routes
 * Nothing else appears here: commercial assignments and approvals are OPERATIONAL
 * (they live on the purchase document, UI-2/UI-3), and quotation surfaces do not exist
 * (UI-0 GAP-6) so no control pretends to.
 */
export function CommerceCommercialSettings({
  canConfigure,
  canReadDirectory,
}: {
  canConfigure: boolean;
  canReadDirectory: boolean;
}) {
  return (
    <div className="space-y-core-gap" data-testid="commerce-commercial-settings">
      <CommerceSectionHeading
        title="تنظیمات بازرگانی"
        description="گروه‌های رسیدگی به ردیف‌های خرید و پیکربندی واگذاری و تأیید بازرگانی را از این بخش مدیریت کنید."
      />

      <CommerceCommercialGroupSettings
        canConfigure={canConfigure}
        canReadDirectory={canReadDirectory}
      />

      <CommerceCommercialConfigurationSettings
        canConfigure={canConfigure}
        canReadDirectory={canReadDirectory}
      />
    </div>
  );
}