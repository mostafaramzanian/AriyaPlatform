"use client";


export default function AuditModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-2xl rounded-2xl bg-surface p-6 shadow-lg">
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-semibold">نمونهٔ لاگ تصمیم</h3>
          <button onClick={onClose} className="text-muted-foreground">بستن</button>
        </div>
        <div className="mt-4 text-sm text-muted-foreground">
          <p>شناسهٔ لاگ: <strong>#A-20260731-001</strong></p>
          <p className="mt-3">خلاصهٔ تصمیم: عامل پرداخت، صورتحساب معتبر را بررسی و پرداخت را اجرا کرد.</p>
          <pre className="mt-4 max-h-40 overflow-auto rounded bg-surface p-3 text-xs">{
`timestamp: 2026-07-31T08:00:12Z
agent: invoice-processor-v2
input: invoice_id=INV-2026-0001
decision: APPROVE
actions: ["create_payment_txn", "notify-accounting"]
audit: ["vector_match:0.92","policy_check:PASS"]`
}</pre>
          <div className="mt-4 flex justify-end">
            <a href="/security-brief.pdf" className="btn-secondary" target="_blank" rel="noreferrer">خلاصهٔ امنیتی</a>
          </div>
        </div>
      </div>
    </div>
  );
}
