export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';
export const API_VERSION = 'v1';
export const API_ENDPOINT = `${API_BASE_URL}/${API_VERSION}`;

export const APP_NAME = 'پلتفرم آریا';
export const APP_DESCRIPTION = 'سیستم برنامه‌ریزی منابع سازمانی';
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://aria-platform.com';

export const FEATURES = [
  'حسابداری و امور مالی',
  'مدیریت موجودی',
  'فروش و CRM',
  'زنجیره تامین',
  'منابع انسانی',
  'تولید',
  'مدیریت پروژه',
  'هوش تجاری و تحلیل',
];

export const ROLES = ['VISITOR', 'LEAD', 'CUSTOMER', 'PARTNER', 'ADMIN'];

export const DEFAULT_LOCALE = 'fa';
export const SUPPORTED_LOCALES = ['fa', 'en'];

export const PAGINATION_DEFAULTS = {
  page: 1,
  limit: 20,
  maxLimit: 100,
};

export const RATE_LIMIT = {
  login: '10/15m',
  contactForm: '5/1h',
  default: '100/1m',
};
