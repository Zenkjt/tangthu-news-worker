const REPO = "Zenkjt/tangthu-opds";
const SOURCES_PATH = "config/config_news_sources.json";
const SUBS_PATH = "config/config_news_subscriptions.json";
const GH_API = "https://api.github.com";

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: cors(),
  });
}

async function gh(env, path, options = {}) {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not configured");

  const headers = {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...(options.headers || {}),
  };

  const res = await fetch(`${GH_API}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 500)}`);
  }
  return res;
}

function normalizeUrl(raw) {
  const u = new URL(raw.trim());
  if (!/^https?:$/.test(u.protocol)) throw new Error("Chỉ hỗ trợ URL HTTP/HTTPS");
  u.hash = "";
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}

function sourceNameFromHtml(html, url) {
  const get = (re) => {
    const m = html.match(re);
    return m ? m[1].replace(/\s+/g, " ").trim() : "";
  };

  const site = get(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["'][^>]*>/i)
    || get(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["'][^>]*>/i);

  const title = get(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i)
    || get(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["'][^>]*>/i);

  const pageTitle = get(/<title[^>]*>([\s\S]*?)<\/title>/i);

  const base = site || (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "").split(".")[0];
    } catch {
      return "";
    }
  })();

  if (title && base && title.toLowerCase() !== base.toLowerCase()) {
    // Prefer the site name plus the page/topic title for section/category URLs.
    return `${base === "vnexpress" ? "VnExpress" : base} — ${title}`;
  }

  return base || title || "Nguồn tin";
}

async function discoverSource(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "TangThuNewsWorker/1.0 (+https://tangthu.pages.dev)",
      "Accept": "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });

  if (!res.ok) throw new Error(`Nguồn trả HTTP ${res.status}`);
  const html = await res.text();
  return {
    name: sourceNameFromHtml(html, res.url || url),
    url: normalizeUrl(res.url || url),
  };
}

async function readJsonFile(env, path) {
  const res = await gh(env, `/repos/${REPO}/contents/${path}`);
  const meta = await res.json();
  const content = atob(meta.content.replace(/\n/g, ""));
  return {
    sha: meta.sha,
    data: JSON.parse(content),
  };
}

async function updateJsonFile(env, path, data, sha, message) {
  const content = btoa(unescape(encodeURIComponent(
    JSON.stringify(data, null, 2) + "\n"
  )));

  await gh(env, `/repos/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content,
      sha,
    }),
  });
}

async function addSource(env, body) {
  const url = normalizeUrl(body.url);
  const checked = await discoverSource(url);
  const file = await readJsonFile(env, SOURCES_PATH);
  const sources = Array.isArray(file.data.sources) ? file.data.sources : [];

  const existing = sources.find(s => normalizeUrl(s.url) === checked.url);
  if (existing) {
    return { added: false, exists: true, source: existing };
  }

  const bytes = new TextEncoder().encode(checked.url);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)]
    .map(x => x.toString(16).padStart(2, "0")).join("");
  const id = `s-${hash.slice(0, 12)}`;
  const order = sources.reduce((m, s) => Math.max(m, Number(s.order) || 0), 0) + 1;

  const source = {
    id,
    name: checked.name,
    url: checked.url,
    enabled: true,
    order,
  };

  sources.push(source);
  await updateJsonFile(
    env,
    SOURCES_PATH,
    { sources },
    file.sha,
    `news: add source ${source.name}`
  );

  return { added: true, exists: false, source };
}

async function addSubscription(env, body) {
  const branchId = String(body.branch_id || "").trim();
  const sourceId = String(body.source_id || "").trim();
  const articleCount = Number(body.article_count);
  const editionMode = body.edition_mode === "images" ? "images" : "text";

  if (!branchId || !sourceId || !Number.isInteger(articleCount) ||
      articleCount < 5 || articleCount > 25) {
    throw new Error("Thông tin đăng ký không hợp lệ");
  }

  const file = await readJsonFile(env, SUBS_PATH);
  const subs = Array.isArray(file.data.subscriptions) ? file.data.subscriptions : [];

  const existing = subs.find(
    s => s.branch_id === branchId && s.source_id === sourceId
  );

  const seed = `${branchId}:${sourceId}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(seed)
  );
  const hash = [...new Uint8Array(digest)]
    .map(x => x.toString(16).padStart(2, "0")).join("");

  const now = new Date().toISOString();

  if (existing) {
    existing.article_count = articleCount;
    existing.edition_mode = editionMode;
    existing.enabled = true;
    existing.updated_at = now;
  } else {
    subs.push({
      id: `sub-${hash.slice(0, 12)}`,
      branch_id: branchId,
      source_id: sourceId,
      article_count: articleCount,
      edition_mode: editionMode,
      enabled: true,
      created_at: now,
      updated_at: now,
    });
  }

  await updateJsonFile(
    env,
    SUBS_PATH,
    { subscriptions: subs },
    file.sha,
    `news: ${existing ? "update" : "add"} subscription ${branchId}/${sourceId}`
  );

  return {
    added: !existing,
    updated: !!existing,
    subscription: existing || subs[subs.length - 1],
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/") {
        return json({ ok: true, service: "Tàng Thư News Worker" });
      }

      if (url.pathname === "/source/check" && request.method === "POST") {
        const body = await request.json();
        const checked = await discoverSource(normalizeUrl(body.url));
        return json({ ok: true, ...checked });
      }

      if (url.pathname === "/source/add" && request.method === "POST") {
        const body = await request.json();
        return json({ ok: true, ...(await addSource(env, body)) });
      }

      if (url.pathname === "/subscription/add" && request.method === "POST") {
        const body = await request.json();
        return json({ ok: true, ...(await addSubscription(env, body)) });
      }

      return json({ ok: false, error: "Not found" }, 404);
    } catch (error) {
      return json({ ok: false, error: error.message || String(error) }, 400);
    }
  },
};
