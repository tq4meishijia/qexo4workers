/* Content views: posts, pages, config files, editor, image library. */

import { api, confirmDialog, copyText, debounce, esc, filterRows, fmtDate, icon, navigate, openModal, renderMarkdown, route, setTitle, state, t, toast } from "./core.js";

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

const STATUS_TAG = (s) => (s ? `<span class="tag ok">已发布</span>` : `<span class="tag warn">草稿</span>`);

function toolbarHtml({ placeholder = "搜索…", extra = "" }) {
  return `<div class="toolbar">
    <input id="search" placeholder="${esc(placeholder)}" style="max-width:280px" />
    <button class="btn sm" id="refresh">${icon("dashboard")} 刷新索引</button>
    <div class="spacer"></div>
    ${extra}
  </div>`;
}

/* ------------------------------------------------------------------ */
/* posts                                                              */
/* ------------------------------------------------------------------ */

async function renderPosts({ view, query }) {
  setTitle("文章", [{ text: "内容" }, { text: "文章" }]);
  const tab = query.get("tab") || "all";
  view.innerHTML = `
    <div class="card">
      <div class="tabs">
        <button class="tab ${tab === "all" ? "active" : ""}" data-tab="all">全部</button>
        <button class="tab ${tab === "published" ? "active" : ""}" data-tab="published">已发布</button>
        <button class="tab ${tab === "draft" ? "active" : ""}" data-tab="draft">草稿</button>
      </div>
      <div id="list"></div>
    </div>`;

  let items = [];
  // 文章名 → { phase: pending|success|noop|error, action, message, timer }
  // 只记录发布 / 转草稿两类操作，重命名与删除不进入这里。
  const rowFx = new Map();
  const FX_HOLD = { success: 1600, noop: 1400, error: 3600 };

  /** 状态列：按当前反馈阶段渲染加载 / 成功 / 失败 / 未变化。 */
  const statusTagWithFx = (status, fx) => {
    if (!fx) return STATUS_TAG(status);
    if (fx.phase === "pending") {
      return `<span class="tag info">${fx.action === "publish" ? "发布中" : "转回中"}</span>`;
    }
    if (fx.phase === "noop") {
      return `${STATUS_TAG(status)}<span class="tag info">未变化</span>`;
    }
    if (fx.phase === "error") {
      return `<span class="tag err" title="${esc(fx.message || "操作失败")}">失败</span>`;
    }
    // 成功：状态标签已迁移，给新标签一次入场动画
    return STATUS_TAG(status).replace('class="tag', 'class="tag just-changed');
  };

  /** 反馈保留一段时间后清除，再与服务端对齐；避免重绘打断动画。 */
  const clearFx = (name, ms) => {
    const fx = rowFx.get(name);
    if (!fx) return;
    if (fx.timer) clearTimeout(fx.timer);
    fx.timer = setTimeout(() => {
      rowFx.delete(name);
      if (location.hash.startsWith("#/posts")) load();
    }, ms);
  };

  const draw = () => {
    if (!location.hash.startsWith("#/posts")) return;
    const listEl = document.getElementById("list");
    if (!listEl) return;
    const q = document.getElementById("search")?.value.toLowerCase() || "";
    const rows = items.filter((i) => {
      if (tab === "published" && !i.status) return false;
      if (tab === "draft" && i.status) return false;
      return !q || i.name.toLowerCase().includes(q) || (i.title || "").toLowerCase().includes(q);
    });
    document.getElementById("list").innerHTML = `
      <div class="toolbar">
        <input id="search" placeholder="搜索文章名…" style="max-width:280px" value="${esc(q)}" />        <button class="btn sm" id="refresh">刷新索引</button>
        <div class="spacer"></div>
        <button class="btn primary sm" id="new">${icon("plus")} 新建文章</button>
      </div>
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>标题 / 文件名</th><th>状态</th><th>路径</th><th>大小</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>${rows.map((r) => {
          const fx = rowFx.get(r.name);
          const busy = fx?.phase === "pending";
          const label = busy
            ? fx.action === "publish" ? "发布中" : "转回中"
            : r.status ? "转草稿" : "发布";
          const rowCls = fx?.phase === "success" ? " row-flash ok" : fx?.phase === "error" ? " row-flash err" : "";
          const lock = busy ? " is-locked" : "";
          const off = busy ? "disabled" : "";
          return `
          <tr class="post-row${rowCls}">
            <td><a class="${lock.trim()}" href="#/editor?path=${encodeURIComponent(r.path)}&status=${r.status ? 1 : 0}&type=post"><strong>${esc(r.title || r.name)}</strong></a>
              <div class="hint mono">${esc(r.fullname || r.name)}</div></td>
            <td class="status-cell" aria-live="polite">${statusTagWithFx(r.status, fx)}</td>
            <td class="mono" style="color:var(--muted);font-size:12px">${esc(r.path)}</td>
            <td>${r.size ? Math.round(r.size / 1024) + " KB" : "—"}</td>
            <td class="actions">
              <a class="btn sm${lock}" href="#/editor?path=${encodeURIComponent(r.path)}&status=${r.status ? 1 : 0}&type=post">编辑</a>
              <button class="btn sm${busy ? " is-loading" : ""}${fx?.phase === "error" ? " is-error" : ""}"
                data-act="${r.status ? "unpublish" : "publish"}" data-path="${esc(r.path)}" data-name="${esc(r.name)}"
                ${busy ? 'disabled aria-busy="true"' : ""}>
                ${busy ? '<span class="spin" aria-hidden="true"></span>' : ""}${label}
              </button>
              <button class="btn sm" data-act="rename" data-path="${esc(r.path)}" data-name="${esc(r.name)}" ${off}>重命名</button>
              <button class="btn sm danger" data-act="delete" data-path="${esc(r.path)}" data-name="${esc(r.name)}" ${off}>删除</button>
            </td>
          </tr>`;
        }).join("")}
        </tbody></table></div>` : `<div class="empty"><strong>这里还没有文章</strong>点击右上角新建一篇</div>`}`;

    document.getElementById("new").onclick = newPost;
    document.getElementById("refresh").onclick = refresh;
    document.getElementById("search").oninput = (e) => {
      if (location.hash.startsWith("#/images")) filterRows(".image-card", e.target.value);
      else filterRows("#list tbody tr", e.target.value);
    };
    document.querySelectorAll("[data-act]").forEach((btn) => {
      btn.onclick = () => act(btn.dataset.act, btn.dataset.path, btn.dataset.name);
    });
  };

  const refresh = async () => {
    toast("正在读取仓库目录…");
    const res = await api("/api/posts/refresh", { method: "POST", body: {} });
    toast(`索引已刷新：${res.counts.posts} 篇已发布 / ${res.counts.drafts} 篇草稿`, "ok");
    await load();
  };

  const load = async () => {
    const res = await api("/api/posts");
    items = res.data || [];
    draw();
  };

  const newPost = () => {
    openModal({
      title: "新建文章",
      body: `<label class="field"><span>文件名（不含扩展名，可含目录）</span><input id="m-name" placeholder="hello-world" /></label>
             <p class="hint">将创建为草稿，发布时移动到正式目录。</p>`,
      buttons: [
        { label: "取消", cls: "ghost" },
        {
          label: "创建",
          cls: "primary",
          onClick: async () => {
            const name = document.getElementById("m-name").value.trim();
            if (!name) {
              toast("请输入文件名", "err");
              return false;
            }
            try {
              const res = await api("/api/new_post", { method: "POST", body: { file: name } });
              toast("创建成功", "ok");
              navigate(`/editor?path=${encodeURIComponent(res.path)}&status=0&type=post`);
            } catch (e) {
              toast(e.message, "err");
              return false;
            }
          },
        },
      ],
    });
  };

  /** 发布 / 转草稿：行内加载反馈 + 结果动画，连续点击直接忽略。 */
  const changeStatus = async (kind, path, name) => {
    if (rowFx.get(name)?.phase === "pending") {
      toast("正在提交，请稍候", "warn", 1200);
      return;
    }
    rowFx.set(name, { phase: "pending", action: kind });
    draw();
    try {
      const res = await api(kind === "publish" ? "/api/publish" : "/api/unpublish", {
        method: "POST",
        body: { file: path },
      });
      const status = kind === "publish";
      const before = items.find((i) => i.name === name);
      const nextPath = res.path || path;
      // 后端标记 already，或本地比对确认状态/路径都没变 → 按「未变化」反馈，
      // 不播放状态迁移动画。
      const noop = Boolean(res.already) || (before && before.status === status && before.path === nextPath);
      items = items.map((i) => (i.name === name ? { ...i, path: nextPath, status } : i));
      rowFx.set(name, { phase: noop ? "noop" : "success", action: kind, message: res.msg });
      toast(res.msg || (status ? "发布成功" : "已转为草稿"), noop ? "" : "ok");
      draw();
      clearFx(name, noop ? FX_HOLD.noop : FX_HOLD.success);
    } catch (e) {
      rowFx.set(name, { phase: "error", action: kind, message: e.message });
      toast(e.message, "err");
      draw();
      clearFx(name, FX_HOLD.error);
    }
  };

  const act = async (kind, path, name) => {
    if (kind === "publish" || kind === "unpublish") {
      await changeStatus(kind, path, name);
      return;
    }
    try {
      if (kind === "delete") {
        if (!(await confirmDialog(`确定删除 ${path} 吗？该操作会直接提交到仓库，不可回退。`))) return;
        await api("/api/delete", { method: "POST", body: { file: path } });
        toast("删除成功", "ok");
      } else if (kind === "rename") {
        openModal({
          title: "重命名",
          body: `<label class="field"><span>新路径</span><input id="m-new" value="${esc(path)}" /></label>`,
          buttons: [
            { label: "取消", cls: "ghost" },
            {
              label: "保存",
              cls: "primary",
              onClick: async () => {
                const next = document.getElementById("m-new").value.trim();
                if (!next || next === path) return false;
                try {
                  await api("/api/rename", { method: "POST", body: { file: path, new: next } });
                  toast("重命名成功", "ok");
                } catch (e) {
                  toast(e.message, "err");
                  return false;
                }
              },
            },
          ],
        });
      }
      await load();
    } catch (e) {
      toast(e.message, "err");
    }
  };

  document.querySelectorAll("[data-tab]").forEach((el) => {
    el.onclick = () => {
      document.querySelectorAll("[data-tab]").forEach((x) => x.classList.remove("active"));
      el.classList.add("active");
      location.hash = `#/posts?tab=${el.dataset.tab}`;
    };
  });

  await load();
  if (query.get("new")) newPost();
}

