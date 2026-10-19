const REPO = "Zenkjt/tangthu-opds";
const SOURCES_PATH = "config/config_news_sources.json";
const SUBS_PATH = "config/config_news_subscriptions.json";
const BRANCHES_PATH = "config/branches.json";
const GH_API = "https://api.github.com";
const DEFAULT_ALLOWED_ORIGIN = "https://tangthu.pages.dev";

const limits = new Map();

function headers(origin) {
  return {
    "Access-Control-Allow-Origin": origin || DEFAULT_ALLOWED_ORIGIN,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
}

function json(data, status = 200, origin = DEFAULT_ALLOWED_ORIGIN) {
  return new Response(JSON.stringify(data), {
    status,
    headers: headers(origin),
  });
}

function requestOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;
  if (origin && origin !== allowed) return null;
  return origin || allowed;
}

function rateLimit(request, kind) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = `${kind}:${ip}`;
  const now = Date.now();
  const windowMs = 60_000;
  const max = kind === "check" ? 30 : 10;
  const old = limits.get(key);
  if (!old || now - old.start >= windowMs) {
    limits.set(key, { start: now, count: 1 });
    return true;
  }
  if (old.count >= max) return false;
  old.count++;
  return true;
}

async function gh(env, path, options = {}) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN chưa được cấu hình");

  const res = await fetch(`${GH_API}${path}`, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "TangThu-News-Worker/1.0 (+https://tangthu.pages.dev)",
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    const error = new Error(`GitHub API ${res.status}: ${body.slice(0, 500)}`);
    error.status = res.status;
    throw error;
  }
  return res;
}

function normalizeUrl(raw) {
  const u = new URL(String(raw || "").trim());
  if (!/^https?:$/.test(u.protocol)) {
    throw new Error("Chỉ hỗ trợ URL HTTP/HTTPS");
  }
  u.hash = "";
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}

