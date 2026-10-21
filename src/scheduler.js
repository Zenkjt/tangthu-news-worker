const CRAWLER_REPO = "Zenkjt/tangthu-news-crawler";
const DAILY_EVENT = "news-daily";
const GH_API = "https://api.github.com";

async function dispatchDaily(env) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN chưa được cấu hình");

  const res = await fetch(`${GH_API}/repos/${CRAWLER_REPO}/dispatches`, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "TangThu-News-Worker/1.0 (+https://tangthu.pages.dev)",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: DAILY_EVENT,
      client_payload: { mode: "daily" },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub daily dispatch ${res.status}: ${body.slice(0, 500)}`);
  }
}

import worker from "./index.js";

export default {
  async scheduled(controller, env, ctx) {
    await dispatchDaily(env);
  },

  async fetch(request, env, ctx) {
    return worker.fetch(request, env, ctx);
  },
};
