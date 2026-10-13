import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * PHASE UI-5 — the FINAL Commerce frontend gate, written as executable assertions.
 *
 * UI-5 does not add a screen; it hardens the product screens UI-1 → UI-4 built into one
 * experience. The behaviours gained dedicated specs elsewhere (the requester picker in
 * `CommercePurchaseCreateView.spec.tsx`, the pending-decision callout in
 * `CommercePurchaseDetailView.spec.tsx`); what lives HERE are the cross-cutting properties
 * a per-screen test can never see, because they belong to the WHOLE surface:
 *
 *   1. §37  no `tenantId`, no Prisma, no backend module, no browser-side rule evaluation;
 *   2. §1/§3 every `/commerce/**` call answers to a route the backend actually exposes —
 *            and no call names a still-open gap (workflow-instances, line-routing,
 *            summary/KPI, pending queue, search, audit timeline) as if it existed;
 *   3. §33  ONE product term for the document («درخواست خرید» / «سند درخواست خرید»);
 *   4. §24  logical CSS only — no physical left/right anywhere in Commerce styling;
 *   5. §6   navigation coherence — every link points at a route that exists.
 *
 * WHY A SOURCE SCAN. These claims are about ABSENCE — about what the product never asks
 * for and never offers. A rendered test can only observe what appears; the honest way to
 * prove a door does not exist is to read every doorframe. The repo's own convention for
 * boundaries does exactly this (`commerce-gateways.spec.ts`, `commerce-isolation.spec.ts`
 * and the other guard suites all scan source).
 *
 * COMMENTS ARE STRIPPED FIRST. This codebase documents its refusals in prose — its own
 * comments say «NO `tenantId` anywhere» — and a scan that failed on its own documentation
 * would teach the next author to delete the honest comment instead of the real violation.
 * Only block comments and whole-line `//` comments are removed: a string containing `//`
 * (a URL) is never touched.
 */

const COMMERCE_DIR = join(__dirname, '..');
const SRC_DIR = join(COMMERCE_DIR, '..', '..');
const LIB_DIR = join(SRC_DIR, 'lib');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** The Commerce UI sources (its own tests excluded) plus the three Commerce lib modules. */
const UI_FILES = walk(COMMERCE_DIR).filter(
  (file) => !file.includes('__tests__') && /\.(ts|tsx)$/.test(file)
);
const LIB_FILES = ['commerce-api.ts', 'commerce-labels.ts', 'commerce-decimals.ts'].map((name) =>
  join(LIB_DIR, name)
);

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const SOURCES = [...UI_FILES, ...LIB_FILES].map((file) => ({
  name: relative(SRC_DIR, file).replace(/\\/g, '/'),
  code: stripComments(readFileSync(file, 'utf8')),
}));

/** One file's comment-free source, by file-name suffix. */
function source(name: string): string {
  const found = SOURCES.find((entry) => entry.name.endsWith(name));
  if (!found) throw new Error(`source not found: ${name}`);
  return found.code;
}

const offenders = (pattern: RegExp) =>
  SOURCES.filter(({ code }) => pattern.test(code)).map(({ name }) => name);

