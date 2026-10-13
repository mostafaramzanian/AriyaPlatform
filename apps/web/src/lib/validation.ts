// lib/validation.ts - Form validation schemas using Zod
import { z } from 'zod';

export const contactFormSchema = z.object({
  name: z
    .string()
    .min(2, { message: 'نام باید حداقل 2 کاراکتر باشد' })
    .max(100, { message: 'نام نباید بیشتر از 100 کاراکتر باشد' }),
  email: z
    .string()
    .email({ message: 'لطفاً یک آدرس ایمیل معتبر وارد کنید' })
    .max(255, { message: 'ایمیل نباید بیشتر از 255 کاراکتر باشد' }),
  company: z
    .string()
    .max(100, { message: 'نام شرکت نباید بیشتر از 100 کاراکتر باشد' })
    .optional()
    .or(z.literal('')),
  message: z
    .string()
    .min(10, { message: 'پیام باید حداقل 10 کاراکتر باشد' })
    .max(5000, { message: 'پیام نباید بیشتر از 5000 کاراکتر باشد' }),
  phone: z
    .string()
    .regex(/^[\+]?[(]?[0-9]{3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}$/, {
      message: 'لطفاً یک شماره تلفن معتبر وارد کنید',
    })
    .optional()
    .or(z.literal('')),
});

export const bookDemoFormSchema = z.object({
  firstName: z
    .string()
    .min(2, { message: 'نام الزامی است' })
    .max(50),
  lastName: z
    .string()
    .min(2, { message: 'نام خانوادگی الزامی است' })
    .max(50),
  email: z.string().email({ message: 'آدرس ایمیل معتبر نیست' }),
  company: z.string().min(1, { message: 'نام شرکت الزامی است' }).max(100),
  phone: z.string().min(1, { message: 'شماره تلفن الزامی است' }),
  jobTitle: z.string().max(100).optional().or(z.literal('')),
  companySize: z.enum(['1-10', '11-50', '51-200', '201-1000', '1000+']),
  useCase: z.string().max(500).optional().or(z.literal('')),
  timeline: z.enum(['immediate', '1-3-months', '3-6-months', 'exploring']),
});

export const newsletterFormSchema = z.object({
  email: z
    .string()
    .email({ message: 'لطفاً یک آدرس ایمیل معتبر وارد کنید' })
    .max(255),
});

export type ContactFormData = z.infer<typeof contactFormSchema>;
export type BookDemoFormData = z.infer<typeof bookDemoFormSchema>;
export type NewsletterFormData = z.infer<typeof newsletterFormSchema>;
