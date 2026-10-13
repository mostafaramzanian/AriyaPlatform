export type ApiResponse<T = any> = {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any[];
  };
  meta?: {
    timestamp: string;
    version: string;
  };
};

export type User = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export enum UserRole {
  VISITOR = 'VISITOR',
  LEAD = 'LEAD',
  CUSTOMER = 'CUSTOMER',
  PARTNER = 'PARTNER',
  ADMIN = 'ADMIN',
}

export type Lead = {
  id: string;
  email: string;
  name: string;
  company?: string;
  phone?: string;
  industry?: string;
  companySize?: string;
  modulesInterested?: string;
  leadSource: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type Meeting = {
  id: string;
  leadId: string;
  scheduledAt: string;
  duration: number;
  status: string;
  meetingLink?: string;
  createdAt: string;
  updatedAt: string;
};
