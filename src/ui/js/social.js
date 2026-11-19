/* Social views: friend links and talks. */

import { api, confirmDialog, debounce, esc, filterRows, fmtDate, icon, listStateHtml, openModal, route, runBusy, setTitle, toast } from "./core.js";

/* ------------------------------------------------------------------ */
/* friends                                                            */
/* ------------------------------------------------------------------ */

function friendForm(item = {}) {
  return `
    <label class="field"><span>名称</span><input id="m-name" value="${esc(item.name || "")}" /></label>
    <label class="field"><span>链接</span><input id="m-url" value="${esc(item.url || "")}" placeholder="https://example.com" /></label>
    <label class="field"><span>头像</span><input id="m-image" value="${esc(item.image || "")}" placeholder="https://example.com/avatar.png" /></label>
    <label class="field"><span>描述</span><input id="m-desc" value="${esc(item.description || "")}" /></label>
    <label class="field"><span>状态</span>
      <select id="m-status"><option ${item.status === "显示" ? "selected" : ""}>显示</option><option ${item.status === "隐藏" ? "selected" : ""}>隐藏</option></select>
    </label>`;
}

function readFriendForm() {
  return {
    name: document.getElementById("m-name").value.trim(),
    url: document.getElementById("m-url").value.trim(),
    image: document.getElementById("m-image").value.trim(),
    description: document.getElementById("m-desc").value.trim(),
    status: document.getElementById("m-status").value,
  };
}

async function renderFriends({ view }) {
  setTitle("友链", [{ text: "互动" }, { text: "友链" }]);
  view.innerHTML = `<div class="card" id="list">${listStateHtml.loading("正在读取友链…")}</div>`;
  let items = [];

  const draw = () => {
    if (!location.hash.startsWith("#/friends")) return;
    if (!document.getElementById("list")) return;
    const q = document.getElementById("search")?.value.toLowerCase() || "";
    const rows = items.filter((i) => !q || i.name.toLowerCase().includes(q) || i.url.toLowerCase().includes(q));
    document.getElementById("list").innerHTML = `
      <div class="toolbar">
        <input id="search" placeholder="搜索友链…" style="max-width:280px" value="${esc(q)}" />
        <div class="spacer"></div>
        <button class="btn sm" id="clean">清理隐藏友链</button>
        <button class="btn primary sm" id="add">${icon("plus")} 添加友链</button>
      </div>
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>名称</th><th>链接</th><th>描述</th><th>状态</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td><strong>${esc(r.name)}</strong><div class="hint">${esc(r.time)}</div></td>
          <td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a></td>
          <td>${esc(r.description || "—")}</td>
          <td>${r.status === "显示" ? '<span class="tag ok">显示</span>' : '<span class="tag warn">隐藏</span>'}</td>
          <td class="actions"><button class="btn sm" data-edit="${esc(r.time)}">编辑</button>
            <button class="btn sm danger" data-del="${esc(r.time)}">删除</button></td>
        </tr>`).join("")}</tbody></table></div>` : `<div class="empty"><strong>还没有友链</strong>可以手动添加，或开放前台申请</div>`}`;

    document.getElementById("search").oninput = (e) => filterRows("#list tbody tr", e.target.value);
    document.getElementById("add").onclick = () =>
      openModal({
        title: "添加友链",
        body: friendForm(),
        buttons: [
          { label: "取消", cls: "ghost" },
          {
            label: "添加",
            cls: "primary",
            onClick: async () => {
              try {
                await api("/api/friends", { method: "POST", body: readFriendForm() });
                toast("添加成功！", "ok");
                await load();
              } catch (e) {
                toast(e.message, "err");
                return false;
              }
            },
          },
        ],
      });
    document.getElementById("clean").onclick = async () => {
      if (!(await confirmDialog("确定清理所有隐藏的友链吗？该操作不可回退。"))) return;
      try {
        const res = await runBusy(document.getElementById("clean"), () => api("/api/friends/clean", { method: "POST", body: {} }), "清理中…");
        toast(res.msg, "ok");
        await load();
      } catch (e) {
        toast(e.message, "err");
      }
    };
    document.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.onclick = () => {
        const item = items.find((i) => i.time === btn.dataset.edit);
        openModal({
          title: "编辑友链",
          body: friendForm(item),
          buttons: [
            { label: "取消", cls: "ghost" },
            {
              label: "保存",
              cls: "primary",
              onClick: async () => {
                try {
                  await api("/api/friends", { method: "PUT", body: { ...readFriendForm(), time: item.time } });
                  toast("修改成功！", "ok");
                  await load();
                } catch (e) {
                  toast(e.message, "err");
                  return false;
                }
              },
            },
          ],
        });
      };
    });
    document.querySelectorAll("[data-del]").forEach((btn) => {
      btn.onclick = async () => {
        if (!(await confirmDialog("确定删除该友链吗？"))) return;
        try {
          await runBusy(btn, () => api("/api/friends", { method: "DELETE", body: { time: btn.dataset.del } }), "删除中…");
          toast("删除成功！", "ok");
          await load();
        } catch (e) {
          toast(e.message, "err");
        }
      };
    });
  };

  const load = async () => {
    try {
      const res = await api("/api/friends");
      items = res.data || [];
    } catch (e) {
      const list = document.getElementById("list");
      if (list) list.innerHTML = listStateHtml.error(e.message);
      toast(e.message, "err");
      return;
    }
    draw();
  };
  await load();
}

