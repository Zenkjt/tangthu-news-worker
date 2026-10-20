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
  return new Response(JSON.stringify(data), { status, headers: headers(origin) });
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
  if (!/^https?:$/.test(u.protocol)) throw new Error("Chỉ hỗ trợ URL HTTP/HTTPS");
  u.hash = "";
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}

function htmlValue(html, regex) {
  const m = html.match(regex);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function repairMojibake(value) {
  const text = String(value || "");
  if (!/[ÃÂ]/.test(text)) return text;
  try {
    const bytes = Uint8Array.from(text, ch => ch.charCodeAt(0) & 0xff);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return text;
  }
}

function cleanName(value, max = 60) {
  let text = repairMojibake(decodeHtml(String(value || "")))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > max) text = text.slice(0, max - 1).trimEnd() + "…";
  return text;
}

async function sourceId(url) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  const hash = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
  return `s-${hash.slice(0, 12)}`;
}

function sourceNameFromHtml(html, url) {
  const site = cleanName(
    htmlValue(html, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["'][^>]*>/i) ||
    htmlValue(html, /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["'][^>]*>/i)
  );
  const h1 = cleanName(htmlValue(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i), 40);
  const title = cleanName(htmlValue(html, /<title[^>]*>([\s\S]*?)<\/title>/i), 60);
  const host = new URL(url).hostname.replace(/^www\./i, "");
  const first = host.split(".")[0];
  const brand = first === "vnexpress"
    ? "VnExpress"
    : first.replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  if (/\/chu-de\//i.test(new URL(url).pathname) && h1 && h1.length <= 40) {
    return cleanName(`${brand} — ${h1}`, 60);
  }
  if (site && site.length <= 40 && !/^https?:\/\//i.test(site)) return cleanName(site, 60);
  return cleanName(brand || site || title || "Nguồn tin", 60);
}

async function discoverSource(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "TangThu-News-Worker/1.0 (+https://tangthu.pages.dev)",
      "Accept": "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Nguồn trả HTTP ${res.status}`);
  const html = await res.text();
  const finalUrl = normalizeUrl(res.url || url);
  return { id: await sourceId(finalUrl), name: sourceNameFromHtml(html, finalUrl), url: finalUrl };
}

async function readJsonFile(env, path) {
  const res = await gh(env, `/repos/${REPO}/contents/${path}?ref=main`);
  const meta = await res.json();
  const content = atob(String(meta.content).replace(/\n/g, ""));
  const bytes = Uint8Array.from(content, ch => ch.charCodeAt(0));
  return {
    sha: meta.sha,
    data: JSON.parse(new TextDecoder("utf-8").decode(bytes)),
  };
}

async function gitHead(env) {
  const res = await gh(env, `/repos/${REPO}/git/ref/heads/main`);
  return (await res.json()).object.sha;
}

async function gitCommitTwoFiles(env, baseCommitSha, sourcesData, subsData, message) {
  const commitRes = await gh(env, `/repos/${REPO}/git/commits/${baseCommitSha}`);
  const commit = await commitRes.json();

  const treeRes = await gh(env, `/repos/${REPO}/git/trees`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      base_tree: commit.tree.sha,
      tree: [
        {
          path: SOURCES_PATH,
          mode: "100644",
          type: "blob",
          content: JSON.stringify(sourcesData, null, 2) + "\n",
        },
        {
          path: SUBS_PATH,
          mode: "100644",
          type: "blob",
          content: JSON.stringify(subsData, null, 2) + "\n",
        },
      ],
    }),
  });
  const tree = await treeRes.json();
  if (!tree.sha) throw new Error("Không tạo được Git tree");

  const newCommitRes = await gh(env, `/repos/${REPO}/git/commits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: [baseCommitSha],
    }),
  });
  const newCommit = await newCommitRes.json();
  if (!newCommit.sha) throw new Error("Không tạo được Git commit");

  await gh(env, `/repos/${REPO}/git/refs/heads/main`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sha: newCommit.sha, force: false }),
  });
  return newCommit.sha;
}

async function gitCommitFile(env, baseCommitSha, path, data, message) {
  const commitRes = await gh(env, `/repos/${REPO}/git/commits/${baseCommitSha}`);
  const commit = await commitRes.json();
  const treeRes = await gh(env, `/repos/${REPO}/git/trees`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      base_tree: commit.tree.sha,
      tree: [{ path, mode: "100644", type: "blob", content: JSON.stringify(data, null, 2) + "\n" }],
    }),
  });
  const tree = await treeRes.json();
  if (!tree.sha) throw new Error("Không tạo được Git tree");
  const newCommitRes = await gh(env, `/repos/${REPO}/git/commits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, tree: tree.sha, parents: [baseCommitSha] }),
  });
  const newCommit = await newCommitRes.json();
  if (!newCommit.sha) throw new Error("Không tạo được Git commit");
  await gh(env, `/repos/${REPO}/git/refs/heads/main`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sha: newCommit.sha, force: false }),
  });
  return newCommit.sha;
}

