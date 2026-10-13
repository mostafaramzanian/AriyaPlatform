import fa from '@/messages/fa.json';
import en from '@/messages/en.json';

const MESSAGES: Record<string, any> = {
  fa,
  en,
};

export function t(key: string, locale = 'fa') {
  if (!key) return '';
  try {
    const parts = key.split('.');
    let cur: any = MESSAGES[locale] || MESSAGES['fa'];
    for (const p of parts) {
      if (cur == null) return key;
      cur = cur[p];
    }
    if (typeof cur === 'string') return cur;
    return key;
  } catch (e) {
    return key;
  }
}

export default t;