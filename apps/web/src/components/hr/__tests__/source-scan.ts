import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The shipped source of a file, with its COMMENTS STRIPPED.
 *
 * Shared by every spec that has to assert an ABSENCE where it would actually appear — a word, a
 * route, a grant that must not be named in a screen. Stripping comments is the whole point: the files
 * legitimately DISCUSS the concepts they must not implement. `HrMissionView.tsx`'s header explains
 * why there is no project picker and why `HrMissionRequestStatus` has no completion member, so a raw
 * scan would fail on those explanations rather than on code. What must not exist is the token in the
 * CODE, so the scan reads code with its comments removed.
 *
 * IT LIVES IN ONE FILE because two specs (the employee surface and the approval surface) both scan
 * shipped source, and a helper copied into a second spec drifts from the first.
 *
 * A BLANK RESULT IS AN ERROR, NOT AN ABSENCE. Most of the claims these specs make are NEGATIVE
 * (`not.toContain`), and a negative claim passes trivially against an empty string — so a path typo
 * or a casing slip on Windows would turn "this surface does not do X" into a green test that proves
 * nothing. The helper therefore refuses to return empty source, which is what caught a
 * `Hrmissionconfigurationview.tsx` read that silently scanned nothing.
 */
export function executableSource(path: string): string {
  const source = readFileSync(join(process.cwd(), path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  if (source.trim() === '') {
    const blanked = readFileSync(join(process.cwd(), path), 'utf8').trim() === '';
    throw new Error(
      blanked
        ? `source-scan: '${path}' is empty; the absence assertions would pass vacuously.`
        : `source-scan: '${path}' produced no executable code after comment stripping; the ` +
            'absence assertions would pass vacuously.'
    );
  }

  return source;
}
