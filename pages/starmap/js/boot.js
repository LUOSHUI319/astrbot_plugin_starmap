/* 记忆星图 · 数据引导
 *
 * 原来是 <script src="data/memory-data.js"> 静态数据；现在改成插件接口。
 * app.js 第 5 行就 `const data = window.MEMORY_DATA`，是立即执行的，
 * 所以必须先把数据拿回来、设好全局变量，再动态插入 app.js。
 *
 * 接口前缀不写死：插件页面可能挂在 /api/plugin/page/<name>/ 或
 * /<plugin>/page/<name>/ 下，几个基地址依次试，谁通用谁。
 */
(async function () {
  const statusEl = document.getElementById("map-status");
  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text;
  };

  const here = location.pathname.replace(/\/[^/]*$/, "");
  // 脚本自身的地址一定是对的（能加载到它说明解析成功），用它反推接口前缀最可靠
  const self = (document.currentScript && document.currentScript.src) || "";
  const selfDir = self ? self.replace(/\/[^/]*$/, "") : "";
  const BASES = [
    selfDir ? `${selfDir}/..` : "",
    "..",
    ".",
    `${here}/..`,
    "/api/plugin/page",
    "/astrbot_plugin_starmap/page",
  ].filter(Boolean);

  const tryJson = async (path) => {
    let last = "";
    for (const base of BASES) {
      const url = `${base}/${path}`;
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
          last = `${url} → HTTP ${res.status}`;
          continue;
        }
        const body = await res.json();
        if (body && body.status === "error") {
          last = `${url} → ${body.message || "接口报错"}`;
          continue;
        }
        return { ok: true, data: (body && body.data) || body, url };
      } catch (err) {
        last = `${url} → ${err && err.message ? err.message : err}`;
      }
    }
    return { ok: false, error: last };
  };

  setStatus("正在连接记忆库");
  const got = await tryJson("data");
  let payload = got.ok ? got.data : null;
  // file:// 或 iframe 的 about:/blob: 下，fetch 任何 http 地址都会被浏览器直接拒绝，
  // 报的是含糊的 "Failed to fetch"。这种情况不是接口没写对，是打开方式不对。
  const badProtocol = !/^https?:$/.test(location.protocol);
  let failure = got.ok ? "" : got.error;
  if (!got.ok && badProtocol) {
    failure = `当前是 ${location.protocol} 打开的，读不了接口`;
  }

  if (!payload) {
    window.MEMORY_DATA = {
      exported_at: Math.floor(Date.now() / 1000),
      count: 0,
      atoms: [],
      edges: [],
      graph: { version: 1, nodeCount: 0, edgeCount: 0, counts: {} },
      missing: true,
    };
    setStatus(failure ? `读不到记忆库：${failure}` : "没有可显示的记忆");
    console.warn("[starmap] 数据加载失败:", failure);
  } else {
    window.MEMORY_DATA = payload;
    if (payload.missing) {
      setStatus("没找到「从绫开始」的记忆库");
      tryJson("status").then((r) => {
        if (r.ok) console.info("[starmap] 诊断", r.data);
      });
    }
  }

  const boot = document.createElement("script");
  boot.src = "js/app.js?v=9";
  boot.onerror = () => setStatus("星图脚本加载失败");
  document.body.appendChild(boot);

  if (!payload || payload.missing) {
    const why = badProtocol
      ? `现在是 ${location.protocol} 打开的，浏览器不允许本地文件读接口。请改成从 AstrBot 面板打开这个页面。`
      : payload
        ? "没找到「从绫开始」的记忆库"
        : failure || "读不到记忆库";
    // 不再自动弹全屏：只在右下角放一个小按钮，点了才展开，免得挡住画布
    setupBind(why, badProtocol);
  }

  // 首次访问（或点右上角 ?）显示使用说明：这是个要上市场的插件，
  // 「从哪打开」「记忆库在哪」必须在页面里写清楚，不然别人装完一脸茫然。
  setupGuide();

  function setupGuide() {
    const KEY = "starmap.guide.seen";
    let seen = false;
    try {
      seen = localStorage.getItem(KEY) === "1";
    } catch (err) {
      seen = false;
    }
    const helpBtn = document.createElement("button");
    helpBtn.id = "guide-open";
    helpBtn.type = "button";
    helpBtn.textContent = "使用说明";
    helpBtn.style.cssText = [
      "padding:10px 24px", "border-radius:10px", "cursor:pointer",
      "font:14.5px/1 system-ui,sans-serif", "letter-spacing:.04em", "font-weight:500",
      "color:#dff0e6", "background:rgba(155,196,177,.20)",
      "border:1px solid rgba(155,196,177,.48)",
      "white-space:nowrap", "flex:none",
      "box-shadow:0 2px 10px rgba(0,0,0,.25)",
    ].join(";");
    helpBtn.onclick = () => showGuide();
    // 放在页面顶栏中间（搜索框和快照之间），别贴边
    const header = document.querySelector(".header");
    if (header) {
      const anchor = header.querySelector(".snapshot");
      if (anchor) header.insertBefore(helpBtn, anchor);
      else header.appendChild(helpBtn);
    } else {
      helpBtn.style.position = "fixed";
      helpBtn.style.top = "16px";
      helpBtn.style.right = "22px";
      helpBtn.style.zIndex = "9000";
      document.body.appendChild(helpBtn);
    }
    if (!seen) showGuide();
  }

  function showGuide() {
    if (document.getElementById("guide-panel")) return;
    const port = location.port || "6186";
    const style = document.createElement("style");
    style.textContent = `
#guide-panel{position:fixed;inset:0;z-index:9500;display:flex;align-items:center;justify-content:center;
  background:rgba(8,10,10,.78);backdrop-filter:blur(3px);font:14px/1.7 system-ui,sans-serif;color:#d8e3dc}
#guide-box{width:min(560px,92vw);padding:26px 26px 20px;border:1px solid rgba(155,196,177,.26);
  border-radius:16px;background:#121714;box-shadow:0 24px 60px rgba(0,0,0,.55);position:relative}
#guide-box h2{margin:0 0 14px;font-size:18px;font-weight:600;letter-spacing:.02em;padding-right:28px}
#guide-box h3{margin:16px 0 6px;font-size:13px;color:#b9cec1;letter-spacing:.04em}
#guide-box p{margin:0 0 8px;font-size:13px;color:#9db3a6}
#guide-box code{display:inline-block;padding:3px 8px;border-radius:6px;background:rgba(155,196,177,.1);
  border:1px solid rgba(155,196,177,.2);font:12.5px/1.5 ui-monospace,Consolas,monospace;color:#cfe8dc;
  word-break:break-all}
#guide-box .warn{color:#e0c48a}
#guide-close{position:absolute;top:12px;right:14px;width:26px;height:26px;border:none;cursor:pointer;
  background:transparent;color:#8fa89b;font-size:19px;line-height:1;border-radius:6px}
#guide-close:hover{background:rgba(155,196,177,.12);color:#d8e3dc}
#guide-ok{margin-top:18px;padding:9px 20px;border-radius:9px;cursor:pointer;font-size:13px;
  color:#0e1210;background:linear-gradient(180deg,#c8f0dc,#9ecdb6);border:none;font-weight:600}
`;
    document.head.appendChild(style);

    const panel = document.createElement("div");
    panel.id = "guide-panel";
    panel.innerHTML = `
      <div id="guide-box">
        <button id="guide-close" title="关闭">×</button>
        <h2>从绫开始 · 记忆星图 · 使用说明</h2>

        <h3>一、怎么打开</h3>
        <p>直接访问这个地址（收藏起来最方便）：</p>
        <p><code>http://127.0.0.1:${port}/</code></p>
        <p class="warn">不要从 AstrBot 面板里直接点开插件页面 —— 面板的页面地址需要一次性登录令牌，
          手动输入会显示「未授权」。想在面板里看，请用插件自带的入口，不要复制地址。</p>

        <h3>二、记忆库怎么接上</h3>
        <p>插件会自动找「从绫开始」的数据库，通常在：</p>
        <p><code>data\\plugin_data\\astrbot_plugin_congling\\congling.db</code></p>
        <p>如果没找到，点右下角「注入记忆库」：把 congling.db 的完整路径粘进去 →
          点「扫描」确认找到多少条记忆 → 点「注入」。路径可以在这个插件的配置面板里复制。</p>

        <h3>三、数据是实时的</h3>
        <p>星图只读打开数据库，不写、不改。每 60 秒或数据有变化时自动重算关联，刷新页面即可看到最新。</p>

        <button id="guide-ok">知道了</button>
      </div>`;
    document.body.appendChild(panel);

    const close = () => {
      if (panel.dataset.closing === "1") return;
      panel.dataset.closing = "1";
      const box = panel.querySelector("#guide-box");
      const target = document.getElementById("guide-open");
      try {
        localStorage.setItem("starmap.guide.seen", "1");
      } catch (err) {}

      if (!box || !target) {
        panel.remove();
        return;
      }
      // 缩回按钮：算好位移和缩放，让弹窗「飞」到按钮上
      const from = box.getBoundingClientRect();
      const to = target.getBoundingClientRect();
      const sx = Math.max(0.06, to.width / from.width);
      const sy = Math.max(0.06, to.height / from.height);
      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);

      box.style.transformOrigin = "center center";
      box.style.willChange = "transform, opacity";
      box.style.transition = "transform .46s cubic-bezier(.32,.72,.28,1), opacity .46s ease-in";
      panel.style.transition = "background .46s ease-in";
      requestAnimationFrame(() => {
        panel.style.background = "rgba(8,10,10,0)";
        panel.style.backdropFilter = "blur(0px)";
        box.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
        box.style.opacity = "0";
      });
      // 按钮同时轻轻一亮，像是把东西收进去了
      target.style.transition = "transform .18s ease, box-shadow .46s ease";
      target.style.transform = "scale(1.06)";
      target.style.boxShadow = "0 0 22px rgba(180,230,205,.55)";
      setTimeout(() => {
        target.style.transform = "";
        target.style.boxShadow = "";
      }, 460);
      setTimeout(() => panel.remove(), 480);
    };
    panel.querySelector("#guide-ok").onclick = close;
    panel.querySelector("#guide-close").onclick = close;
    panel.onclick = (e) => {
      if (e.target === panel) close();
    };
  }

  /* ------------------------------------------------------------ 注入入口 */
  function setupBind(reason, localFile) {
    if (document.getElementById("bind-open")) return;
    const btn = document.createElement("button");
    btn.id = "bind-open";
    btn.textContent = "注入记忆库";
    btn.title = reason;
    btn.style.cssText = [
      "position:fixed", "right:22px", "bottom:22px", "z-index:9000",
      "padding:10px 16px", "border-radius:10px", "cursor:pointer",
      "font:13px/1 system-ui,sans-serif", "letter-spacing:.02em",
      "color:#d8e3dc", "background:rgba(155,196,177,.16)",
      "border:1px solid rgba(155,196,177,.35)",
      "box-shadow:0 8px 24px rgba(0,0,0,.35)", "backdrop-filter:blur(4px)",
    ].join(";");
    btn.onclick = () => showBindPanel(reason, localFile);
    document.body.appendChild(btn);
  }

  function showBindPanel(reason, localFile) {
    if (document.getElementById("bind-panel")) return;
    const style = document.createElement("style");
    style.textContent = `
#bind-panel{position:fixed;right:22px;bottom:74px;z-index:9001;width:min(480px,92vw);
  font:14px/1.6 system-ui,sans-serif;color:#d8e3dc}
#bind-box{padding:22px 22px 18px;border:1px solid rgba(155,196,177,.24);border-radius:14px;
  background:rgba(18,24,22,.96);box-shadow:0 20px 50px rgba(0,0,0,.5);position:relative;overflow:hidden}
#bind-close{position:absolute;top:10px;right:12px;width:24px;height:24px;border:none;cursor:pointer;
  background:transparent;color:#8fa89b;font-size:18px;line-height:1;border-radius:6px}
#bind-close:hover{background:rgba(155,196,177,.12);color:#d8e3dc}
#bind-box h2{margin:0 0 6px;font-size:15px;font-weight:600;padding-right:24px}
#bind-box p{margin:0 0 14px;color:#8fa89b;font-size:12px}
#bind-input{width:100%;box-sizing:border-box;padding:10px 11px;border-radius:8px;font-size:12.5px;
  border:1px solid rgba(155,196,177,.22);background:rgba(0,0,0,.28);color:#e6efe9;outline:none}
#bind-input:focus{border-color:rgba(155,196,177,.55)}
#bind-row{display:flex;gap:9px;margin-top:11px;align-items:center;flex-wrap:wrap}
#bind-scan,#bind-go{padding:8px 14px;border-radius:8px;border:1px solid rgba(155,196,177,.3);
  background:rgba(155,196,177,.1);color:#d8e3dc;cursor:pointer;font-size:12.5px}
#bind-go{background:rgba(155,196,177,.22);border-color:rgba(155,196,177,.5)}
#bind-scan:disabled,#bind-go:disabled{opacity:.4;cursor:default}
#bind-msg{font-size:11.5px;color:#9db3a6;min-height:16px;flex:1 1 100%}
#bind-track{margin-top:12px;height:3px;border-radius:2px;background:rgba(155,196,177,.14);overflow:hidden;opacity:0;transition:opacity .25s}
#bind-track.on{opacity:1}
#bind-fill{height:100%;width:0;border-radius:2px;
  background:linear-gradient(90deg,rgba(155,196,177,.5),rgba(200,240,220,.95));
  box-shadow:0 0 12px rgba(180,230,205,.7);transition:width .3s ease-out}
#bind-stars{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.bind-star{position:absolute;width:3px;height:3px;border-radius:50%;background:#c8f0dc;opacity:0;
  animation:bindFloat 1.6s ease-out forwards}
@keyframes bindFloat{0%{opacity:0;transform:translateY(0) scale(.4)}20%{opacity:.9}
  100%{opacity:0;transform:translateY(-70px) scale(1.1)}}
#bind-box.done{border-color:rgba(180,240,210,.6);box-shadow:0 0 40px rgba(150,220,190,.25),0 20px 50px rgba(0,0,0,.5)}
`;
    document.head.appendChild(style);

    const panel = document.createElement("div");
    panel.id = "bind-panel";
    panel.innerHTML = `
      <div id="bind-box">
        <button id="bind-close" title="关闭">×</button>
        <div id="bind-stars"></div>
        <h2>注入记忆库</h2>
        <p>${reason ? `${reason}。` : ""}${localFile ? "面板地址一般是 http://127.0.0.1:6185/api/plugin/page/starmap/" : "把 congling.db 的完整路径粘进来，扫描确认后点注入。"}</p>
        <input id="bind-input" placeholder="E:\\...\\plugin_data\\astrbot_plugin_congling\\congling.db" spellcheck="false" />
        <div id="bind-row">
          <button id="bind-scan">扫描</button>
          <button id="bind-go" disabled>注入</button>
          <span id="bind-msg"></span>
        </div>
        <div id="bind-track"><div id="bind-fill"></div></div>
      </div>`;
    document.body.appendChild(panel);

    const closeBtn = panel.querySelector("#bind-close");
    if (closeBtn) {
      closeBtn.onclick = () => {
        panel.remove();
        const open = document.getElementById("bind-open");
        if (open) open.style.display = "";
      };
    }
    const open = document.getElementById("bind-open");
    if (open) open.style.display = "none";

    const input = panel.querySelector("#bind-input");
    const scanBtn = panel.querySelector("#bind-scan");
    const goBtn = panel.querySelector("#bind-go");
    const msg = panel.querySelector("#bind-msg");
    const track = panel.querySelector("#bind-track");
    const fill = panel.querySelector("#bind-fill");
    const stars = panel.querySelector("#bind-stars");
    const box = panel.querySelector("#bind-box");
    let bound = null;

    const postJson = async (path, payloadObj) => {
      let last = "";
      for (const base of BASES) {
        const url = `${base}/${path}`;
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payloadObj),
          });
          if (!res.ok) {
            last = `${url} → HTTP ${res.status}`;
            continue;
          }
          const body = await res.json();
          if (body && body.status === "error") {
            last = `${url} → ${body.message || "接口报错"}`;
            continue;
          }
          return { ok: true, data: (body && body.data) || body };
        } catch (err) {
          last = `${url} → ${err && err.message ? err.message : err}`;
        }
      }
      return { ok: false, error: last };
    };

    scanBtn.onclick = async () => {
      const path = input.value.trim();
      if (!path) {
        msg.textContent = "先粘一个路径";
        return;
      }
      scanBtn.disabled = true;
      msg.textContent = "扫描中…";
      try {
        const r = await postJson("scan", { path });
        if (!r.ok) {
          bound = null;
          goBtn.disabled = true;
          msg.textContent = r.error || "扫描失败";
        } else {
          bound = r.data;
          goBtn.disabled = false;
          msg.textContent = `找到 ${bound.count} 条记忆 · ${bound.sessions} 个会话`;
        }
      } finally {
        scanBtn.disabled = false;
      }
    };

    const burst = () => {
      for (let i = 0; i < 18; i++) {
        const s = document.createElement("span");
        s.className = "bind-star";
        s.style.left = `${10 + Math.random() * 80}%`;
        s.style.top = `${40 + Math.random() * 30}%`;
        s.style.animationDelay = `${Math.random() * 0.35}s`;
        stars.appendChild(s);
        setTimeout(() => s.remove(), 2200);
      }
    };

    goBtn.onclick = async () => {
      if (!bound) return;
      goBtn.disabled = true;
      scanBtn.disabled = true;
      track.classList.add("on");
      let pct = 0;
      fill.style.width = "0%";
      const timer = setInterval(() => {
        pct += Math.max(0.6, (88 - pct) * 0.08);
        if (pct > 88) pct = 88;
        fill.style.width = `${pct.toFixed(1)}%`;
      }, 90);
      msg.textContent = "正在读取记忆…";
      try {
        const r = await postJson("bind", { path: input.value.trim() });
        clearInterval(timer);
        if (!r.ok) throw new Error(r.error || "注入失败");
        fill.style.width = "100%";
        box.classList.add("done");
        burst();
        msg.textContent = `注入成功：${r.data.count} 条记忆，正在重启星图…`;
        setTimeout(() => location.reload(), 1100);
      } catch (err) {
        clearInterval(timer);
        track.classList.remove("on");
        fill.style.width = "0%";
        msg.textContent = err.message || "注入失败";
        goBtn.disabled = false;
        scanBtn.disabled = false;
      }
    };
  }
})();