describe('PHASE UI-5 — the final Commerce frontend gate', () => {
  describe('§37 — the security boundary of browser code', () => {
    it('never carries a tenantId outside a comment, on any Commerce surface', () => {
      expect(offenders(/tenantId/)).toEqual([]);
    });

    it('imports no Prisma client, no generated client, no backend module, no database package', () => {
      expect(
        offenders(/@prisma|generated\/[a-z-]*client|from ['"].*apps\/api|database\/prisma/)
      ).toEqual([]);
    });

    it('evaluates no workflow, rule or authorization logic in the browser', () => {
      // The condition EDITOR authors `{field, op, value}` leaves for the server to
      // validate — it never decides anything. These are the names of the deciding side.
      expect(
        offenders(
          /evaluateSync|RuleEngineService|canTransitionPurchaseDocument|advanceWorkflow|resolveNextStep|isRuleApplicable|assertMember/
        )
      ).toEqual([]);
    });
  });

  describe('§1/§3 — no capability the backend has not exposed', () => {
    /** The path prefixes of every route `commerce.module.ts` registers. */
    const ALLOWED_ROUTE_PREFIXES = [
      '/commerce/purchase-documents',
      '/commerce/commercial-groups',
      '/commerce/commercial-configurations',
      '/commerce/commercial-assignments',
      '/commerce/commercial-approvals',
      '/commerce/workflow-definitions',
      '/commerce/workflow-versions',
      // PHASE C4-R (GAP-3): the completion policy's configuration routes
      // (`commerce/completion-policies`) are a live surface now — the Settings Center's
      // «تکمیل خرید» section reads and writes them.
      '/commerce/completion-policies',
    ];

    it('addresses only routes that exist on the server', () => {
      const called = new Set<string>();
      for (const { code } of SOURCES) {
        for (const match of code.matchAll(/['"`](\/commerce\/[A-Za-z0-9/_-]*)/g)) {
          called.add(match[1]);
        }
      }

      expect(called.size).toBeGreaterThan(0);
      expect(
        [...called].filter(
          (path) => !ALLOWED_ROUTE_PREFIXES.some((prefix) => path.startsWith(prefix))
        )
      ).toEqual([]);
    });

    it('names no still-open gap as if it were an API — workflow, routing, KPI, queue, search, audit', () => {
      const deferred = [
        '/commerce/workflow-instances', // GAP-1
        'approvals/pending', // GAP-1b
        'line-routing', // GAP-2
        '/commerce/summary', // GAP-4
        '/commerce/search', // GAP-5
        '/timeline', // GAP-7
        '/audit', // GAP-7
        '/commerce/notifications', // GAP-9
      ];
      expect(deferred.filter((needle) => SOURCES.some(({ code }) => code.includes(needle)))).toEqual(
        []
      );
    });

    it('offers no Close control — the completion UI is a later, explicit task (GAP-3, C4-R §30)', () => {
      // PHASE C4-R changed the REASON this assertion holds, not the assertion itself: the
      // backend now DOES define the CLOSED transition (a published Purchase Completion
      // Policy authorises it and `POST …/purchase-documents/:id/close` performs it), but the
      // C4-R brief explicitly defers the close CONTROL to a later UI task — "the backend
      // contract must not be bent to the current UI". So no screen may render one yet, and
      // the honesty gate keeps refusing the vocabulary that would imply one.
      expect(offenders(/data-testid=["'`][^"'`]*close-document|بستن سند|بستن درخواست/)).toEqual([]);
    });
  });

  describe('§33 — one product vocabulary', () => {
    it('never uses «سند خرید» — the document is the «سند درخواست خرید»', () => {
      expect(offenders(/سند خرید/)).toEqual([]);
    });

    it('qualifies every «خرید جدید» — never a bare synonym for the purchase request', () => {
      const violations: string[] = [];
      for (const { name, code } of SOURCES) {
        const needle = 'خرید جدید';
        let index = code.indexOf(needle);
        while (index !== -1) {
          const before = code.slice(Math.max(0, index - 12), index);
          if (!/(درخواست|فرآیند)\s$/.test(before)) violations.push(`${name}: …${before}${needle}`);
          index = code.indexOf(needle, index + needle.length);
        }
      }
      expect(violations).toEqual([]);
    });

    it('states the SAME create action on Home, the register and the form itself', () => {
      expect(source('CommerceHomeView.tsx')).toContain('درخواست خرید جدید');
      expect(source('CommercePurchaseListView.tsx')).toContain('درخواست خرید جدید');
      expect(source('CommercePurchaseCreateView.tsx')).toContain('درخواست خرید جدید');
    });
  });

  describe('§24 — RTL is a property of the stylesheet, not of the QA run', () => {
    it('uses logical CSS properties only: no physical left/right in any Commerce style', () => {
      expect(
        offenders(
          /(^|[\s"'`])(ml-|mr-|pl-|pr-)([0-9]|px|auto)|text-left|text-right|(^|[\s"'`])left-[0-9]|(^|[\s"'`])right-[0-9]|border-[lr]-|rounded-[lr]-/
        )
      ).toEqual([]);
    });
  });

  describe('§6 — navigation coherence', () => {
    /** Every route `apps/web/src/app/admin/commerce` actually serves. */
    const REAL_ROUTES = [
      '/admin/commerce',
      '/admin/commerce/tasks',
      '/admin/commerce/purchases',
      '/admin/commerce/purchases/new',
      '/admin/commerce/purchases/', // `[id]` — dynamic, matched by prefix
      '/admin/settings', // the Settings Center every configuration surface lives in
    ];

    it('links only to routes that exist', () => {
      const hrefs = new Set<string>();
      for (const { code } of SOURCES) {
        for (const match of code.matchAll(/["'`](\/admin\/[A-Za-z0-9/_-]*)["'`]/g)) {
          hrefs.add(match[1]);
        }
        for (const match of code.matchAll(/href=\{`([^`]+)`\}/g)) {
          if (match[1].startsWith('/admin/')) {
            hrefs.add(match[1].replace(/\$\{[^}]+\}/g, 'x'));
          }
        }
      }

      expect(hrefs.size).toBeGreaterThan(0);
      expect(
        [...hrefs].filter(
          (href) =>
            !REAL_ROUTES.some((route) =>
              route.endsWith('/') ? href.startsWith(route) : href === route
            )
        )
      ).toEqual([]);
    });

    it('keeps the register and task destinations the sidebar rail declares', () => {
      const home = source('CommerceHomeView.tsx');
      expect(home).toContain('href="/admin/commerce/purchases"');
      expect(home).toContain('href="/admin/commerce/tasks"');
    });
  });

  describe('§10/§13/§14 — the deferred gaps stay honestly deferred', () => {
    it('My Tasks keeps the bounded-composition disclosure and claims no complete inbox', () => {
      const tasks = source('CommerceTasksView.tsx');
      expect(tasks).toContain('ممکن است موارد خارج از این بازه در آن نباشند');
      expect(tasks).not.toMatch(/همه کارهای (شما|من)/);
    });

    it('Purchase Detail labels its events as read-derived and admits the audit gap', () => {
      const detail = source('CommercePurchaseDetailView.tsx');
      expect(detail).toContain('تاریخچهٔ کامل ممیزی');
      expect(detail).toContain('اطلاعات خوانده‌شدهٔ همین صفحه');
    });

    it('shows no workflow-execution vocabulary as a control anywhere (GAP-1)', () => {
      expect(
        offenders(/data-testid=["'`][^"'`]*workflow-(step-)?(approve|decision)|resolvedApprover/)
      ).toEqual([]);
    });
  });
});
