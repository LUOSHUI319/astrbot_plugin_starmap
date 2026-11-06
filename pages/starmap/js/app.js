/* 纯本地 Canvas 星图；无请求、无第三方依赖。 */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const data = window.MEMORY_DATA;
  if (!data || !window.MemoryPhysics) {
    $("map-status").textContent = "本地文件缺失";
    $("empty").hidden = false;
    $("empty").querySelector("p").textContent = "请保留完整目录，并运行 node star-map/scripts/build-data.js 生成数据。";
    return;
  }
  const KINDS = {
    fact: { name: "事实", color: "#55dce9" },
    event: { name: "事件", color: "#ffb454" },
    pref: { name: "偏好", color: "#ef7bc1" },
    promise: { name: "承诺", color: "#e0ef65" },
    relation: { name: "关系", color: "#6ce4a2" },
    emotion: { name: "情绪", color: "#ff7868" }
  };
  const LEVELS = ["不可忘", "随口", "细节", "平常事实", "在意的事", "关键"];
  const RADII = [6, 2.3, 3.1, 4.0, 5.1, 6.3];
  const BRIGHT = [1, 0.44, 0.58, 0.70, 0.85, 0.98];
  // PHONG / 光：所有离屏球体共用此光源与投影，不随节点随机旋转。
  const PHONG = Object.freeze({
    key: { color: '#fff3e0', direction: [-0.55, -0.65, 0.75], intensity: 0.78, offset: 0.28 },
    ambient: { color: '#7f9bb0', intensity: 0.21 },
    fresnel: { intensity: 0.28, width: 0.85, saturation: 1.35 },
    specular: { min: 0.014, max: 0.46 },
    shadow: { opacity: 0.055, offsetX: 0.52, offsetY: 0.66 },
    bloom: { wide: 0.12, middle: 0.11 },
    depth: { k: 0.42, parallax: 0.1, tilt: 0.93, fade: 0.32, air: 0.26, background: '#0b1114' },
    strengthBands: 4, airBands: 3, atlasSize: 1024, atlasPages: 8,
    planes: 6, rasterBatch: 512, cachePadding: 64
  });
  // POST / 后期：独立于用户调校的 PHONG，全部画布常驻、仅 resize 改尺寸。
  const POST = Object.freeze({
    storageKey: 'memory-star-map.bloom', alpha: 0.56, mobileAlpha: 0.38,
    spread: 0.58, fog: '#0d151a', fogStrength: 0.48,
    farContrast: 0.13, nearContrast: 0.045
  });
  // MATERIAL / 琉璃：按最终物理像素直径直接烘焙，不把大图 mip 缩成色块。
  const MATERIAL = Object.freeze({
    diameters: [3, 4, 6, 8, 10, 12, 15, 16, 20, 24, 32, 40, 48, 64, 80, 112, 160, 224, 320],
    dimScale: 0.8, archivedScale: 0.86, dimAlpha: 0.34,
    specularPeak: 0.42, transmission: 0.19, shadow: 0.045,
    edge: '#05090c', edgeMix: 0.34
  });
  const RENDER = Object.freeze({ physicsInterval: 50, bakeBudgetMs: 1.6 });
  let savedBloom = true;
  try { savedBloom = localStorage.getItem(POST.storageKey) !== 'off'; } catch (_) { /* file: 隐私模式仍可用 */ }
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const mix = (a, b, t) => {
    const x = rgb(a), y = rgb(b);
    return '#' + x.map((v, i) => Math.round(Math.max(0, Math.min(255, v + (y[i] - v) * t))).toString(16).padStart(2, '0')).join('');
  };
  const shade = (color, factor) => mix('#000000', color, factor);
  const saturated = color => {
    const channels = rgb(color), mean = channels.reduce((a, b) => a + b, 0) / 3;
    return '#' + channels.map(v => Math.round(Math.max(0, Math.min(255, mean + (v - mean) * PHONG.fresnel.saturation))).toString(16).padStart(2, '0')).join('');
  };
  const format = n => n.toLocaleString("zh-CN");
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // 日期筛选与导出源一致使用中国时区，换电脑打开也不会改变边界。
  const day = seconds => new Date(seconds * 1000 + 8 * 3600000).toISOString().slice(0, 10);
  const dateTime = seconds => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(seconds * 1000);
  const nodes = data.atoms.filter(n => n.status === "active" || n.status === "archived").map(n => ({
    ...n, visible: true, radius: RADII[n.level] || 4, color: KINDS[n.kind]?.color || "#ddd",
    searchText: [n.text, n.session, n.subject, ...(n.tags || []), ...(n.ent || []).map(e => e.k)].join(" ").normalize("NFKC").toLowerCase(),
    day: day(n.created), neighbors: [], pinned: false,
    ox: 0, oy: 0, ovx: 0, ovy: 0, light: 0, breathing: 0
  }));
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const edges = data.edges.map(([a, b, weight, mask]) => ({ a: nodeById.get(a), b: nodeById.get(b), weight, mask })).filter(e => e.a && e.b);
  edges.forEach(e => { e.a.neighbors.push({ node: e.b, edge: e }); e.b.neighbors.push({ node: e.a, edge: e }); });
  nodes.forEach(n => n.neighbors.sort((a, b) => b.edge.weight - a.edge.weight));
  const physics = new window.MemoryPhysics(nodes, edges);
  for (const group of physics.groups) for (const n of group.nodes) {
    let hash = Math.imul(n.id ^ 0x9e3779b9, 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 16), 0xc2b2ae35) >>> 0;
    const radial2 = Math.min(0.98, ((n.x - group.x) ** 2 + (n.y - group.y) ** 2) / group.radius ** 2);
    n.z = (hash / 4294967296 * 2 - 1) * Math.sqrt(1 - radial2);
    n.depthScale = 1 / (1 + n.z * PHONG.depth.k);
    n.parallax = 1 - n.z * PHONG.depth.parallax;
    n.depthAlpha = 1 - (n.z + 1) * 0.5 * PHONG.depth.fade;
    n.airBand = Math.round((n.z + 1) * 0.5 * PHONG.airBands);
    n.plane = Math.min(PHONG.planes - 1, Math.floor((n.z + 1) * 0.5 * PHONG.planes));
    n.parallax = 1 - ((n.plane + 0.5) / PHONG.planes * 2 - 1) * PHONG.depth.parallax;
  }
  const canvas = $("map"), mainCtx = canvas.getContext("2d", { alpha: false });
  let ctx = mainCtx;
  const sceneCanvas = document.createElement('canvas'), sceneCtx = sceneCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
  const environmentCanvas = document.createElement('canvas'), environmentCtx = environmentCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
  let sceneKey = '', environmentKey = '', cacheVersion = 0;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const state = {
    kinds: new Set(Object.keys(KINDS)), levels: new Set([0, 1, 2, 3, 4, 5]),
    visible: [], visibleEdges: [], hovered: null, selected: null, related: new Set(),
    matches: [], matchSet: new Set(), query: "", searchIndex: 0,
    motion: !reduceMotion.matches, showEdges: true, bloom: savedBloom, dirty: true, width: 1, height: 1, dpr: 1,
    camera: { x: 0, y: 0, zoom: 0.4 }, flight: null, zoomFlight: null,
    inertia: { x: 0, y: 0 }, cursor: null, clock: 0, lastFrame: 0,
    focus: 0, focusTween: null, lights: new Map(), waves: new Map(),
    panel: 0, panelTween: null, pulse: null, nextPulse: 3600,
    fps: 0, frameTime: 0, rendered: 0, mobile: false, groups: []
  };
  let disposed = false;
  let searchDue = null, lastPhysics = 0, fpsStart = performance.now(), frames = 0;
  let pointer = null, pinch = null, previousFocus = null;
  const pointers = new Map();
  const pickGrid = new Map();
  const sprites = new Map();
  const starSprites = new Map();
  let atlasPages = [];
  let atlasCursor = 0, atlasGeneration = 0;
  let starCache = null, buildingStars = null, spareStars = null, starRevision = 0;
  let backdrop = null, dustLayers = [];
  const bloomHalf = document.createElement('canvas'), bloomQuarter = document.createElement('canvas'), bloomEighth = document.createElement('canvas');
  const bloomH = bloomHalf.getContext('2d', { willReadFrequently: true }), bloomQ = bloomQuarter.getContext('2d', { willReadFrequently: true }), bloomE = bloomEighth.getContext('2d', { willReadFrequently: true });
  let farStarSprite = null;
  const sessionCounts = new Map();
  nodes.forEach(n => sessionCounts.set(n.session, (sessionCounts.get(n.session) || 0) + 1));
  $("snapshot-date").textContent = day(data.exported_at).replaceAll("-", ".");
  $("snapshot-date").dateTime = new Date(data.exported_at * 1000).toISOString();
  $("snapshot-date").title = dateTime(data.exported_at) + "（中国时区）";
  $("footer-stats").textContent = `快照 ${format(data.count)} 条 · 已删除 ${data.graph.counts.deleted || 0} 条不显示`;

  function createFilters() {
    $("kind-filters").innerHTML = Object.entries(KINDS).map(([key, k]) =>
      `<label class="filter-row"><input type="checkbox" data-kind="${key}" checked aria-label="${k.name}"><span class="filter-label"><span class="swatch" style="--kind:${k.color}"></span>${k.name}</span><span class="filter-value mono" id="kind-${key}">0</span><span class="filter-percent mono" id="kind-pct-${key}">0%</span></label>`).join("");
    $("level-filters").innerHTML = LEVELS.map((name, i) =>
      `<label class="filter-row"><input type="checkbox" data-level="${i}" checked aria-label="${i} 级 ${name}"><span class="filter-label"><span class="level-sample"><span class="level-dot ${i === 0 ? "level-zero" : ""}" style="--size:${RADII[i] + 1}px;--opacity:${BRIGHT[i]}"></span></span><span><span class="mono">${i}</span> ${name}</span></span><span class="filter-value mono" id="level-${i}">0</span><span class="filter-percent mono" id="level-pct-${i}">0%</span></label>`).join("");
    const options = [...sessionCounts].sort((a, b) => b[1] - a[1]).map(([s, count]) => {
      const option = document.createElement("option"); option.value = s || "__unknown__";
      option.textContent = `${s || "未标来源"} · ${format(count)}`; return option;
    });
    $("session-select").append(...options);
    const dates = nodes.map(n => n.day).sort();
    for (const id of ["date-start", "date-end"]) {
      $(id).min = dates[0]; $(id).max = dates[dates.length - 1];
    }
    $("date-start").value = dates[0]; $("date-end").value = dates[dates.length - 1];
  }
  function projected(n) {
    return { x: n.cx + (n.x - n.cx) * n.depthScale, y: n.cy + (n.y - n.cy) * n.depthScale };
  }
  function screen(n, offsets = true) {
    const p = n.displayX === undefined || n.pinned ? projected(n) : { x: n.displayX, y: n.displayY };
    return { x: (p.x - state.camera.x * n.parallax) * state.camera.zoom + state.width / 2 + (offsets ? n.ox : 0),
      y: (p.y - state.camera.y * n.parallax) * state.camera.zoom * PHONG.depth.tilt + state.height / 2 + (offsets ? n.oy : 0) };
  }
  function world(x, y) {
    return { x: (x - state.width / 2) / state.camera.zoom + state.camera.x,
      y: (y - state.height / 2) / (state.camera.zoom * PHONG.depth.tilt) + state.camera.y };
  }
  function dirty() { state.dirty = true; }
  function flyTo(x, y, zoom, immediate = false) {
    zoom = Math.max(0.08, Math.min(4.5, zoom));
    state.zoomFlight = null; state.inertia.x = state.inertia.y = 0;
    if (immediate || !state.motion) {
      state.camera = { x, y, zoom }; state.flight = null;
    } else state.flight = { from: { ...state.camera }, to: { x, y, zoom }, start: state.clock, duration: 720 };
    dirty();
  }
  function fit(list = state.visible, immediate = false) {
    if (!list.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of list) {
      const p = projected(n), x = p.x / n.parallax, y = p.y / n.parallax;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const zoom = Math.min(1.7, Math.max(120, state.width - 130) / ((maxX - minX) * 1.07 + 90), Math.max(100, state.height - 185) / ((maxY - minY) * PHONG.depth.tilt * 1.07 + 90));
    flyTo((minX + maxX) / 2, (minY + maxY) / 2, zoom, immediate);
  }
  function zoomAt(factor, x = state.width / 2, y = state.height / 2) {
    state.flight = null;
    state.inertia.x = state.inertia.y = 0;
    const before = world(x, y), target = Math.max(0.08, Math.min(4.5, (state.zoomFlight?.to || state.camera.zoom) * factor));
    if (state.motion) state.zoomFlight = { from: state.camera.zoom, to: target, anchor: before, x, y, start: state.clock, duration: 230 };
    else {
      state.camera.zoom = target;
      state.camera.x = before.x - (x - state.width / 2) / target;
      state.camera.y = before.y - (y - state.height / 2) / (target * PHONG.depth.tilt);
    }
    dirty();
  }
  function focusNode(n) {
    const zoom = Math.max(state.camera.zoom, 1.35);
    const detailWidth = !$("detail").hidden && state.width > 600 ? $("detail").offsetWidth : 0;
    const p = projected(n);
    flyTo((p.x + detailWidth / (2 * zoom)) / n.parallax, p.y / n.parallax, zoom);
    $("focus-caption").textContent = n.session || "未标来源";
  }
  function applyFilters(refit = true) {
    const from = $("date-start").value, to = $("date-end").value, session = $("session-select").value;
    const invalid = !!(from && to && from > to);
    $("date-error").hidden = !invalid;
    for (const n of nodes) n.visible = !invalid && state.kinds.has(n.kind) && state.levels.has(n.level) &&
      (n.status === "active" || $("archived").checked) && (!from || n.day >= from) && (!to || n.day <= to) &&
      (!session || (n.session || "__unknown__") === session);
    state.visible = nodes.filter(n => n.visible).sort((a, b) => b.z - a.z || a.id - b.id);
    starRevision++; buildingStars = null; spareStars = starCache; starCache = null;
    for (const n of state.visible) { n.sprite = makeStarSprite(n); n.litSprite = n.sprite; }
    state.visibleEdges = edges.filter(e => e.a.visible && e.b.visible);
    state.pulse = null;
    state.groups = physics.groups.map(group => {
      const shown = group.nodes.filter(n => n.visible);
      const rgb = [0, 0, 0];
      for (const n of shown) for (let i = 0; i < 3; i++) rgb[i] += parseInt(n.color.slice(1 + i * 2, 3 + i * 2), 16);
      const color = '#' + rgb.map(v => Math.round(v / (shown.length || 1)).toString(16).padStart(2, '0')).join('');
      const result = { name: group.name, nodes: shown, sprite: radialSprite(color, 128), farSprite: radialSprite(mix(color, PHONG.ambient.color, 0.55), 128) };
      shown.forEach(n => { n.group = result; });
      return result;
    }).filter(group => group.nodes.length);
    $("empty").hidden = state.visible.length > 0;
    $("node-total").textContent = format(state.visible.length);
    $("edge-total").textContent = format(state.visibleEdges.length);
    $("session-total").textContent = format(new Set(state.visible.map(n => n.session)).size);
    $("visible-ratio").textContent = `${format(state.visible.length)} / ${format(nodes.length)} 可观测`;
    $("cluster-count").textContent = `${format(state.visible.length)} 条`;
    $("focus-caption").textContent = session ? (session === "__unknown__" ? "未标来源" : session) : "全部会话";
    const kinds = {}, levels = {};
    state.visible.forEach(n => { kinds[n.kind] = (kinds[n.kind] || 0) + 1; levels[n.level] = (levels[n.level] || 0) + 1; });
    for (const key of Object.keys(KINDS)) {
      $(`kind-${key}`).textContent = format(kinds[key] || 0);
      $(`kind-pct-${key}`).textContent = `${Math.round(100 * (kinds[key] || 0) / (state.visible.length || 1))}%`;
    }
    for (let i = 0; i < 6; i++) {
      $(`level-${i}`).textContent = format(levels[i] || 0);
      $(`level-pct-${i}`).textContent = `${Math.round(100 * (levels[i] || 0) / (state.visible.length || 1))}%`;
    }
    setHover(null);
    if (state.selected && !state.selected.visible) closeDetail();
    else if (state.selected) renderDetail(state.selected);
    updateHighlight();
    physics.reheat();
    runSearch(false);
    if (refit) fit();
    dirty();
  }
  function reset() {
    state.kinds = new Set(Object.keys(KINDS)); state.levels = new Set([0, 1, 2, 3, 4, 5]);
    document.querySelectorAll("[data-kind],[data-level]").forEach(el => { el.checked = true; });
    $("archived").checked = false; $("session-select").value = "";
    $("date-start").value = $("date-start").min; $("date-end").value = $("date-end").max;
    $("search").value = ""; closeDetail(); applyFilters();
  }
  function tween(from, to, duration, delay = 0) {
    return { from, to, start: state.clock + delay, duration };
  }
  function valueAt(t) {
    if (!t) return 0;
    const p = Math.max(0, Math.min(1, (state.clock - t.start) / t.duration));
    const ease = t.to < t.from ? 1 - Math.pow(1 - p, 3) : p * p * (3 - 2 * p);
    return t.from + (t.to - t.from) * ease;
  }
  function updateHighlight(clicked = false) {
    state.related.clear();
    const anchor = state.hovered || state.selected;
    const oldLights = state.lights, oldWaves = state.waves;
    state.lights = new Map(); state.waves = new Map();
    for (const [n] of oldLights) state.lights.set(n, tween(n.light, 0, 400));
    for (const [edge, wave] of oldWaves) state.waves.set(edge, { ...wave, fade: tween(wave.amount || 0, 0, 400) });
    state.focusTween = tween(state.focus, anchor ? 1 : 0, anchor ? 160 : 400);
    if (anchor) {
      state.related.add(anchor.id);
      state.lights.set(anchor, tween(anchor.light, 1, 150));
      let rank = 0;
      anchor.neighbors.forEach(({ node, edge }) => {
        if (!node.visible) return;
        const delay = ++rank * (clicked ? 40 : 50);
        state.related.add(node.id);
        state.waves.set(edge, { anchor, start: state.clock + delay, amount: 0, progress: 0 });
        state.lights.set(node, tween(node.light, 0.82, 160, delay + 100));
      });
    }
    if (!state.motion) {
      state.focus = anchor ? 1 : 0;
      state.focusTween = tween(state.focus, state.focus, 1);
      for (const [n, t] of state.lights) { n.light = t.to; t.from = t.to; t.start = state.clock; }
      for (const wave of state.waves.values()) {
        wave.amount = wave.fade ? 0 : 1; wave.progress = 1; wave.start = state.clock - 200;
        if (wave.fade) wave.fade = tween(0, 0, 1);
      }
    }
    dirty();
  }
  function setHover(n, position) {
    if (state.hovered !== n) { state.hovered = n; updateHighlight(); }
    canvas.style.cursor = n ? "pointer" : "grab";
    const tip = $("tooltip");
    if (!n || !position) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.innerHTML = `<div class="tooltip-meta"><span class="swatch" style="--kind:${n.color}"></span>${KINDS[n.kind].name} · ${LEVELS[n.level]} <span class="mono">#${n.id}</span></div><p>${escape(n.text.slice(0, 84))}${n.text.length > 84 ? "…" : ""}</p>`;
    tip.style.left = `${Math.max(8, Math.min(state.width - tip.offsetWidth - 12, position.x + 16))}px`;
    tip.style.top = `${Math.max(8, Math.min(state.height - tip.offsetHeight - 12, position.y + 18))}px`;
    $("focus-caption").textContent = n.session || "未标来源";
  }
  function reasons(e) {
    return [[1, "同会话"], [2, "共享实体 / 标签"], [4, "二元词重叠"], [8, "18 小时内"], [16, "同分类"]]
      .filter(([bit]) => e.mask & bit).map(([, label]) => label).join(" · ");
  }
  function renderDetail(n) {
    const neighbors = n.neighbors.filter(({ node }) => node.visible);
    $("detail-id").textContent = `#${n.id}`;
    $("detail-content").innerHTML = `
      <div class="detail-badges"><span class="detail-kind" style="--kind:${n.color}"><span class="swatch"></span>${KINDS[n.kind].name}</span><span>${n.level} 级 · ${LEVELS[n.level]}</span><span>${n.status === "active" ? "活跃" : "已归档"}</span></div>
      <p class="memory-text">${escape(n.text)}</p>
      <div class="detail-metrics">${[["重要度", n.importance], ["记忆强度", n.strength]].map(([label, value]) =>
        `<div><span class="metric-label">${label}</span><strong class="metric-value mono">${(value * 100).toFixed(1)}<small>%</small></strong><span class="meter"><i style="width:${Math.min(100, Math.max(0, value * 100))}%"></i></span></div>`).join("")}</div>
      <dl><dt>来源会话</dt><dd>${escape(n.session || "未标来源")}</dd><dt>创建时间 · 中国时区</dt><dd class="mono">${escape(dateTime(n.created))}</dd><dt>最近命中 · 中国时区</dt><dd class="mono">${n.last_hit ? escape(dateTime(n.last_hit)) : "尚无记录"}</dd><dt>命中次数</dt><dd class="mono">${format(n.hits || 0)} 次</dd><dt>主体</dt><dd>${escape(n.subject || "未标注")}</dd><dt>实体与标签</dt><dd class="entity-tags">${[
        ...(n.ent || []).map(e => `${e.k} · ${e.r}`), ...(n.tags || [])
      ].map(t => `<span class="entity-tag">${escape(t)}</span>`).join("") || "未标注"}</dd></dl>
      <div class="related-heading">关联记忆 <span>${neighbors.length} / ${n.neighbors.length} 条可见</span></div>
      <p class="relation-note">依据文本与元数据推断，不代表已确认关系。</p>
      ${neighbors.map(({ node: other, edge }) => `<button class="related-item" data-related="${other.id}"><span class="tooltip-meta"><span class="swatch" style="--kind:${other.color}"></span>${KINDS[other.kind].name} · ${LEVELS[other.level]}<span class="mono"> ${edge.weight.toFixed(2)}</span></span><p>${escape(other.text)}</p><small>${escape(reasons(edge))}</small></button>`).join("") || '<p class="relation-note">当前范围没有可见关联。</p>'}`;
  }
  function selectNode(n, fly = true) {
    if (!n?.visible) return;
    previousFocus = document.activeElement;
    state.selected = n; $("detail").hidden = false;
    state.panelTween = tween(state.panel, 1, 320);
    if (!state.motion) { state.panel = 1; state.panelTween = null; paintPanel(); }
    $("focus-caption").textContent = n.session || "未标来源";
    setHover(null); renderDetail(n); updateHighlight(true);
    if (fly) focusNode(n);
    $("detail-close").focus({ preventScroll: true });
  }
  function closeDetail() {
    state.selected = null;
    state.panelTween = tween(state.panel, 0, 260);
    if (!state.motion) { state.panel = 0; state.panelTween = null; paintPanel(); }
    updateHighlight();
    if (previousFocus?.isConnected && previousFocus !== document.body) previousFocus.focus({ preventScroll: true });
  }
  function paintPanel() {
    const panel = $("detail");
    panel.style.opacity = String(state.panel);
    panel.style.transform = `translateX(${(1 - state.panel) * 36}px)`;
    panel.style.pointerEvents = state.selected ? 'auto' : 'none';
    if (state.panel === 0 && !state.selected) panel.hidden = true;
  }
  function runSearch(autofly = true) {
    state.query = $("search").value.trim().normalize("NFKC").toLowerCase();
    const terms = state.query.split(/\s+/).filter(Boolean);
    state.matches = terms.length ? state.visible.filter(n => terms.every(term => n.searchText.includes(term))) : [];
    state.matchSet = new Set(state.matches.map(n => n.id)); state.searchIndex = 0;
    $("search-count").textContent = state.query ? `${format(state.matches.length)} 命中` : "";
    const results = $("search-results");
    results.hidden = !state.query || document.activeElement !== $("search");
    results.innerHTML = state.matches.length ? state.matches.slice(0, 30).map(n =>
      `<button class="search-result" data-result="${n.id}"><small>${escape(n.session || "未标来源")} · ${KINDS[n.kind].name} · ${LEVELS[n.level]}</small>${escape(n.text.slice(0, 95))}</button>`).join("") +
      (state.matches.length > 30 ? `<p class="search-empty">显示前 30 条；回车可巡览全部 ${format(state.matches.length)} 条命中。</p>` : "") :
      '<div class="search-empty">当前筛选范围没有命中，可调整左侧条件。</div>';
    if (autofly && state.matches.length) focusNode(state.matches[0]);
    dirty();
  }
  function pick(x, y) {
    // 输入发生在下一帧之前时直接检查最新位置，不额外驱动一次绘制。
    let best = null, distance = Infinity;
    if (state.dirty) {
      for (const n of state.visible) {
        const p = screen(n), d = Math.hypot(x - p.x, y - p.y);
        if (d <= Math.max(7, n.radius * state.camera.zoom * n.depthScale + 3) && d < distance) { best = n; distance = d; }
      }
      return best;
    }
    const gx = Math.floor(x / 24), gy = Math.floor(y / 24);
    const reach = Math.ceil(Math.max(7, Math.max(...RADII) * state.camera.zoom * 1.3 + 3) / 24);
    for (let a = -reach; a <= reach; a++) for (let b = -reach; b <= reach; b++) {
      const bucket = pickGrid.get(`${gx + a},${gy + b}`);
      if (!bucket) continue;
      for (const n of bucket) {
        const p = screen(n), d = Math.hypot(x - p.x, y - p.y), radius = Math.max(7, n.radius * state.camera.zoom * n.depthScale + 3);
        if (d <= radius && d < distance) { best = n; distance = d; }
      }
    }
    return best;
  }
  function radialSprite(color, size = 64) {
    const sprite = document.createElement("canvas");
    sprite.width = sprite.height = size;
    const c = sprite.getContext("2d"), r = size / 2;
    const gradient = c.createRadialGradient(r, r, 0, r, r, r);
    gradient.addColorStop(0, color); gradient.addColorStop(0.18, color + "90");
    gradient.addColorStop(0.5, color + "24"); gradient.addColorStop(1, color + "00");
    c.fillStyle = gradient; c.fillRect(0, 0, size, size);
    return sprite;
  }
  function makeSprite(kind) {
    if (!sprites.has(kind)) sprites.set(kind, radialSprite(KINDS[kind].color));
    return sprites.get(kind);
  }
  function makeStarSprite(n) {
    const strength = Math.round(Math.max(0, Math.min(1, n.strength || 0)) * PHONG.strengthBands) / PHONG.strengthBands;
    const key = `${n.kind}:${n.level}:${strength}:${n.airBand}`;
    if (starSprites.has(key)) return starSprites.get(key);
    const fog = Math.pow(n.airBand / PHONG.airBands, 1.3) * POST.fogStrength;
    const color = mix(mix(n.color, PHONG.depth.background, n.airBand / PHONG.airBands * PHONG.depth.air), POST.fog, fog);
    const sprite = { key, color, fog, strength, level: n.level, sized: new Map() };
    starSprites.set(key, sprite); return sprite;
  }
  function bakeSphere(c, material, diameter, dim) {
    const { color, fog, strength, level } = material, r = diameter / 2;
    const middle = diameter >= 16, near = diameter > 40, attenuation = dim ? 0.5 : 1;
    const edge = mix(color, MATERIAL.edge, MATERIAL.edgeMix);
    const [lx, ly] = PHONG.key.direction, length = Math.hypot(lx, ly);
    const ox = lx / length * PHONG.key.offset * r, oy = ly / length * PHONG.key.offset * r;
    if (near) {
      const shadow = c.createRadialGradient(r * 0.4, r * 0.5, r * 0.1, r * 0.4, r * 0.5, r * 1.35);
      shadow.addColorStop(0, '#000000'); shadow.addColorStop(1, '#00000000');
      c.fillStyle = shadow; c.globalAlpha = Math.min(MATERIAL.shadow, PHONG.shadow.opacity) * attenuation;
      c.save(); c.translate(r * PHONG.shadow.offsetX, r * PHONG.shadow.offsetY);
      c.rotate(0.55); c.scale(1, 0.4); c.beginPath(); c.arc(0, 0, r * 1.35, 0, Math.PI * 2); c.fill(); c.restore();
    }
    // 离轴亮面 + 冷暗面，远档也完整保留球面明暗。
    const body = c.createRadialGradient(ox, oy, 0, -ox * 0.24, -oy * 0.24, r * 1.15);
    body.addColorStop(0, mix(color, PHONG.key.color, 0.24 * PHONG.key.intensity));
    body.addColorStop(0.36, shade(color, 0.8 + strength * 0.1));
    body.addColorStop(0.7, shade(mix(color, PHONG.ambient.color, PHONG.ambient.intensity), 0.5));
    body.addColorStop(1, edge);
    c.globalAlpha = 0.88; c.fillStyle = body;
    c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.fill();
    // 透光内芯：宽而偏心，既不是白点，也不是匀色圆。
    const inner = c.createRadialGradient(ox, oy, 0, ox, oy, r * 0.85);
    const innerColor = mix(color, PHONG.key.color, 0.18);
    inner.addColorStop(0, innerColor); inner.addColorStop(0.25, innerColor + 'b0'); inner.addColorStop(1, innerColor + '00');
    c.save(); c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.clip();
    c.globalAlpha = MATERIAL.transmission * attenuation * (1 - fog * 0.5);
    c.fillStyle = inner; c.fillRect(-r, -r, diameter, diameter);
    // 0.8–1.0 半径的玻璃厚度；圆心完全透明，不把明暗压成平片。
    const limb = c.createRadialGradient(0, 0, r * 0.78, 0, 0, r);
    limb.addColorStop(0, edge + '00'); limb.addColorStop(0.25, edge + '1c'); limb.addColorStop(1, edge + '8a');
    c.globalAlpha = 1; c.fillStyle = limb; c.fillRect(-r, -r, diameter, diameter);
    // 边缘透光：玻璃球的厚度在这一圈发亮，不是描一道黑边。
    c.strokeStyle = mix(saturated(color), PHONG.key.color, 0.3);
    c.lineWidth = Math.max(0.6, r * 0.055);
    c.globalAlpha = (0.26 + strength * 0.22) * attenuation * (1 - fog);
    c.beginPath(); c.arc(0, 0, r - c.lineWidth * 0.7, 0, Math.PI * 2); c.stroke();
    if (middle) {
      const sharp = Math.max(0, ((level === 0 ? 5 : level) - 1) / 4);
      const sx = ox * 1.5, sy = oy * 1.5, sr = r * (0.21 + sharp * 0.055);
      const highlight = mix(color, PHONG.key.color, 0.6);
      const specular = c.createRadialGradient(sx, sy, 0, sx, sy, sr);
      specular.addColorStop(0, highlight); specular.addColorStop(0.2, highlight + '9c');
      specular.addColorStop(0.52, highlight + '38'); specular.addColorStop(1, highlight + '00');
      c.globalAlpha = Math.min(MATERIAL.specularPeak, PHONG.specular.min + sharp * PHONG.specular.max) * attenuation * (1 - fog);
      c.fillStyle = specular; c.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
      c.strokeStyle = mix(saturated(color), PHONG.key.color, 0.16);
      c.lineWidth = Math.min(1.15, Math.max(0.55, PHONG.fresnel.width * diameter / 40));
      c.globalAlpha = PHONG.fresnel.intensity * attenuation * (1 - fog);
      c.beginPath(); c.arc(0, 0, r - c.lineWidth, Math.PI * 0.95, Math.PI * 1.83); c.stroke();
      c.globalAlpha *= 0.2; c.beginPath(); c.arc(0, 0, r - c.lineWidth, 0.05, Math.PI * 0.8); c.stroke();
    }
    if (near) {
      // 反方向透射的小弧把内部光与暗边相连，避免像上了釉的表面。
      c.strokeStyle = color; c.lineWidth = r * 0.07; c.globalAlpha = 0.11 * attenuation;
      c.beginPath(); c.arc(-ox * 0.3, -oy * 0.3, r * 0.65, 0.2, 1.2); c.stroke();
      c.strokeStyle = MATERIAL.edge; c.lineWidth = r * 0.075; c.globalAlpha = 0.18 * attenuation;
      c.beginPath(); c.arc(0, 0, r * 0.88, Math.PI * 0.12, Math.PI * 0.8); c.stroke();
    }
    c.restore(); c.globalAlpha = 1;
  }
  function rasterSlot(sprite, diameter, dim) {
    const key = `${diameter}:${dim ? 1 : 0}`;
    let slot = sprite.sized.get(key);
    if (slot && slot.generation === slot.page.generation) return slot;
    const size = Math.ceil(diameter * 1.5) + 2, cell = size + 2, limit = PHONG.atlasSize;
    let page = atlasPages[atlasPages.length - 1];
    if (atlasPages.length === PHONG.atlasPages) page = atlasPages[atlasCursor];
    if (page && page.x + cell > limit) { page.x = 0; page.y += page.row; page.row = 0; }
    if (!page || page.y + cell > limit) {
      if (atlasPages.length >= PHONG.atlasPages) {
        atlasCursor = (atlasCursor + 1) % PHONG.atlasPages; page = atlasPages[atlasCursor];
        for (const [source, oldKey] of page.entries) source.sized.delete(oldKey);
        page.ctx.clearRect(0, 0, limit, limit); page.entries.length = 0;
        page.x = page.y = page.row = 0; page.generation = ++atlasGeneration;
      } else {
        const sheet = document.createElement('canvas'); sheet.width = sheet.height = limit;
        page = { sheet, ctx: sheet.getContext('2d', { willReadFrequently: true }), x: 0, y: 0, row: 0, generation: ++atlasGeneration, entries: [] };
        atlasPages.push(page); atlasCursor = atlasPages.length - 1;
      }
    }
    slot = { sheet: page.sheet, page, generation: page.generation, x: page.x + 1, y: page.y + 1, size };
    page.ctx.save(); page.ctx.translate(slot.x + size / 2, slot.y + size / 2);
    bakeSphere(page.ctx, sprite, diameter, dim); page.ctx.restore();
    page.x += cell; page.row = Math.max(page.row, cell);
    page.entries.push([sprite, key]); sprite.sized.set(key, slot); return slot;
  }
  function drawSphere(c, n, x, y, radius, zoom, dim = false) {
    const actual = radius * 2 * state.dpr * (dim ? MATERIAL.dimScale : 1) * (n.status === 'archived' ? MATERIAL.archivedScale : 1);
    // 档内靠近最终像素直接烘焙；远/中/近边界不跨档，只有很小的缩放误差。
    const candidates = MATERIAL.diameters.filter(d => actual < 16 ? d < 16 : actual <= 40 ? d >= 16 && d <= 40 : d > 40);
    const diameter = candidates.reduce((best, d) => Math.abs(d - actual) < Math.abs(best - actual) ? d : best);
    const slot = rasterSlot(n.sprite, diameter, dim), s = slot.size / state.dpr * actual / diameter;
    c.drawImage(slot.sheet, slot.x, slot.y, slot.size, slot.size,
      Math.round((x - s / 2) * state.dpr) / state.dpr, Math.round((y - s / 2) * state.dpr) / state.dpr, s, s);
  }
  function drawGlow(c, n, x, y, radius, zoom, gain = 1) {
    const size = radius * Math.max(4.4, 8 - zoom * 2.6);
    const alpha = c.globalAlpha;
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = alpha * PHONG.bloom.wide * (0.5 + n.strength) * gain;
    c.drawImage(makeSprite(n.kind), x - size / 2, y - size / 2, size, size);
    c.globalAlpha = alpha * PHONG.bloom.middle * (0.5 + n.strength) * gain;
    c.drawImage(makeSprite(n.kind), x - radius * 1.7, y - radius * 1.7, radius * 3.4, radius * 3.4);
    c.globalAlpha = alpha; c.globalCompositeOperation = 'source-over';
  }
  function cacheCamera() {
    if (state.flight) return { ...state.flight.to };
    if (state.zoomFlight) {
      const f = state.zoomFlight;
      return { x: f.anchor.x - (f.x - state.width / 2) / f.to,
        y: f.anchor.y - (f.y - state.height / 2) / (f.to * PHONG.depth.tilt), zoom: f.to };
    }
    return { ...state.camera };
  }
  function beginStarCache() {
    const pad = PHONG.cachePadding, width = Math.ceil((state.width + pad * 2) * state.dpr), height = Math.ceil((state.height + pad * 2) * state.dpr);
    let cache = spareStars;
    if (!cache || cache.width !== width || cache.height !== height) {
      cache = { width, height, planes: Array.from({ length: PHONG.planes }, () => {
        const body = document.createElement('canvas'), dim = document.createElement('canvas'), glow = document.createElement('canvas'), bright = document.createElement('canvas');
        body.width = dim.width = width; body.height = dim.height = height;
        glow.width = bright.width = Math.ceil(width / 2); glow.height = bright.height = Math.ceil(height / 2);
        // CPU-backed bake targets avoid a deferred multi-canvas raster/upload spike on swap.
        const options = { willReadFrequently: true };
        return { body, dim, glow, bright, c: body.getContext('2d', options), d: dim.getContext('2d', options), g: glow.getContext('2d', options), b: bright.getContext('2d', options) };
      }) };
      cache.flat = {};
      for (const name of ['body', 'dim', 'glow', 'bright']) {
        const sheet = document.createElement('canvas'), half = name === 'glow' || name === 'bright';
        sheet.width = half ? Math.ceil(width / 2) : width; sheet.height = half ? Math.ceil(height / 2) : height;
        sheet.getContext('2d', { willReadFrequently: true });
        cache.flat[name] = sheet;
      }
    }
    spareStars = null;
    for (const layer of cache.planes) for (const c of [layer.c, layer.d, layer.g, layer.b]) {
      c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, c.canvas.width, c.canvas.height);
      const ratio = c === layer.g || c === layer.b ? 0.5 : 1;
      c.setTransform(state.dpr * ratio, 0, 0, state.dpr * ratio, 0, 0);
    }
    Object.assign(cache, { camera: cacheCamera(), revision: starRevision, tick: physics.tick, time: state.clock, index: 0, positions: [] });
    buildingStars = cache;
  }
  function advanceStarCache() {
    const target = cacheCamera();
    const staleCamera = !starCache || ['x', 'y', 'zoom'].some(k => Math.abs(starCache.camera[k] - target[k]) > (k === 'zoom' ? 0.0001 : 0.3));
    if (!buildingStars && (!starCache || starCache.revision !== starRevision || staleCamera || (state.motion && physics.tick !== starCache.tick && state.clock - starCache.time > 100))) beginStarCache();
    if (!buildingStars) return;
    const cache = buildingStars, end = starCache && state.motion ? Math.min(state.visible.length, cache.index + PHONG.rasterBatch) : state.visible.length;
    const { x: cx, y: cy, zoom: z } = cache.camera, pad = PHONG.cachePadding;
    const bakeStarted = performance.now(), startIndex = cache.index;
    for (; cache.index < end; cache.index++) {
      const n = state.visible[cache.index], p = projected(n), layer = cache.planes[n.plane];
      cache.positions.push({ n, x: p.x, y: p.y, ox: n.ox, oy: n.oy });
      const x = (p.x - cx * n.parallax) * z + state.width / 2 + pad;
      const y = (p.y - cy * n.parallax) * z * PHONG.depth.tilt + state.height / 2 + pad;
      if (x < -32 || y < -32 || x > cache.width / state.dpr + 32 || y > cache.height / state.dpr + 32) continue;
      const radius = Math.max(state.mobile ? 0.65 : 0.8, n.radius * z * n.depthScale * (state.mobile ? 0.78 : 1));
      layer.c.globalAlpha = n.depthAlpha * (n.status === 'archived' ? 0.65 : 1);
      drawSphere(layer.c, n, x, y, radius, z);
      if (!state.bloom && n.level >= 3) { layer.g.globalAlpha = layer.c.globalAlpha; drawGlow(layer.g, n, x, y, radius, z); }
      if (state.bloom && n.level >= 4) {
        layer.b.globalAlpha = layer.c.globalAlpha * 0.85;
        drawSphere(layer.b, n, x, y, radius, z);
      }
      layer.d.globalAlpha = layer.c.globalAlpha * MATERIAL.dimAlpha;
      drawSphere(layer.d, n, x, y, radius, z, true);
      if (starCache && state.motion && (cache.index - startIndex + 1) % 64 === 0 && performance.now() - bakeStarted > RENDER.bakeBudgetMs) {
        cache.index++; break;
      }
    }
    if (cache.index === state.visible.length) {
      // 静止镜头只贴合并层；视差移动才贴六层，避免每帧六张全屏透明缩放。
      for (const name of ['body', 'dim', 'glow', 'bright']) {
        const c = cache.flat[name].getContext('2d'); c.clearRect(0, 0, c.canvas.width, c.canvas.height);
        if ((name === 'glow' && state.bloom) || (name === 'bright' && !state.bloom)) continue;
        c.globalCompositeOperation = name === 'glow' || name === 'bright' ? 'lighter' : 'source-over';
        for (let i = PHONG.planes - 1; i >= 0; i--) c.drawImage(cache.planes[i][name], 0, 0);
      }
      for (const p of cache.positions) { p.n.displayX = p.x; p.n.displayY = p.y; }
      cache.version = ++cacheVersion;
      spareStars = starCache; starCache = cache; buildingStars = null;
    }
  }
  function drawStarCache(target = ctx, emission = false) {
    if (!starCache) return;
    const cache = starCache, ratio = state.camera.zoom / cache.camera.zoom, pad = PHONG.cachePadding;
    const focus = state.query ? 1 : state.focus;
    const c = target; c.save();
    const stationary = ['x', 'y', 'zoom'].every(k => Math.abs(state.camera[k] - cache.camera[k]) < 0.00001);
    for (let i = stationary ? 0 : PHONG.planes - 1; i >= 0; i--) {
      const layer = stationary ? cache.flat : cache.planes[i], parallax = 1 - ((i + 0.5) / PHONG.planes * 2 - 1) * PHONG.depth.parallax;
      const x = state.width / 2 * (1 - ratio) - pad * ratio - (state.camera.x - cache.camera.x) * state.camera.zoom * parallax;
      const y = state.height / 2 * (1 - ratio) - pad * ratio - (state.camera.y - cache.camera.y) * state.camera.zoom * PHONG.depth.tilt * parallax;
      const w = cache.width / state.dpr * ratio, h = cache.height / state.dpr * ratio;
      const blit = (sheet, alpha, additive) => {
        c.globalAlpha = alpha; c.globalCompositeOperation = additive ? 'lighter' : 'source-over';
        if (stationary) {
          const half = sheet.width < cache.width, density = state.dpr * (half ? 0.5 : 1);
          c.drawImage(sheet, pad * density, pad * density, state.width * density, state.height * density, 0, 0, state.width, state.height);
        } else c.drawImage(sheet, x, y, w, h);
      };
      if (emission) { if (focus < 0.999) blit(layer.bright, 1 - focus, true); }
      else {
        if (focus < 0.999) { blit(layer.body, 1 - focus, false); if (!state.bloom) blit(layer.glow, 1 - focus, true); }
        if (focus > 0.001) blit(layer.dim, focus, false);
      }
    }
    c.restore();
  }
  function cacheEnvironment() {
    const w = Math.ceil(state.width), h = Math.ceil(state.height);
    backdrop = document.createElement('canvas'); backdrop.width = w; backdrop.height = h;
    const c = backdrop.getContext('2d');
    const g = c.createRadialGradient(w * 0.48, h * 0.45, 0, w * 0.5, h * 0.48, Math.hypot(w, h) * 0.58);
    g.addColorStop(0, '#11191c'); g.addColorStop(0.5, '#0b1114'); g.addColorStop(1, '#050709');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    farStarSprite = farStarSprite || radialSprite('#b2c6d1');
    let seed = 731;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    dustLayers = [0.035, 0.075, 0.14].map((rate, layer) => {
      const sheet = document.createElement('canvas'); sheet.width = sheet.height = 768;
      const d = sheet.getContext('2d');
      for (let i = 0; i < 230 - layer * 55; i++) {
        const x = random() * 768, y = random() * 768, r = 0.25 + random() * (layer === 2 ? 0.55 : 0.35);
        d.globalAlpha = 0.07 + random() * 0.18; d.fillStyle = i % 5 ? '#a5b5bd' : '#c4bba7';
        d.beginPath(); d.arc(x, y, r, 0, Math.PI * 2); d.fill();
      }
      return { sheet, rate };
    });
    Object.keys(KINDS).forEach(makeSprite);
  }
  function drawEnvironment() {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1; ctx.drawImage(backdrop, 0, 0, state.width, state.height);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.13;
    ctx.drawImage(farStarSprite, state.width * 0.17, state.height * 0.37, 18, 18);
    ctx.drawImage(farStarSprite, state.width * 0.84, state.height * 0.66, 13, 13);
    for (const { sheet, rate } of dustLayers) {
      const scale = 1 + (state.camera.zoom - 0.4) * rate;
      const tile = 768 * scale;
      const x = ((-state.camera.x * rate * state.camera.zoom - state.width * (scale - 1) / 2) % tile + tile) % tile - tile;
      const y = ((-state.camera.y * rate * state.camera.zoom - state.height * (scale - 1) / 2) % tile + tile) % tile - tile;
      ctx.globalAlpha = state.mobile ? 0.65 : 0.9;
      for (let a = x; a < state.width; a += tile) for (let b = y; b < state.height; b += tile) ctx.drawImage(sheet, a, b, tile, tile);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  function resizeBloom() {
    for (const [sheet, scale] of [[bloomHalf, 2], [bloomQuarter, 4], [bloomEighth, 8]]) {
      const w = Math.max(1, Math.ceil(canvas.width / scale)), h = Math.max(1, Math.ceil(canvas.height / scale));
      if (sheet.width !== w || sheet.height !== h) { sheet.width = w; sheet.height = h; }
    }
  }
  function postBloom(points, rings, now) {
    if (!state.bloom) return;
    bloomH.setTransform(1, 0, 0, 1, 0, 0); bloomH.clearRect(0, 0, bloomHalf.width, bloomHalf.height);
    bloomH.setTransform(bloomHalf.width / state.width, 0, 0, bloomHalf.height / state.height, 0, 0);
    drawStarCache(bloomH, true);
    const region = state.cursor || (state.clock < state.gravityUntil ? state.gravityRegion : null);
    if (region) {
      bloomH.save(); bloomH.beginPath(); bloomH.arc(region.x, region.y, 154, 0, Math.PI * 2); bloomH.clip();
      bloomH.clearRect(region.x - 155, region.y - 155, 310, 310); bloomH.restore();
    }
    for (const n of points) {
      const matched = state.matchSet.has(n.id), focus = n === state.hovered || n === state.selected || matched;
      const dim = (1 - state.focus * 0.78) + n.light * state.focus * 0.78;
      if ((state.query && !matched) || dim < 0.35) continue;
      const live = region && Math.hypot(n.sx - region.x, n.sy - region.y) < 190;
      if (!focus && !(n.level >= 4 && live)) continue;
      bloomH.save();
      if (!focus && live) { bloomH.beginPath(); bloomH.arc(region.x, region.y, 154, 0, Math.PI * 2); bloomH.clip(); }
      const radius = Math.max(state.mobile ? 0.65 : 0.8, n.radius * state.camera.zoom * n.depthScale * (state.mobile ? 0.78 : 1)) *
        (1 + n.breathing * 0.03 * (1 - Math.cos(now * Math.PI * 2 / 1200)));
      bloomH.globalAlpha = n.depthAlpha * dim * (n.status === 'archived' ? 0.65 : 1) * (focus && !matched ? Math.max(n.light, state.panel) : 0.85);
      bloomH.globalCompositeOperation = 'lighter';
      drawSphere(bloomH, n, n.sx, n.sy, radius, state.camera.zoom);
      drawGlow(bloomH, n, n.sx, n.sy, radius, state.camera.zoom, 1.8);
      bloomH.restore();
    }
    bloomH.globalCompositeOperation = 'lighter';
    for (const { n, radius, opacity } of rings) {
      if (n.level !== 0) continue;
      bloomH.strokeStyle = n.color; bloomH.globalAlpha = opacity * 0.9; bloomH.lineWidth = 1;
      bloomH.beginPath(); bloomH.arc(n.sx, n.sy, radius, 0, Math.PI * 2); bloomH.stroke();
    }
    if (state.showEdges) {
      for (const [edge, wave] of state.waves) {
        if (!edge.a.visible || !edge.b.visible || wave.amount < 0.002 || wave.progress <= 0 || wave.progress >= 1) continue;
        const a = wave.anchor, b = edge.a === a ? edge.b : edge.a;
        const x = a.sx + (b.sx - a.sx) * wave.progress, y = a.sy + (b.sy - a.sy) * wave.progress;
        bloomH.globalAlpha = wave.amount * 0.35; bloomH.drawImage(makeSprite(a.kind), x - 5, y - 5, 10, 10);
      }
      if (state.pulse) {
        const { edge, start, duration } = state.pulse, t = (now - start) / duration;
        const x = edge.a.sx + (edge.b.sx - edge.a.sx) * t, y = edge.a.sy + (edge.b.sy - edge.a.sy) * t;
        bloomH.globalAlpha = Math.sin(t * Math.PI) * 0.27;
        bloomH.drawImage(makeSprite(edge.a.kind), x - 4, y - 4, 8, 8);
      }
    }
    bloomH.globalAlpha = 0.13;
    bloomH.drawImage(farStarSprite, state.width * 0.17, state.height * 0.37, 18, 18);
    bloomH.drawImage(farStarSprite, state.width * 0.84, state.height * 0.66, 13, 13);
    bloomH.globalCompositeOperation = 'source-over'; bloomH.globalAlpha = 1;
    bloomQ.clearRect(0, 0, bloomQuarter.width, bloomQuarter.height);
    bloomQ.globalAlpha = 1; bloomQ.drawImage(bloomHalf, 0, 0, bloomQuarter.width, bloomQuarter.height);
    bloomE.clearRect(0, 0, bloomEighth.width, bloomEighth.height);
    bloomE.drawImage(bloomQuarter, 0, 0, bloomEighth.width, bloomEighth.height);
    bloomQ.globalAlpha = POST.spread;
    bloomQ.drawImage(bloomEighth, 0, 0, bloomQuarter.width, bloomQuarter.height);
    bloomQ.globalAlpha = 1;
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = state.mobile ? POST.mobileAlpha : POST.alpha;
    ctx.drawImage(bloomQuarter, 0, 0, state.width, state.height);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  }
  function setBloom(enabled, persist = true) {
    if (state.bloom !== enabled) {
      starRevision++; buildingStars = null; spareStars = starCache; starCache = null;
    }
    state.bloom = enabled;
    const button = $('toggle-bloom');
    button.classList.toggle('active', enabled); button.setAttribute('aria-pressed', String(enabled));
    button.title = enabled ? '关闭后期光晕' : '开启后期光晕';
    button.setAttribute('aria-label', button.title);
    if (persist) try { localStorage.setItem(POST.storageKey, enabled ? 'on' : 'off'); } catch (_) { /* 不阻止渲染 */ }
    dirty();
  }
  function render(now) {
    const profileStart = performance.now();
    const w = state.width, h = state.height, z = state.camera.zoom;
    advanceStarCache();
    const region = state.cursor || (state.clock < state.gravityUntil ? state.gravityRegion : null);
    const key = `${starCache?.version}:${state.camera.x}:${state.camera.y}:${z}:${state.focus.toFixed(4)}:${state.query}:${state.showEdges}:${state.bloom}`;
    const rebuildScene = key !== sceneKey;
    const environmentRevision = `${starCache?.version}:${state.camera.x}:${state.camera.y}:${z}:${state.query}:${state.showEdges}`;
    const rebuildEnvironment = environmentRevision !== environmentKey;
    ctx = environmentCtx;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    if (!backdrop) cacheEnvironment();
    if (rebuildEnvironment) drawEnvironment();
    const profileEnvironment = performance.now();
    const breath = 1 + 0.03 * Math.sin(now * Math.PI * 2 / 10000);
    const searching = !!state.query;
    const points = [];
    pickGrid.clear();
    for (const group of state.groups) {
      group.minX = group.minY = group.farMinX = group.farMinY = Infinity;
      group.maxX = group.maxY = group.farMaxX = group.farMaxY = -Infinity;
    }
    for (const n of state.visible) {
      const p = screen(n); n.sx = p.x; n.sy = p.y;
      const g = n.group;
      g.minX = Math.min(g.minX, p.x); g.minY = Math.min(g.minY, p.y);
      g.maxX = Math.max(g.maxX, p.x); g.maxY = Math.max(g.maxY, p.y);
      if (n.z > 0) {
        g.farMinX = Math.min(g.farMinX, p.x); g.farMinY = Math.min(g.farMinY, p.y);
        g.farMaxX = Math.max(g.farMaxX, p.x); g.farMaxY = Math.max(g.farMaxY, p.y);
      }
      if (p.x < -35 || p.y < -35 || p.x > w + 35 || p.y > h + 35) continue;
      points.push(n);
      const key = `${Math.floor(p.x / 24)},${Math.floor(p.y / 24)}`;
      if (!pickGrid.has(key)) pickGrid.set(key, []);
      pickGrid.get(key).push(n);
    }
    ctx.globalCompositeOperation = 'lighter';
    if (rebuildEnvironment) for (const g of state.groups) {
      if (g.nodes.length < 8) continue;
      if (Number.isFinite(g.farMinX)) {
        const fw = Math.max(60, g.farMaxX - g.farMinX + 110 * z) * 1.65, fh = Math.max(50, g.farMaxY - g.farMinY + 110 * z) * 1.65;
        ctx.globalAlpha = 0.026;
        ctx.drawImage(g.farSprite, (g.farMinX + g.farMaxX - fw) / 2, (g.farMinY + g.farMaxY - fh) / 2, fw, fh);
      }
      const gw = Math.max(55, g.maxX - g.minX + 85 * z), gh = Math.max(45, g.maxY - g.minY + 85 * z);
      ctx.globalAlpha = 0.05;
      ctx.drawImage(g.sprite, (g.minX + g.maxX - gw * 1.35) / 2, (g.minY + g.maxY - gh * 1.35) / 2, gw * 1.35, gh * 1.35);
    }
    ctx.globalCompositeOperation = 'source-over';
    const profileFog = performance.now();
    if (rebuildEnvironment && state.showEdges) {
      ctx.lineWidth = 0.55; ctx.strokeStyle = "#a6b2a1";
      ctx.globalAlpha = searching ? 0.025 : 0.045;
      ctx.beginPath();
      for (const e of state.visibleEdges) {
        const a = e.a, b = e.b;
        if ((a.sx < 0 && b.sx < 0) || (a.sx > w && b.sx > w) || (a.sy < 0 && b.sy < 0) || (a.sy > h && b.sy > h)) continue;
        ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy);
      }
      ctx.stroke();
    }
    environmentKey = environmentRevision;
    const profileEdges = performance.now();
    ctx = sceneCtx;
    if (rebuildScene) {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(environmentCanvas, 0, 0);
      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
      drawStarCache(); sceneKey = key;
    }
    ctx = mainCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(sceneCanvas, 0, 0);
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    if (region) {
      // 只擦除光标附近 308px 区域；不为每一颗球或整幅星层建立裁剪蒙版。
      const left = Math.max(0, region.x - 155), top = Math.max(0, region.y - 155);
      const width = Math.min(state.width, region.x + 155) - left, height = Math.min(state.height, region.y + 155) - top;
      ctx.save(); ctx.beginPath(); ctx.arc(region.x, region.y, 154, 0, Math.PI * 2); ctx.clip();
      if (width > 0 && height > 0) ctx.drawImage(environmentCanvas, left * state.dpr, top * state.dpr, width * state.dpr, height * state.dpr, left, top, width, height);
      ctx.restore();
    }
    if (state.showEdges) {
      for (const [edge, wave] of state.waves) {
        if (!edge.a.visible || !edge.b.visible || wave.amount < 0.002) continue;
        const a = wave.anchor, b = edge.a === a ? edge.b : edge.a;
        ctx.strokeStyle = a.color; ctx.globalAlpha = wave.amount * 0.32; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(a.sx + (b.sx - a.sx) * wave.progress, a.sy + (b.sy - a.sy) * wave.progress); ctx.stroke();
        if (wave.progress > 0 && wave.progress < 1) {
          const x = a.sx + (b.sx - a.sx) * wave.progress, y = a.sy + (b.sy - a.sy) * wave.progress;
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = wave.amount * 0.35; ctx.drawImage(makeSprite(a.kind), x - 5, y - 5, 10, 10);
          ctx.globalCompositeOperation = 'source-over';
        }
      }
      if (state.pulse) {
        const { edge, start, duration } = state.pulse, t = (now - start) / duration;
        const x = edge.a.sx + (edge.b.sx - edge.a.sx) * t, y = edge.a.sy + (edge.b.sy - edge.a.sy) * t;
        ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = Math.sin(t * Math.PI) * 0.27;
        ctx.drawImage(makeSprite(edge.a.kind), x - 4, y - 4, 8, 8);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    const rings = [];
    const profileCached = performance.now();
    const localSpheres = [];
    for (const n of points) {
      const matched = state.matchSet.has(n.id);
      const dim = (1 - state.focus * 0.78) + n.light * state.focus * 0.78;
      const searchDim = searching && !matched ? 0.18 : 1;
      const hoverScale = 1 + n.breathing * 0.03 * (1 - Math.cos(now * Math.PI * 2 / 1200));
      const radius = Math.max(state.mobile ? 0.65 : 0.8, n.radius * z * n.depthScale * (state.mobile ? 0.78 : 1)) * hoverScale;
      const alpha = BRIGHT[n.level] * dim * searchDim * n.depthAlpha * (n.status === "archived" ? 0.55 : 0.85);
      const live = region && Math.hypot(n.sx - region.x, n.sy - region.y) < 190;
      // 压暗仍是同一材质的 dim 球，不存在纯色圆片 / 细沙替代路径。
      if (searchDim < 0.6 || dim < 0.35) {
        if (live) {
          localSpheres.push({ n, radius, dimmed: true, alpha: n.depthAlpha * MATERIAL.dimAlpha * (n.status === 'archived' ? 0.65 : 1) });
        }
        continue;
      }
      if (live || n.light > 0.001 || matched || n.pinned) {
        const highlighted = n.light > 0.001 || matched;
        const opacity = n.depthAlpha * (n.status === 'archived' ? 0.65 : 1) *
          (live || matched || n.pinned ? dim * searchDim : n.light * state.focus);
        if (live && !highlighted) localSpheres.push({ n, radius, dimmed: false, alpha: opacity });
        else {
          ctx.globalAlpha = opacity;
          drawSphere(ctx, n, n.sx, n.sy, radius, z);
          if (!state.bloom && (n.level >= 3 || highlighted)) drawGlow(ctx, n, n.sx, n.sy, radius, z);
        }
      }
      if (n.level === 0 || n.light > 0.01 || matched) {
        rings.push({ n, radius: radius + (n.light > 0.01 || matched ? 4 : 2.5) * (state.mobile ? 0.75 : 1),
          color: n.light > 0.01 || matched ? '#e0e9e5' : n.color,
          opacity: alpha * (n.level === 0 ? 0.6 : matched ? 0.75 : n.light * 0.7) });
      }
    }
    if (localSpheres.length) {
      ctx.save(); ctx.beginPath(); ctx.arc(region.x, region.y, 154, 0, Math.PI * 2); ctx.clip();
      for (const item of localSpheres) {
        ctx.globalAlpha = item.alpha;
        drawSphere(ctx, item.n, item.n.sx, item.n.sy, item.radius, z, item.dimmed);
        if (!state.bloom && !item.dimmed && item.n.level >= 3) drawGlow(ctx, item.n, item.n.sx, item.n.sy, item.radius, z);
      }
      ctx.restore();
    }
    const profileStars = performance.now();
    ctx.lineWidth = 0.65;
    for (const { n, radius, color, opacity } of rings) {
      const angle = now * 0.00022 + n.id;
      ctx.strokeStyle = color; ctx.globalAlpha = opacity; ctx.beginPath();
      if (n.light > 0.01) {
        ctx.arc(n.sx, n.sy, radius, angle, angle + Math.PI * 1.3);
        ctx.moveTo(n.sx + Math.cos(angle + Math.PI * 1.5) * radius, n.sy + Math.sin(angle + Math.PI * 1.5) * radius);
        ctx.arc(n.sx, n.sy, radius, angle + Math.PI * 1.5, angle + Math.PI * 1.85);
      } else ctx.arc(n.sx, n.sy, radius, 0, Math.PI * 2);
      ctx.stroke();
      if (n.level === 0) {
        const orbit = angle * 1.5, r = radius + 2.4;
        ctx.fillStyle = n.color; ctx.globalAlpha = opacity * 0.8; ctx.beginPath();
        ctx.arc(n.sx + Math.cos(orbit) * r, n.sy + Math.sin(orbit) * r, state.mobile ? 0.65 : 0.9, 0, Math.PI * 2); ctx.fill();
      }
    }
    const profileRings = performance.now();
    if (state.focus < 0.02 && !searching && z < 0.9 && state.visible.length > 100) {
      ctx.font = '10px "Microsoft YaHei", sans-serif';
      const occupied = [];
      for (const g of state.groups) {
        if (g.nodes.length < 14 || g.maxX - g.minX < 65 || g.maxY - g.minY < 40) continue;
        const name = g.name || '未标来源', text = `${name.length > 25 ? name.slice(0, 24) + '…' : name}  ${format(g.nodes.length)}`;
        const width = ctx.measureText(text).width + 12;
        const candidates = [{ x: (g.minX + g.maxX - width) / 2, y: g.minY - 26 }, { x: g.maxX + 14, y: (g.minY + g.maxY) / 2 }];
        for (const r of candidates) {
          r.w = width; r.h = 18;
          if (r.x < 20 || r.x + width > w - 20 || r.y < 105 || r.y > h - 95 ||
            occupied.some(o => r.x < o.x + o.w + 8 && r.x + r.w + 8 > o.x && r.y < o.y + 24 && r.y + 24 > o.y) ||
            points.some(n => n.sx > r.x - 9 && n.sx < r.x + width + 9 && n.sy > r.y - 9 && n.sy < r.y + 27)) continue;
          ctx.fillStyle = '#070c10'; ctx.globalAlpha = 0.7; ctx.fillRect(r.x, r.y, r.w, r.h);
          ctx.fillStyle = '#a5b3b8'; ctx.globalAlpha = 0.65; ctx.fillText(text, r.x + 6, r.y + 12);
          occupied.push(r); break;
        }
      }
    }
    const profileLabels = performance.now();
    postBloom(points, rings, now);
    const profileBloom = performance.now();
    // 固定雾色罩降低远景对比；近景用极淡黑罩压暗黑位，主光仍由球体 sprite 保留。
    const distant = Math.max(0, Math.min(1, (0.5 - z) / 0.42));
    const close = Math.max(0, Math.min(1, (z - 1.2) / 2));
    ctx.globalCompositeOperation = distant ? 'source-over' : 'soft-light';
    ctx.fillStyle = distant ? POST.fog : '#000000';
    ctx.globalAlpha = distant * POST.farContrast + close * POST.nearContrast; ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    // 统一亮度呼吸覆盖环境与节点，幅度仅 3%。
    ctx.fillStyle = '#000'; ctx.globalAlpha = (1.03 - breath) / 1.03; ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
    state.profile = { environment: profileEnvironment-profileStart, mappingFog: profileFog-profileEnvironment,
      edges: profileEdges-profileFog, cached:profileCached-profileEdges, stars: profileStars-profileCached, rings:profileRings-profileStars,
      labels:profileLabels-profileRings, bloom:profileBloom-profileLabels, overlay:performance.now()-profileBloom };
    state.rendered = points.length;
    $("zoom-value").textContent = `${Math.round(z * 100)}%`;
    state.dirty = false;
  }
  function animate(dt) {
    if (state.focusTween) state.focus = valueAt(state.focusTween);
    for (const [n, t] of state.lights) {
      n.light = valueAt(t);
      if (n.light < 0.001 && t.to === 0) { n.light = 0; state.lights.delete(n); }
    }
    for (const [edge, wave] of state.waves) {
      if (wave.fade) {
        wave.amount = valueAt(wave.fade);
        if (wave.amount < 0.001) state.waves.delete(edge);
      } else {
        const t = Math.max(0, state.clock - wave.start);
        wave.progress = Math.min(1, t / 140);
        wave.amount = Math.min(1, t / 150);
      }
    }
    if (state.panelTween) {
      state.panel = valueAt(state.panelTween); paintPanel();
      if (state.clock >= state.panelTween.start + state.panelTween.duration) state.panelTween = null;
    }
    // 屏幕空间弹簧不写入物理坐标；缩放不会放大 6px 引力上限。
    const step = Math.min(dt, 32) / 1000;
    for (const n of state.visible) {
      const targetBreath = n === state.hovered ? 1 : 0;
      n.breathing += (targetBreath - n.breathing) * (1 - Math.exp(-dt / (targetBreath ? 55 : 135)));
      const { x, y } = screen(n, false);
      const dx = state.cursor ? state.cursor.x - x : 0, dy = state.cursor ? state.cursor.y - y : 0;
      const distance = Math.hypot(dx, dy);
      const pull = state.cursor && !pointer && !pinch && distance > 0 && distance < 140 ? 5.1 * Math.pow(1 - distance / 140, 2) / distance : 0;
      n.ovx += ((dx * pull - n.ox) * 160 - n.ovx * 19) * step;
      n.ovy += ((dy * pull - n.oy) * 160 - n.ovy * 19) * step;
      n.ox += n.ovx * step; n.oy += n.ovy * step;
      const offset = Math.hypot(n.ox, n.oy);
      if (offset > 6) { n.ox *= 6 / offset; n.oy *= 6 / offset; }
    }
    if (state.flight) {
      const f = state.flight, t = Math.max(0, Math.min(1, (state.clock - f.start) / f.duration)), eased = 1 - Math.pow(1 - t, 3);
      for (const key of ['x', 'y', 'zoom']) state.camera[key] = f.from[key] + (f.to[key] - f.from[key]) * eased;
      if (t === 1) state.flight = null;
    } else if (state.zoomFlight) {
      const f = state.zoomFlight, t = Math.max(0, Math.min(1, (state.clock - f.start) / f.duration));
      state.camera.zoom = f.from + (f.to - f.from) * (1 - Math.pow(1 - t, 3));
      state.camera.x = f.anchor.x - (f.x - state.width / 2) / state.camera.zoom;
      state.camera.y = f.anchor.y - (f.y - state.height / 2) / (state.camera.zoom * PHONG.depth.tilt);
      if (t === 1) state.zoomFlight = null;
    } else if (!pointer && !pinch) {
      const v = state.inertia, decay = Math.exp(-dt / 180);
      state.camera.x -= v.x * 180 * (1 - decay) / state.camera.zoom;
      state.camera.y -= v.y * 180 * (1 - decay) / (state.camera.zoom * PHONG.depth.tilt);
      v.x *= decay; v.y *= decay;
      if (Math.hypot(v.x, v.y) < 0.008) v.x = v.y = 0;
    }
    if (state.pulse && state.clock - state.pulse.start >= state.pulse.duration) state.pulse = null;
    if (state.clock >= state.nextPulse) {
      if (state.visibleEdges.length) state.pulse = { edge: state.visibleEdges[Math.floor(Math.random() * state.visibleEdges.length)], start: state.clock, duration: 1100 };
      state.nextPulse = state.clock + 4500 + Math.random() * 3500;
    }
  }
  function frame(timestamp) {
    if (disposed) return;
    const now = timestamp;
    requestAnimationFrame(frame);
    // 动画使用真实经过时间；仅弹簧积分在 animate 中限步，慢帧不拖长淡出。
    const dt = state.lastFrame ? Math.max(0, now - state.lastFrame) : 16.67;
    state.lastFrame = now;
    if (document.hidden) { fpsStart = now; frames = 0; return; }
    const began = performance.now();
    if (searchDue !== null && performance.now() >= searchDue) { searchDue = null; runSearch(); }
    if (state.motion) { state.clock += dt; animate(dt); }
    // 物理最多 20Hz，为软件绘制留帧预算；每帧最多一步，不追赶后台积压。
    if (state.motion && now - lastPhysics >= RENDER.physicsInterval) {
      if (physics.step()) dirty();
      lastPhysics = now;
    }
    if (state.dirty || state.motion) { render(state.clock); frames++; }
    state.frameTime = state.frameTime * 0.9 + (performance.now() - began) * 0.1;
    if (now - fpsStart >= 1000) {
      state.fps = Math.round(frames * 1000 / (now - fpsStart)); frames = 0; fpsStart = now;
      $("fps").textContent = state.motion && state.fps > 0 ? `${state.fps} FPS` : "— FPS";
      $("map-status").textContent = !state.motion ? "动态已暂停" : physics.alpha >= 0.008 ? "星群舒展中" : "星群已稳定";
    }
  }
  function resize() {
    const box = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1, mobile = matchMedia('(max-width:760px)').matches;
    // ResizeObserver 首次回调及 window.resize 常重复通知同一尺寸，不重复扔掉已烘焙星层。
    if (backdrop && state.width === box.width && state.height === box.height && state.dpr === dpr && state.mobile === mobile) return;
    state.width = box.width; state.height = box.height;
    state.dpr = dpr; state.mobile = mobile;
    starCache = buildingStars = spareStars = null;
    const width = Math.round(box.width * state.dpr), height = Math.round(box.height * state.dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width; canvas.height = height;
    }
    if (sceneCanvas.width !== width || sceneCanvas.height !== height) { sceneCanvas.width = width; sceneCanvas.height = height; }
    if (environmentCanvas.width !== width || environmentCanvas.height !== height) { environmentCanvas.width = width; environmentCanvas.height = height; }
    sceneKey = environmentKey = '';
    cacheEnvironment(); resizeBloom(); dirty();
  }
  function position(event) {
    const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function setMotion(enabled) {
    state.motion = enabled;
    document.body.classList.toggle('motion-paused', !enabled);
    if (!enabled) {
      buildingStars = null;
      state.flight = state.zoomFlight = null;
      state.inertia.x = state.inertia.y = 0;
      if (state.panelTween) { state.panel = state.panelTween.to; state.panelTween = null; paintPanel(); }
    }
    $("toggle-motion").classList.toggle("active", enabled);
    $("toggle-motion").setAttribute("aria-pressed", String(enabled));
    $("toggle-motion").setAttribute("aria-label", enabled ? "暂停动态" : "继续动态");
    $("toggle-motion").title = enabled ? "暂停动态" : "继续动态";
    $("toggle-motion").textContent = enabled ? "Ⅱ" : "▷";
    $("map-status").textContent = enabled ? "星群舒展中" : "动态已暂停";
    if (!enabled) $("fps").textContent = "— FPS";
    dirty();
  }
  createFilters();
  $("filters").addEventListener("change", event => {
    const el = event.target;
    if (el.dataset.kind) el.checked ? state.kinds.add(el.dataset.kind) : state.kinds.delete(el.dataset.kind);
    if (el.dataset.level !== undefined) el.checked ? state.levels.add(Number(el.dataset.level)) : state.levels.delete(Number(el.dataset.level));
    applyFilters();
  });
  $("session-select").addEventListener("change", () => applyFilters());
  $("reset").addEventListener("click", reset); $("empty-reset").addEventListener("click", reset);
  $("detail-close").addEventListener("click", closeDetail);
  $("detail-content").addEventListener("click", event => {
    const button = event.target.closest("[data-related]"); if (button) selectNode(nodeById.get(Number(button.dataset.related)), true);
  });
  $("search").addEventListener("input", () => { searchDue = performance.now() + 180; });
  $("search").addEventListener("focus", () => { if (state.query) $("search-results").hidden = false; });
  $("search").addEventListener("keydown", event => {
    if (event.key === "Enter" && $("search").value.trim().normalize("NFKC").toLowerCase() !== state.query) {
      searchDue = null; runSearch(false);
    }
    if (event.key === "Enter" && state.matches.length) {
      event.preventDefault(); selectNode(state.matches[state.searchIndex % state.matches.length], true);
      state.searchIndex = (state.searchIndex + 1) % state.matches.length;
      $("search").focus({ preventScroll: true }); $("search-results").hidden = true;
    } else if (event.key === "ArrowDown") { event.preventDefault(); $("search-results").querySelector("button")?.focus(); }
  });
  $("search-results").addEventListener("click", event => {
    const button = event.target.closest("[data-result]");
    if (button) { selectNode(nodeById.get(Number(button.dataset.result)), true); $("search-results").hidden = true; }
  });
  document.addEventListener("pointerdown", event => {
    if (!event.target.closest(".search-wrap")) $("search-results").hidden = true;
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") { $("search-results").hidden = true; closeDetail(); setHover(null); $("filters").classList.remove("open"); $("filter-toggle").setAttribute("aria-expanded", "false"); }
  });
  $("filter-toggle").addEventListener("click", () => {
    const expanded = $("filters").classList.toggle("open"); $("filter-toggle").setAttribute("aria-expanded", String(expanded));
  });
  $("toggle-edges").addEventListener("click", () => {
    state.showEdges = !state.showEdges; $("toggle-edges").classList.toggle("active", state.showEdges);
    $("toggle-edges").setAttribute("aria-pressed", String(state.showEdges)); dirty();
  });
  $("toggle-motion").addEventListener("click", () => setMotion(!state.motion));
  $("toggle-bloom").addEventListener("click", () => setBloom(!state.bloom));
  $("zoom-in").addEventListener("click", () => zoomAt(1.25));
  $("zoom-out").addEventListener("click", () => zoomAt(0.8));
  $("fit").addEventListener("click", () => fit());
  canvas.addEventListener("wheel", event => {
    event.preventDefault(); const p = position(event); zoomAt(Math.exp(-Math.max(-150, Math.min(150, event.deltaY)) * 0.002), p.x, p.y);
  }, { passive: false });
  canvas.addEventListener("keydown", event => {
    if (["+", "=", "-"].includes(event.key)) { event.preventDefault(); zoomAt(event.key === "-" ? 0.8 : 1.25); }
    if (event.key === "Home") { event.preventDefault(); fit(); }
    if (event.key.startsWith("Arrow")) {
      event.preventDefault(); state.flight = state.zoomFlight = null; state.inertia.x = state.inertia.y = 0;
      const step = 60 / state.camera.zoom;
      if (event.key === "ArrowLeft") state.camera.x -= step;
      if (event.key === "ArrowRight") state.camera.x += step;
      if (event.key === "ArrowUp") state.camera.y -= step;
      if (event.key === "ArrowDown") state.camera.y += step;
      dirty();
    }
  });
  canvas.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    const p = position(event); pointers.set(event.pointerId, p); canvas.setPointerCapture(event.pointerId);
    state.flight = state.zoomFlight = null; state.inertia.x = state.inertia.y = 0;
    state.cursor = null; $("search-results").hidden = true; canvas.focus({ preventScroll: true });
    if (pointers.size === 2) {
      if (pointer?.node) pointer.node.pinned = false;
      const [a, b] = [...pointers.values()];
      pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: state.camera.zoom, world: world((a.x + b.x) / 2, (a.y + b.y) / 2) };
      pointer = null; return;
    }
    pointer = { id: event.pointerId, start: p, previous: p, node: pick(p.x, p.y), moved: false, time: performance.now(), vx: 0, vy: 0 };
    setHover(null);
  });
  canvas.addEventListener("pointermove", event => {
    const p = position(event);
    state.cursor = event.pointerType === 'touch' ? null : p;
    if (state.cursor) { state.gravityRegion = p; state.gravityUntil = state.clock + 700; }
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, p);
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()], x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
      state.camera.zoom = Math.max(0.08, Math.min(4.5, pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.distance)));
      state.camera.x = pinch.world.x - (x - state.width / 2) / state.camera.zoom;
      state.camera.y = pinch.world.y - (y - state.height / 2) / (state.camera.zoom * PHONG.depth.tilt);
      dirty(); return;
    }
    if (!pointer) { setHover(pick(p.x, p.y), p); return; }
    if (pointer.id !== event.pointerId) return;
    if (Math.hypot(p.x - pointer.start.x, p.y - pointer.start.y) > 4) pointer.moved = true;
    if (pointer.moved) {
      if (pointer.node) {
        const n = pointer.node;
        const px = (p.x - n.ox - state.width / 2) / state.camera.zoom + state.camera.x * n.parallax;
        const py = (p.y - n.oy - state.height / 2) / (state.camera.zoom * PHONG.depth.tilt) + state.camera.y * n.parallax;
        n.x = n.cx + (px - n.cx) / n.depthScale; n.y = n.cy + (py - n.cy) / n.depthScale;
        n.displayX = px; n.displayY = py;
        pointer.node.pinned = true; physics.reheat(0.24);
      } else {
        state.camera.x -= (p.x - pointer.previous.x) / state.camera.zoom;
        state.camera.y -= (p.y - pointer.previous.y) / (state.camera.zoom * PHONG.depth.tilt);
        const dt = Math.max(8, performance.now() - pointer.time);
        pointer.vx = Math.max(-1.2, Math.min(1.2, (p.x - pointer.previous.x) / dt));
        pointer.vy = Math.max(-1.2, Math.min(1.2, (p.y - pointer.previous.y) / dt));
      }
      dirty();
    }
    pointer.previous = p; pointer.time = performance.now();
  });
  function release(event) {
    const cancelled = event.type !== "pointerup";
    pointers.delete(event.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; pointer = null; }
    if (pointer?.id === event.pointerId) {
      if (pointer.node) {
        pointer.node.pinned = false;
        if (pointer.moved) starRevision++;
        if (!pointer.moved && !cancelled) selectNode(pointer.node);
      } else if (!pointer.moved && !cancelled) closeDetail();
      else if (!cancelled && state.motion && performance.now() - pointer.time < 90) {
        state.inertia.x = pointer.vx; state.inertia.y = pointer.vy;
      }
      pointer = null;
    }
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    dirty();
  }
  canvas.addEventListener("pointerup", release); canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("lostpointercapture", release);
  canvas.addEventListener("pointerleave", () => { state.cursor = null; if (!pointer) setHover(null); });
  const observer = new ResizeObserver(resize); observer.observe(canvas);
  window.addEventListener("resize", resize);
  window.addEventListener("pagehide", () => { disposed = true; observer.disconnect(); });
  reduceMotion.addEventListener("change", event => setMotion(!event.matches));
  resize(); applyFilters(false); fit(state.visible, true); setMotion(state.motion); setBloom(state.bloom, false);
  // 减少动态偏好下做少量初始化收敛，之后保持静止；仍允许手动拖拽。
  if (reduceMotion.matches) { for (let i = 0; i < 12; i++) physics.step(); fit(state.visible, true); }
  render(0);
  // 首次同步加载/烘焙是启动耗时；FPS 从首幅完整画面之后开始计实际动画帧。
  fpsStart = performance.now(); frames = 0;
  requestAnimationFrame(frame);
  // 只读诊断入口用于离线浏览器自检，不触发网络或改变源快照。
  window.MEMORY_APP = Object.freeze({
    // 验收时才读 atlas 像素，正常动画不做像素回读。
    inspectMaterial: () => {
      const chosen = new Map();
      for (const material of starSprites.values()) for (const [key, slot] of material.sized) {
        if (slot.generation !== slot.page.generation) continue;
        const [diameter, dim] = key.split(':').map(Number);
        const tier = diameter < 16 ? 'far' : diameter <= 40 ? 'middle' : 'near', group = `${tier}:${dim}`;
        if (diameter < 6 || chosen.has(group)) continue;
        const center = slot.size / 2, radius = diameter / 2;
        const samples = [-0.65, -0.3, 0, 0.3, 0.65].map(t => {
          const pixels = slot.page.ctx.getImageData(Math.floor(slot.x + center + t * radius * 0.7), Math.floor(slot.y + center + t * radius * 0.7), 1, 1).data;
          return { rgb: [...pixels].slice(0, 3), alpha: pixels[3], luminance: Math.round(pixels[0] * 0.2126 + pixels[1] * 0.7152 + pixels[2] * 0.0722) };
        });
        chosen.set(group, { tier, dim: !!dim, diameter, samples, range: Math.max(...samples.map(p => p.luminance)) - Math.min(...samples.map(p => p.luminance)) });
      }
      return [...chosen.values()];
    },
    inspect: () => ({
      ready: true, nodes: nodes.length, edges: edges.length, visibleNodes: state.visible.length,
      visibleEdges: state.visibleEdges.length, matches: state.matches.length, selected: state.selected?.id ?? null,
      hovered: state.hovered?.id ?? null, highlighted: state.related.size, camera: { ...state.camera },
      motion: state.motion, showEdges: state.showEdges, fps: state.fps, frameMs: state.frameTime,
      physicsComparisons: physics.comparisons, physicsTick: physics.tick, physicsAlpha: physics.alpha, dpr: state.dpr,
      width: state.width, height: state.height, rendered: state.rendered,
      profile: state.profile,
      projection: { ...PHONG.depth }, spriteCount: starSprites.size, atlasPages: atlasPages.length,
      bloom: state.bloom, bloomAlpha: state.mobile ? POST.mobileAlpha : POST.alpha,
      bloomBuffers: [bloomHalf, bloomQuarter, bloomEighth].map(c => [c.width, c.height]),
      canvasSize: [canvas.width, canvas.height], composite: ctx.globalCompositeOperation,
      material: { tiers: ['<16px', '16–40px', '>40px'], variants: ['normal', 'dim'], atlasLimit: PHONG.atlasPages,
        atlasEntries: atlasPages.reduce((sum, page) => sum + page.entries.length, 0), dimAlpha: MATERIAL.dimAlpha,
        tiersCached: [...new Set([...starSprites.values()].flatMap(s => [...s.sized.keys()].map(k => +k.split(':')[0] < 16 ? 'far' : +k.split(':')[0] <= 40 ? 'middle' : 'near')))] },
      depth: { min: Math.min(...nodes.map(n => n.z)), max: Math.max(...nodes.map(n => n.z)), sorted: state.visible.every((n, i) => !i || state.visible[i - 1].z >= n.z) },
      clock: state.clock, focus: state.focus, panel: state.panel,
      inertia: { ...state.inertia }, zooming: !!state.zoomFlight,
      waves: [...state.waves.values()].map(v => ({ start: v.start, progress: v.progress, amount: v.amount })),
      lights: [...state.lights].map(([n]) => ({ id: n.id, value: n.light })),
      maxOffset: Math.max(0, ...state.visible.map(n => Math.hypot(n.ox, n.oy))),
      interactiveSample: state.visible.filter(n => n.neighbors.length >= 4).slice(0, 30).map(n => ({ id: n.id, neighbors: n.neighbors.filter(v => v.node.visible).length, ...screen(n) })),
      finite: nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)),
      sample: state.visible.slice(0, 5).map(n => ({ id: n.id, ...screen(n) }))
    })
  });
})();
