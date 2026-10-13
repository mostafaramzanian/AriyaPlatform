import {CoreObservabilityView} from '@/components/core/CoreObservabilityView';

/**
 * Phase 49M-2: the route for the observability screen.
 *
 * `robots: { index: false, follow: false }` MATCHES EVERY OTHER `/admin` PAGE, and matters more
 * here than elsewhere: the content is application logs, audit events and security events. The
 * route is authenticated regardless — `CoreObservabilityView` gates on `admin.observability.read`
 * and `ObservabilityController` enforces the same permission server-side — so this is defence in
 * depth against a crawler that reaches an authenticated session, not the access control itself.
 */
export const metadata = {
    title: 'لاگ‌ها و رخدادها',
    robots: {index: false, follow: false},
};

export default function AdminObservabilityPage() {
    return <CoreObservabilityView/>;
}