/* ------------------------------------------------------------------ */
/* talks                                                              */
/* ------------------------------------------------------------------ */

async function renderTalks({ view }) {
  setTitle("说说", [{ text: "互动" }, { text: "说说" }]);
  view.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input id="search" placeholder="搜索内容…" style="max-width:280px" />
        <div class="spacer"></div>
        <button class="btn primary sm" id="add">${icon("plus")} 发布说说</button>
      </div>
      <div id="list">${listStateHtml.loading("正在读取说说…")}</div>
    </div>`;
  let items = [];

  const draw = () => {
    if (!location.hash.startsWith("#/talks")) return;
    if (!document.getElementById("list")) return;
    const q = document.getElementById("search").value.toLowerCase();
    const rows = items.filter((i) => !q || i.content.toLowerCase().includes(q));
    document.getElementById("list").innerHTML = rows.length
      ? rows.map((r) => `<div class="card" style="margin-bottom:12px;background:var(--panel-2)">
          <div class="flex" style="justify-content:space-between">
            <span class="hint">${esc(r.time_text || fmtDate(r.time))}</span>
            <span class="flex">
              <button class="btn sm" data-edit="${esc(r.id)}">编辑</button>
              <button class="btn sm danger" data-del="${esc(r.id)}">删除</button>
            </span>
          </div>
          <p style="margin:10px 0 8px;white-space:pre-wrap;line-height:1.7">${esc(r.content)}</p>
          <div class="flex">${(r.tags || []).map((tg) => `<span class="tag info">#${esc(tg)}</span>`).join("")}
            <span class="tag">♥ ${r.like || 0}</span></div>
        </div>`).join("")
      : `<div class="empty"><strong>还没有说说</strong>记录一句话、一张图或一个想法</div>`;
    document.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.onclick = () => {
        const item = items.find((i) => i.id === btn.dataset.edit);
        openModal({
          title: "编辑说说",
          body: `<label class="field"><span>内容</span><textarea id="t-content" rows="6">${esc(item.content)}</textarea></label>
                 <label class="field"><span>标签（JSON 数组）</span><input id="t-tags" value="${esc(JSON.stringify(item.tags || []))}" /></label>
                 <label class="field"><span>附加字段（JSON）</span><textarea id="t-values" rows="3" class="mono">${esc(JSON.stringify(item.values || {}, null, 2))}</textarea></label>`,
          buttons: [
            { label: "取消", cls: "ghost" },
            {
              label: "保存",
              cls: "primary",
              onClick: async () => {
                try {
                  await api("/api/talks", {
                    method: "POST",
                    body: {
                      id: item.id,
                      content: document.getElementById("t-content").value,
                      tags: document.getElementById("t-tags").value || "[]",
                      values: document.getElementById("t-values").value || "{}",
                      time: item.time,
                    },
                  });
                  toast("修改成功！", "ok");
                  await load();
                } catch (e) {
                  toast(e.message, "err");
                  return false;
                }
              },
            },
          ],
        });
      };
    });
    document.querySelectorAll("[data-del]").forEach((btn) => {
      btn.onclick = async () => {
        if (!(await confirmDialog("确定删除这条说说吗？"))) return;
        try {
          await runBusy(btn, () => api("/api/talks", { method: "DELETE", body: { id: btn.dataset.del } }), "删除中…");
          toast("删除成功！", "ok");
          await load();
        } catch (e) {
          toast(e.message, "err");
        }
      };
    });
  };

  const load = async () => {
    try {
      const res = await api("/api/talks");
      items = res.data || [];
    } catch (e) {
      const list = document.getElementById("list");
      if (list) list.innerHTML = listStateHtml.error(e.message);
      toast(e.message, "err");
      return;
    }
    draw();
  };

  document.getElementById("search").oninput = debounce(draw, 200);
  document.getElementById("add").onclick = () =>
    openModal({
      title: "发布说说",
      body: `<label class="field"><span>内容</span><textarea id="t-content" rows="6" placeholder="写点什么…"></textarea></label>
             <label class="field"><span>标签（JSON 数组）</span><input id="t-tags" value="[]" /></label>
             <label class="field"><span>附加字段（JSON，可选）</span><textarea id="t-values" rows="3" class="mono">{}</textarea></label>`,
      buttons: [
        { label: "取消", cls: "ghost" },
        {
          label: "发布",
          cls: "primary",
          onClick: async () => {
            const content = document.getElementById("t-content").value.trim();
            if (!content) {
              toast("内容不能为空", "err");
              return false;
            }
            try {
              await api("/api/talks", {
                method: "POST",
                body: {
                  content,
                  tags: document.getElementById("t-tags").value || "[]",
                  values: document.getElementById("t-values").value || "{}",
                },
              });
              toast("发布成功！", "ok");
              await load();
            } catch (e) {
              toast(e.message, "err");
              return false;
            }
          },
        },
      ],
    });
  await load();
}

route("/friends", renderFriends);
route("/talks", renderTalks);
