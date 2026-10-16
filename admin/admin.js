/* ROYAL WATCH — басқару панелі. Vanilla JS, build жоқ. API: Cloudflare Worker (worker/). */
(function () {
  "use strict";

  /* ------------------------------------------------------------ helpers */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function money(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₸"; }
  var SITE_ROOT = new URL("../", location.href).href;
  var LS = { token: "rw-token", exp: "rw-exp", user: "rw-user", api: "rw-api" };
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }

  var STATUS = { in_stock: "Қоймада", on_order: "Тапсырыс бойынша", sold: "Сатылып кетті" };
  var CATS = { women: "Әйелдерге", accessory: "Аксессуар", kz: "Қазақстандық бренд" };
  var LEAD_TYPE = { buy: "Сатып алу басылды", info: "«Толығырақ» басылды", callback: "Кері қоңырау", order: "Тапсырыс" };
  var SPEC_PRESETS = [
    ["Корпус", "Корпус"], ["Механизм", "Механизм"], ["Бау / білезік", "Ремешок / браслет"], ["Әйнек", "Стекло"],
    ["Суға төзімділік", "Водонепроницаемость"], ["Диаметрі", "Диаметр"], ["Жағдайы", "Состояние"], ["Жиынтығы", "Комплектация"]
  ];

  var S = {
    api: "", token: null, user: null, data: null, site: null, dirty: false, ed: null,
    filter: { q: "", cat: "", status: "", active: "" }, leads: null, leadFilter: "active", leadCounts: {}, users: null, busy: false
  };

  /* ------------------------------------------------------------- ui bits */
  var toastTimer;
  function toast(msg, isErr) {
    var t = $("#toast");
    t.textContent = msg; t.classList.toggle("is-err", !!isErr); t.classList.add("is-on");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove("is-on"); }, isErr ? 6000 : 3500);
  }

  function dialog(opts) {
    return new Promise(function (resolve) {
      var m = $("#modal");
      m.innerHTML = '<div class="modal__box" role="dialog" aria-modal="true"><p class="modal__title">' + esc(opts.title) + "</p>" +
        (opts.text ? '<p class="muted" style="margin:0">' + esc(opts.text) + "</p>" : "") + (opts.html || "") +
        '<p class="err small" id="dlgErr" style="margin:10px 0 0" hidden></p>' +
        '<div class="modal__actions">' + (opts.cancel === false ? "" : '<button class="btn btn--ghost" data-dlg="0">' + esc(opts.cancel || "Бас тарту") + "</button>") +
        '<button class="btn' + (opts.danger ? " btn--danger" : "") + '" data-dlg="1">' + esc(opts.ok || "Жарайды") + "</button></div></div>";
      m.hidden = false;
      var first = $("input", m) || $('[data-dlg="1"]', m); if (first) first.focus();
      function close(v) { m.hidden = true; m.innerHTML = ""; m.onclick = null; document.removeEventListener("keydown", onKey); resolve(v); }
      function onKey(e) { if (e.key === "Escape") close(null); if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); $('[data-dlg="1"]', m).click(); } }
      document.addEventListener("keydown", onKey);
      m.onclick = function (e) {
        var b = e.target.closest("[data-dlg]");
        if (e.target === m) return close(null);
        if (!b) return;
        if (b.dataset.dlg === "0") return close(null);
        var vals = {}; $$("input", m).forEach(function (i) { vals[i.name] = i.value; });
        if (opts.validate) { var err = opts.validate(vals); if (err) { var el = $("#dlgErr", m); el.textContent = err; el.hidden = false; return; } }
        close(opts.html ? vals : true);
      };
    });
  }
  var confirmBox = function (title, text, ok, danger) { return dialog({ title: title, text: text, ok: ok || "Иә", danger: danger }); };

  /* ----------------------------------------------------------------- api */
  async function api(path, opts) {
    opts = opts || {};
    var res;
    try {
      res = await fetch(S.api + path, {
        method: opts.method || "GET",
        headers: Object.assign({}, opts.body ? { "content-type": "application/json" } : {}, S.token ? { authorization: "Bearer " + S.token } : {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
    } catch (e) { throw new Error("Серверге қосыла алмады. Интернетті тексеріңіз."); }
    var data = null; try { data = await res.json(); } catch (e) {}
    if (res.status === 401 && path !== "/api/login") { logout("Сессия аяқталды. Қайта кіріңіз."); throw new Error("Қайта кіріңіз"); }
    if (!res.ok) { var err = new Error((data && data.error) || "Қате " + res.status); err.status = res.status; throw err; }
    return data;
  }

  function logout(msg) {
    S.token = null; S.user = null; S.data = null; S.site = null; S.dirty = false; S.ed = null;
    lsSet(LS.token, null); lsSet(LS.exp, null); lsSet(LS.user, null);
    renderLogin(msg);
  }

  /* --------------------------------------------------------------- shell */
  function shell(active, inner) {
    var nav = [["products", "Тауарлар"], ["leads", "Өтінімдер"], ["site", "Сайт баптауы"]];
    if (S.user && S.user.role === "owner") nav.push(["users", "Пайдаланушылар"]);
    var newN = S.leadCounts.new || 0;
    return '<header class="top"><div class="top__row"><div class="top__brand">ROYAL WATCH<small>Басқару панелі</small></div><div class="top__spacer"></div>' +
      '<a class="btn btn--ghost btn--sm" href="' + SITE_ROOT + '" target="_blank" rel="noopener">Сайтты ашу</a>' +
      '<div class="top__user"><span>' + esc(S.user.username) + '</span><button class="btn btn--ghost btn--sm" data-act="password">Пароль</button><button class="btn btn--ghost btn--sm" data-act="logout">Шығу</button></div></div>' +
      '<nav class="nav">' + nav.map(function (n) {
        return '<a href="#/' + n[0] + '" class="' + (active === n[0] ? "is-active" : "") + '">' + n[1] + (n[0] === "leads" && newN ? ' <span class="badge">' + newN + "</span>" : "") + "</a>";
      }).join("") + "</nav></header>" + '<main class="wrap">' + inner + "</main>" + savebar();
  }

  function savebar() {
    if (!S.dirty || S.ed) return "";
    return '<div class="savebar"><div class="savebar__in"><span class="savebar__msg">Сақталмаған өзгерістер бар (реті / көрінуі)</span><span class="sp"></span>' +
      '<button class="btn btn--ghost" data-act="discard">Болдырмау</button><button class="btn" data-act="publish">Жариялау</button></div></div>';
  }

  /* --------------------------------------------------------------- login */
  function renderLogin(msg) {
    $("#app").innerHTML = '<div class="login"><form class="login__card" id="loginForm" autocomplete="on">' +
      '<div class="login__brand">ROYAL WATCH</div><div class="login__sub">Басқару панеліне кіру</div>' +
      '<label class="field"><span>Логин</span><input type="text" name="username" autocomplete="username" autocapitalize="none" required></label>' +
      '<label class="field"><span>Пароль</span><input type="password" name="password" autocomplete="current-password" required></label>' +
      '<button class="btn" style="width:100%" type="submit">Кіру</button><p class="err" id="loginErr">' + esc(msg || "") + "</p></form></div>";
    var f = $("#loginForm");
    f.username.focus();
    f.onsubmit = async function (e) {
      e.preventDefault();
      var btn = $("button", f), err = $("#loginErr"); err.textContent = ""; btn.disabled = true;
      try {
        var r = await api("/api/login", { method: "POST", body: { username: f.username.value, password: f.password.value } });
        S.token = r.token; S.user = r.user;
        lsSet(LS.token, r.token); lsSet(LS.exp, String(r.expires)); lsSet(LS.user, JSON.stringify(r.user));
        await boot();
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    };
  }

  /* ----------------------------------------------------------------- data */
  async function loadAll() {
    var d = await api("/api/data");
    S.data = clone(d.products); S.site = clone(d.site); S.dirty = false;
    refreshLeadCount();
  }
  async function refreshLeadCount() {
    try {
      var r = await api("/api/leads/count"); S.leadCounts = r.counts || {};
      var a = $('.nav a[href="#/leads"]'); if (!a) return;
      var b = $(".badge", a), n = S.leadCounts.new || 0;
      if (n && !b) { b = document.createElement("span"); b.className = "badge"; a.appendChild(b); }
      if (b) { b.textContent = n; b.hidden = !n; }
    } catch (e) {}
  }

  async function commit(message, files, deletes, expect) {
    var r = await api("/api/commit", { method: "POST", body: { message: message, files: files, deletes: deletes || [], expect: expect || {} } });
    return r;
  }

  async function publishList(message) {
    var r = await commit(message, [{ path: "data/products.json", json: S.data.data }], [], { "data/products.json": S.data.sha });
    S.data.sha = r.shas["data/products.json"]; S.dirty = false;
    return r;
  }

  function conflictDialog() {
    return dialog({ title: "Деректер басқа жерде өзгерген", text: "Біреу осы сәтте өзгеріс жасаған. Жаңа нұсқаны жүктеу керек (сіздің жасалмаған өзгерістеріңіз жоғалады).", ok: "Жаңарту", cancel: "Қалу" })
      .then(function (ok) { if (ok) return loadAll().then(function () { S.ed = null; location.hash = "#/products"; route(true); }); });
  }

  /* --------------------------------------------------------------- routes */
  function route(force) {
    if (!S.token) return;
    if (!S.data) { $("#app").innerHTML = '<div class="loading">Жүктелуде…</div>'; return; }
    var h = location.hash.replace(/^#\/?/, "") || "products";
    var parts = h.split("/");
    if (parts[0] === "product") return viewEditor(decodeURIComponent(parts[1] || ""));
    if (parts[0] === "new") return viewEditor(null, parts[1] === "dup" ? decodeURIComponent(parts[2] || "") : null);
    S.ed = null;
    if (parts[0] === "leads") return viewLeads();
    if (parts[0] === "site") return viewSite();
    if (parts[0] === "users") return viewUsers();
    return viewProducts();
  }

  /* ------------------------------------------------------------ products */
  function viewProducts() {
    var list = S.data.data.products, f = S.filter;
    var brands = Array.from(new Set(list.map(function (p) { return p.brand; }))).sort();
    var q = f.q.trim().toLowerCase();
    var shown = list.filter(function (p) {
      if (q && (p.brand + " " + p.name.kk + " " + p.name.ru + " " + p.variant + " " + p.sku + " " + p.id).toLowerCase().indexOf(q) === -1) return false;
      if (f.cat === "watch" && (p.cats || []).indexOf("accessory") !== -1) return false;
      if (f.cat && f.cat !== "watch" && (p.cats || []).indexOf(f.cat) === -1) return false;
      if (f.status && p.status !== f.status) return false;
      if (f.active === "on" && p.active === false) return false;
      if (f.active === "off" && p.active !== false) return false;
      if (f.brand && p.brand !== f.brand) return false;
      return true;
    });
    var filtered = shown.length !== list.length;
    var rows = shown.map(function (p) {
      var i = list.indexOf(p);
      var price = p.priceOnRequest || !p.price ? '<span>Баға сұраңыз</span>' : (p.promo && p.promo < p.price ? '<span><s>' + money(p.price) + "</s> " + money(p.promo) + "</span>" : "<span>" + money(p.price) + "</span>");
      var st = '<span class="tag ' + (p.status === "sold" ? "tag--bad" : p.status === "on_order" ? "tag--warn" : "tag--ok") + '">' + STATUS[p.status] + "</span>";
      var cats = (p.cats || []).map(function (c) { return '<span class="tag">' + CATS[c] + "</span>"; }).join(" ");
      return '<div class="prow' + (p.active === false ? " is-off" : "") + '" data-id="' + esc(p.id) + '">' +
        '<img class="prow__img" loading="lazy" alt="" src="' + esc(imgUrl(p.images[0])) + '" onerror="this.style.visibility=\'hidden\'">' +
        '<div class="prow__main"><div class="prow__brand">' + esc(p.brand) + '</div><div class="prow__name">' + esc(p.name.kk) + (p.variant ? ", " + esc(p.variant) : "") + "</div>" +
        '<div class="prow__meta">' + price + st + cats + (p.sku ? "<span>" + esc(p.sku) + "</span>" : "") + "<span>" + p.images.length + " фото</span></div></div>" +
        '<div class="prow__act"><label class="check small" title="Сайтта көрсету"><span class="switch"><input type="checkbox" data-act="toggle" data-id="' + esc(p.id) + '"' + (p.active === false ? "" : " checked") + '><i></i></span><span>Сайтта</span></label><span class="sp"></span>' +
        '<button class="iconbtn" data-act="top" data-id="' + esc(p.id) + '" title="Ең басына" ' + (filtered || i === 0 ? "disabled" : "") + ">⤒</button>" +
        '<button class="iconbtn" data-act="up" data-id="' + esc(p.id) + '" title="Жоғары" ' + (filtered || i === 0 ? "disabled" : "") + ">▲</button>" +
        '<button class="iconbtn" data-act="down" data-id="' + esc(p.id) + '" title="Төмен" ' + (filtered || i === list.length - 1 ? "disabled" : "") + ">▼</button>" +
        '<a class="btn btn--sm" href="#/product/' + encodeURIComponent(p.id) + '">Өңдеу</a>' +
        '<a class="btn btn--ghost btn--sm" href="#/new/dup/' + encodeURIComponent(p.id) + '">Көшіру</a>' +
        '<button class="btn btn--danger btn--sm" data-act="delete" data-id="' + esc(p.id) + '">Жою</button></div></div>';
    }).join("");
    $("#app").innerHTML = shell("products",
      '<div class="toolbar"><h1 class="h1" style="margin:0">Тауарлар</h1><span class="count">' + shown.length + " / " + list.length + '</span><a class="btn" href="#/new" style="margin-left:8px">+ Жаңа тауар</a></div>' +
      '<div class="toolbar"><input class="grow" type="search" id="fq" placeholder="Іздеу: бренд, атауы, артикул…" value="' + esc(f.q) + '">' +
      '<select id="fcat"><option value="">Барлық санат</option><option value="watch"' + (f.cat === "watch" ? " selected" : "") + '>Тек сағаттар</option>' +
      Object.keys(CATS).map(function (k) { return '<option value="' + k + '"' + (f.cat === k ? " selected" : "") + ">" + CATS[k] + "</option>"; }).join("") + "</select>" +
      '<select id="fbrand"><option value="">Барлық бренд</option>' + brands.map(function (b) { return '<option' + (f.brand === b ? " selected" : "") + ">" + esc(b) + "</option>"; }).join("") + "</select>" +
      '<select id="fstatus"><option value="">Барлық мәртебе</option>' + Object.keys(STATUS).map(function (k) { return '<option value="' + k + '"' + (f.status === k ? " selected" : "") + ">" + STATUS[k] + "</option>"; }).join("") + "</select>" +
      '<select id="factive"><option value="">Көрінуі: барлығы</option><option value="on"' + (f.active === "on" ? " selected" : "") + '>Сайтта көрінеді</option><option value="off"' + (f.active === "off" ? " selected" : "") + ">Жасырын</option></select></div>" +
      (filtered ? '<p class="muted small" style="margin:-4px 0 10px">Сүзгі қосулы: реттеу батырмалары өшірілген.</p>' : "") +
      '<div class="plist">' + (rows || '<div class="empty">Ештеңе табылмады</div>') + "</div>");
  }

  function imgUrl(p) { return p ? (/^(https?:|blob:|data:)/.test(p) ? p : SITE_ROOT + p) : ""; }

  function moveProduct(id, how) {
    var list = S.data.data.products, i = list.findIndex(function (p) { return p.id === id; });
    if (i < 0) return;
    var item = list.splice(i, 1)[0];
    var j = how === "top" ? 0 : how === "up" ? Math.max(0, i - 1) : Math.min(list.length, i + 1);
    list.splice(j, 0, item); S.dirty = true; viewProducts();
  }

  function referencedElsewhere(path, exceptId) {
    return S.data.data.products.some(function (p) { return p.id !== exceptId && p.images.indexOf(path) !== -1; }) ||
      (S.site && S.site.data && S.site.data.hero && S.site.data.hero.slides || []).some(function (s) { return s && (s.desktop === path || s.mobile === path); });
  }

  async function deleteProduct(id) {
    var list = S.data.data.products, p = list.find(function (x) { return x.id === id; });
    if (!p) return;
    var ok = await confirmBox("Тауарды жою", "«" + p.brand + " " + p.name.kk + (p.variant ? ", " + p.variant : "") + "» сайттан біржола жойылады. Қайтару мүмкін емес.", "Жою", true);
    if (!ok) return;
    var deletes = p.images.filter(function (im) { return !referencedElsewhere(im, id) && /^images\/(?!categories|hero)/.test(im); });
    var prev = list.slice();
    S.data.data.products = list.filter(function (x) { return x.id !== id; });
    try {
      busy(true);
      var r = await commit("жою: " + p.brand + " " + p.name.kk, [{ path: "data/products.json", json: S.data.data }], deletes, { "data/products.json": S.data.sha });
      S.data.sha = r.shas["data/products.json"]; S.dirty = false;
      toast("Жойылды. Сайттан 1–2 минутта кетеді.");
    } catch (e) {
      S.data.data.products = prev;
      if (e.status === 409) return conflictDialog();
      toast(e.message, true);
    } finally { busy(false); route(true); }
  }

  function busy(on) { S.busy = on; document.body.style.cursor = on ? "progress" : ""; }

  /* -------------------------------------------------------------- editor */
  var RU_MAP = { а: "a", ә: "a", б: "b", в: "v", г: "g", ғ: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", қ: "k", л: "l", м: "m", н: "n", ң: "n", о: "o", ө: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ұ: "u", ү: "u", ф: "f", х: "h", һ: "h", ц: "c", ч: "ch", ш: "sh", щ: "sh", ъ: "", ы: "y", і: "i", ь: "", э: "e", ю: "yu", я: "ya" };
  function slugify(s) {
    return String(s || "").toLowerCase().replace(/[а-яёәғқңөұүһі]/g, function (c) { return RU_MAP[c] != null ? RU_MAP[c] : ""; })
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
  }
  function uniqueSlug(base, exceptId) {
    var used = {}; S.data.data.products.forEach(function (p) { if (p.id !== exceptId) { used[p.id] = 1; used[(p.seo && p.seo.slug) || p.id] = 1; } });
    var s = base || "tauar", n = s, i = 2;
    while (used[n]) n = s + "-" + i++;
    return n;
  }
  function blankProduct() {
    return { active: true, brand: "", brandRu: "", name: { kk: "", ru: "" }, variant: "", price: null, promo: null, priceOnRequest: false, status: "in_stock", cats: [], sku: "",
      tagline: { kk: "", ru: "" }, specs: [], images: [], alt: { kk: "", ru: "" }, altPlain: "", msg: { buy: { kk: "", ru: "" }, info: { kk: "", ru: "" } }, seo: { slug: "", description: { kk: "", ru: "" } } };
  }

  function viewEditor(id, dupFrom) {
    var list = S.data.data.products, src;
    if (id) {
      src = list.find(function (p) { return p.id === id; });
      if (!src) { location.hash = "#/products"; return; }
    }
    if (!S.ed || S.ed.key !== (id || ("new:" + (dupFrom || "")))) {
      var base;
      if (id) base = clone(src);
      else if (dupFrom) {
        var d = list.find(function (p) { return p.id === dupFrom; });
        base = d ? clone(d) : blankProduct();
        delete base.id; base.seo = base.seo || { slug: "", description: { kk: "", ru: "" } }; base.seo.slug = "";
        base.sku = "";
      } else base = blankProduct();
      S.ed = { key: id || ("new:" + (dupFrom || "")), id: id || null, isNew: !id, dupFrom: dupFrom || null, p: base, orig: id ? clone(src) : null,
        images: (base.images || []).map(function (path) { return { path: path }; }), specs: clone(base.specs || []), touchedRu: !!id, touchedSlug: !!id, pos: "top" };
    }
    var e = S.ed, p = e.p;
    var brands = Array.from(new Set(list.map(function (x) { return x.brand; }))).sort();
    var title = e.isNew ? (e.dupFrom ? "Көшірме: жаңа тауар" : "Жаңа тауар") : "Тауарды өңдеу";
    $("#app").innerHTML = shell("products",
      '<div class="editor-head"><a class="back" href="#/products">← Тізімге</a></div><h1 class="h1">' + title + "</h1>" +
      '<form id="edForm" novalidate>' +
      '<div class="card"><p class="card__title">Негізгі мәлімет</p>' +
      '<div class="row row--2"><label class="field"><span>Бренд *</span><input type="text" name="brand" list="brandList" value="' + esc(p.brand) + '" placeholder="Мысалы: Rolex"><datalist id="brandList">' + brands.map(function (b) { return '<option value="' + esc(b) + '">'; }).join("") + '</datalist><small>Тізімнен таңдаңыз немесе жаңасын жазыңыз</small></label>' +
      '<label class="field"><span>Артикул / модель нөмірі (SKU)</span><input type="text" name="sku" value="' + esc(p.sku) + '"></label></div>' +
      '<div class="row row--2"><label class="field"><span>Атауы (қазақша) *</span><input type="text" name="nameKk" value="' + esc(p.name.kk) + '" placeholder="Мысалы: Submariner Date"></label>' +
      '<label class="field"><span>Атауы (орысша)</span><input type="text" name="nameRu" value="' + esc(p.name.ru) + '"><small>Бос қалдырсаңыз, қазақшасы қойылады</small></label></div>' +
      '<div class="row row--2"><label class="field"><span>Нұсқа / түсі</span><input type="text" name="variant" value="' + esc(p.variant) + '" placeholder="Мысалы: Black Bezel"><small>Атаудың жанында сұр түспен көрсетіледі</small></label>' +
      '<label class="field"><span>Брендтің орысша жазылуы (қажет болса)</span><input type="text" name="brandRu" value="' + esc(p.brandRu || "") + '"><small>Тек бренд екі тілде әртүрлі жазылса</small></label></div>' +
      '<div class="label" style="margin-bottom:6px">Санаттар</div><div class="checks">' + Object.keys(CATS).map(function (k) {
        return '<label class="check"><input type="checkbox" name="cat" value="' + k + '"' + ((p.cats || []).indexOf(k) !== -1 ? " checked" : "") + ">" + CATS[k] + "</label>";
      }).join("") + "</div><p class=\"muted small\" style=\"margin:6px 0 0\">Ештеңе белгіленбесе — ер адамдар сағаты болады.</p></div>" +

      '<div class="card"><p class="card__title">Баға және мәртебе</p><div class="row row--3">' +
      '<label class="field"><span>Баға (₸)</span><input type="number" inputmode="numeric" min="0" step="1" name="price" value="' + (p.price || "") + '"></label>' +
      '<label class="field"><span>Жеңілдік бағасы (₸)</span><input type="number" inputmode="numeric" min="0" step="1" name="promo" value="' + (p.promo || "") + '"><small>Міндетті емес. Негізгі бағадан төмен болуы керек</small></label>' +
      '<label class="field"><span>Мәртебе</span><select name="status">' + Object.keys(STATUS).map(function (k) { return '<option value="' + k + '"' + (p.status === k ? " selected" : "") + ">" + STATUS[k] + "</option>"; }).join("") + "</select></label></div>" +
      '<div class="checks"><label class="check"><input type="checkbox" name="priceOnRequest"' + (p.priceOnRequest || !p.price ? " checked" : "") + '>Бағасы келісімді («Баға сұраңыз»)</label>' +
      '<label class="check"><input type="checkbox" name="active"' + (p.active === false ? "" : " checked") + ">Сайтта көрсету</label></div></div>" +

      '<div class="card"><p class="card__title">Сипаттама</p>' +
      '<label class="field"><span>Қысқаша сипаттама (қазақша)</span><textarea name="taglineKk">' + esc(p.tagline.kk) + "</textarea></label>" +
      '<label class="field"><span>Қысқаша сипаттама (орысша)</span><textarea name="taglineRu">' + esc(p.tagline.ru) + "</textarea></label>" +
      '<div class="label" style="margin:4px 0 8px">Техникалық сипаттамалар</div><div id="specList"></div>' +
      '<button type="button" class="btn btn--ghost btn--sm" data-act="spec-add">+ Жол қосу</button><div class="chips" id="specChips">' +
      SPEC_PRESETS.map(function (s, i) { return '<button type="button" class="chip" data-act="spec-preset" data-i="' + i + '">+ ' + esc(s[0]) + "</button>"; }).join("") + "</div></div>" +

      '<div class="card"><p class="card__title">Суреттер</p>' +
      '<div class="drop" id="drop" tabindex="0" role="button">Суреттерді осында сүйреп әкеліңіз немесе басып таңдаңыз<br><span class="small">Бірінші сурет — басты фото. Автоматты түрде кішірейтіліп, WebP форматына айналады.</span></div>' +
      '<input type="file" id="fileInput" accept="image/*" multiple hidden><div class="thumbs" id="thumbs"></div></div>' +

      '<details class="more"><summary>SEO және WhatsApp мәтіндері</summary><div>' +
      '<label class="field"><span>URL-сілтеме (slug)</span><input type="text" name="slug" value="' + esc((p.seo && p.seo.slug) || "") + '"><small>Тікелей сілтеме: ' + esc(SITE_ROOT) + '#p-<b id="slugPreview">' + esc((p.seo && p.seo.slug) || "…") + "</b></small></label>" +
      '<div class="row row--2"><label class="field"><span>Meta сипаттама (қазақша)</span><textarea name="seoKk" style="min-height:64px">' + esc((p.seo && p.seo.description && p.seo.description.kk) || "") + '</textarea><small>Бос болса, қысқаша сипаттама алынады</small></label>' +
      '<label class="field"><span>Meta сипаттама (орысша)</span><textarea name="seoRu" style="min-height:64px">' + esc((p.seo && p.seo.description && p.seo.description.ru) || "") + "</textarea></label></div>" +
      '<div class="row row--2"><label class="field"><span>«Сатып алу» хабарламасы (қаз.)</span><textarea name="buyKk" style="min-height:64px">' + esc(p.msg.buy.kk) + "</textarea></label>" +
      '<label class="field"><span>«Сатып алу» хабарламасы (орыс.)</span><textarea name="buyRu" style="min-height:64px">' + esc(p.msg.buy.ru) + "</textarea></label>" +
      '<label class="field"><span>«Толығырақ» хабарламасы (қаз.)</span><textarea name="infoKk" style="min-height:64px">' + esc(p.msg.info.kk) + "</textarea></label>" +
      '<label class="field"><span>«Толығырақ» хабарламасы (орыс.)</span><textarea name="infoRu" style="min-height:64px">' + esc(p.msg.info.ru) + "</textarea></label></div>" +
      '<p class="muted small">WhatsApp хабарламалары бос болса, атау бойынша автоматты құрастырылады.</p></div></details>' +
      (e.isNew ? '<div class="card"><label class="field" style="margin:0"><span>Каталогтағы орны</span><select name="pos"><option value="top"' + (e.pos === "top" ? " selected" : "") + '>Тізімнің басында</option><option value="end"' + (e.pos === "end" ? " selected" : "") + '>Тізімнің соңында</option></select></label></div>' : "") +
      '<p class="err" id="edErr"></p></form>' +
      '<div class="savebar"><div class="savebar__in"><a class="btn btn--ghost" href="#/products">Бас тарту</a><span class="sp"></span>' +
      (e.isNew ? "" : '<a class="btn btn--ghost" href="' + SITE_ROOT + '#p-' + encodeURIComponent((p.seo && p.seo.slug) || p.id) + '" target="_blank" rel="noopener">Сайтта көру</a>') +
      '<button class="btn" data-act="save" id="saveBtn">Сақтау</button></div></div>');
    renderSpecs(); renderThumbs();
  }

  function renderSpecs() {
    var box = $("#specList"); if (!box) return;
    box.innerHTML = S.ed.specs.map(function (s, i) {
      return '<div class="spec-row"><input type="text" data-spec="' + i + '" data-lang="kk" placeholder="Қазақша: Корпус — болат" value="' + esc(s.kk) + '">' +
        '<input type="text" data-spec="' + i + '" data-lang="ru" placeholder="Орысша: Корпус — сталь" value="' + esc(s.ru) + '">' +
        '<span style="display:flex;gap:4px"><button type="button" class="iconbtn" data-act="spec-up" data-i="' + i + '" ' + (i === 0 ? "disabled" : "") + '>▲</button><button type="button" class="iconbtn" data-act="spec-del" data-i="' + i + '">✕</button></span></div>';
    }).join("") || '<p class="muted small" style="margin:0 0 8px">Әзірге жол жоқ.</p>';
  }

  function renderThumbs() {
    var box = $("#thumbs"); if (!box) return;
    var im = S.ed.images;
    box.innerHTML = im.map(function (x, i) {
      return '<div class="thumb' + (i === 0 ? " is-cover" : "") + '"><img alt="" src="' + esc(imgUrl(x.blobUrl || x.path)) + '" onerror="this.style.visibility=\'hidden\'">' +
        (i === 0 ? '<span class="thumb__tag">Басты</span>' : "") + (x.blobUrl ? '<span class="thumb__new">жаңа</span>' : "") +
        '<div class="thumb__bar"><button type="button" class="iconbtn" data-act="img-left" data-i="' + i + '" ' + (i === 0 ? "disabled" : "") + ' title="Алға">◀</button>' +
        '<button type="button" class="iconbtn" data-act="img-cover" data-i="' + i + '" ' + (i === 0 ? "disabled" : "") + ' title="Басты ету">★</button>' +
        '<button type="button" class="iconbtn" data-act="img-right" data-i="' + i + '" ' + (i === im.length - 1 ? "disabled" : "") + ' title="Артқа">▶</button>' +
        '<button type="button" class="iconbtn" data-act="img-del" data-i="' + i + '" title="Жою">✕</button></div></div>';
    }).join("");
  }

  /* image processing: downscale + WebP in the browser (keeps the repo light) */
  async function processImage(file, maxSide, quality) {
    var bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) { bmp = await createImageBitmap(file); }
    var s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    var w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
    var cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    var ctx = cv.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h);
    var type = "image/webp";
    var blob = await new Promise(function (r) { cv.toBlob(r, type, quality); });
    if (!blob || blob.type !== "image/webp") { type = "image/jpeg"; blob = await new Promise(function (r) { cv.toBlob(r, type, 0.88); }); }
    var b64 = await new Promise(function (resolve, reject) { var fr = new FileReader(); fr.onload = function () { resolve(String(fr.result).split(",")[1]); }; fr.onerror = reject; fr.readAsDataURL(blob); });
    return { blobUrl: URL.createObjectURL(blob), base64: b64, ext: type === "image/webp" ? "webp" : "jpg", w: w, h: h, kb: Math.round(blob.size / 1024) };
  }

  async function addFiles(files, target) {
    files = Array.prototype.slice.call(files).filter(function (f) { return /^image\//.test(f.type); });
    if (!files.length) return toast("Тек сурет файлдарын таңдаңыз", true);
    for (var i = 0; i < files.length; i++) {
      try { target.push(await processImage(files[i], 1600, 0.86)); } catch (e) { toast("Суретті оқи алмадым: " + files[i].name, true); }
    }
    renderThumbs();
  }

  function readForm() {
    var f = $("#edForm"), v = function (n) { var el = f.elements[n]; return el ? el.value.trim() : ""; };
    var num = function (n) { var x = v(n); return x === "" ? null : Number(x); };
    var cats = $$('input[name="cat"]:checked', f).map(function (c) { return c.value; });
    return {
      brand: v("brand"), brandRu: v("brandRu"), sku: v("sku"), nameKk: v("nameKk"), nameRu: v("nameRu"), variant: v("variant"), cats: cats,
      price: num("price"), promo: num("promo"), status: f.elements.status.value, priceOnRequest: f.elements.priceOnRequest.checked, active: f.elements.active.checked,
      taglineKk: v("taglineKk"), taglineRu: v("taglineRu"), slug: v("slug"), seoKk: v("seoKk"), seoRu: v("seoRu"),
      buyKk: v("buyKk"), buyRu: v("buyRu"), infoKk: v("infoKk"), infoRu: v("infoRu"), pos: f.elements.pos ? f.elements.pos.value : null
    };
  }

  async function saveProduct() {
    var e = S.ed, f = readForm(), err = $("#edErr"); err.textContent = "";
    function fail(m, field) { err.textContent = m; toast(m, true); var el = $("#edForm").elements[field]; if (el && el.focus) el.focus(); return false; }
    if (!f.brand) return fail("Брендті жазыңыз", "brand");
    if (!f.nameKk) return fail("Атауын жазыңыз", "nameKk");
    if (!f.priceOnRequest && !(f.price > 0)) return fail("Бағасын жазыңыз немесе «Баға сұраңыз» белгісін қойыңыз", "price");
    if (f.promo != null && f.price != null && f.promo >= f.price) return fail("Жеңілдік бағасы негізгі бағадан төмен болуы керек", "promo");
    if (!e.images.length) return fail("Кемінде бір сурет қосыңыз", "");
    var p = e.isNew ? blankProduct() : clone(e.orig);
    p.brand = f.brand; p.brandRu = f.brandRu; p.sku = f.sku;
    p.name = { kk: f.nameKk, ru: f.nameRu || f.nameKk }; p.variant = f.variant; p.cats = f.cats;
    p.price = f.priceOnRequest ? (f.price || null) : f.price; p.promo = f.promo; p.priceOnRequest = f.priceOnRequest || !(f.price > 0);
    p.status = f.status; p.active = f.active;
    p.tagline = { kk: f.taglineKk, ru: f.taglineRu || f.taglineKk };
    p.specs = e.specs.filter(function (s) { return (s.kk || "").trim() || (s.ru || "").trim(); }).map(function (s) { return { kk: s.kk.trim() || s.ru.trim(), ru: s.ru.trim() || s.kk.trim() }; });
    var full = p.brand + " " + p.name.kk + (p.variant ? " " + p.variant : ""), fullRu = p.brand + " " + p.name.ru + (p.variant ? " " + p.variant : "");
    // WhatsApp texts: generated when empty; when the name changed, the old full name inside them is swapped for the new one
    var prev = e.orig || (e.dupFrom && S.data.data.products.find(function (x) { return x.id === e.dupFrom; })) || null;
    var oldKk = prev ? prev.brand + " " + prev.name.kk + (prev.variant ? " " + prev.variant : "") : "";
    var oldRu = prev ? prev.brand + " " + prev.name.ru + (prev.variant ? " " + prev.variant : "") : "";
    var msgText = function (val, gen, old, neu) { return !val ? gen : (old && old !== neu && val.indexOf(old) !== -1 ? val.split(old).join(neu) : val); };
    p.msg = {
      buy: { kk: msgText(f.buyKk, "Сәлеметсіз бе! Маған " + full + " қызықты. Осы тауарды сатып алғым келеді.", oldKk, full), ru: msgText(f.buyRu, "Здравствуйте! Меня заинтересовал товар " + fullRu + ". Хочу купить.", oldRu, fullRu) },
      info: { kk: msgText(f.infoKk, "Сәлеметсіз бе! " + full + " туралы бағасы мен толық ақпаратын айтыңызшы.", oldKk, full), ru: msgText(f.infoRu, "Здравствуйте! Подскажите, пожалуйста, цену и подробнее о " + fullRu + ".", oldRu, fullRu) }
    };
    p.alt = { kk: full + ", алдыңғы көрінісі", ru: fullRu + ", вид спереди" }; p.altPlain = full;
    var slug = slugify(f.slug) || slugify(full);
    if (e.isNew) { slug = uniqueSlug(slug, null); p.id = slug; }
    else { var other = S.data.data.products.some(function (x) { return x.id !== p.id && ((x.seo && x.seo.slug) || x.id) === slug; }); if (other || !slug) return fail("Бұл slug бос емес, басқасын жазыңыз", "slug"); }
    p.seo = { slug: slug, description: { kk: f.seoKk, ru: f.seoRu } };
    // new photos get their final paths here
    var stamp = Date.now().toString(36), files = [];
    p.images = e.images.map(function (im, i) {
      if (im.path) return im.path;
      var path = "images/" + p.id + "/" + stamp + "-" + (i + 1) + "." + im.ext;
      files.push({ path: path, base64: im.base64 });
      return path;
    });
    var deletes = [];
    if (!e.isNew) e.orig.images.forEach(function (im) { if (p.images.indexOf(im) === -1 && !referencedElsewhere(im, p.id) && /^images\/(?!categories|hero)/.test(im)) deletes.push(im); });
    var list = S.data.data.products, backup = list.slice();
    if (e.isNew) {
      var at = e.dupFrom ? list.findIndex(function (x) { return x.id === e.dupFrom; }) + 1 : (f.pos === "end" ? list.length : 0);
      list.splice(at, 0, p);
    } else list[list.findIndex(function (x) { return x.id === p.id; })] = p;
    var btn = $("#saveBtn"); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Сақталуда…'; busy(true);
    try {
      var r = await commit((e.isNew ? "жаңа: " : "өзгерту: ") + full, [{ path: "data/products.json", json: S.data.data }].concat(files), deletes, { "data/products.json": S.data.sha });
      S.data.sha = r.shas["data/products.json"]; S.dirty = false; S.ed = null;
      toast("Сақталды. Сайтта 1–2 минутта көрінеді.");
      location.hash = "#/products";
    } catch (ex) {
      S.data.data.products = backup;
      btn.disabled = false; btn.textContent = "Сақтау";
      if (ex.status === 409 && /өзгерген/.test(ex.message)) return conflictDialog();
      err.textContent = ex.message; toast(ex.message, true);
    } finally { busy(false); }
  }

  /* -------------------------------------------------------- site settings */
  function viewSite() {
    var s = S.site.data || {}, c = s.contacts || {}, h = s.hero || {}, sl = h.slides || [{}, {}];
    var pair = function (o) { o = o || {}; return { kk: esc(o.kk || ""), ru: esc(o.ru || "") }; };
    var a = pair(c.address), hr = pair(c.hours), ey = pair(h.eyebrow), ds = pair(h.desc), ct = pair(h.cta && h.cta.text);
    S.siteImgs = S.siteImgs || [{}, {}];
    function slot(i, k, label, hint) {
      var cur = (S.siteImgs[i] || {})[k], path = (sl[i] || {})[k];
      var src = cur ? (cur.clear ? "" : cur.blobUrl) : (path ? imgUrl(path) : "");
      return '<div class="field"><span>' + label + '</span><div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">' +
        (src ? '<img alt="" src="' + esc(src) + '" style="height:72px;border-radius:6px;border:1px solid var(--line);background:#f1efe9">' : '<span class="muted small">Әдепкі сурет қолданылады</span>') +
        '<label class="btn btn--ghost btn--sm" style="cursor:pointer">Сурет таңдау<input type="file" accept="image/*" hidden data-site-img="' + i + ":" + k + '"></label>' +
        (src ? '<button type="button" class="btn btn--ghost btn--sm" data-act="site-img-clear" data-i="' + i + '" data-k="' + k + '">Әдепкіге қайтару</button>' : "") + '</div><small>' + hint + "</small></div>";
    }
    $("#app").innerHTML = shell("site", '<h1 class="h1">Сайт баптауы</h1><form id="siteForm" novalidate>' +
      '<div class="card"><p class="card__title">Байланыс</p><div class="row row--2">' +
      '<label class="field"><span>WhatsApp нөмірі</span><input type="text" name="whatsapp" inputmode="tel" value="' + esc(c.whatsapp || "") + '"><small>Халықаралық форматта, + мен бос орынсыз: 77081664466. Барлық «Сатып алу» батырмалары осы нөмірге жібереді.</small></label>' +
      '<label class="field"><span>Телефон (футерде көрсетіледі)</span><input type="text" name="phone" inputmode="tel" value="' + esc(c.phone || "") + '" placeholder="+7 708 166 44 66"></label>' +
      '<label class="field"><span>Instagram сілтемесі</span><input type="url" name="instagram" value="' + esc(c.instagram || "") + '" placeholder="https://instagram.com/…"></label>' +
      '<label class="field"><span>Telegram сілтемесі</span><input type="url" name="telegram" value="' + esc(c.telegram || "") + '" placeholder="https://t.me/…"></label>' +
      '<label class="field"><span>TikTok сілтемесі</span><input type="url" name="tiktok" value="' + esc(c.tiktok || "") + '"></label>' +
      '<label class="field"><span>Карта сілтемесі (2GIS / Google)</span><input type="url" name="map" value="' + esc(c.map || "") + '"></label>' +
      '<label class="field"><span>Мекенжай (қазақша)</span><input type="text" name="addrKk" value="' + a.kk + '"></label>' +
      '<label class="field"><span>Мекенжай (орысша)</span><input type="text" name="addrRu" value="' + a.ru + '"></label>' +
      '<label class="field"><span>Жұмыс уақыты (қазақша)</span><input type="text" name="hoursKk" value="' + hr.kk + '" placeholder="Күн сайын 10:00–21:00"></label>' +
      '<label class="field"><span>Жұмыс уақыты (орысша)</span><input type="text" name="hoursRu" value="' + hr.ru + '" placeholder="Ежедневно 10:00–21:00"></label></div></div>' +
      '<div class="card"><p class="card__title">Басты бет баннері</p><div class="row row--2">' +
      '<label class="field"><span>Кіші тақырып (қазақша)</span><input type="text" name="eyKk" value="' + ey.kk + '"></label>' +
      '<label class="field"><span>Кіші тақырып (орысша)</span><input type="text" name="eyRu" value="' + ey.ru + '"></label></div>' +
      '<label class="field"><span>Үлкен тақырып</span><input type="text" name="heroTitle" value="' + esc(h.title || "") + '"></label>' +
      '<div class="row row--2"><label class="field"><span>Сипаттама (қазақша)</span><textarea name="dsKk">' + ds.kk + '</textarea></label>' +
      '<label class="field"><span>Сипаттама (орысша)</span><textarea name="dsRu">' + ds.ru + '</textarea></label></div>' +
      '<div class="row row--3"><label class="field"><span>Батырма мәтіні (қазақша)</span><input type="text" name="ctKk" value="' + ct.kk + '"></label>' +
      '<label class="field"><span>Батырма мәтіні (орысша)</span><input type="text" name="ctRu" value="' + ct.ru + '"></label>' +
      '<label class="field"><span>Батырма сілтемесі</span><input type="text" name="ctLink" value="' + esc((h.cta && h.cta.link) || "") + '" placeholder="#new-arrivals"></label></div></div>' +
      '<div class="card"><p class="card__title">Баннер суреттері</p><div class="row row--2"><div>' +
      '<p class="label">1-слайд</p>' + slot(0, "desktop", "Компьютер үшін", "Ұсыныс: 2400×1200, көлденең") + slot(0, "mobile", "Телефон үшін", "Ұсыныс: 1080×1800, тік") + '</div><div>' +
      '<p class="label">2-слайд</p>' + slot(1, "desktop", "Компьютер үшін", "Ұсыныс: 2400×1200, көлденең") + slot(1, "mobile", "Телефон үшін", "Ұсыныс: 1080×1800, тік") + "</div></div></div>" +
      '<p class="err" id="siteErr"></p></form><div class="savebar"><div class="savebar__in"><span class="sp"></span><button class="btn" data-act="site-save" id="siteSave">Сақтау</button></div></div>');
  }

  async function saveSite() {
    var f = $("#siteForm"), v = function (n) { return f.elements[n].value.trim(); }, err = $("#siteErr"); err.textContent = "";
    var d = clone(S.site.data || {});
    d.contacts = { whatsapp: v("whatsapp").replace(/\D/g, ""), phone: v("phone"), instagram: v("instagram"), telegram: v("telegram"), tiktok: v("tiktok"), map: v("map"),
      address: { kk: v("addrKk"), ru: v("addrRu") }, hours: { kk: v("hoursKk"), ru: v("hoursRu") } };
    if (!d.contacts.whatsapp) { err.textContent = "WhatsApp нөмірін жазыңыз"; return toast(err.textContent, true); }
    var slides = ((d.hero && d.hero.slides) || [{}, {}]).map(function (x) { return Object.assign({ desktop: "", mobile: "" }, x); });
    var files = [], stamp = Date.now().toString(36);
    (S.siteImgs || []).forEach(function (o, i) {
      ["desktop", "mobile"].forEach(function (k) {
        var im = o && o[k]; if (!im) return;
        if (im.clear) { slides[i][k] = ""; return; }
        var path = "images/hero/" + stamp + "-" + (k === "desktop" ? "d" : "m") + (i + 1) + "." + im.ext;
        files.push({ path: path, base64: im.base64 }); slides[i][k] = path;
      });
    });
    d.hero = { eyebrow: { kk: v("eyKk"), ru: v("eyRu") }, title: v("heroTitle"), desc: { kk: v("dsKk"), ru: v("dsRu") }, cta: { text: { kk: v("ctKk"), ru: v("ctRu") }, link: v("ctLink") }, slides: slides };
    var btn = $("#siteSave"); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Сақталуда…'; busy(true);
    try {
      var r = await commit("сайт баптауы", [{ path: "data/site.json", json: d }].concat(files), [], { "data/site.json": S.site.sha });
      S.site = { sha: r.shas["data/site.json"], data: d }; S.siteImgs = [{}, {}];
      toast("Сақталды. Сайтта 1–2 минутта көрінеді."); viewSite();
    } catch (ex) {
      btn.disabled = false; btn.textContent = "Сақтау";
      if (ex.status === 409 && /өзгерген/.test(ex.message)) return conflictDialog();
      err.textContent = ex.message; toast(ex.message, true);
    } finally { busy(false); }
  }

  /* --------------------------------------------------------------- leads */
  async function viewLeads() {
    $("#app").innerHTML = shell("leads", '<div class="loading">Жүктелуде…</div>');
    try {
      var r = await api("/api/leads?status=" + S.leadFilter);
      S.leads = r.leads; S.leadCounts = r.counts || S.leadCounts;
    } catch (e) { return toast(e.message, true); }
    var tabs = [["active", "Белсенді"], ["new", "Жаңа"], ["done", "Өңделді"], ["deleted", "Жойылған"], ["all", "Барлығы"]];
    var cnt = S.leadCounts;
    $("#app").innerHTML = shell("leads", '<div class="toolbar"><h1 class="h1" style="margin:0">Өтінімдер</h1><button class="btn btn--ghost btn--sm" data-act="leads-refresh" style="margin-left:auto">Жаңарту</button></div>' +
      '<div class="toolbar">' + tabs.map(function (t) {
        return '<button class="btn btn--sm ' + (S.leadFilter === t[0] ? "" : "btn--ghost") + '" data-act="leads-tab" data-t="' + t[0] + '">' + t[1] + (cnt[t[0]] != null && t[0] !== "active" && t[0] !== "all" ? " (" + cnt[t[0]] + ")" : "") + "</button>";
      }).join("") + "</div>" +
      '<div class="plist">' + (S.leads.map(function (l) {
        var d = new Date(String(l.created).replace(" ", "T") + "Z");
        var when = isNaN(d) ? l.created : d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
        return '<div class="lead' + (l.status === "new" ? " is-new" : "") + '"><div class="lead__top"><span class="tag ' + (l.status === "new" ? "tag--warn" : l.status === "done" ? "tag--ok" : "tag--bad") + '">' + ({ new: "Жаңа", done: "Өңделді", deleted: "Жойылған" }[l.status]) + '</span><b>' + esc(LEAD_TYPE[l.type] || l.type) + '</b><span class="muted small">' + esc(when) + "</span><span class=\"tag\">" + (l.lang === "ru" ? "RU" : "KK") + "</span></div>" +
          (l.title ? '<div class="lead__title">' + esc(l.title) + (l.price ? ' <span class="muted">· ' + money(l.price) + "</span>" : "") + "</div>" : "") +
          (l.name || l.phone ? '<div>' + esc(l.name) + (l.phone ? ' · <a href="tel:' + esc(l.phone.replace(/[^\d+]/g, "")) + '">' + esc(l.phone) + "</a>" : "") + "</div>" : "") +
          (l.message ? '<div class="muted">' + esc(l.message) + "</div>" : "") +
          '<div class="lead__act">' + (l.status !== "done" ? '<button class="btn btn--sm" data-act="lead" data-id="' + l.id + '" data-s="done">Өңделді</button>' : '<button class="btn btn--ghost btn--sm" data-act="lead" data-id="' + l.id + '" data-s="new">Жаңа деп белгілеу</button>') +
          (l.status !== "deleted" ? '<button class="btn btn--danger btn--sm" data-act="lead" data-id="' + l.id + '" data-s="deleted">Жою</button>' : '<button class="btn btn--ghost btn--sm" data-act="lead" data-id="' + l.id + '" data-s="new">Қайтару</button>') + "</div></div>";
      }).join("") || '<div class="empty">Өтінім жоқ</div>') + "</div>" +
      '<p class="muted small" style="margin-top:14px">Клиент сайттағы «Сатып алу» немесе «Толығырақ» батырмасын басқанда осында жазылады (және Telegram-ға хабарлама барады).</p>');
  }

  /* --------------------------------------------------------------- users */
  async function viewUsers() {
    $("#app").innerHTML = shell("users", '<div class="loading">Жүктелуде…</div>');
    try { S.users = (await api("/api/users")).users; } catch (e) { return toast(e.message, true); }
    $("#app").innerHTML = shell("users", '<div class="toolbar"><h1 class="h1" style="margin:0">Пайдаланушылар</h1><button class="btn" data-act="user-add" style="margin-left:auto">+ Қосу</button></div><div class="plist">' +
      S.users.map(function (u) {
        return '<div class="prow" style="grid-template-columns:1fr auto"><div class="prow__main"><div class="prow__name">' + esc(u.username) + '</div><div class="prow__meta"><span class="tag ' + (u.role === "owner" ? "tag--ok" : "") + '">' + (u.role === "owner" ? "Иесі (толық құқық)" : "Редактор") + "</span></div></div>" +
          '<div class="prow__act" style="grid-column:auto;border:0;padding:0"><button class="btn btn--ghost btn--sm" data-act="user-pass" data-u="' + esc(u.username) + '">Пароль қою</button>' +
          (u.username === S.user.username ? "" : '<button class="btn btn--danger btn--sm" data-act="user-del" data-u="' + esc(u.username) + '">Жою</button>') + "</div></div>";
      }).join("") + '</div><p class="muted small" style="margin-top:14px">Редактор тауар мен сайт мәтіндерін өңдей алады, бірақ пайдаланушыларды басқара алмайды. Парольді ұмытса — осы жерден жаңасын қойыңыз.</p>');
  }

  /* --------------------------------------------------------------- events */
  document.addEventListener("click", async function (ev) {
    var el = ev.target.closest("[data-act]"); if (!el) {
      if (ev.target.closest("#drop")) $("#fileInput").click();
      return;
    }
    var act = el.dataset.act, id = el.dataset.id, i = Number(el.dataset.i);
    try {
      switch (act) {
        case "logout": return logout();
        case "password": return changePassword();
        case "toggle": { var p = S.data.data.products.find(function (x) { return x.id === id; }); p.active = el.checked; S.dirty = true; return viewProducts(); }
        case "top": case "up": case "down": return moveProduct(id, act);
        case "delete": return deleteProduct(id);
        case "discard": { await loadAll(); return route(true); }
        case "publish": { busy(true); try { await publishList("тізімді жаңарту"); toast("Жарияланды. Сайтта 1–2 минутта көрінеді."); } catch (e) { if (e.status === 409 && /өзгерген/.test(e.message)) return conflictDialog(); toast(e.message, true); } finally { busy(false); } return route(true); }
        case "save": return saveProduct();
        case "spec-add": S.ed.specs.push({ kk: "", ru: "" }); renderSpecs(); return;
        case "spec-preset": S.ed.specs.push({ kk: SPEC_PRESETS[i][0] + " — ", ru: SPEC_PRESETS[i][1] + " — " }); renderSpecs(); { var inputs = $$("#specList input"); inputs[inputs.length - 2].focus(); } return;
        case "spec-del": S.ed.specs.splice(i, 1); return renderSpecs();
        case "spec-up": { var t = S.ed.specs.splice(i, 1)[0]; S.ed.specs.splice(i - 1, 0, t); return renderSpecs(); }
        case "img-del": S.ed.images.splice(i, 1); return renderThumbs();
        case "img-left": { var a = S.ed.images.splice(i, 1)[0]; S.ed.images.splice(i - 1, 0, a); return renderThumbs(); }
        case "img-right": { var b = S.ed.images.splice(i, 1)[0]; S.ed.images.splice(i + 1, 0, b); return renderThumbs(); }
        case "img-cover": { var c = S.ed.images.splice(i, 1)[0]; S.ed.images.unshift(c); return renderThumbs(); }
        case "site-save": return saveSite();
        case "site-img-clear": { var si = Number(el.dataset.i); S.siteImgs[si] = S.siteImgs[si] || {}; S.siteImgs[si][el.dataset.k] = { clear: true }; return viewSite(); }
        case "leads-tab": S.leadFilter = el.dataset.t; return viewLeads();
        case "leads-refresh": return viewLeads();
        case "lead": { await api("/api/leads/" + id, { method: "PATCH", body: { status: el.dataset.s } }); return viewLeads().then(refreshLeadCount); }
        case "user-add": return addUser();
        case "user-pass": return setUserPassword(el.dataset.u);
        case "user-del": { if (await confirmBox("Пайдаланушыны жою", el.dataset.u + " аккаунты жойылады.", "Жою", true)) { await api("/api/users/" + encodeURIComponent(el.dataset.u), { method: "DELETE" }); toast("Жойылды"); return viewUsers(); } return; }
      }
    } catch (e) { if (e.message !== "Қайта кіріңіз") toast(e.message, true); }
  });

  document.addEventListener("input", function (ev) {
    var t = ev.target;
    if (t.id === "fq") { S.filter.q = t.value; var pos = t.selectionStart; viewProducts(); var n = $("#fq"); n.focus(); n.setSelectionRange(pos, pos); return; }
    if (t.dataset && t.dataset.spec != null) { S.ed.specs[Number(t.dataset.spec)][t.dataset.lang] = t.value; return; }
    var f = t.form; if (!f || f.id !== "edForm" || !S.ed) return;
    if (t.name === "nameRu") S.ed.touchedRu = true;
    if (t.name === "nameKk" && !S.ed.touchedRu) f.elements.nameRu.value = t.value;
    if (t.name === "slug") S.ed.touchedSlug = true;
    if (["brand", "nameKk", "variant", "slug"].indexOf(t.name) !== -1 && S.ed.isNew && !S.ed.touchedSlug) {
      f.elements.slug.value = slugify(f.elements.brand.value + " " + f.elements.nameKk.value + " " + f.elements.variant.value);
    }
    if (f.elements.slug) { var sp = $("#slugPreview"); if (sp) sp.textContent = slugify(f.elements.slug.value) || "…"; }
    if (t.name === "priceOnRequest") { f.elements.price.disabled = false; }
  });

  document.addEventListener("change", function (ev) {
    var t = ev.target;
    var map = { fcat: "cat", fstatus: "status", factive: "active", fbrand: "brand" };
    if (map[t.id]) { S.filter[map[t.id]] = t.value; return viewProducts(); }
    if (t.id === "fileInput") { addFiles(t.files, S.ed.images); t.value = ""; return; }
    if (t.dataset && t.dataset.siteImg) {
      var ps = t.dataset.siteImg.split(":"), idx = Number(ps[0]), k = ps[1], file = t.files[0]; if (!file) return;
      processImage(file, k === "desktop" ? 2400 : 1200, 0.84).then(function (im) { S.siteImgs[idx] = S.siteImgs[idx] || {}; S.siteImgs[idx][k] = im; viewSite(); toast("Сурет дайын. «Сақтау» батырмасын басыңыз."); })
        .catch(function () { toast("Суретті оқи алмадым", true); });
    }
  });

  ["dragenter", "dragover"].forEach(function (n) { document.addEventListener(n, function (ev) { var d = ev.target.closest && ev.target.closest("#drop"); if (d) { ev.preventDefault(); d.classList.add("is-over"); } }); });
  ["dragleave", "drop"].forEach(function (n) { document.addEventListener(n, function (ev) { var d = ev.target.closest && ev.target.closest("#drop"); if (d) { ev.preventDefault(); d.classList.remove("is-over"); if (n === "drop" && S.ed) addFiles(ev.dataTransfer.files, S.ed.images); } }); });
  document.addEventListener("keydown", function (ev) { if ((ev.key === "Enter" || ev.key === " ") && ev.target.id === "drop") { ev.preventDefault(); $("#fileInput").click(); } });
  window.addEventListener("beforeunload", function (ev) { if (S.dirty) { ev.preventDefault(); ev.returnValue = ""; } });
  window.addEventListener("hashchange", function () { if (S.token && S.data) route(); });

  /* ---------------------------------------------------- dialogs: passwords */
  async function changePassword() {
    var v = await dialog({ title: "Парольді ауыстыру", html: '<label class="field" style="margin-top:12px"><span>Ескі пароль</span><input type="password" name="old" autocomplete="current-password"></label><label class="field"><span>Жаңа пароль (кемінде 10 таңба)</span><input type="password" name="pw" autocomplete="new-password"></label>', ok: "Сақтау",
      validate: function (x) { return !x.old ? "Ескі парольді жазыңыз" : (x.pw || "").length < 10 ? "Жаңа пароль кемінде 10 таңба болуы керек" : ""; } });
    if (!v) return;
    try { await api("/api/password", { method: "POST", body: { old: v.old, password: v.pw } }); toast("Пароль ауыстырылды"); } catch (e) { toast(e.message, true); }
  }
  async function addUser() {
    var v = await dialog({ title: "Жаңа пайдаланушы", html: '<label class="field" style="margin-top:12px"><span>Логин (a-z, 0-9)</span><input type="text" name="u" autocapitalize="none"></label><label class="field"><span>Пароль (кемінде 10 таңба)</span><input type="text" name="pw"></label><label class="field"><span>Рөлі</span><input type="text" name="role" value="editor" readonly></label>', ok: "Қосу",
      validate: function (x) { return !/^[a-z0-9._-]{3,40}$/i.test(x.u || "") ? "Логин: 3–40 таңба, тек латын әріптері мен сандар" : (x.pw || "").length < 10 ? "Пароль кемінде 10 таңба" : ""; } });
    if (!v) return;
    try { await api("/api/users", { method: "POST", body: { username: v.u, password: v.pw, role: "editor" } }); toast("Қосылды"); viewUsers(); } catch (e) { toast(e.message, true); }
  }
  async function setUserPassword(u) {
    var v = await dialog({ title: "Жаңа пароль: " + u, html: '<label class="field" style="margin-top:12px"><span>Жаңа пароль (кемінде 10 таңба)</span><input type="text" name="pw"></label>', ok: "Сақтау", validate: function (x) { return (x.pw || "").length < 10 ? "Кемінде 10 таңба" : ""; } });
    if (!v) return;
    try { await api("/api/users/" + encodeURIComponent(u) + "/password", { method: "POST", body: { password: v.pw } }); toast("Пароль қойылды"); } catch (e) { toast(e.message, true); }
  }

  /* ----------------------------------------------------------------- boot */
  async function boot() {
    $("#app").innerHTML = '<div class="loading">Жүктелуде…</div>';
    try { await loadAll(); } catch (e) { if (S.token) { toast(e.message, true); $("#app").innerHTML = '<div class="loading">' + esc(e.message) + ' <br><br><button class="btn" onclick="location.reload()">Қайталау</button></div>'; } return; }
    S.siteImgs = [{}, {}];
    if (!location.hash) location.hash = "#/products"; else route(true);
    setInterval(function () { if (S.token) refreshLeadCount(); }, 90000);
  }

  async function init() {
    var qp = new URLSearchParams(location.search).get("api");
    if (qp) lsSet(LS.api, qp.replace(/\/+$/, ""));
    S.api = lsGet(LS.api) || "";
    if (!S.api) {
      try { var s = await (await fetch(SITE_ROOT + "data/site.json", { cache: "no-cache" })).json(); S.api = String(s.api || "").replace(/\/+$/, ""); } catch (e) {}
    }
    if (!S.api) { $("#app").innerHTML = '<div class="login"><div class="login__card"><div class="login__brand">ROYAL WATCH</div><p class="err" style="text-align:center">Басқару серверінің мекенжайы (API) бапталмаған. Әзірлеушіге хабарласыңыз.</p></div></div>'; return; }
    var tok = lsGet(LS.token), exp = Number(lsGet(LS.exp) || 0);
    if (tok && exp > Date.now() / 1000) {
      S.token = tok; try { S.user = JSON.parse(lsGet(LS.user)); } catch (e) {}
      if (S.user) return boot();
    }
    renderLogin();
  }
  init();
})();
