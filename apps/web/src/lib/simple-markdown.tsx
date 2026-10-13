
/**
 * Phase 34: minimal, dependency-free renderer for the markdown content
 * already produced by the backend (BlogService sanitizes markdown source,
 * it does not convert to HTML — see apps/api sanitizeMarkdown). Deliberately
 * does not add a markdown/rich-text library (no such dependency exists in
 * apps/web today; see anti-overbuild rule). Supports only the handful of
 * constructs actually used by the CMS today: #/##/### headings and
 * paragraphs. React escapes all text content, so this is XSS-safe without
 * needing dangerouslySetInnerHTML.
 */
export function SimpleMarkdown({ content }: { content: string }) {
  const blocks = content.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);

  return (
    <div className="prose-content space-y-5">
      {blocks.map((block, index) => {
        const headingMatch = block.match(/^(#{1,3})\s+(.*)$/);
        if (headingMatch) {
          const level = headingMatch[1].length;
          const text = headingMatch[2];
          if (level === 1) {
            return (
              <h2 key={index} className="text-2xl font-semibold text-foreground">
                {text}
              </h2>
            );
          }
          if (level === 2) {
            return (
              <h3 key={index} className="text-xl font-semibold text-foreground">
                {text}
              </h3>
            );
          }
          return (
            <h4 key={index} className="text-lg font-semibold text-foreground">
              {text}
            </h4>
          );
        }
        return (
          <p key={index} className="leading-8 text-muted-foreground whitespace-pre-line">
            {block}
          </p>
        );
      })}
    </div>
  );
}
