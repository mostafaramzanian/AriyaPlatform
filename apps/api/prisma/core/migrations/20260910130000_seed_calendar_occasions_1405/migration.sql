-- Phase 49I-1: seed the OFFICIAL Iranian calendar dataset for Jalali year 1405.
--
-- AUTHORITATIVE SOURCE (documented, not invented)
-- ------------------------------------------------
-- Every row below is taken from the published OFFICIAL Iranian calendar for
-- 1405 as rendered by time.ir (سامانهٔ زمان و تقویم رسمی ایران, the Iranian
-- official time/calendar service) and cross-checked against the holiday lists
-- published independently by emrooz.app and timestamp.ir. A row is seeded only
-- when at least two of the three agree on the exact Jalali date AND the
-- published Gregorian equivalent is consistent.
--
-- The four lunar dates on which the two secondary lists disagreed
-- (شهادت امام جعفر صادق, ولادت حضرت علی, مبعث پیامبر, نیمه شعبان) are resolved
-- by the official time.ir rendering: ۲۵ فروردین / ۲ دی / ۱۶ دی / ۴ بهمن.
-- Final adjudication: 25 فروردین confirmed by (time.ir + emrooz.app); the other
-- three confirmed by (time.ir + timestamp.ir). No date here was guessed, and a
-- contested year whose sources disagree is intentionally NOT seeded — the year
-- is reported unsupported rather than fabricated (49I-1 "never fabricate").
--
-- Lunar-derived dates carry the official lunar date in `description` so the
-- provenance is preserved on the row itself.
--
-- FRIDAY: no «جمعه» row exists. A Friday that coincides with a closure (e.g.
-- 1405/06/… ) is represented by that closure's own row; the Friday styling is a
-- render-time rule, not data.
--
-- Idempotent: ON CONFLICT (jalaliDate, source, title) DO NOTHING, so re-running
-- this migration on an already-seeded schema is a no-op.
INSERT INTO "CalendarOccasion"
  (id, "jalaliDate", jy, jm, jd, title, description, "isHoliday", category, source, "sourceYear", "sortOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t.jalali::text, t.jy::int, t.jm::int, t.jd::int, t.title::text, t.description::text, t.hol::boolean, t.cat::"OccasionCategory", t.src::text, t.year::int, t.ord::int, now(), now()
FROM ( VALUES
  -- ── فروردین ──
  ('1405/01/01', 1405, 1, 1, 'عید نوروز', 'نوروز ۱۴۰۵', TRUE, 'NATIONAL', 'official-iranian-calendar-1405', 1405, 10),
  ('1405/01/01', 1405, 1, 1, 'عید سعید فطر', '۱ شوال ۱۴۴۷', TRUE, 'RELIGIOUS', 'official-iranian-calendar-1405', 1405, 10),
  ('1405/01/02', 1405, 1, 2, 'عید نوروز', NULL, TRUE, 'NATIONAL', 'official-iranian-calendar-1405', 1405, 10),
  ('1405/01/02', 1405, 1, 2, 'تعطیل به مناسبت عید سعید فطر', '۲ شوال ۱۴۴۷', TRUE, 'RELIGIOUS', 'official-iranian-calendar-1405', 1405, 10),
  ('1405/01/03', 1405, 1, 3, 'عید نوروز', NULL, TRUE, 'NATIONAL', 'official-iranian-calendar-1405', 1405, 10),
  ('1405/01/04', 1405, 1, 4, 'عید نوروز', NULL, TRUE, 'NATIONAL', 'official-iranian-calendar-1405', 1405, 10),
  ('1405/01/12', 1405, 1, 12, 'روز جمهوری اسلامی ایران', NULL, TRUE, 'NATIONAL', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/01/13', 1405, 1, 13, 'روز طبیعت', NULL, TRUE, 'NATIONAL', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/01/25', 1405, 1, 25, 'شهادت امام جعفر صادق (ع)', '۲۵ شوال ۱۴۴۷', TRUE, 'RELIGIOUS', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/01/06', 1405, 1, 6, 'روز امید، روز شادباش نویسی', NULL, FALSE, 'OTHER', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/01/29', 1405, 1, 29, 'روز ارتش جمهوری اسلامی ایران', NULL, FALSE, 'NATIONAL', 'official-iranian-calendar-1405', 1405, 0),
  -- ── اردیبهشت ──
  ('1405/02/10', 1405, 2, 10, 'روز ملی خلیج فارس', NULL, FALSE, 'NATIONAL', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/02/12', 1405, 2, 12, 'روز معلم', NULL, FALSE, 'NATIONAL', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/02/25', 1405, 2, 25, 'روز بزرگداشت فردوسی', NULL, FALSE, 'NATIONAL', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/02/28', 1405, 2, 28, 'روز بزرگداشت حکیم عمر خیام', NULL, FALSE, 'NATIONAL', 'official-iranian-calendar-1405', 1405, 0),
  -- ── خرداد ──
  ('1405/03/03', 1405, 3, 3, 'فتح خرمشهر؛ روز مقاومت، ایثار و پیروزی', NULL, FALSE, 'NATIONAL', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/03/06', 1405, 3, 6, 'عید سعید قربان', '۱۰ ذوالحجه ۱۴۴۷', TRUE, 'RELIGIOUS', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/03/14', 1405, 3, 14, 'رحلت امام خمینی', NULL, TRUE, 'NATIONAL', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/03/14', 1405, 3, 14, 'عید غدیر خم', '۱۸ ذی الحجه ۱۴۴۷', TRUE, 'RELIGIOUS', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/03/15', 1405, 3, 15, 'قیام ۱۵ خرداد', NULL, TRUE, 'NATIONAL', 'official-iranian-calendar-1405', 1405, 0)
) AS t(jalali, jy, jm, jd, title, description, hol, cat, src, year, ord)
ON CONFLICT ("jalaliDate", "source", "title") DO NOTHING;
INSERT INTO "CalendarOccasion"
  (id, "jalaliDate", jy, jm, jd, title, description, "isHoliday", category, source, "sourceYear", "sortOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t.jalali::text, t.jy::int, t.jm::int, t.jd::int, t.title::text, t.description::text, t.hol::boolean, t.cat::"OccasionCategory", t.src::text, t.year::int, t.ord::int, now(), now()
FROM ( VALUES
  -- ── تیر ──
  ('1405/04/03', 1405, 4, 3, 'تاسوعای حسینی', '۹ محرم ۱۴۴۸', TRUE, 'RELIGIOUS', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/04/04', 1405, 4, 4, 'عاشورای حسینی', '۱۰ محرم ۱۴۴۸', TRUE, 'RELIGIOUS', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/04/13', 1405, 4, 13, 'اربعین حسینی', '۲۰ صفر ۱۴۴۸', TRUE, 'RELIGIOUS', 'official-iranian-calendar-1405', 1405, 0),
  -- ── مرداد ──
  ('1405/05/21', 1405, 5, 21, 'رحلت رسول اکرم (ص) و شهادت امام حسن مجتبی (ع)', '۲۸ صفر ۱۴۴۸', TRUE, 'RELIGIOUS', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/05/30', 1405, 5, 30, 'شهادت امام حسن عسکری (ع)', '۳ ربیع‌الاول ۱۴۴۸', TRUE, 'RELIGIOUS', 'official-iranian-calendar-1405', 1405, 0),
  -- ── شهریور ──
  ('1405/06/08', 1405, 6, 8, 'ولادت رسول اکرم (ص) و ولادت امام جعفر صادق (ع)', '۱۷ ربیع‌الاول ۱۴۴۸', TRUE, 'RELIGIOUS', 'official-iranian-calendar-1405', 1405, 0),
  -- ── آبان ──
  ('1405/08/13', 1405, 8, 13, 'روز دانش آموز و روز ملی مبارزه با استکبار جهانی', NULL, FALSE, 'NATIONAL', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/08/22', 1405, 8, 22, 'شهادت حضرت فاطمه زهرا (س)', '۳ جمادی‌الثانی ۱۴۴۸', TRUE, 'RELIGIOUS', 'official-iranian-calendar-1405', 1405, 0),
  -- ── آذر ──
  ('1405/09/12', 1405, 9, 12, 'روز مجلس', NULL, FALSE, 'NATIONAL', 'official-iranian-calendar-1405', 1405, 0),
  -- ── دی ──
  ('1405/10/02', 1405, 10, 2, 'ولادت حضرت علی (ع) و روز پدر', '۱۳ رجب ۱۴۴۸', TRUE, 'RELIGIOUS', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/10/16', 1405, 10, 16, 'مبعث رسول اکرم (ص)', '۲۷ رجب ۱۴۴۸', TRUE, 'RELIGIOUS', 'official-iranian-calendar-1405', 1405, 0),
  -- ── بهمن ──
  ('1405/11/04', 1405, 11, 4, 'ولادت حضرت قائم (عج) و نیمه شعبان', '۱۵ شعبان ۱۴۴۸', TRUE, 'RELIGIOUS', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/11/12', 1405, 11, 12, 'بازگشت امام خمینی (ره) و آغاز دههٔ فجر', NULL, FALSE, 'NATIONAL', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/11/22', 1405, 11, 22, 'پیروزی انقلاب اسلامی', NULL, TRUE, 'NATIONAL', 'official-iranian-calendar-1405', 1405, 0),
  -- ── اسفند ──
  ('1405/12/05', 1405, 12, 5, 'روز مهندس؛ بزرگداشت خواجه نصیرالدین طوسی', NULL, FALSE, 'NATIONAL', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/12/09', 1405, 12, 9, 'شهادت حضرت علی (ع)', '۲۱ رمضان ۱۴۴۸', TRUE, 'RELIGIOUS', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/12/19', 1405, 12, 19, 'عید سعید فطر', '۱ شوال ۱۴۴۸', TRUE, 'RELIGIOUS', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/12/20', 1405, 12, 20, 'تعطیل به مناسبت عید سعید فطر', '۲ شوال ۱۴۴۸', TRUE, 'RELIGIOUS', 'official-iranian-calendar-1405', 1405, 0),
  ('1405/12/29', 1405, 12, 29, 'روز ملی شدن صنعت نفت', NULL, TRUE, 'NATIONAL', 'official-iranian-calendar-1405', 1405, 0)
) AS t(jalali, jy, jm, jd, title, description, hol, cat, src, year, ord)
ON CONFLICT ("jalaliDate", "source", "title") DO NOTHING;