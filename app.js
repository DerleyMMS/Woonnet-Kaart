// Woonnet Rijnmond – kaart & overzicht
// 1. Wijklabels op de kaartjes van de gewone site.
// 2. Knop "Kaart & overzicht": volledig scherm met kaart, lijst per wijk en filters.

(() => {
  "use strict";

  // Al geladen (bijv. bookmarklet nogmaals aangetikt)? Dan alleen openen.
  if (window.__wnrOpen) {
    window.__wnrOpen();
    return;
  }

  // App-modus: losse web-app (index.html zet window.__WNR_APP = true).
  const APP_MODE = !!window.__WNR_APP;

  // ── Instellingen ────────────────────────────────────────────────────────
  // Woningen in deze gebieden worden groen gemarkeerd (zoekt in wijk, buurt
  // en plaats; hoofdletters maken niet uit).
  let FAVORIETE_GEBIEDEN = [
    "Hillegersberg",
    "Schiebroek",
    "Berkel en Rodenrijs",
    "Bergschenhoek",
  ];
  // In de app stel je ze in via ⚙️ (opgeslagen op je telefoon, niet in de code).
  if (APP_MODE) {
    try {
      FAVORIETE_GEBIEDEN = JSON.parse(localStorage.getItem("wnr-fav") || "[]");
    } catch (_) {
      FAVORIETE_GEBIEDEN = [];
    }
  }
  const CACHE_MINUTEN = 10; // hoe lang het aanbod onthouden wordt
  // ────────────────────────────────────────────────────────────────────────

  const GRAPHQL_URL = "https://housing.mesh-router.embracecloud.nl/graphql";
  const SITE = APP_MODE ? "https://www.woonnetrijnmond.nl" : location.origin;
  const PAGE_SIZE = 30;
  const MAX_PAGES = 40;
  const DATA_KEY = "wnr-overzicht-data";
  const FILTER_KEY = "wnr-overzicht-filters";
  const WIJK_PREFIX = "wnr-wijk:";

  let siteHeaders = {
    accept: "application/graphql-response+json,application/json;q=0.9",
    "apollographql-client-name": "Portal UI - woonnetrijnmond",
    "apollographql-client-version": "1.0.0",
    authorization: "",
    "content-type": "application/json",
    "x-ec-portal-id":
      "UG9ydGFsUHJvdmlkZXJQb3J0YWw6NDg0MDExNWQtZTk4NC00MzQwLTgxYTktZjNjODZiYjM0MDk2",
    "x-ec-tenant-id": "woonnetrijnmond",
  };

  const LIST_QUERY = `query wnrOverzicht($first: Int, $after: String, $filter: HousingWherePublicationFilterInput, $locale: String) {
  housingPublications(orderBy: STARTDATE_ASC, filter: $filter, locale: $locale) {
    nodes(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id startTime
        allocationProcess { name }
        highlights { description }
        unit {
          slug { value }
          suitability unitUsageType
          basicRent { exact min max }
          grossRent { exact min max }
          numberOfBedrooms { exact min max }
          energyRating { name }
          balcony { name }
          dimensions { edges { node { area surfaceArea } } }
          thumbnails: photos(size: PRESENTATION) { edges { node { url } } }
          location { addressLine1 addressLine2 addressLine3 geoPosition { latitude longitude } }
        }
      } }
    }
  }
}`;

  const DETAIL_QUERY = `query widgetPublicationDetailMainInfo($publicationId: String!, $locale: String) {
  housingPublications(locale: $locale, where: {publicationId: {eq: $publicationId}}) {
    nodes { edges { node { id unit { location { addressLine3 } } } } }
  }
}`;

  // Zelfde standaardfilter als de site (geen garages/parkeerplaatsen).
  const SITE_FILTER = {
    and: [
      { or: [{ suitability: { eq: "NO_PREFERENCE" } }] },
      {
        or: [
          { unitUsageType: { eq: "STANDARD" } },
          { unitUsageType: { eq: "CLUSTER" } },
        ],
      },
    ],
  };

  // ── Hulpfuncties ────────────────────────────────────────────────────────
  const store = {
    get(k, s = sessionStorage) {
      try {
        const v = s.getItem(k);
        return v === null ? null : JSON.parse(v);
      } catch (_) {
        return null;
      }
    },
    set(k, v, s = sessionStorage) {
      try {
        s.setItem(k, JSON.stringify(v));
      } catch (_) {}
    },
  };

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const euro = (n) =>
    "€ " + Number(n).toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function money(v) {
    if (!v) return null;
    if (v.exact) return { lo: v.exact, hi: v.exact };
    if (v.min || v.max) return { lo: v.min || v.max, hi: v.max || v.min };
    return null;
  }

  const moneyText = (m) => (!m ? "–" : m.lo === m.hi ? euro(m.lo) : `${euro(m.lo)} – ${euro(m.hi)}`);

  function isFav(text) {
    const t = String(text).toLowerCase();
    return FAVORIETE_GEBIEDEN.some((g) => t.includes(g.toLowerCase()));
  }

  const ID_RE = /(SG91c2luZ1B1YmxpY2F0aW9u[A-Za-z0-9+/=]+)/;

  const DOELGROEP = {
    NONE: "",
    NO_PREFERENCE: "",
    SENIORS55_PLUS: "55+",
    SENIORS65_PLUS: "65+",
    YOUNG_PEOPLE21_UP_TO27: "Jongeren 21–27",
  };
  function doelgroepLabel(s) {
    if (s in DOELGROEP) return DOELGROEP[s];
    const str = String(s || "");
    let m = str.match(/^SENIORS_?(\d+)_?PLUS$/);
    if (m) return `${m[1]}+`;
    m = str.match(/^YOUNG_PEOPLE_?(\d+)?_?UP_?TO_?(\d+)$/);
    if (m) return m[1] ? `Jongeren ${m[1]}–${m[2]}` : `Jongeren t/m ${m[2]}`;
    return str.replace(/_/g, " ").toLowerCase();
  }

  function normalize(node) {
    const u = node.unit || {};
    const loc = u.location || {};
    const parts = String(loc.addressLine3 || "").split(",").map((s) => s.trim()).filter(Boolean);
    const city = loc.addressLine2 || parts[parts.length - 1] || "Onbekend";
    const wijk = parts.length >= 3 ? parts[0] : parts[0] || "Onbekende wijk";
    const buurt = parts.length >= 3 ? parts[1] : "";
    const total = (u.dimensions?.edges || []).map((e) => e.node).find((n) => n.area === "TOTAL");
    const beds = u.numberOfBedrooms ? u.numberOfBedrooms.exact || u.numberOfBedrooms.min || 0 : 0;
    return {
      id: node.id,
      slug: u.slug?.value || "",
      address: loc.addressLine1 || "",
      city,
      wijk,
      buurt,
      line3: loc.addressLine3 || "",
      lat: loc.geoPosition?.latitude || null,
      lng: loc.geoPosition?.longitude || null,
      rent: money(u.basicRent),
      gross: money(u.grossRent),
      beds,
      m2: total && total.surfaceArea ? Math.round(total.surfaceArea / 1e6) : null,
      energy: u.energyRating?.name || "",
      balcony: u.balcony?.name || "",
      model: node.allocationProcess?.name || "",
      highlights: (node.highlights || []).map((h) => h.description).filter(Boolean),
      doelgroep: doelgroepLabel(u.suitability),
      start: node.startTime || "",
      thumb: u.thumbnails?.edges?.[0]?.node?.url || "",
      fav: isFav(loc.addressLine3 || city),
    };
  }

  function startText(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    if (d > new Date())
      return "Reageren vanaf " + d.toLocaleString("nl-NL", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    return "Reageren mogelijk";
  }

  // ── fetch van de site meelezen (voor headers als je ingelogd bent) ──────
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.startsWith(GRAPHQL_URL) && init?.headers) {
      try {
        const h = init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : { ...init.headers };
        if (h["x-ec-portal-id"]) siteHeaders = h;
      } catch (_) {}
    }
    return originalFetch(input, init);
  };

  function gql(operationName, query, variables) {
    return originalFetch(GRAPHQL_URL, {
      method: "POST",
      headers: siteHeaders,
      body: JSON.stringify({ operationName, variables, query }),
    }).then((r) => r.json());
  }

  // ── Aanbod laden ────────────────────────────────────────────────────────
  let data = null; // {time, items:[]}
  let loadPromise = null;
  const listeners = new Set();
  const notify = (msg) => listeners.forEach((fn) => fn(msg));

  function loadAll(force = false) {
    if (!force) {
      if (data && Date.now() - data.time < CACHE_MINUTEN * 60e3) return Promise.resolve(data);
      const cached = store.get(DATA_KEY);
      if (cached && Date.now() - cached.time < CACHE_MINUTEN * 60e3) {
        data = cached;
        return Promise.resolve(data);
      }
    }
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const items = [];
      let after = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        notify({ loading: true, count: items.length });
        const json = await gql("wnrOverzicht", LIST_QUERY, {
          first: PAGE_SIZE,
          after,
          locale: "nl-NL",
          filter: SITE_FILTER,
        });
        if (json.errors?.length && !json.data) throw new Error(json.errors[0].message);
        const nodes = json?.data?.housingPublications?.nodes;
        for (const e of nodes?.edges || []) items.push(normalize(e.node));
        if (!nodes?.pageInfo?.hasNextPage) break;
        after = nodes.pageInfo.endCursor;
      }
      data = { time: Date.now(), items };
      store.set(DATA_KEY, data);
      notify({ loading: false, count: items.length });
      return data;
    })()
      .catch((err) => {
        notify({ loading: false, error: String(err.message || err) });
        throw err;
      })
      .finally(() => {
        loadPromise = null;
      });
    return loadPromise;
  }

  const byId = () => new Map((data?.items || []).map((i) => [i.id, i]));

  // ════════════════════════════════════════════════════════════════════════
  // 1. Wijklabels op de gewone kaartjes
  // ════════════════════════════════════════════════════════════════════════
  const detailCache = new Map();
  function wijkVoor(id) {
    const item = byId().get(id);
    if (item?.line3) return Promise.resolve(item.line3);
    const ss = store.get(WIJK_PREFIX + id);
    if (ss) return Promise.resolve(ss);
    if (!detailCache.has(id)) {
      detailCache.set(
        id,
        gql("widgetPublicationDetailMainInfo", DETAIL_QUERY, { publicationId: id, locale: "nl-NL" })
          .then((j) => {
            const l3 = j?.data?.housingPublications?.nodes?.edges?.[0]?.node?.unit?.location?.addressLine3 || "";
            if (l3) store.set(WIJK_PREFIX + id, l3);
            return l3;
          })
          .catch(() => "")
      );
    }
    return detailCache.get(id);
  }

  function formatLine3(l3) {
    const p = l3.split(",").map((s) => s.trim()).filter(Boolean);
    if (p.length >= 3) return p[0] === p[1] ? p[1] : `${p[1]} · ${p[0]}`;
    return p.join(" · ");
  }

  function processCard(card) {
    let href = card.getAttribute("href") || "";
    try {
      href = decodeURIComponent(href);
    } catch (_) {}
    const id = href.match(ID_RE)?.[1];
    if (!id) return;
    if (card.dataset.wnrId === id && card.querySelector(".wnr-wijk")) return;
    const line2 = card.querySelector('[data-testid="advertisementAddressText-addressLine2"]');
    if (!line2) return;
    card.dataset.wnrId = id;
    let badge = card.querySelector(".wnr-wijk");
    if (!badge) {
      badge = document.createElement("div");
      line2.insertAdjacentElement("afterend", badge);
    }
    badge.className = "wnr-wijk wnr-loading";
    badge.textContent = "wijk laden…";
    card.classList.remove("wnr-fav-card");
    // Wacht kort op het bulk-laden (scheelt losse verzoeken), daarna per stuk.
    const wait = loadPromise ? Promise.race([loadPromise.catch(() => {}), new Promise((r) => setTimeout(r, 4000))]) : Promise.resolve();
    wait.then(() => wijkVoor(id)).then((l3) => {
      if (card.dataset.wnrId !== id) return;
      if (!l3) {
        badge.className = "wnr-wijk";
        badge.textContent = "wijk onbekend";
        return;
      }
      const fav = isFav(l3);
      badge.className = "wnr-wijk" + (fav ? " wnr-fav" : "");
      badge.textContent = formatLine3(l3);
      badge.title = l3;
      card.classList.toggle("wnr-fav-card", fav);
    });
  }

  function injectPageStyle() {
    if (document.getElementById("wnr-page-style")) return;
    const s = document.createElement("style");
    s.id = "wnr-page-style";
    s.textContent = `
      .wnr-wijk{display:inline-flex;align-items:center;gap:4px;margin-top:4px;padding:2px 8px;border-radius:999px;font-size:13px;line-height:1.5;font-weight:500;background:#eef1f5;color:#3a4250}
      .wnr-wijk::before{content:"📍";font-size:12px}
      .wnr-wijk.wnr-fav{background:#dcf5e3;color:#146c2e;font-weight:600}
      .wnr-wijk.wnr-loading{opacity:.55;font-style:italic}
      a[data-testid="advertisementCard-link"].wnr-fav-card [data-testid="advertisementCard"]{box-shadow:0 0 0 3px #2fa84f}
      #wnr-open-btn{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;align-items:center;gap:8px;
        padding:12px 18px;border:0;border-radius:999px;background:#0779CA;color:#fff;font:600 15px/1 system-ui,sans-serif;
        box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer}
      #wnr-open-btn:hover{background:#0566aa}
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  // ════════════════════════════════════════════════════════════════════════
  // 2. Kaartcomponent (OpenStreetMap-tegels)
  // ════════════════════════════════════════════════════════════════════════
  const TILE = 256;
  const MIN_Z = 8, MAX_Z = 18;
  function project(lat, lng, z) {
    const s = TILE * 2 ** z;
    const sin = Math.sin((lat * Math.PI) / 180);
    return { x: ((lng + 180) / 360) * s, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s };
  }
  function unproject(x, y, z) {
    const s = TILE * 2 ** z;
    const n = Math.PI - (2 * Math.PI * y) / s;
    return { lat: (180 / Math.PI) * Math.atan(Math.sinh(n)), lng: (x / s) * 360 - 180 };
  }

  class TinyMap {
    constructor(el, { onPinClick, onBackgroundClick }) {
      this.el = el;
      this.z = 11;
      this.center = { lat: 51.95, lng: 4.48 };
      this.tiles = new Map();
      this.pins = [];
      this.onPinClick = onPinClick;
      this.onBackgroundClick = onBackgroundClick;
      el.innerHTML = `
        <div class="m-tiles"></div><div class="m-pins"></div><div class="m-popup-layer"></div>
        <div class="m-zoom"><button data-z="1" title="Inzoomen">+</button><button data-z="-1" title="Uitzoomen">−</button><button data-fit title="Alles tonen">⤢</button></div>
        <div class="m-attr">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-bijdragers</div>`;
      this.tileLayer = el.querySelector(".m-tiles");
      this.pinLayer = el.querySelector(".m-pins");
      this.popupLayer = el.querySelector(".m-popup-layer");
      el.querySelector(".m-zoom").addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        e.stopPropagation();
        if (b.dataset.fit !== undefined) this.fit(this.lastFitPoints || []);
        else this.zoomAt(Number(b.dataset.z));
      });
      this._bindPointer();
      this._wheelLock = 0;
      el.addEventListener("wheel", (e) => {
        e.preventDefault();
        const now = Date.now();
        if (now < this._wheelLock || Math.abs(e.deltaY) < 2) return;
        this._wheelLock = now + 220;
        const r = el.getBoundingClientRect();
        this.zoomAt(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });
      el.addEventListener("dblclick", (e) => {
        if (e.target.closest(".m-pin,.m-popup,.m-zoom")) return;
        const r = el.getBoundingClientRect();
        this.zoomAt(1, e.clientX - r.left, e.clientY - r.top);
      });
      new ResizeObserver(() => {
        if (this.pendingFit && el.clientWidth && el.clientHeight) this.fit(this.pendingFit);
        else this.render();
      }).observe(el);
    }

    size() {
      return { w: this.el.clientWidth, h: this.el.clientHeight };
    }

    topLeft() {
      const c = project(this.center.lat, this.center.lng, this.z);
      const { w, h } = this.size();
      return { x: c.x - w / 2, y: c.y - h / 2 };
    }

    _bindPointer() {
      // Slepen met één vinger/muis, knijpen met twee vingers om te zoomen.
      const pts = new Map();
      let drag = null;
      let pinch = null;
      const startDrag = (x, y) => {
        const c = project(this.center.lat, this.center.lng, this.z);
        drag = { x, y, cx: c.x, cy: c.y, moved: false };
      };
      const pinchInfo = () => {
        const [a, b] = [...pts.values()];
        const r = this.el.getBoundingClientRect();
        return {
          d: Math.hypot(a.x - b.x, a.y - b.y),
          mx: (a.x + b.x) / 2 - r.left,
          my: (a.y + b.y) / 2 - r.top,
        };
      };
      this.el.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest(".m-pin,.m-popup,.m-zoom,.m-attr")) return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        try { this.el.setPointerCapture(e.pointerId); } catch (_) {}
        if (pts.size === 2) {
          drag = null;
          pinch = { d0: pinchInfo().d };
        } else if (pts.size === 1) {
          startDrag(e.clientX, e.clientY);
          this.el.classList.add("dragging");
        }
      });
      this.el.addEventListener("pointermove", (e) => {
        if (!pts.has(e.pointerId)) return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && pts.size >= 2) {
          const { d, mx, my } = pinchInfo();
          const ratio = d / pinch.d0;
          if (ratio > 1.45) { this.zoomAt(1, mx, my); pinch.d0 = d; }
          else if (ratio < 0.69) { this.zoomAt(-1, mx, my); pinch.d0 = d; }
          return;
        }
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        this.center = unproject(drag.cx - dx, drag.cy - dy, this.z);
        this.render();
      });
      const end = (e) => {
        if (!pts.has(e.pointerId)) return;
        pts.delete(e.pointerId);
        try { this.el.releasePointerCapture(e.pointerId); } catch (_) {}
        if (pinch) {
          if (pts.size < 2) pinch = null;
          if (pts.size === 1) {
            const [p] = [...pts.values()];
            startDrag(p.x, p.y);
            drag.moved = true; // na knijpen geen "tik"
          }
          return;
        }
        if (drag && !drag.moved && this.onBackgroundClick) this.onBackgroundClick();
        if (pts.size === 0) {
          drag = null;
          this.el.classList.remove("dragging");
        }
      };
      this.el.addEventListener("pointerup", end);
      this.el.addEventListener("pointercancel", end);
    }

    zoomAt(delta, px, py) {
      const z2 = Math.max(MIN_Z, Math.min(MAX_Z, this.z + delta));
      if (z2 === this.z) return;
      const { w, h } = this.size();
      if (px === undefined) { px = w / 2; py = h / 2; }
      const tl = this.topLeft();
      const ll = unproject(tl.x + px, tl.y + py, this.z);
      const p2 = project(ll.lat, ll.lng, z2);
      this.z = z2;
      this.center = unproject(p2.x - px + w / 2, p2.y - py + h / 2, z2);
      this.render();
    }

    setView(lat, lng, z) {
      this.center = { lat, lng };
      if (z) this.z = Math.max(MIN_Z, Math.min(MAX_Z, z));
      this.render();
    }

    fit(points) {
      this.lastFitPoints = points;
      if (!points.length) return this.render();
      const { w, h } = this.size();
      if (!w || !h) {
        this.pendingFit = points; // kaart nog onzichtbaar: inpassen zodra hij zichtbaar wordt
        return;
      }
      this.pendingFit = null;
      const pad = Math.min(80, w / 5, h / 5);
      let z = MAX_Z - 2;
      for (; z > MIN_Z; z--) {
        const ps = points.map((p) => project(p.lat, p.lng, z));
        const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
        if (Math.max(...xs) - Math.min(...xs) < w - pad && Math.max(...ys) - Math.min(...ys) < h - pad) break;
      }
      const ps = points.map((p) => project(p.lat, p.lng, z));
      const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
      this.z = z;
      this.center = unproject((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, z);
      this.render();
    }

    setPins(pins) {
      this.pins = pins;
      this.pinLayer.innerHTML = "";
      for (const p of pins) {
        const d = document.createElement("div");
        d.className = "m-pin" + (p.fav ? " fav" : "") + (p.items.length > 1 ? " multi" : "");
        d.textContent = p.items.length > 1 ? p.items.length : "";
        d.title = p.items.length > 1 ? `${p.items.length} woningen · ${p.items[0].address}` : p.items[0].address;
        d.addEventListener("click", (e) => {
          e.stopPropagation();
          this.onPinClick && this.onPinClick(p);
        });
        d.addEventListener("pointerdown", (e) => e.stopPropagation());
        p.el = d;
        this.pinLayer.appendChild(d);
      }
      this.render();
    }

    showPopup(pin, html) {
      this.popup = { pin, html };
      this.render();
    }

    closePopup() {
      this.popup = null;
      this.popupLayer.innerHTML = "";
    }

    render() {
      const { w, h } = this.size();
      if (!w || !h) return;
      const z = this.z;
      const tl = this.topLeft();
      const n = 2 ** z;
      const x0 = Math.floor(tl.x / TILE), x1 = Math.floor((tl.x + w) / TILE);
      const y0 = Math.max(0, Math.floor(tl.y / TILE)), y1 = Math.min(n - 1, Math.floor((tl.y + h) / TILE));
      const want = new Set();
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const xx = ((x % n) + n) % n;
          const key = `${z}/${x}/${y}`;
          want.add(key);
          let img = this.tiles.get(key);
          if (!img) {
            img = document.createElement("img");
            img.className = "m-tile";
            img.draggable = false;
            img.alt = "";
            img.src = `https://tile.openstreetmap.org/${z}/${xx}/${y}.png`;
            this.tiles.set(key, img);
            this.tileLayer.appendChild(img);
          }
          img.style.transform = `translate(${Math.round(x * TILE - tl.x)}px, ${Math.round(y * TILE - tl.y)}px)`;
        }
      }
      for (const [key, img] of this.tiles) {
        if (!want.has(key)) {
          img.remove();
          this.tiles.delete(key);
        }
      }
      for (const p of this.pins) {
        const pp = project(p.lat, p.lng, z);
        p.el.style.transform = `translate(${Math.round(pp.x - tl.x)}px, ${Math.round(pp.y - tl.y)}px)`;
      }
      if (this.popup) {
        const pp = project(this.popup.pin.lat, this.popup.pin.lng, z);
        let el = this.popupLayer.firstElementChild;
        if (!el || el.dataset.key !== this.popup.pin.key) {
          this.popupLayer.innerHTML = `<div class="m-popup" data-key="${esc(this.popup.pin.key)}"><button class="m-popup-close" title="Sluiten">×</button>${this.popup.html}</div>`;
          el = this.popupLayer.firstElementChild;
          el.addEventListener("pointerdown", (e) => e.stopPropagation());
          el.addEventListener("wheel", (e) => e.stopPropagation());
          el.querySelector(".m-popup-close").addEventListener("click", (e) => {
            e.stopPropagation();
            this.closePopup();
          });
        }
        el.style.transform = `translate(${Math.round(pp.x - tl.x)}px, ${Math.round(pp.y - tl.y)}px)`;
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // 3. Overzichtsscherm
  // ════════════════════════════════════════════════════════════════════════
  const DEFAULT_FILTERS = {
    q: "", city: "", wijk: "", maxRent: "", minBeds: "0", minM2: "", model: "",
    doelgroep: "", balcony: false, favOnly: false, sort: "wijk",
  };
  let filters = { ...DEFAULT_FILTERS, ...(store.get(FILTER_KEY, localStorage) || {}) };
  let overlay = null; // {host, root, map, ...}
  let selectedId = null;
  const collapsed = new Set();

  const OVERLAY_CSS = `
  :host{all:initial}
  *{box-sizing:border-box}
  .wrap{position:fixed;inset:0;z-index:2147483600;display:flex;flex-direction:column;background:#f4f6f9;color:#191b1f;
    font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  header{padding:8px 14px 10px;background:#fff;border-bottom:1px solid #e1e5eb}
  .top{display:flex;align-items:center;gap:12px;margin-bottom:8px}
  header h1{font-size:17px;margin:0;white-space:nowrap}
  header .count{color:#5b6472;white-space:nowrap}
  .filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  input,select{font:inherit;padding:6px 8px;border:1px solid #cfd5dd;border-radius:8px;background:#fff;color:inherit;min-width:0}
  input[type=search]{width:170px} input.num{width:92px}
  label.chk{display:flex;align-items:center;gap:5px;white-space:nowrap;cursor:pointer;user-select:none}
  button{font:inherit;cursor:pointer}
  .btn{padding:6px 12px;border:1px solid #cfd5dd;border-radius:8px;background:#fff}
  .btn:hover{background:#f0f3f7}
  .close{margin-left:auto;font-size:22px;line-height:1;width:34px;height:34px;border:0;border-radius:50%;background:#eef1f5}
  .close:hover{background:#e1e5eb}
  main{flex:1;display:flex;min-height:0}
  .list{width:440px;max-width:48vw;overflow-y:auto;background:#fff;border-right:1px solid #e1e5eb}
  .map{position:relative;flex:1;overflow:hidden;background:#e8ecef;cursor:grab;touch-action:none}
  .map.dragging{cursor:grabbing}
  .m-tiles,.m-pins,.m-popup-layer{position:absolute;inset:0}
  .m-pins,.m-popup-layer{pointer-events:none}
  .m-tile{position:absolute;left:0;top:0;width:256px;height:256px;user-select:none;-webkit-user-drag:none}
  .m-pin{pointer-events:auto;position:absolute;left:0;top:0;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;
    background:#0779CA;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);cursor:pointer;
    color:#fff;font:700 11px/1 system-ui,sans-serif;display:flex;align-items:center;justify-content:center}
  .m-pin.multi{width:26px;height:26px;margin:-13px 0 0 -13px}
  .m-pin.fav{background:#2fa84f}
  .m-pin.sel{background:#f08a00;z-index:5;box-shadow:0 0 0 4px rgba(240,138,0,.35),0 1px 4px rgba(0,0,0,.4)}
  .m-pin:hover{filter:brightness(1.12)}
  .m-popup{pointer-events:auto;position:absolute;left:0;top:0;width:300px;max-height:340px;overflow:auto;margin:-20px 0 0 -150px;
    transform-origin:0 0;translate:0 -100%;background:#fff;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);padding:10px 10px 6px;cursor:default}
  .m-popup-close{position:sticky;top:0;float:right;border:0;background:#eef1f5;border-radius:50%;width:24px;height:24px;line-height:1}
  .m-zoom{position:absolute;right:12px;top:12px;display:flex;flex-direction:column;gap:4px}
  .m-zoom button{width:34px;height:34px;border:0;border-radius:8px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);font-size:18px}
  .m-attr{position:absolute;right:0;bottom:0;background:rgba(255,255,255,.85);font-size:11px;padding:2px 6px}
  .m-attr a{color:#333}
  .city{position:sticky;top:0;z-index:2;background:#191b1f;color:#fff;padding:7px 14px;font-weight:700;display:flex;justify-content:space-between}
  .wijk{display:flex;justify-content:space-between;align-items:center;width:100%;padding:8px 14px;border:0;border-bottom:1px solid #e9edf2;
    background:#f4f6f9;font-weight:600;text-align:left}
  .wijk.fav{background:#e8f7ec;color:#146c2e}
  .wijk .n{font-weight:500;color:#5b6472}
  .wijk::before{content:"▾";margin-right:6px}
  .wijk.collapsed::before{content:"▸"}
  .item{display:flex;gap:10px;padding:10px 14px;border-bottom:1px solid #eef1f5;cursor:pointer}
  .item:hover{background:#f7f9fb}
  .item.sel{background:#fff4e5;box-shadow:inset 3px 0 0 #f08a00}
  .item img,.pop-item img{width:92px;height:68px;object-fit:cover;border-radius:6px;background:#e1e5eb;flex:none}
  .item .info{min-width:0;flex:1}
  .addr{font-weight:700}
  .sub{color:#5b6472;font-size:13px}
  .price{font-weight:700;margin-top:2px}
  .price small{font-weight:400;color:#5b6472}
  .chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
  .chip{font-size:12px;padding:1px 7px;border-radius:999px;background:#eef1f5;white-space:nowrap}
  .chip.model{background:#e3effa;color:#0566aa}
  .chip.age{background:#fff0d6;color:#8a5300}
  .chip.fav{background:#dcf5e3;color:#146c2e}
  .chip.time{background:#f1ecfb;color:#5a3d99}
  a.open{display:inline-block;margin-top:6px;color:#0779CA;font-weight:600;text-decoration:none}
  a.open:hover{text-decoration:underline}
  .pop-item{display:flex;gap:8px;padding:6px 0;border-bottom:1px solid #eef1f5}
  .pop-item:last-child{border:0}
  .pop-item img{width:72px;height:54px}
  .empty,.status{padding:24px 16px;color:#5b6472;text-align:center}
  .status.err{color:#b3261e}
  .ftoggle,.tabs,.settings{display:none}
  /* ── Losse app ── */
  .wrap.app .settings{display:inline-block}
  .wrap.app .close{display:none}
  .wrap.app header{padding-top:max(8px, env(safe-area-inset-top))}
  .wrap.app .list{padding-bottom:env(safe-area-inset-bottom)}
  .wrap.app .m-attr{padding-bottom:max(2px, env(safe-area-inset-bottom))}
  .wrap.app .top{flex-wrap:nowrap}
  .wrap.app .count{flex:1}
  /* ── Telefoon ── */
  @media (max-width:800px){
    .wrap{height:100dvh}
    header{padding:8px 10px}
    .top{margin-bottom:0;gap:8px}
    header h1{font-size:16px}
    header .count{font-size:13px;flex:1;white-space:normal}
    .ftoggle{display:inline-block}
    .ftoggle.active{background:#0779CA;color:#fff;border-color:#0779CA}
    .filters{display:none;margin-top:8px;max-height:55dvh;overflow:auto}
    .wrap.show-filters .filters{display:flex}
    .filters>input,.filters>select{flex:1 1 calc(50% - 6px)}
    .filters input[type=search]{width:auto;flex-basis:100%}
    input,select{font-size:16px} /* voorkomt inzoomen op iPhone */
    .tabs{display:flex;background:#fff;border-bottom:1px solid #e1e5eb}
    .tabs button{flex:1;padding:10px;border:0;background:none;font-weight:600;color:#5b6472;border-bottom:3px solid transparent}
    .tabs button.on{color:#0779CA;border-bottom-color:#0779CA}
    main{display:block;position:relative}
    .list,.map{position:absolute;inset:0;width:auto;max-width:none;border:0}
    .wrap[data-tab=list] .map,.wrap[data-tab=map] .list{visibility:hidden;pointer-events:none}
    .item{padding:10px}
    .item img{width:84px;height:64px}
    .m-popup{width:min(300px,86vw);margin-left:calc(-1 * min(150px,43vw));max-height:50dvh}
    .m-zoom{top:auto;bottom:28px}
    .m-zoom button{width:40px;height:40px}
  }
  `;

  function itemChips(i) {
    const c = [];
    if (i.model) c.push(`<span class="chip model">${esc(i.model)}</span>`);
    if (i.beds) c.push(`<span class="chip">${i.beds} slpk</span>`);
    if (i.m2) c.push(`<span class="chip">${i.m2} m²</span>`);
    if (i.energy) c.push(`<span class="chip">Label ${esc(i.energy)}</span>`);
    if (i.balcony) c.push(`<span class="chip">${esc(i.balcony)}</span>`);
    if (i.doelgroep) c.push(`<span class="chip age">${esc(i.doelgroep)}</span>`);
    for (const h of i.highlights) c.push(`<span class="chip">${esc(h)}</span>`);
    const t = startText(i.start);
    if (t) c.push(`<span class="chip time">${esc(t)}</span>`);
    return `<div class="chips">${c.join("")}</div>`;
  }

  const advUrl = (i) => `${SITE}/nl-NL/aanbod/advertentie/${i.slug}`;

  // Buurt · wijk · plaats, zonder dubbele namen.
  const locText = (i) => [...new Set([i.buurt, i.wijk, i.city].filter(Boolean))].join(" · ");

  function itemHtml(i) {
    return `<div class="item${i.id === selectedId ? " sel" : ""}" data-id="${esc(i.id)}">
      ${i.thumb ? `<img loading="lazy" src="${esc(i.thumb)}" alt="">` : `<img alt="">`}
      <div class="info">
        <div class="addr">${esc(i.address)}</div>
        <div class="sub">${esc(locText(i))}</div>
        <div class="price">${moneyText(i.rent)} <small>kaal · ${moneyText(i.gross)} totaal</small></div>
        ${itemChips(i)}
        <a class="open" href="${esc(advUrl(i))}" target="_blank" rel="noopener">Bekijk advertentie ↗</a>
      </div></div>`;
  }

  function popupHtml(pin) {
    return pin.items
      .map((i) => `<div class="pop-item">
        ${i.thumb ? `<img src="${esc(i.thumb)}" alt="">` : ""}
        <div><div class="addr">${esc(i.address)}</div>
        <div class="sub">${esc([i.buurt, i.city].filter(Boolean).join(" · "))}</div>
        <div class="price">${moneyText(i.rent)} <small>kaal</small></div>
        <div class="sub">${[i.beds ? i.beds + " slpk" : "", i.m2 ? i.m2 + " m²" : "", i.model].filter(Boolean).map(esc).join(" · ")}</div>
        <a class="open" href="${esc(advUrl(i))}" target="_blank" rel="noopener">Bekijk ↗</a></div></div>`)
      .join("");
  }

  function applyFilters(items) {
    const q = filters.q.trim().toLowerCase();
    const maxRent = parseFloat(String(filters.maxRent).replace(",", "."));
    const minM2 = parseFloat(filters.minM2);
    const minBeds = parseInt(filters.minBeds, 10) || 0;
    let out = items.filter((i) => {
      if (q && ![i.address, i.city, i.wijk, i.buurt].join(" ").toLowerCase().includes(q)) return false;
      if (filters.city && i.city !== filters.city) return false;
      if (filters.wijk && i.wijk !== filters.wijk) return false;
      if (maxRent && (!i.rent || i.rent.lo > maxRent)) return false;
      if (minM2 && (!i.m2 || i.m2 < minM2)) return false;
      if (minBeds && i.beds < minBeds) return false;
      if (filters.model && i.model !== filters.model) return false;
      if (filters.doelgroep === "geen" && i.doelgroep) return false;
      if (filters.doelgroep && filters.doelgroep !== "geen" && i.doelgroep !== filters.doelgroep) return false;
      if (filters.balcony && !i.balcony) return false;
      if (filters.favOnly && !i.fav) return false;
      return true;
    });
    const rentOf = (i) => (i.rent ? i.rent.lo : Infinity);
    const sorters = {
      wijk: (a, b) => rentOf(a) - rentOf(b),
      prijs: (a, b) => rentOf(a) - rentOf(b),
      prijsAf: (a, b) => rentOf(b) - rentOf(a),
      m2: (a, b) => (b.m2 || 0) - (a.m2 || 0),
      start: (a, b) => String(a.start).localeCompare(String(b.start)),
    };
    out.sort(sorters[filters.sort] || sorters.wijk);
    return out;
  }

  function options(values, selected, allLabel) {
    return `<option value="">${esc(allLabel)}</option>` +
      values.map((v) => `<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(v)}</option>`).join("");
  }

  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b, "nl"));

  function buildOverlay() {
    const host = document.createElement("div");
    host.id = "wnr-overzicht-host";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${OVERLAY_CSS}</style>
      <div class="wrap${APP_MODE ? " app" : ""}" data-tab="list">
        <header>
          <div class="top">
            <h1>🗺️ Woonnet overzicht</h1>
            <span class="count"></span>
            <button class="btn ftoggle" data-act="filters">Filters</button>
            <button class="btn settings" data-act="settings" title="Favoriete gebieden instellen">⚙️</button>
            <button class="close" data-act="close" title="Sluiten (Esc)">×</button>
          </div>
          <div class="filters">
            <input type="search" data-f="q" placeholder="Zoek straat, wijk…">
            <select data-f="city"></select>
            <select data-f="wijk"></select>
            <input class="num" data-f="maxRent" inputmode="decimal" placeholder="Max kale huur">
            <select data-f="minBeds">
              <option value="0">Slaapkamers</option><option value="1">1+ slpk</option><option value="2">2+ slpk</option>
              <option value="3">3+ slpk</option><option value="4">4+ slpk</option>
            </select>
            <input class="num" data-f="minM2" inputmode="numeric" placeholder="Min m²">
            <select data-f="model"></select>
            <select data-f="doelgroep"></select>
            <label class="chk"><input type="checkbox" data-f="balcony"> Balkon</label>
            <label class="chk"><input type="checkbox" data-f="favOnly"> ★ Favoriete gebieden</label>
            <select data-f="sort">
              <option value="wijk">Groeperen per wijk</option>
              <option value="prijs">Huur oplopend</option>
              <option value="prijsAf">Huur aflopend</option>
              <option value="m2">Grootste eerst</option>
              <option value="start">Reageerdatum</option>
            </select>
            <button class="btn" data-act="reset">Wis filters</button>
            <button class="btn" data-act="refresh" title="Aanbod opnieuw ophalen">↻ Vernieuwen</button>
          </div>
        </header>
        <nav class="tabs"><button data-tab="list" class="on">☰ Lijst</button><button data-tab="map">🗺️ Kaart</button></nav>
        <main><div class="list"></div><div class="map"></div></main>
      </div>`;
    document.body.appendChild(host);

    const $ = (s) => root.querySelector(s);
    const o = { host, root, $, wrap: $(".wrap"), list: $(".list"), count: $(".count") };
    o.map = new TinyMap($(".map"), {
      onPinClick: (pin) => selectPin(pin, false),
      onBackgroundClick: () => o.map.closePopup(),
    });

    root.addEventListener("input", (e) => {
      const f = e.target.dataset?.f;
      if (!f) return;
      filters[f] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
      if (f === "city") filters.wijk = "";
      store.set(FILTER_KEY, filters, localStorage);
      render(true);
    });
    root.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "close") return closeOverlay();
      if (act === "reset") {
        filters = { ...DEFAULT_FILTERS };
        store.set(FILTER_KEY, filters, localStorage);
        return render(true);
      }
      if (act === "refresh") return refresh(true);
      if (act === "filters") {
        o.wrap.classList.toggle("show-filters");
        return;
      }
      if (act === "settings") {
        const v = prompt(
          "Favoriete gebieden, gescheiden door komma's\n(bijv. Hillegersberg, Schiebroek, Bergschenhoek)",
          FAVORIETE_GEBIEDEN.join(", ")
        );
        if (v !== null) {
          FAVORIETE_GEBIEDEN = v.split(",").map((s) => s.trim()).filter(Boolean);
          try {
            localStorage.setItem("wnr-fav", JSON.stringify(FAVORIETE_GEBIEDEN));
          } catch (_) {}
          render(false);
        }
        return;
      }
      const tab = e.target.closest("[data-tab]")?.dataset.tab;
      if (tab && e.target.closest(".tabs")) return setTab(tab);
      const wijkBtn = e.target.closest(".wijk");
      if (wijkBtn) {
        const k = wijkBtn.dataset.key;
        collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k);
        return render(false);
      }
      if (e.target.closest("a")) return;
      const it = e.target.closest(".item");
      if (it) {
        const pin = o.pins?.find((p) => p.items.some((i) => i.id === it.dataset.id));
        selectedId = it.dataset.id;
        if (pin) {
          if (isMobile()) setTab("map"); // op telefoon direct naar de kaart
          selectPin(pin, true);
        } else renderList();
      }
    });
    root.addEventListener("mouseover", (e) => {
      const it = e.target.closest?.(".item");
      o.pins?.forEach((p) => p.el.classList.toggle("sel", !!it && p.items.some((i) => i.id === it.dataset.id) || p.items.some((i) => i.id === selectedId)));
    });
    return o;
  }

  const isMobile = () => window.matchMedia("(max-width: 800px)").matches;

  function setTab(tab) {
    overlay.wrap.dataset.tab = tab;
    overlay.root.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    overlay.wrap.classList.remove("show-filters");
    if (tab === "map") overlay.map.render();
  }

  function activeFilterCount() {
    return Object.keys(DEFAULT_FILTERS).filter((k) => k !== "sort" && String(filters[k]) !== String(DEFAULT_FILTERS[k])).length;
  }

  function selectPin(pin, fromList) {
    if (!fromList) selectedId = pin.items[0].id;
    overlay.pins.forEach((p) => p.el.classList.toggle("sel", p === pin));
    if (fromList) overlay.map.setView(pin.lat, pin.lng, Math.max(overlay.map.z, 15));
    overlay.map.showPopup(pin, popupHtml(pin));
    renderList();
    const el = overlay.list.querySelector(`.item[data-id="${CSS.escape(selectedId)}"]`);
    if (el && !fromList) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  let lastFiltered = [];

  function render(refit) {
    if (!overlay || !data) return;
    const o = overlay;
    const all = data.items;
    for (const i of all) i.fav = isFav(i.line3 || i.city); // favorieten kunnen veranderd zijn
    const cities = uniq(all.map((i) => i.city));
    const wijken = uniq(all.filter((i) => !filters.city || i.city === filters.city).map((i) => i.wijk));
    const models = uniq(all.map((i) => i.model));
    const groepen = uniq(all.map((i) => i.doelgroep));
    o.$('[data-f="city"]').innerHTML = options(cities, filters.city, "Alle plaatsen");
    o.$('[data-f="wijk"]').innerHTML = options(wijken, filters.wijk, "Alle wijken");
    o.$('[data-f="model"]').innerHTML = options(models, filters.model, "Alle zoekmodellen");
    o.$('[data-f="doelgroep"]').innerHTML =
      `<option value="">Alle doelgroepen</option><option value="geen"${filters.doelgroep === "geen" ? " selected" : ""}>Zonder leeftijdseis</option>` +
      groepen.map((g) => `<option value="${esc(g)}"${g === filters.doelgroep ? " selected" : ""}>Alleen ${esc(g)}</option>`).join("");
    for (const el of o.root.querySelectorAll("[data-f]")) {
      const f = el.dataset.f;
      if (el.type === "checkbox") el.checked = !!filters[f];
      else if (el.tagName !== "SELECT" || ["minBeds", "sort"].includes(f)) {
        if (el !== o.root.activeElement) el.value = filters[f];
      }
    }

    lastFiltered = applyFilters(all);
    o.count.textContent = `${lastFiltered.length} van ${all.length} woningen`;
    const nf = activeFilterCount();
    const ft = o.$(".ftoggle");
    ft.textContent = nf ? `Filters (${nf})` : "Filters";
    ft.classList.toggle("active", nf > 0);

    // Pins: woningen op exact dezelfde plek (zelfde complex) samenvoegen.
    const groups = new Map();
    for (const i of lastFiltered) {
      if (i.lat == null || i.lng == null) continue;
      const key = i.lat.toFixed(5) + "," + i.lng.toFixed(5);
      if (!groups.has(key)) groups.set(key, { key, lat: i.lat, lng: i.lng, items: [], fav: false });
      const g = groups.get(key);
      g.items.push(i);
      g.fav = g.fav || i.fav;
    }
    o.pins = [...groups.values()];
    o.map.closePopup();
    o.map.setPins(o.pins);
    if (refit) o.map.fit(o.pins);
    renderList();
  }

  function renderList() {
    const o = overlay;
    if (!lastFiltered.length) {
      o.list.innerHTML = `<div class="empty">Geen woningen gevonden met deze filters.</div>`;
      return;
    }
    if (filters.sort !== "wijk") {
      o.list.innerHTML = lastFiltered.map(itemHtml).join("");
      return;
    }
    // Groeperen: plaats → wijk. Favoriete gebieden bovenaan.
    const cities = new Map();
    for (const i of lastFiltered) {
      if (!cities.has(i.city)) cities.set(i.city, new Map());
      const w = cities.get(i.city);
      if (!w.has(i.wijk)) w.set(i.wijk, []);
      w.get(i.wijk).push(i);
    }
    const favScore = (items) => (items.some((i) => i.fav) ? 0 : 1);
    const cityList = [...cities.entries()].sort((a, b) => {
      const fa = favScore([...a[1].values()].flat()), fb = favScore([...b[1].values()].flat());
      return fa - fb || a[0].localeCompare(b[0], "nl");
    });
    let html = "";
    for (const [city, wijken] of cityList) {
      const n = [...wijken.values()].reduce((s, l) => s + l.length, 0);
      html += `<div class="city"><span>${esc(city)}</span><span>${n}</span></div>`;
      const wList = [...wijken.entries()].sort((a, b) => favScore(a[1]) - favScore(b[1]) || a[0].localeCompare(b[0], "nl"));
      for (const [wijk, items] of wList) {
        const key = city + "|" + wijk;
        const fav = items.some((i) => i.fav);
        html += `<button class="wijk${fav ? " fav" : ""}${collapsed.has(key) ? " collapsed" : ""}" data-key="${esc(key)}">
          <span>${fav ? "★ " : ""}${esc(wijk)}</span><span class="n">${items.length}</span></button>`;
        if (!collapsed.has(key)) html += items.map(itemHtml).join("");
      }
    }
    const scroll = o.list.scrollTop;
    o.list.innerHTML = html;
    o.list.scrollTop = scroll;
  }

  function setStatus(html, isErr) {
    if (!overlay) return;
    overlay.list.innerHTML = `<div class="status${isErr ? " err" : ""}">${html}</div>`;
  }

  function refresh(force) {
    if (!data || force) setStatus("Aanbod laden…");
    loadAll(force)
      .then(() => render(true))
      .catch((e) => setStatus("Laden mislukt: " + esc(e.message || e) + "<br><br>Probeer ↻ Vernieuwen.", true));
  }

  listeners.add((m) => {
    if (overlay && m.loading) setStatus(`Aanbod laden… ${m.count} woningen opgehaald`);
  });

  function openOverlay() {
    if (!overlay) overlay = buildOverlay();
    overlay.host.style.display = "";
    document.documentElement.style.overflow = "hidden";
    refresh(false);
  }

  function closeOverlay() {
    if (!overlay) return;
    overlay.host.style.display = "none";
    document.documentElement.style.overflow = "";
  }

  document.addEventListener("keydown", (e) => {
    if (!APP_MODE && e.key === "Escape" && overlay && overlay.host.style.display !== "none") closeOverlay();
  });

  // App weer geopend na een tijdje? Dan het aanbod verversen.
  document.addEventListener("visibilitychange", () => {
    if (APP_MODE && overlay && document.visibilityState === "visible" && data && Date.now() - data.time > CACHE_MINUTEN * 60e3) {
      refresh(false);
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  // Start
  // ════════════════════════════════════════════════════════════════════════
  function addButton() {
    if (document.getElementById("wnr-open-btn")) return;
    const b = document.createElement("button");
    b.id = "wnr-open-btn";
    b.type = "button";
    b.innerHTML = "🗺️ Kaart &amp; overzicht";
    b.addEventListener("click", openOverlay);
    document.body.appendChild(b);
  }

  function scan() {
    addButton();
    document.querySelectorAll('a[data-testid="advertisementCard-link"]').forEach(processCard);
  }

  let scheduled = false;
  function start() {
    if (APP_MODE) {
      openOverlay();
      return;
    }
    injectPageStyle();
    loadAll(false).catch(() => {});
    scan();
    new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        scan();
      });
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
  }

  window.__wnrOpen = openOverlay;

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();
