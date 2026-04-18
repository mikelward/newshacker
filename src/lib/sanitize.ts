import sanitizeHtml from 'sanitize-html';

export function sanitizeCommentHtml(input: string): string {
  return sanitizeHtml(input, {
    allowedTags: ['a', 'p', 'i', 'em', 'b', 'strong', 'pre', 'code', 'br'],
    allowedAttributes: {
      a: ['href', 'rel', 'target'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: {
          ...attribs,
          rel: 'noopener noreferrer nofollow',
          target: '_blank',
        },
      }),
    },
  });
}
