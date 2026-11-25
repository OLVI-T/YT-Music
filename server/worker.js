import { DurableObject } from "cloudflare:workers";

const ORIGIN = "https://olvi-t.github.io";
const headers = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ready: Boolean(env.YOUTUBE_API_KEY && env.SEARCH_BUDGET) });
    }
    if (url.pathname !== "/search") return json({ error: "Not found" }, 404);
    // CORS is a browser restriction, not authentication. The durable budget
    // below also caps requests from clients that forge the Origin header.
    if (request.headers.get("Origin") !== ORIGIN) return json({ error: "Origin not allowed" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const query = (url.searchParams.get("q") || "").trim().replace(/\s+/g, " ");
    if (query.length < 2 || query.length > 150) {
      return json({ error: "Введи от 2 до 150 символов." }, 400);
    }
    if (!env.YOUTUBE_API_KEY || !env.SEARCH_BUDGET) {
      return json({ error: "Поиск пока не настроен." }, 503);
    }
    try {
      // The single durable object serializes all searches and persists the
      // daily cap; restarting the Worker cannot reset the YouTube budget.
      const stub = env.SEARCH_BUDGET.getByName("youtube-search");
      const response = await stub.search(query, request.headers.get("CF-Connecting-IP") || "unknown");
      return json(response.body, response.status);
    } catch {
      return json({ error: "Поиск временно недоступен. Попробуй позже." }, 503);
    }
  },
};

export class SearchBudget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.lastByIp = new Map();
    this.pending = Promise.resolve();
  }

  search(query, ip) {
    // Explicit serialization also covers awaits to the upstream API.
    const result = this.pending.then(() => this.runSearch(query, ip));
    this.pending = result.catch(() => {});
    return result;
  }

  async runSearch(query, ip) {
    const now = Date.now();
    for (const [address, last] of this.lastByIp) {
      if (now - last > 60000) this.lastByIp.delete(address);
    }
    if (now - (this.lastByIp.get(ip) || 0) < 3000) {
      return { status: 429, body: { error: "Подожди несколько секунд перед следующим поиском." } };
    }
    this.lastByIp.set(ip, now);

    // Store only a bounded cache of public search results, never the API key.
    const cached = await this.ctx.storage.get("cache");
    const key = query.toLocaleLowerCase("ru");
    const entries = (cached || []).filter(entry => entry.expires > now);
    const match = entries.find(entry => entry.query === key);
    if (match) return { status: 200, body: { items: match.items } };

    // YouTube resets its quota at midnight Pacific Time.
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(now));
    const saved = await this.ctx.storage.get("budget");
    const budget = saved?.day === day ? saved : { day, count: 0 };
    // Leave headroom below the current default of 100 search calls/day.
    if (budget.count >= 90) {
      return { status: 429, body: { error: "Дневной лимит поиска исчерпан. Попробуй завтра." } };
    }
    budget.count += 1;
    await this.ctx.storage.put("budget", budget);

    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    for (const [name, value] of Object.entries({
      part: "snippet", q: query, type: "video", videoCategoryId: "10",
      videoEmbeddable: "true", videoSyndicated: "true", maxResults: "12",
      fields: "items(id/videoId,snippet(title,channelTitle,thumbnails/medium/url))",
    })) url.searchParams.set(name, value);
    let response;
    try {
      response = await fetch(url, {
        headers: { "X-Goog-Api-Key": this.env.YOUTUBE_API_KEY },
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      return { status: 502, body: { error: "YouTube не ответил. Попробуй позже." } };
    }
    // Never forward upstream errors or credential details to the browser.
    if (!response.ok) {
      return { status: response.status === 403 || response.status === 429 ? 429 : 502,
        body: { error: "YouTube не разрешил поиск. Проверь квоту и настройки API-ключа." } };
    }
    const data = await response.json();
    const items = (data.items || []).filter(item => /^[\w-]{11}$/.test(item.id?.videoId || "")).map(item => ({
      videoId: item.id.videoId,
      title: item.snippet?.title || "Без названия",
      channel: item.snippet?.channelTitle || "",
      thumbnail: item.snippet?.thumbnails?.medium?.url || "",
    }));
    entries.push({ query: key, items, expires: now + 15 * 60 * 1000 });
    await this.ctx.storage.put("cache", entries.slice(-50));
    return { status: 200, body: { items } };
  }
}
