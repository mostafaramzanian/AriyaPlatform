import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { canReadAnyKpi, fetchKpi, fetchKpiHistory, fetchKpis, KPI_READ_REMITS } from '../kpi-api';
import { coreGet } from '../core-http';

jest.mock('../core-http', () => ({ coreGet: jest.fn() }));

const coreGetMock = coreGet as jest.MockedFunction<typeof coreGet>;

/**
 * Phase KPI-RUNTIME — what `kpi-api.ts` promises, as executable behaviour.
 *
 * THREE CLAIMS:
 *  1. THE REMITS ARE THE SERVER'S, NOT THIS FILE'S OPINION. `KPI_READ_REMITS` is a
 *     client-side restatement (the API cannot be imported across apps), so the test reads
 *     `kpi-runtime.controller.ts` and `permissions.ts` OFF DISK and asserts the two agree
 *     member for member. A hand-copied list that silently drifted would hide the rail row
 *     from exactly the callers the controller admits — and unlike a snapshot, this fails
 *     with both lists printed.
 *  2. THE GATE IS A UNION. `canReadAnyKpi` opens on any one remit and on no remit closes it.
 *  3. ONLY `jy`/`jm` CROSS THE WIRE, and both are optional — no tenantId, no status, no
 *     pagination, because the DTO refuses every one of them with a 422.
 */

const API_SRC = resolve(__dirname, '../../../../api/src');

/** Every `KEY: 'value'` pair in `Permissions`, so a `Permissions.X` token can be resolved. */
function permissionStrings(): Record<string, string> {
  const source = readFileSync(resolve(API_SRC, 'auth/rbac/constants/permissions.ts'), 'utf8');
  const map: Record<string, string> = {};
  for (const match of source.matchAll(/^\s*([A-Z0-9_]+):\s*'([^']+)',$/gm)) {
    map[match[1]] = match[2];
  }
  return map;
}

/** The `Permissions.*` members the controller spreads into `KPI_READ_REMITS`. */
function controllerRemits(): string[] {
  const source = readFileSync(
    resolve(API_SRC, 'modules/kpi-runtime/kpi-runtime.controller.ts'),
    'utf8'
  );
  const block = /export const KPI_READ_REMITS[^=]*=\s*\[([\s\S]*?)\]/.exec(source);
  if (!block) throw new Error('fixture: controller KPI_READ_REMITS not found');

  const known = permissionStrings();
  return [...block[1].matchAll(/Permissions\.([A-Z0-9_]+)/g)].map((match) => {
    const value = known[match[1]];
    if (!value) throw new Error(`fixture: unknown permission ${match[1]}`);
    return value;
  });
}

describe('KPI_READ_REMITS — the client restatement agrees with the server, member for member', () => {
  it('is exactly the controller’s own union', () => {
    expect([...KPI_READ_REMITS].sort()).toEqual(controllerRemits().sort());
  });

  it('is the three domains the five approved KPIs read from', () => {
    expect([...KPI_READ_REMITS].sort()).toEqual([
      'commerce.read',
      'financial.check.read',
      'production.bom.read',
    ]);
  });
});

describe('canReadAnyKpi — a UNION, because one remit is not the whole catalogue', () => {
  it('opens on any single remit', () => {
    for (const remit of KPI_READ_REMITS) {
      expect(canReadAnyKpi([remit])).toBe(true);
    }
  });

  it('closes on no remit and on an unrelated grant', () => {
    expect(canReadAnyKpi([])).toBe(false);
    expect(canReadAnyKpi(['admin.users.read'])).toBe(false);
  });
});

describe('the query — only jy/jm, both optional', () => {
  beforeEach(() => coreGetMock.mockReset());

  it('omits the query string entirely when no period is stated', async () => {
    await fetchKpis();
    expect(coreGetMock).toHaveBeenCalledWith('/kpis');
  });

  it('sends exactly the two integers the DTO validates', async () => {
    await fetchKpis({ jy: 1405, jm: 8 });
    expect(coreGetMock).toHaveBeenCalledWith('/kpis?jy=1405&jm=8');
  });

  it('lets the server fill a half-stated period rather than inventing the other half', async () => {
    await fetchKpis({ jm: 8 });
    expect(coreGetMock).toHaveBeenCalledWith('/kpis?jm=8');
  });

  it('encodes the technical key and keeps the period on the detail route', async () => {
    await fetchKpi('production-bom-decision-cycle-time', { jy: 1405, jm: 8 });
    expect(coreGetMock).toHaveBeenCalledWith(
      '/kpis/production-bom-decision-cycle-time?jy=1405&jm=8'
    );
  });

  it('never carries a tenantId, a status or a page — the DTO would 422 them', async () => {
    await fetchKpis({ jy: 1405, jm: 8 });
    const path = coreGetMock.mock.calls[0][0] as string;
    expect(path).not.toMatch(/tenant|status|page|search/i);
  });
});

describe('the history query — a bounded range, never an open-ended one', () => {
  beforeEach(() => coreGetMock.mockReset());

  it('asks for the server default with an empty query', async () => {
    await fetchKpiHistory('production-bom-decision-cycle-time');
    expect(coreGetMock).toHaveBeenCalledWith('/kpis/production-bom-decision-cycle-time/history');
  });

  it('sends a bounded period count', async () => {
    await fetchKpiHistory('production-bom-decision-cycle-time', { periodCount: 6 });
    expect(coreGetMock).toHaveBeenCalledWith(
      '/kpis/production-bom-decision-cycle-time/history?periodCount=6'
    );
  });

  it('sends an explicit from/to range and encodes the key', async () => {
    await fetchKpiHistory('commerce-purchase-cycle-time', {
      fromJy: 1405,
      fromJm: 6,
      toJy: 1405,
      toJm: 8,
    });
    expect(coreGetMock).toHaveBeenCalledWith(
      '/kpis/commerce-purchase-cycle-time/history?fromJy=1405&fromJm=6&toJy=1405&toJm=8'
    );
  });
});
