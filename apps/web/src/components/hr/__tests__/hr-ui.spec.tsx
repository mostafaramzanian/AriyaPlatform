import { render, screen } from '@testing-library/react';

import {
  HrBadge,
  HrCard,
  HrEmployeeStatusBadge,
  HrField,
  HrNotice,
  HrPageHeading,
  HrRecordStatusBadge,
} from '../hr-ui';

/**
 * Phase 51-HR-2B: the shared HR primitives.
 *
 * The rules pinned here are the ones §30 makes non-negotiable: a status is a WORD first and
 * a colour second, an inline mutation result is announced to assistive technology, and every
 * interactive element the browser E2E drives carries a `data-testid` rather than a label a
 * translation could move.
 */
describe('hr-ui primitives', () => {
  it('renders a status as its Persian word, with colour as a second channel only', () => {
    render(<HrEmployeeStatusBadge status="TERMINATED" />);

    expect(screen.getByTestId('hr-employee-status-TERMINATED')).toHaveTextContent('خاتمه‌یافته');
    // The destructive tone is additive: the class list carries colour, the text carries meaning.
    expect(screen.getByTestId('hr-employee-status-TERMINATED').className).toContain('destructive');
  });

  it('renders a record status through the record label, never the employee one', () => {
    render(<HrRecordStatusBadge status="INACTIVE" />);

    expect(screen.getByTestId('hr-record-status-INACTIVE')).toHaveTextContent('غیرفعال');
  });

  it('tints a badge by tone and keeps an untoned badge neutral', () => {
    render(
      <>
        <HrBadge tone="ok" testId="b-ok">
          a
        </HrBadge>
        <HrBadge tone="muted" testId="b-muted">
          b
        </HrBadge>
      </>,
    );

    expect(screen.getByTestId('b-ok').className).toContain('emerald');
    expect(screen.getByTestId('b-muted').className).toContain('muted');
  });

  it('announces a failed mutation as an alert and a successful one as a status', () => {
    render(
      <>
        <HrNotice tone="error" message="ثبت نشد." />
        <HrNotice tone="ok" message="ثبت شد." />
      </>,
    );

    expect(screen.getByTestId('hr-notice-error')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('hr-notice-ok')).toHaveAttribute('role', 'status');
  });

  it('renders the heading description and its actions slot only when supplied', () => {
    const { rerender } = render(<HrPageHeading title="کارکنان" />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('کارکنان');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    rerender(
      <HrPageHeading
        title="کارکنان"
        description="توضیح"
        actions={<button type="button">عمل</button>}
      />,
    );

    expect(screen.getByText('توضیح')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'عمل' })).toBeInTheDocument();
  });

  it('exposes a card test hook and a field label/value pair', () => {
    render(
      <HrCard title="عنوان" testId="card-1">
        <dl>
          <HrField label="کد کارمندی">E-1</HrField>
        </dl>
      </HrCard>,
    );

    expect(screen.getByTestId('card-1')).toBeInTheDocument();
    expect(screen.getByText('عنوان')).toBeInTheDocument();
    expect(screen.getByText('کد کارمندی')).toBeInTheDocument();
    expect(screen.getByText('E-1')).toBeInTheDocument();
  });
});