function htmlValue(html, regex) {
  const m = html.match(regex);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function sourceNameFromHtml(html, url) {
  const site =
    htmlValue(html, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["'][^>]*>/i) ||
    htmlValue(html, /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["'][^>]*>/i);

  const ogTitle =
    htmlValue(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i) ||
    htmlValue(html, /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["'][^>]*>/i);

  const h1 = decodeHtml(
    htmlValue(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i)
      .replace(/<[^>]+>/g, " ")
  );

  const title = decodeHtml(
    htmlValue(html, /<title[^>]*>([\s\S]*?)<\/title>/i)
      .replace(/<[^>]+>/g, " ")
  );

  const host = new URL(url).hostname.replace(/^www\./i, "");
  const first = host.split(".")[0];
  const brand = site || (
    first === "vnexpress" ? "VnExpress" :
    first.replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase())
  );

  // Category/topic pages: use the page's section heading when it is meaningful.
  if (/\/chu-de\//i.test(new URL(url).pathname) && h1 && h1.length <= 80) {
    return `${brand} — ${h1}`;
  }

  if (ogTitle && ogTitle.length <= 100 && !/^https?:/i.test(ogTitle)) {
    return `${brand} — ${ogTitle}`;
  }

  if (h1 && h1.length <= 80) {
    return `${brand} — ${h1}`;
  }

  return brand || title || "Nguồn tin";
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
  const finalUrl = normalizeUrl(res.url || url);

  return {
    name: sourceNameFromHtml(html, finalUrl),
    url: finalUrl,
  };
}

async function readJsonFile(env, path) {
  const res = await gh(env, `/repos/${REPO}/contents/${path}?ref=main`);
  const meta = await res.json();
  const content = atob(String(meta.content).replace(/\n/g, ""));
  return { sha: meta.sha, data: JSON.parse(content) };
}

function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function writeJsonFile(env, path, data, sha, message) {
  return gh(env, `/repos/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: base64Utf8(JSON.stringify(data, null, 2) + "\n"),
      sha,
      branch: "main",
    }),
  });
}

async function mutateJsonFile(env, path, message, mutator) {
  // GitHub Contents API is optimistic-concurrency based. Re-read after a conflict.
  for (let attempt = 0; attempt < 4; attempt++) {
    const file = await readJsonFile(env, path);
    const result = await mutator(file.data);

    if (result && result.skipWrite) return result.value;

    try {
      await writeJsonFile(env, path, result.data, file.sha, message);
      return result.value;
    } catch (error) {
      if (error.status !== 409 && error.status !== 422) throw error;
      if (attempt === 3) {
        throw new Error("Registry đang được cập nhật đồng thời, vui lòng thử lại.");
      }
    }
  }
  throw new Error("Không thể cập nhật registry");
}

async function addSource(env, body) {
  const url = normalizeUrl(body.url);
  const checked = await discoverSource(url);

  return mutateJsonFile(
    env,
    SOURCES_PATH,
    `news: add source ${checked.name}`,
    async data => {
      const sources = Array.isArray(data.sources) ? data.sources : [];
      const existing = sources.find(s => {
        try { return normalizeUrl(s.url) === checked.url; } catch { return false; }
      });
      if (existing) return { skipWrite: true, value: { added: false, exists: true, source: existing } };

      const digest = await crypto.subtle.digest(
        "SHA-256", new TextEncoder().encode(checked.url)
      );
      const hash = [...new Uint8Array(digest)]
        .map(x => x.toString(16).padStart(2, "0")).join("");

      const source = {
        id: `s-${hash.slice(0, 12)}`,
        name: checked.name,
        url: checked.url,
        enabled: true,
        order: sources.reduce((m, s) => Math.max(m, Number(s.order) || 0), 0) + 1,
      };

      sources.push(source);
      return { data: { sources }, value: { added: true, exists: false, source } };
    }
  );
}

async function addSubscription(env, body) {
  const branchId = String(body.branch_id || "").trim();
  const sourceId = String(body.source_id || "").trim();
  const articleCount = Number(body.article_count);
  const editionMode = body.edition_mode === "images" ? "images" : "text";
  const totalArticles = Number(body.total_articles);

  if (!branchId || !sourceId ||
      !Number.isInteger(articleCount) || articleCount < 5 || articleCount > 25) {
    throw new Error("Thông tin đăng ký không hợp lệ");
  }

  if (editionMode === "images" && Number.isFinite(totalArticles) && totalArticles > 100) {
    throw new Error("Chế độ có hình chỉ cho tối đa 100 bài trong một bản tin");
  }
  if (editionMode === "text" && Number.isFinite(totalArticles) && totalArticles > 200) {
    throw new Error("Chế độ chỉ chữ chỉ cho tối đa 200 bài trong một bản tin");
  }

  const [branches, sources] = await Promise.all([
    readJsonFile(env, BRANCHES_PATH),
    readJsonFile(env, SOURCES_PATH),
  ]);

  const branchList = Array.isArray(branches.data.branches) ? branches.data.branches : [];
  const sourceList = Array.isArray(sources.data.sources) ? sources.data.sources : [];

  const branch = branchList.find(b => b.id === branchId);
  if (!branch) throw new Error("Tủ sách không tồn tại, vui lòng tạo tủ");
  if (branch.enabled === false || (branch.status && branch.status !== "active")) {
    throw new Error("Tủ sách đang không hoạt động");
  }

  const source = sourceList.find(s => s.id === sourceId);
  if (!source) throw new Error("Nguồn tin không tồn tại");
  if (source.enabled === false) throw new Error("Nguồn tin đang bị tắt");

  const now = new Date().toISOString();

  return mutateJsonFile(
    env,
    SUBS_PATH,
    `news: update subscription ${branchId}/${sourceId}`,
    async data => {
      const subscriptions = Array.isArray(data.subscriptions) ? data.subscriptions : [];
      const index = subscriptions.findIndex(
        s => s.branch_id === branchId && s.source_id === sourceId
      );

      if (index >= 0) {
        const item = subscriptions[index];
        item.article_count = articleCount;
        item.edition_mode = editionMode;
        item.enabled = true;
        item.updated_at = now;
        return {
          data: { subscriptions },
          value: { added: false, updated: true, subscription: item },
        };
      }

      const digest = await crypto.subtle.digest(
        "SHA-256", new TextEncoder().encode(`${branchId}:${sourceId}`)
      );
      const hash = [...new Uint8Array(digest)]
        .map(x => x.toString(16).padStart(2, "0")).join("");

      const item = {
        id: `sub-${hash.slice(0, 12)}`,
        branch_id: branchId,
        source_id: sourceId,
        article_count: articleCount,
        edition_mode: editionMode,
        enabled: true,
        created_at: now,
        updated_at: now,
      };

      subscriptions.push(item);
      return {
        data: { subscriptions },
        value: { added: true, updated: false, subscription: item },
      };
    }
  );
}

export default {
  async fetch(request, env) {
    const origin = requestOrigin(request, env);
    if (!origin) return new Response("Forbidden", { status: 403 });

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: headers(origin) });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/" && request.method === "GET") {
        return json({ ok: true, service: "Tàng Thư News Worker" }, 200, origin);
      }

      if (url.pathname === "/source/check" && request.method === "POST") {
        if (!rateLimit(request, "check")) {
          return json({ ok: false, error: "Quá nhiều yêu cầu, vui lòng thử lại sau." }, 429, origin);
        }
        const body = await request.json();
        const checked = await discoverSource(normalizeUrl(body.url));
        return json({ ok: true, source: checked }, 200, origin);
      }

      if (url.pathname === "/source/add" && request.method === "POST") {
        if (!rateLimit(request, "write")) {
          return json({ ok: false, error: "Quá nhiều yêu cầu, vui lòng thử lại sau." }, 429, origin);
        }
        const body = await request.json();
        return json({ ok: true, source: await addSource(env, body) }, 200, origin);
      }

      if (url.pathname === "/subscription/add" && request.method === "POST") {
        if (!rateLimit(request, "write")) {
          return json({ ok: false, error: "Quá nhiều yêu cầu, vui lòng thử lại sau." }, 429, origin);
        }
        const body = await request.json();
        return json({ ok: true, result: await addSubscription(env, body) }, 200, origin);
      }

      return json({ ok: false, error: "Not found" }, 404, origin);
    } catch (error) {
      const status = error.status === 404 ? 404 : 400;
      return json({ ok: false, error: error.message || String(error) }, status, origin);
    }
  },
};