async function addSource(env, body) {
  const source = await discoverSource(normalizeUrl(body.url));
  const url = source.url;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const head = await gitHead(env);
      const file = await readJsonFile(env, SOURCES_PATH);
      const sources = Array.isArray(file.data.sources) ? file.data.sources.slice() : [];
      const existing = sources.find(s => {
        try { return normalizeUrl(s.url) === url; } catch { return false; }
      });
      if (existing) return { source: existing, added: false, exists: true };
      const nextOrder = sources.reduce((m, s) => Math.max(m, Number(s.order) || 0), 0) + 1;
      const record = {
        id: source.id,
        name: url,
        url,
        enabled: true,
        order: nextOrder,
      };
      sources.push(record);
      const commit = await gitCommitFile(env, head, SOURCES_PATH, { sources }, `news: add source ${url}`);
      return { source: record, added: true, exists: false, commit };
    } catch (error) {
      if ((error.status === 409 || error.status === 422) && attempt < 3) continue;
      throw error;
    }
  }
  throw new Error("Registry đang được cập nhật đồng thời, vui lòng thử lại.");
}

async function getNewsConfig(env) {
  const [sourcesFile, subsFile] = await Promise.all([
    readJsonFile(env, SOURCES_PATH),
    readJsonFile(env, SUBS_PATH),
  ]);
  return {
    sources: Array.isArray(sourcesFile.data.sources) ? sourcesFile.data.sources : [],
    subscriptions: Array.isArray(subsFile.data.subscriptions) ? subsFile.data.subscriptions : [],
  };
}

