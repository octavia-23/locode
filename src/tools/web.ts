import { ToolDefinition } from '../types.js';

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export const fetchWebTool: ToolDefinition = {
  name: 'fetch_web',
  description: 'Fetch content from a webpage URL (e.g. documentation, API references, articles). Returns readable extracted text.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The HTTP or HTTPS URL to fetch'
      }
    },
    required: ['url']
  },
  needsApproval: false,
  async execute(args) {
    try {
      const url = args.url;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return { result: 'Invalid URL. Must begin with http:// or https://', isError: true };
      }

      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(15000)
      });

      if (!res.ok) {
        return { result: `HTTP request failed with status ${res.status}: ${res.statusText}`, isError: true };
      }

      const raw = await res.text();
      const clean = stripHtml(raw);

      // Truncate to ~4,000 characters to keep local model context budget safe
      const maxLen = 4000;
      const preview = clean.length > maxLen
        ? clean.slice(0, maxLen) + `\n... [Content truncated at ${maxLen} characters]`
        : clean;

      return { result: `Content fetched from ${url}:\n\n${preview}` };
    } catch (err: any) {
      return { result: `Failed to fetch URL: ${err.message}`, isError: true };
    }
  }
};

export const searchWebTool: ToolDefinition = {
  name: 'search_web',
  description: 'Search the live web using DuckDuckGo (no API key required). Returns top search result titles, snippets, and URLs.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query or technical question'
      }
    },
    required: ['query']
  },
  needsApproval: false,
  async execute(args) {
    try {
      const query = encodeURIComponent(args.query);
      const url = `https://html.duckduckgo.com/html/?q=${query}`;

      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(15000)
      });

      if (!res.ok) {
        return { result: `Search failed with status ${res.status}`, isError: true };
      }

      const html = await res.text();

      // Extract results from DuckDuckGo HTML
      const results: Array<{ title: string; snippet: string; link: string }> = [];

      // Regex matches results in DuckDuckGo HTML
      const resultBlockRegex = /<div[^>]+class="[^"]*result__body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
      let blockMatch: RegExpExecArray | null;

      while ((blockMatch = resultBlockRegex.exec(html)) !== null && results.length < 5) {
        const block = blockMatch[1];

        // Extract title & link
        const linkMatch = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/i.exec(block);
        // Extract snippet
        const snippetMatch = /<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/i.exec(block);

        if (linkMatch) {
          let rawLink = linkMatch[1];
          // DuckDuckGo redirects through /l/?uddg=...
          const uddgMatch = /uddg=([^&]+)/.exec(rawLink);
          if (uddgMatch) {
            rawLink = decodeURIComponent(uddgMatch[1]);
          }

          results.push({
            title: stripHtml(linkMatch[2]),
            link: rawLink,
            snippet: snippetMatch ? stripHtml(snippetMatch[1]) : ''
          });
        }
      }

      if (results.length === 0) {
        return { result: `No search results found for "${args.query}".` };
      }

      const formatted = results
        .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.link}\n   Snippet: ${r.snippet}`)
        .join('\n\n');

      return { result: `Search results for "${args.query}":\n\n${formatted}` };
    } catch (err: any) {
      return { result: `Web search error: ${err.message}`, isError: true };
    }
  }
};