/* ------------------------------------------------------------------ */
/* pages                                                              */
/* ------------------------------------------------------------------ */

async function renderPages({ view, query }) {
  setTitle("页面", [{ text: "内容" }, { text: "页面" }]);
  view.innerHTML = `<div class="card" id="list"><div class="empty">加载中…</div></div>`;
  let items = [];

  const draw = () => {
    if (!location.hash.startsWith("#/pages")) return;
    if (!document.getElementById("list")) return;
    const q = document.getElementById("search")?.value.toLowerCase() || "";
    const rows = items.filter((i) => !q || i.name.toLowerCase().includes(q));
    document.getElementById("list").innerHTML = `
      <div class="toolbar">
        <input id="search" placeholder="搜索页面…" style="max-width:280px" value="${esc(q)}" />
        <button class="btn sm" id="refresh">刷新索引</button>
        <div class="spacer"></div>
        <button class="btn primary sm" id="new">${icon("plus")} 新建页面</button>
      </div>
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>名称</th><th>路径</th><th>大小</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td><a href="#/editor?path=${encodeURIComponent(r.path)}&type=page"><strong>${esc(r.name)}</strong></a></td>
          <td class="mono" style="color:var(--muted);font-size:12px">${esc(r.path)}</td>
          <td>${r.size ? Math.round(r.size / 1024) + " KB" : "—"}</td>
          <td class="actions">
            <a class="btn sm" href="#/editor?path=${encodeURIComponent(r.path)}&type=page">编辑</a>
            <button class="btn sm danger" data-del="${esc(r.path)}">删除</button>
          </td></tr>`).join("")}</tbody></table></div>`
        : `<div class="empty"><strong>还没有独立页面</strong>可以创建「关于」「友链」等固定页面</div>`}`;

    document.getElementById("search").oninput = (e) => {
      if (location.hash.startsWith("#/images")) filterRows(".image-card", e.target.value);
      else filterRows("#list tbody tr", e.target.value);
    };
    document.getElementById("refresh").onclick = async () => {
      const res = await api("/api/posts/refresh", { method: "POST", body: {} });
      toast(`索引已刷新：${res.counts.pages} 个页面`, "ok");
      await load();
    };
    document.getElementById("new").onclick = () =>
      openModal({
        title: "新建页面",
        body: `<label class="field"><span>路径（不含扩展名）</span><input id="m-name" placeholder="about" /></label>`,
        buttons: [
          { label: "取消", cls: "ghost" },
          {
            label: "创建",
            cls: "primary",
            onClick: async () => {
              const name = document.getElementById("m-name").value.trim();
              if (!name) return false;
              try {
                const res = await api("/api/new_page", { method: "POST", body: { file: name } });
                toast("创建成功", "ok");
                navigate(`/editor?path=${encodeURIComponent(res.path)}&type=page`);
              } catch (e) {
                toast(e.message, "err");
                return false;
              }
            },
          },
        ],
      });
    document.querySelectorAll("[data-del]").forEach((btn) => {
      btn.onclick = async () => {
        const path = btn.dataset.del;
        if (!(await confirmDialog(`确定删除页面 ${path} 吗？`))) return;
        try {
          await api("/api/delete", { method: "POST", body: { file: path } });
          toast("删除成功", "ok");
          await load();
        } catch (e) {
          toast(e.message, "err");
        }
      };
    });
  };

  const load = async () => {
    const res = await api("/api/pages");
    items = res.data || [];
    draw();
  };
  await load();
}