async function updateSubscription(env, body) {
  const branchId = String(body.branch_id || "").trim();
  const sourceIdValue = String(body.source_id || "").trim();
  const action = body.action === "cancel" ? "cancel" : "save";
  if (!branchId || !sourceIdValue) throw new Error("Thiếu tủ sách hoặc nguồn tin");

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const [head, branchesFile, sourcesFile, subsFile] = await Promise.all([
        gitHead(env),
        readJsonFile(env, BRANCHES_PATH),
        readJsonFile(env, SOURCES_PATH),
        readJsonFile(env, SUBS_PATH),
      ]);
      const branches = Array.isArray(branchesFile.data.branches) ? branchesFile.data.branches : [];
      const sources = Array.isArray(sourcesFile.data.sources) ? sourcesFile.data.sources : [];
      const subs = Array.isArray(subsFile.data.subscriptions) ? subsFile.data.subscriptions.slice() : [];
      const branch = branches.find(b => b.id === branchId);
      const source = sources.find(s => s.id === sourceIdValue);
      if (!branch) throw new Error("Tủ sách không tồn tại, vui lòng tạo tủ");
      if (!source) throw new Error("Nguồn tin không tồn tại");
      if (branch.enabled === false || (branch.status && branch.status !== "active")) throw new Error("Tủ sách đang không hoạt động");
      const index = subs.findIndex(s => s.branch_id === branchId && s.source_id === sourceIdValue);
      const now = new Date().toISOString();
      if (action === "cancel") {
        if (index >= 0) {
          subs[index] = { ...subs[index], enabled: false, updated_at: now };
        }
      } else {
        const count = Number(body.article_count);
        const mode = body.edition_mode === "images" ? "images" : "text";
        if (!Number.isInteger(count) || count < 5 || count > 25) throw new Error("Số bài mỗi nguồn phải từ 5 đến 25");
        if (index >= 0) {
          subs[index] = { ...subs[index], article_count: count, edition_mode: mode, enabled: true, updated_at: now };
        } else {
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${branchId}:${sourceIdValue}`));
          const hash = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
          subs.push({ id: `sub-${hash.slice(0, 12)}`, branch_id: branchId, source_id: sourceIdValue, article_count: count, edition_mode: mode, enabled: true, created_at: now, updated_at: now });
        }
      }
      const commit = await gitCommitFile(env, head, SUBS_PATH, { subscriptions: subs }, `news: ${action === "cancel" ? "cancel" : "update"} ${branchId}/${sourceIdValue}`);
      return { branch_name: branch.display_name || branch.id, source: source, action, commit };
    } catch (error) {
      if ((error.status === 409 || error.status === 422) && attempt < 3) continue;
      throw error;
    }
  }
  throw new Error("Registry đang được cập nhật đồng thời, vui lòng thử lại.");
}

async function buildRegistration(env, body) {
  const branchId = String(body.branch_id || "").trim();
  const mode = body.edition_mode === "images" ? "images" : "text";
  const total = Number(body.total_articles);
  const newSourcesInput = Array.isArray(body.new_sources) ? body.new_sources : [];
  const selected = Array.isArray(body.subscriptions) ? body.subscriptions : [];

  if (!branchId) throw new Error("Chưa chọn tủ sách");
  if (!Number.isInteger(total) || total < 0 || total > 200) throw new Error("Tổng số bài không hợp lệ");
  if (selected.length && total < 5) throw new Error("Tổng số bài không hợp lệ");
  if (mode === "images" && total > 100) throw new Error("Chế độ có hình chỉ cho tối đa 100 bài");
  if (selected.some(x => !x || !Number.isInteger(Number(x.article_count)) || Number(x.article_count) < 5 || Number(x.article_count) > 25)) {
    throw new Error("Số bài mỗi nguồn phải từ 5 đến 25");
  }

  const [branchesFile, sourcesFile, subsFile] = await Promise.all([
    readJsonFile(env, BRANCHES_PATH),
    readJsonFile(env, SOURCES_PATH),
    readJsonFile(env, SUBS_PATH),
  ]);

  const branches = Array.isArray(branchesFile.data.branches) ? branchesFile.data.branches : [];
  const sources = Array.isArray(sourcesFile.data.sources) ? sourcesFile.data.sources.slice() : [];
  const subs = Array.isArray(subsFile.data.subscriptions) ? subsFile.data.subscriptions.slice() : [];
  const branch = branches.find(b => b.id === branchId);

  if (!branch) throw new Error("Tủ sách không tồn tại, vui lòng tạo tủ");
  if (branch.enabled === false || (branch.status && branch.status !== "active")) {
    throw new Error("Tủ sách đang không hoạt động");
  }

  const sourceMap = new Map(sources.map(s => [s.id, s]));
  let nextOrder = sources.reduce((m, s) => Math.max(m, Number(s.order) || 0), 0) + 1;

  for (const raw of newSourcesInput) {
    const url = normalizeUrl(raw.url);
    const id = await sourceId(url);
    if (sourceMap.has(id)) continue;
    const existingUrl = sources.find(s => {
      try { return normalizeUrl(s.url) === url; } catch { return false; }
    });
    if (existingUrl) {
      sourceMap.set(existingUrl.id, existingUrl);
      continue;
    }

    const source = {
      id,
      name: cleanName(raw.name || new URL(url).hostname, 60) || "Nguồn tin",
      url,
      enabled: true,
      order: nextOrder++,
    };
    sources.push(source);
    sourceMap.set(source.id, source);
  }

  const now = new Date().toISOString();
  const resultSubs = [];
  const selectedIds = new Set(selected.map(item => String(item.source_id || "").trim()));

  for (let i = 0; i < subs.length; i++) {
    if (subs[i].branch_id === branchId && subs[i].enabled !== false && !selectedIds.has(subs[i].source_id)) {
      subs[i] = { ...subs[i], enabled: false, updated_at: now };
    }
  }

  for (const item of selected) {
    const sourceIdValue = String(item.source_id || "").trim();
    const source = sourceMap.get(sourceIdValue);
    if (!source) throw new Error(`Nguồn tin không tồn tại: ${sourceIdValue}`);
    if (source.enabled === false) throw new Error(`Nguồn tin đang bị tắt: ${source.name}`);

    const count = Number(item.article_count);
    const index = subs.findIndex(s => s.branch_id === branchId && s.source_id === source.id);
    if (index >= 0) {
      const sub = {
        ...subs[index],
        article_count: count,
        edition_mode: mode,
        enabled: true,
        updated_at: now,
      };
      subs[index] = sub;
      resultSubs.push(sub);
    } else {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${branchId}:${source.id}`)
      );
      const hash = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
      const sub = {
        id: `sub-${hash.slice(0, 12)}`,
        branch_id: branchId,
        source_id: source.id,
        article_count: count,
        edition_mode: mode,
        enabled: true,
        created_at: now,
        updated_at: now,
      };
      subs.push(sub);
      resultSubs.push(sub);
    }
  }

  return { branch, sources, subs, resultSubs };
}

