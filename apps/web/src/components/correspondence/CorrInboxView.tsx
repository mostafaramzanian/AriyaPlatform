'use client';

import * as React from 'react';
import { useReloadToken } from '@/hooks/use-reload-token';
import { listInbox, listReferralInbox, markLetter, removeInboxItem, updateReferralStatus, type InboxItem } from '@/lib/correspondence-api';
import { InboxSurface } from './InboxRow';

/**
 * Phase 50: کارتابل (نامه‌های دریافتی). Two REAL sources: letters addressed to me
 * (TO/CC/BCC rows) and letters referred to me (referral rows). Every action —
 * مشاهده، اقدام، حذف از صندوق — is a server mutation on MY rows.
 */
export function CorrInboxView() {
  const [items, setItems] = React.useState<InboxItem[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<'letters' | 'referrals'>('letters');
  // Re-arms loading/cleared in the retry/action handlers and the tab switch
  // below (same commit as the token/tab bump), so the fetch effect needs no
  // in-effect setter resets. First mount is covered by `isLoading: true`.
  const { token: reloadToken, reload } = useReloadToken(setIsLoading, setError);

  React.useEffect(() => {
    let active = true;
    const loader = tab === 'letters' ? listInbox({ limit: 50 }) : listReferralInbox({ limit: 50 });
    loader
      .then((result) => {
        if (active) setItems(result.items);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : 'دریافت صندوق ناموفق بود.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [tab, reloadToken]);

  const handleViewed = async (item: InboxItem) => {
    setActionError(null);
    try {
      await markLetter(item.letter.id, 'VIEWED');
      if (item.source === 'REFERRAL' && item.referral && item.referral.status === 'PENDING') {
        await updateReferralStatus(item.referral.id, 'VIEWED');
      }
      reload();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'ثبت مشاهده ناموفق بود.');
    }
  };

  const handleActed = async (item: InboxItem) => {
    setActionError(null);
    try {
      if (item.source === 'REFERRAL' && item.referral) {
        await updateReferralStatus(item.referral.id, 'ACTED');
      } else {
        await markLetter(item.letter.id, 'READ');
      }
      reload();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'ثبت اقدام ناموفق بود.');
    }
  };

  const handleRemove = async (item: InboxItem) => {
    setActionError(null);
    try {
      if (item.source === 'RECIPIENT') {
        await removeInboxItem(item.letter.id);
      }
      setItems((prev) => prev.filter((row) => row.itemId !== item.itemId));
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'حذف از صندوق ناموفق بود.');
    }
  };

  // Tab switches re-arm loading/cleared in this handler (same commit as the
  // tab state change), replacing the removed in-effect setter resets.
  const switchTab = (next: 'letters' | 'referrals') => {
    setTab(next);
    setIsLoading(true);
    setError(null);
  };

  return (
    <InboxSurface
      tab={tab}
      setTab={switchTab}
      items={items}
      isLoading={isLoading}
      error={error}
      actionError={actionError}
      onViewed={handleViewed}
      onActed={handleActed}
      onRemove={handleRemove}
      onRetry={reload}
    />
  );
}