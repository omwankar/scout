import { config } from "./config.js";

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export async function webSearch(query: string): Promise<SearchResult[]> {
  if (!config.tavilyApiKey) {
    throw new Error("TAVILY_API_KEY is not configured");
  }

  const doFetch = () =>
    fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(12000),
      body: JSON.stringify({
        api_key: config.tavilyApiKey,
        query,
        search_depth: "basic",
        include_answer: false,
        max_results: 6,
      }),
    });

  let res: Response;
  try {
    res = await doFetch();
  } catch {
    // One quick retry on network hiccup / timeout
    res = await doFetch();
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tavily search failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };

  return (data.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      title: r.title || r.url || "Untitled",
      url: r.url!,
      snippet: (r.content || "").slice(0, 280),
    }));
}

export function formatSearchResults(results: SearchResult[]): string {
  if (!results.length) return "No search results.";
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join("\n\n");
}