async function registerNews(env, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const head = await gitHead(env);
      const state = await buildRegistration(env, body);
      const committedSha = await gitCommitTwoFiles(
        env,
        head,
        { sources: state.sources },
        { subscriptions: state.subs },
        `news: register ${state.branch.id}`
      );
      return {
        branch_name: state.branch.display_name || state.branch.id,
        sources: state.sources,
        subscriptions: state.resultSubs,
        commit: committedSha,
      };
    } catch (error) {
      if ((error.status === 409 || error.status === 422) && attempt < 3) continue;
      throw error;
    }
  }
  throw new Error("Registry đang được cập nhật đồng thời, vui lòng thử lại.");
}

export default {
  async fetch(request, env) {
    const origin = requestOrigin(request, env);
    if (!origin) return new Response("Forbidden", { status: 403 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });

    const url = new URL(request.url);
    try {
      if (url.pathname === "/" && request.method === "GET") {
        return json({ ok: true, service: "Tàng Thư News Worker", version: "v13" }, 200, origin);
      }

      if (url.pathname === "/source/check" && request.method === "POST") {
        if (!rateLimit(request, "check")) return json({ ok: false, error: "Quá nhiều yêu cầu, vui lòng thử lại sau." }, 429, origin);
        const body = await request.json();
        const source = await discoverSource(normalizeUrl(body.url));
        source.name = source.url;
        return json({ ok: true, source }, 200, origin);
      }

      if (url.pathname === "/source/add" && request.method === "POST") {
        if (!rateLimit(request, "write")) return json({ ok: false, error: "Quá nhiều yêu cầu, vui lòng thử lại sau." }, 429, origin);
        return json({ ok: true, ...(await addSource(env, await request.json())) }, 200, origin);
      }

      if (url.pathname === "/news/config" && request.method === "GET") {
        if (!rateLimit(request, "check")) return json({ ok: false, error: "Quá nhiều yêu cầu, vui lòng thử lại sau." }, 429, origin);
        return json({ ok: true, ...(await getNewsConfig(env)) }, 200, origin);
      }

      if (url.pathname === "/subscription/update" && request.method === "POST") {
        if (!rateLimit(request, "write")) return json({ ok: false, error: "Quá nhiều yêu cầu, vui lòng thử lại sau." }, 429, origin);
        return json({ ok: true, ...(await updateSubscription(env, await request.json())) }, 200, origin);
      }

      if (url.pathname === "/news/register" && request.method === "POST") {
        if (!rateLimit(request, "write")) return json({ ok: false, error: "Quá nhiều yêu cầu, vui lòng thử lại sau." }, 429, origin);
        return json({ ok: true, ...(await registerNews(env, await request.json())) }, 200, origin);
      }

      return json({ ok: false, error: "Not found" }, 404, origin);
    } catch (error) {
      const status = error.status === 404 ? 404 : 400;
      return json({ ok: false, error: error.message || String(error) }, status, origin);
    }
  },
};