/* ------------------------------------------------------------------ */
/* editor                                                             */
/* ------------------------------------------------------------------ */

const SPLIT_KEYS = new Set(["title", "date", "updated", "tags", "categories", "abbrlink", "excerpt", "comments", "top", "sticky"]);

function toList(v) {
  if (Array.isArray(v)) return v.join(", ");
  return v == null ? "" : String(v);
}
function fromList(v) {
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

async function renderEditor({ view, query }) {
  const path = query.get("path");
  const type = query.get("type") === "page" ? "page" : "post";
  if (!path) {
    view.innerHTML = `<div class="card"><div class="empty"><strong>缺少文件路径</strong><a href="#/posts">返回文章列表</a></div></div>`;
    return;
  }
  setTitle(type === "page" ? "编辑页面" : "编辑文章", [
    { text: "内容", href: "#/posts" },
    { text: type === "page" ? "页面" : "文章", href: type === "page" ? "#/pages" : "#/posts" },
    { text: path },
  ]);

  view.innerHTML = `<div class="card"><div class="empty">读取文件中…</div></div>`;
  let post;
  try {
    post = await api(`/api/post?path=${encodeURIComponent(path)}`);
  } catch (e) {
    view.innerHTML = `<div class="card"><div class="empty"><strong>无法读取文件</strong><p>${esc(e.message)}</p><a href="#/posts">返回</a></div></div>`;
    return;
  }

  const fm = post.front_matter || {};
  const extras = {};
  for (const [k, v] of Object.entries(fm)) if (!SPLIT_KEYS.has(k)) extras[k] = v;
  const isDraft = type === "post" && (query.get("status") === "0" || path.includes("/_drafts/") || path.includes("/drafts/"));

  view.innerHTML = `
    <div class="editor-grid">
      <div class="card editor-meta">
        <div class="card-head"><div><h3>文章信息</h3><div class="sub mono">${esc(path)}</div></div></div>
        <label class="field"><span>标题</span><input id="f-title" value="${esc(fm.title || post.title || "")}" /></label>
        <div class="row">
          <label class="field"><span>日期</span><input id="f-date" value="${esc(toList(fm.date))}" placeholder="2025-01-01 12:00:00" /></label>
          <label class="field"><span>缩写 abbrlink</span><input id="f-abbrlink" value="${esc(toList(fm.abbrlink))}" /></label>
        </div>
        <label class="field"><span>标签（逗号分隔）</span><input id="f-tags" value="${esc(toList(fm.tags))}" /></label>
        <label class="field"><span>分类（逗号分隔）</span><input id="f-categories" value="${esc(toList(fm.categories))}" /></label>
        <label class="field"><span>摘要 excerpt</span><textarea id="f-excerpt" rows="3">${esc(toList(fm.excerpt))}</textarea></label>
        <label class="field"><span>其他 front-matter（JSON）</span><textarea id="f-extra" rows="5" class="mono">${esc(JSON.stringify(extras, null, 2))}</textarea></label>
        <div class="flex">
          <button class="btn primary" id="save">${isDraft ? "保存草稿" : "保存"}</button>
          ${type === "post" ? `<button class="btn" id="publish">${isDraft ? "发布" : "转为草稿"}</button>` : ""}
        </div>
        <p class="hint mt" id="save-hint"></p>
      </div>

      <div class="editor-main">
        <div class="editor-toolbar">
          <button class="btn sm ghost" data-md="h2">H2</button>
          <button class="btn sm ghost" data-md="h3">H3</button>
          <span class="sep"></span>
          <button class="btn sm ghost" data-md="bold"><strong>B</strong></button>
          <button class="btn sm ghost" data-md="italic"><em>I</em></button>
          <button class="btn sm ghost" data-md="code">&lt;/&gt;</button>
          <button class="btn sm ghost" data-md="link">链接</button>
          <button class="btn sm ghost" data-md="quote">引用</button>
          <button class="btn sm ghost" data-md="list">列表</button>
          <button class="btn sm ghost" data-md="hr">分隔线</button>
          <span class="sep"></span>
          <button class="btn sm ghost" id="upload-inline">插入图片</button>
          <div class="spacer" style="flex:1"></div>
          <button class="btn sm ghost" id="toggle-preview">预览</button>
        </div>
        <div class="editor-panes" id="panes">
          <textarea id="content" placeholder="开始写作…">${esc(post.content || "")}</textarea>
          <div class="preview" id="preview"></div>
        </div>
      </div>
    </div>`;

  const contentEl = document.getElementById("content");
  const previewEl = document.getElementById("preview");
  const panes = document.getElementById("panes");
  const updatePreview = () => (previewEl.innerHTML = renderMarkdown(contentEl.value));
  contentEl.oninput = debounce(updatePreview, 160);
  updatePreview();

  let previewOn = true;
  document.getElementById("toggle-preview").onclick = () => {
    previewOn = !previewOn;
    previewEl.style.display = previewOn ? "" : "none";
    panes.classList.toggle("single", !previewOn);
  };

  const wrapSelection = (before, after = before, placeholder = "文本") => {
    const start = contentEl.selectionStart;
    const end = contentEl.selectionEnd;
    const selected = contentEl.value.slice(start, end) || placeholder;
    contentEl.value = contentEl.value.slice(0, start) + before + selected + after + contentEl.value.slice(end);
    contentEl.focus();
    contentEl.selectionStart = start + before.length;
    contentEl.selectionEnd = start + before.length + selected.length;
    updatePreview();
  };

  const insertAtCursor = (text) => {
    const start = contentEl.selectionStart;
    contentEl.value = contentEl.value.slice(0, start) + text + contentEl.value.slice(start);
    contentEl.focus();
    contentEl.selectionStart = contentEl.selectionEnd = start + text.length;
    updatePreview();
  };

  document.querySelectorAll("[data-md]").forEach((btn) => {
    btn.onclick = () => {
      const k = btn.dataset.md;
      if (k === "bold") wrapSelection("**", "**", "加粗文本");
      else if (k === "italic") wrapSelection("*", "*", "斜体文本");
      else if (k === "code") wrapSelection("`", "`", "code");
      else if (k === "h2") insertAtCursor("\n## 标题\n");
      else if (k === "h3") insertAtCursor("\n### 标题\n");
      else if (k === "quote") insertAtCursor("\n> 引用\n");
      else if (k === "list") insertAtCursor("\n- 列表项\n- 列表项\n");
      else if (k === "hr") insertAtCursor("\n---\n");
      else if (k === "link") wrapSelection("[", "](https://)", "链接文字");
    };
  });

  document.getElementById("upload-inline").onclick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const form = new FormData();
      form.append("file", file);
      try {
        toast("上传中…");
        const res = await api("/api/upload", { method: "POST", body: form });
        insertAtCursor(`\n![${file.name}](${res.url})\n`);
        toast("已插入图片", "ok");
      } catch (e) {
        toast(e.message, "err");
      }
    };
    input.click();
  };

  const collect = () => {
    let extra = {};
    const raw = document.getElementById("f-extra").value.trim();
    if (raw) {
      try {
        extra = JSON.parse(raw);
      } catch {
        throw new Error("其他 front-matter 不是合法 JSON");
      }
    }
    const data = {};
    const title = document.getElementById("f-title").value.trim();
    if (title) data.title = title;
    const date = document.getElementById("f-date").value.trim();
    if (date) data.date = date;
    const abbr = document.getElementById("f-abbrlink").value.trim();
    if (abbr) data.abbrlink = abbr;
    const tags = fromList(document.getElementById("f-tags").value);
    if (tags.length) data.tags = tags;
    const cats = fromList(document.getElementById("f-categories").value);
    if (cats.length) data.categories = cats;
    const excerpt = document.getElementById("f-excerpt").value.trim();
    if (excerpt) data.excerpt = excerpt;
    return { ...extra, ...data };
  };

  const save = async (status) => {
    const btn = document.getElementById("save");
    const hint = document.getElementById("save-hint");
    btn.disabled = true;
    try {
      let fmData;
      try {
        fmData = collect();
      } catch (e) {
        toast(e.message, "err");
        return;
      }
      let content = contentEl.value;
      const auto = state.settings?.settings?.AUTO_EXCERPT_CONFIG;
      if (auto && !fmData.excerpt) {
        try {
          const cfg = JSON.parse(auto);
          if (cfg.auto === "开启") {
            const res = await api("/api/excerpt", { method: "POST", body: { content, length: Number(cfg.params?.length || 200) } });
            if (res.excerpt) fmData[cfg.save_key || "excerpt"] = res.excerpt;
          }
        } catch {
          /* ignore */
        }
      }
      const name = path.split("/").pop().replace(/\.[^.]+$/, "");
      const endpoint = type === "page" ? "/api/save_page" : status ? "/api/save_post" : "/api/save_draft";
      const payload =
        type === "page"
          ? { file: path, content, front_matter: fmData }
          : { file: name, path, content, front_matter: fmData, status: status ? "true" : "false" };
      const res = await api(endpoint, { method: "POST", body: payload });
      hint.textContent = `已保存 · ${new Date().toLocaleTimeString()}`;
      toast(res.msg || "保存成功", "ok");
      if (res.path && res.path !== path) {
        navigate(`/editor?path=${encodeURIComponent(res.path)}&status=${status ? 1 : 0}&type=${type}`);
      }
    } catch (e) {
      toast(e.message, "err");
    } finally {
      btn.disabled = false;
    }
  };

  document.getElementById("save").onclick = () => save(!isDraft);
  document.getElementById("publish")?.addEventListener("click", async () => {
    if (isDraft) {
      await save(true);
    } else {
      if (!(await confirmDialog("转为草稿会从正式目录移动到草稿目录，确定继续？"))) return;
      try {
        await api("/api/unpublish", { method: "POST", body: { file: path } });
        toast("已转为草稿", "ok");
        navigate("/posts?tab=draft");
      } catch (e) {
        toast(e.message, "err");
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* config files                                                       */
/* ------------------------------------------------------------------ */

async function renderConfigs({ view }) {
  setTitle("配置", [{ text: "内容" }, { text: "配置" }]);
  view.innerHTML = `<div class="card" id="list"><div class="empty">加载中…</div></div>`;
  let items = [];

  const draw = () => {
    if (!location.hash.startsWith("#/configs")) return;
    if (!document.getElementById("list")) return;
    const q = document.getElementById("search")?.value.toLowerCase() || "";
    const rows = items.filter((i) => !q || i.name.toLowerCase().includes(q) || i.path.toLowerCase().includes(q));
    document.getElementById("list").innerHTML = `
      <div class="toolbar">
        <input id="search" placeholder="搜索配置文件…" style="max-width:300px" value="${esc(q)}" />
        <button class="btn sm" id="refresh">刷新索引</button>
        <div class="spacer"></div>
        <span class="hint">支持 YAML / JSON / TOML / JS / TS，保存前对 YAML 与 JSON 做语法校验</span>
      </div>
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>配置名</th><th>路径</th><th>大小</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td><strong>${esc(r.name)}</strong></td>
          <td class="mono" style="color:var(--muted);font-size:12px">${esc(r.path)}</td>
          <td>${r.size ? Math.round(r.size / 1024) + " KB" : "—"}</td>
          <td class="actions"><a class="btn sm" href="#/config?path=${encodeURIComponent(r.path)}">编辑</a></td>
        </tr>`).join("")}</tbody></table></div>` : `<div class="empty"><strong>没有找到配置文件</strong>请确认平台配置与仓库路径</div>`}`;
    document.getElementById("search").oninput = (e) => {
      if (location.hash.startsWith("#/images")) filterRows(".image-card", e.target.value);
      else filterRows("#list tbody tr", e.target.value);
    };
    document.getElementById("refresh").onclick = async () => {
      const res = await api("/api/posts/refresh", { method: "POST", body: {} });
      toast(`索引已刷新：${res.counts.configs} 个配置文件`, "ok");
      await load();
    };
  };
  const load = async () => {
    const res = await api("/api/configs");
    items = res.data || [];
    draw();
  };
  await load();
}

async function renderConfigEditor({ view, query }) {
  const path = query.get("path");
  setTitle("编辑配置", [{ text: "配置", href: "#/configs" }, { text: path || "" }]);
  if (!path) {
    view.innerHTML = `<div class="card"><div class="empty"><strong>缺少路径</strong><a href="#/configs">返回</a></div></div>`;
    return;
  }
  view.innerHTML = `<div class="card"><div class="empty">读取中…</div></div>`;
  let data;
  try {
    data = await api(`/api/config?path=${encodeURIComponent(path)}`);
  } catch (e) {
    view.innerHTML = `<div class="card"><div class="empty"><strong>读取失败</strong><p>${esc(e.message)}</p></div></div>`;
    return;
  }
  view.innerHTML = `
    <div class="card">
      <div class="card-head"><div><h3 class="mono" style="font-size:13px">${esc(path)}</h3><div class="sub">保存后会提交到仓库</div></div>
        <div class="flex"><a class="btn sm ghost" href="#/configs">返回</a><button class="btn primary sm" id="save">保存</button></div></div>
      <textarea id="cfg" class="code" style="min-height:62vh;padding:14px;line-height:1.6;font-size:13px">${esc(data.content || "")}</textarea>
      <p class="hint mt" id="hint"></p>
    </div>`;
  document.getElementById("save").onclick = async () => {
    const btn = document.getElementById("save");
    btn.disabled = true;
    try {
      await api("/api/save_config", { method: "POST", body: { file: path, content: document.getElementById("cfg").value } });
      document.getElementById("hint").textContent = `已保存 · ${new Date().toLocaleTimeString()}`;
      toast("保存成功", "ok");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      btn.disabled = false;
    }
  };
}

/* ------------------------------------------------------------------ */
/* images                                                             */
/* ------------------------------------------------------------------ */

async function renderImages({ view }) {
  setTitle("图床", [{ text: "媒体" }, { text: "图床" }]);
  // 未配置图床时上传接口会返回 400；在页面内给出持久引导，避免用户只看到
  // 一条瞬间消失的 toast 而误判为功能损坏。
  let hostType = "关闭";
  try {
    const s = await api("/api/settings");
    hostType = JSON.parse(s.settings?.IMG_HOST || "{}").type || "关闭";
  } catch {
    /* 读取失败时按未配置处理，仅展示提示，不影响页面其它功能 */
  }
  const hostHint = hostType === "关闭"
    ? '<div class="hint mt" id="img-host-hint" style="margin:0 0 12px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg-2);color:var(--text);font-size:13px">图床尚未配置，上传接口当前关闭。请先到 <a href="#/settings/image">设置 → 图床</a> 选择类型并保存，再上传图片。</div>'
    : "";
  view.innerHTML = `
    <div class="card">
      ${hostHint}
      <div class="toolbar">
        <input id="search" placeholder="搜索图片名或 URL…" style="max-width:300px" />
        <div class="spacer"></div>
        <button class="btn primary sm" id="pick">${icon("upload")} 上传图片</button>
      </div>
      <div class="dropzone" id="drop">拖拽图片到此处上传，或点击选择文件</div>
      <div class="image-grid mt" id="grid"></div>
    </div>`;
  let items = [];

  const draw = () => {
    if (!location.hash.startsWith("#/images")) return;
    const grid = document.getElementById("grid");
    if (!grid) return;
    const q = document.getElementById("search").value.toLowerCase();
    const rows = items.filter((i) => !q || i.name.toLowerCase().includes(q) || i.url.toLowerCase().includes(q));
    grid.innerHTML = rows.length
      ? rows.map((i) => `<div class="image-card">
          <div class="thumb" style="background-image:url('${esc(i.url)}')"></div>
          <div class="meta"><strong style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(i.name)}</strong>
            <small>${esc(i.size)} · ${esc(i.date)}</small></div>
          <div class="ops"><button class="btn sm" data-copy="${esc(i.url)}">复制链接</button>
            <button class="btn sm danger" data-del="${esc(i.time)}">删除</button></div>
        </div>`).join("")
      : `<div class="empty" style="grid-column:1/-1"><strong>暂无图片</strong>上传后会记录到 D1，并可同步删除远端对象</div>`;
    document.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = () => copyText(b.dataset.copy)));
    document.querySelectorAll("[data-del]").forEach((b) => {
      b.onclick = async () => {
        const sync = await new Promise((resolve) => {
          openModal({
            title: "删除图片",
            body: `<p class="hint">是否同时删除远端存储中的文件？</p>`,
            buttons: [
              { label: "仅删除记录", cls: "ghost", onClick: () => resolve(false) },
              { label: "同时删除远端", cls: "danger", onClick: () => resolve(true) },
            ],
          });
        });
        try {
          await api("/api/delete_img", { method: "POST", body: { image: b.dataset.del, sync: sync ? "true" : "false" } });
          toast("删除成功", "ok");
          await load();
        } catch (e) {
          toast(e.message, "err");
        }
      };
    });
  };

  const upload = async (files) => {
    for (const file of files) {
      const form = new FormData();
      form.append("file", file);
      try {
        toast(`上传 ${file.name}…`);
        await api("/api/upload", { method: "POST", body: form });
        toast(`${file.name} 上传成功`, "ok");
      } catch (e) {
        toast(`${file.name}: ${e.message}`, "err");
      }
    }
    await load();
  };

  const load = async () => {
    const res = await api("/api/images");
    items = res.data || [];
    draw();
  };

  document.getElementById("search").oninput = debounce(draw, 200);
  document.getElementById("pick").onclick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.onchange = () => upload([...input.files]);
    input.click();
  };
  const drop = document.getElementById("drop");
  drop.onclick = () => document.getElementById("pick").click();
  drop.ondragover = (e) => {
    e.preventDefault();
    drop.classList.add("drag");
  };
  drop.ondragleave = () => drop.classList.remove("drag");
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
    upload([...e.dataTransfer.files].filter((f) => f.type.startsWith("image/")));
  };
  await load();
}

/* ------------------------------------------------------------------ */
/* register                                                           */
/* ------------------------------------------------------------------ */

route("/posts", renderPosts);
route("/pages", renderPages);
route("/editor", renderEditor);
route("/configs", renderConfigs);
route("/config", renderConfigEditor);
route("/images", renderImages);
