export const APP_CONFIG = {
  name: 'Aria ERP',
  version: '1.0.0',
  description: 'Enterprise Resource Planning System',
};

export const API_CONFIG = {
  version: 'v1',
  baseUrl: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001',
};

export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
};

export const FEATURES = [
  'Accounting & Finance',
  'Inventory Management',
  'Sales & CRM',
  'Supply Chain',
  'Human Resources',
  'Manufacturing',
  'Project Management',
  'BI & Analytics',
];

export const INDUSTRIES = [
  'Manufacturing',
  'Retail',
  'Services',
  'Healthcare',
  'Education',
  'Finance',
  'Technology',
  'Hospitality',
];

export const USER_ROLES = ['VISITOR', 'LEAD', 'CUSTOMER', 'PARTNER', 'ADMIN'] as const;
