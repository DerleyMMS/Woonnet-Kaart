// Woonnet Rijnmond – kaart & overzicht
// 1. Wijklabels op de kaartjes van de gewone site.
// 2. Knop "Kaart & overzicht": volledig scherm met kaart, lijst per wijk en filters.
// 3. Zelfde code draait als bookmarklet en als losse web-app (window.__WNR_APP).

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
  // Woningen in deze gebieden worden gemarkeerd (zoekt in wijk, buurt en
  // plaats; hoofdletters maken niet uit).
  let FAVORIETE_GEBIEDEN = [
    "Hillegersberg",
    "Schiebroek",
    "Berkel en Rodenrijs",
    "Bergschenhoek",
  ];
  // In de app stel je ze in via het tandwiel (opgeslagen op je telefoon).
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
  const euroKort = (n) => "€ " + Math.round(Number(n)).toLocaleString("nl-NL");

  function money(v) {
    if (!v) return null;
    if (v.exact) return { lo: v.exact, hi: v.exact };
    if (v.min || v.max) return { lo: v.min || v.max, hi: v.max || v.min };
    return null;
  }

  const moneyText = (m) => (!m ? "–" : m.lo === m.hi ? euro(m.lo) : `${euro(m.lo)} – ${euro(m.hi)}`);
  const moneyKort = (m) => (!m ? "–" : m.lo === m.hi ? euroKort(m.lo) : `${euroKort(m.lo)}–${euroKort(m.hi).slice(2)}`);

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
    if (d > new Date()) {
      const dag = d.toLocaleDateString("nl-NL", { weekday: "short", day: "numeric", month: "short" });
      const tijd = d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
      return `Reageren vanaf ${dag}, ${tijd}`;
    }
    return ""; // al open: geen extra label nodig
  }

  // Engelstalige kenmerken van Woonnet vertalen, dubbelingen weghalen.
  const HIGHLIGHT_NL = { "temporary rental": "Tijdelijke huur", "tijdelijke verhuur": "Tijdelijke huur" };
  function highlightsNl(list) {
    const seen = new Set();
    return list
      .map((h) => HIGHLIGHT_NL[h.toLowerCase()] || h)
      .filter((h) => !seen.has(h.toLowerCase()) && seen.add(h.toLowerCase()));
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
    if (p.length >= 3) return p[0] === p[1] ? p[1] : `${p[1]}, ${p[0]}`;
    return p.join(", ");
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
      .wnr-wijk{display:inline-flex;align-items:center;gap:5px;margin-top:6px;padding:3px 9px;border-radius:7px;font:600 13px/1.4 system-ui,sans-serif;background:#E7F0F1;color:#0F3440}
      .wnr-wijk::before{content:"";width:7px;height:7px;border-radius:50%;background:#1F7A8C}
      .wnr-wijk.wnr-fav{background:#FFC23D;color:#4A3300}
      .wnr-wijk.wnr-fav::before{background:#4A3300}
      .wnr-wijk.wnr-loading{opacity:.5;font-weight:500}
      a[data-testid="advertisementCard-link"].wnr-fav-card [data-testid="advertisementCard"]{box-shadow:0 0 0 3px #FFC23D}
      #wnr-open-btn{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;align-items:center;gap:8px;
        height:48px;padding:0 20px 0 16px;border:0;border-radius:999px;background:#0F3440;color:#fff;
        font:650 15px/1 ui-rounded,"SF Pro Rounded",system-ui,sans-serif;box-shadow:0 8px 24px rgba(15,52,64,.35);cursor:pointer}
      #wnr-open-btn svg{width:18px;height:18px;fill:none;stroke:#FFC23D;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
      #wnr-open-btn:hover{background:#174654}
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  // ── Iconen (eigen eenvoudige lijnen) ────────────────────────────────────
  const svg = (d, extra = "") => `<svg viewBox="0 0 24 24" aria-hidden="true"${extra}>${d}</svg>`;
  const I = {
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    sliders: svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    ext: svg('<path d="M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    minus: svg('<path d="M5 12h14"/>'),
    fit: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    chev: svg('<path d="m6 9 6 6 6-6"/>', ' class="chev"'),
    list: svg('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>'),
    map: svg('<path d="m9 4-5 2v14l5-2 6 2 5-2V4l-5 2-6-2zM9 4v14M15 6v14"/>'),
    star: '<svg viewBox="0 0 24 24" aria-hidden="true" class="star"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
    refresh: svg('<path d="M20 11a8 8 0 0 0-14.8-4M4 4v4h4M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4"/>'),
  };

  // ════════════════════════════════════════════════════════════════════════
  // 2. Kaartcomponent (OpenStreetMap-tegels)
  // ════════════════════════════════════════════════════════════════════════
  const TILE = 256;
  const MIN_Z = 8, MAX_Z = 18;
  const NEAR_Z = 13; // vanaf dit zoomniveau prijslabels i.p.v. stipjes
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
      this.z = 11; // mag een kommagetal zijn: traploos zoomen
      this.center = { lat: 51.95, lng: 4.48 };
      this.tiles = new Map();
      this.pins = [];
      this.onPinClick = onPinClick;
      this.onBackgroundClick = onBackgroundClick;
      this.zoomTarget = null;
      this.anchor = null;
      this._zr = this._fr = this._ir = this._rr = null; // animatie-frames
      el.innerHTML = `
        <div class="m-tiles"></div><div class="m-pins"></div>
        <div class="m-zoom"><button data-z="1" aria-label="Inzoomen">${I.plus}</button><button data-z="-1" aria-label="Uitzoomen">${I.minus}</button><button data-fit aria-label="Alle woningen tonen">${I.fit}</button></div>
        <div class="m-attr">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-bijdragers</div>`;
      this.tileLayer = el.querySelector(".m-tiles");
      this.pinLayer = el.querySelector(".m-pins");
      el.querySelector(".m-zoom").addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        e.stopPropagation();
        if (b.dataset.fit !== undefined) this.flyToPoints(this.lastFitPoints || []);
        else this.zoomBy(Number(b.dataset.z));
      });
      this._bindPointer();
      // Scrollwiel en trackpad: traploos, met zachte uitloop.
      el.addEventListener("wheel", (e) => {
        if (e.target.closest(".mcard")) return;
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const factor = e.ctrlKey ? 0.012 : e.deltaMode === 1 ? 0.06 : 0.0028; // ctrl = knijpen op trackpad
        const delta = Math.max(-1, Math.min(1, -e.deltaY * factor));
        this._stopFly();
        this._stopInertia();
        this.anchor = { px: e.clientX - r.left, py: e.clientY - r.top };
        this.zoomTarget = this.clampZ((this.zoomTarget ?? this.z) + delta);
        this._runZoom();
      }, { passive: false });
      el.addEventListener("dblclick", (e) => {
        if (e.target.closest(".m-pin,.mcard,.m-zoom")) return;
        const r = el.getBoundingClientRect();
        this.zoomBy(1, e.clientX - r.left, e.clientY - r.top);
      });
      new ResizeObserver(() => {
        if (this.pendingFit && el.clientWidth && el.clientHeight) this.fit(this.pendingFit);
        else this.render();
      }).observe(el);
    }

    clampZ(z) {
      return Math.max(MIN_Z, Math.min(MAX_Z, z));
    }

    size() {
      return { w: this.el.clientWidth, h: this.el.clientHeight };
    }

    topLeft() {
      const c = project(this.center.lat, this.center.lng, this.z);
      const { w, h } = this.size();
      return { x: c.x - w / 2, y: c.y - h / 2 };
    }

    // Zoom naar z2 terwijl het punt (px,py) op het scherm op zijn plek blijft.
    setZoomAround(z2, px, py) {
      z2 = this.clampZ(z2);
      const { w, h } = this.size();
      const tl = this.topLeft();
      const ll = unproject(tl.x + px, tl.y + py, this.z);
      const p2 = project(ll.lat, ll.lng, z2);
      this.z = z2;
      this.center = unproject(p2.x - px + w / 2, p2.y - py + h / 2, z2);
      this.render();
    }

    _runZoom() {
      if (this._zr) return;
      const step = () => {
        const d = this.zoomTarget - this.z;
        if (Math.abs(d) < 0.003) {
          this.setZoomAround(this.zoomTarget, this.anchor.px, this.anchor.py);
          this._zr = null;
          this.zoomTarget = null;
          return;
        }
        this.setZoomAround(this.z + d * 0.2, this.anchor.px, this.anchor.py);
        this._zr = requestAnimationFrame(step);
      };
      this._zr = requestAnimationFrame(step);
    }

    _stopZoom() {
      if (this._zr) cancelAnimationFrame(this._zr);
      this._zr = null;
      this.zoomTarget = null;
    }
    _stopFly() {
      if (this._fr) cancelAnimationFrame(this._fr);
      this._fr = null;
    }
    _stopInertia() {
      if (this._ir) cancelAnimationFrame(this._ir);
      this._ir = null;
    }
    stopAll() {
      this._stopZoom();
      this._stopFly();
      this._stopInertia();
    }

    // Knoppen en dubbelklik: één hele stap, vloeiend.
    zoomBy(delta, px, py) {
      const { w, h } = this.size();
      this._stopFly();
      this._stopInertia();
      this.anchor = { px: px ?? w / 2, py: py ?? h / 2 };
      const base = this.zoomTarget ?? this.z;
      this.zoomTarget = this.clampZ(Math.round(base) + delta);
      this._runZoom();
    }

    // Vloeiend naar een plek en zoomniveau "vliegen".
    flyTo(lat, lng, z, ms = 550) {
      this.stopAll();
      const z0 = this.z, z1 = this.clampZ(z ?? this.z);
      const a = project(this.center.lat, this.center.lng, 0);
      const b = project(lat, lng, 0);
      const t0 = performance.now();
      const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
      const step = (now) => {
        const t = Math.min(1, (now - t0) / ms);
        const k = ease(t);
        this.z = z0 + (z1 - z0) * k;
        this.center = unproject(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, 0);
        this.render();
        this._fr = t < 1 ? requestAnimationFrame(step) : null;
      };
      this._fr = requestAnimationFrame(step);
    }

    _bindPointer() {
      // Slepen met één vinger/muis (met uitglijden), knijpen met twee vingers.
      const pts = new Map();
      let drag = null;
      let pinch = null;
      let samples = [];
      const startDrag = (x, y) => {
        const c = project(this.center.lat, this.center.lng, this.z);
        drag = { x, y, cx: c.x, cy: c.y, moved: false };
        samples = [{ x, y, t: performance.now() }];
      };
      const pinchInfo = () => {
        const [a, b] = [...pts.values()];
        const r = this.el.getBoundingClientRect();
        return {
          d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
          mx: (a.x + b.x) / 2 - r.left,
          my: (a.y + b.y) / 2 - r.top,
        };
      };
      this.el.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest(".m-pin,.mcard,.m-zoom,.m-attr")) return;
        this.stopAll();
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        try { this.el.setPointerCapture(e.pointerId); } catch (_) {}
        if (pts.size === 2) {
          const { d, mx, my } = pinchInfo();
          const tl = this.topLeft();
          pinch = { d0: d, z0: this.z, ll: unproject(tl.x + mx, tl.y + my, this.z) };
          drag = null;
        } else if (pts.size === 1) {
          startDrag(e.clientX, e.clientY);
          this.el.classList.add("dragging");
        }
      });
      this.el.addEventListener("pointermove", (e) => {
        if (!pts.has(e.pointerId)) return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && pts.size >= 2) {
          // Kaart volgt de vingers: zoom én verschuiven tegelijk.
          const { d, mx, my } = pinchInfo();
          const z2 = this.clampZ(pinch.z0 + Math.log2(d / pinch.d0));
          const p = project(pinch.ll.lat, pinch.ll.lng, z2);
          const { w, h } = this.size();
          this.z = z2;
          this.center = unproject(p.x - mx + w / 2, p.y - my + h / 2, z2);
          this.render();
          return;
        }
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        this.center = unproject(drag.cx - dx, drag.cy - dy, this.z);
        const now = performance.now();
        samples.push({ x: e.clientX, y: e.clientY, t: now });
        while (samples.length > 2 && now - samples[0].t > 100) samples.shift();
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
        if (pts.size > 0) return;
        if (drag && !drag.moved && this.onBackgroundClick) this.onBackgroundClick();
        if (drag && drag.moved && samples.length >= 2) {
          const a = samples[0], b = samples[samples.length - 1];
          const dt = Math.max(1, b.t - a.t);
          if (performance.now() - b.t < 60) this._inertia((b.x - a.x) / dt, (b.y - a.y) / dt);
        }
        drag = null;
        this.el.classList.remove("dragging");
      };
      this.el.addEventListener("pointerup", end);
      this.el.addEventListener("pointercancel", end);
    }

    // Uitglijden na loslaten.
    _inertia(vx, vy) {
      if (Math.hypot(vx, vy) < 0.25) return;
      let last = performance.now();
      const step = (now) => {
        const dt = Math.min(40, now - last);
        last = now;
        const c = project(this.center.lat, this.center.lng, this.z);
        this.center = unproject(c.x - vx * dt, c.y - vy * dt, this.z);
        const decay = Math.pow(0.994, dt);
        vx *= decay;
        vy *= decay;
        this.render();
        this._ir = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : null;
      };
      this._ir = requestAnimationFrame(step);
    }

    setView(lat, lng, z) {
      this.stopAll();
      this.center = { lat, lng };
      if (z) this.z = this.clampZ(z);
      this.render();
    }

    _fitTarget(points) {
      const { w, h } = this.size();
      const pad = Math.min(90, w / 5, h / 5);
      let z = MAX_Z - 2;
      for (; z > MIN_Z; z--) {
        const ps = points.map((p) => project(p.lat, p.lng, z));
        const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
        if (Math.max(...xs) - Math.min(...xs) < w - pad && Math.max(...ys) - Math.min(...ys) < h - pad) break;
      }
      const ps = points.map((p) => project(p.lat, p.lng, z));
      const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
      return { z, center: unproject((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, z) };
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
      this.stopAll();
      const t = this._fitTarget(points);
      this.z = t.z;
      this.center = t.center;
      this.render();
    }

    flyToPoints(points) {
      if (!points.length) return;
      const t = this._fitTarget(points);
      this.flyTo(t.center.lat, t.center.lng, t.z);
    }

    setPins(pins) {
      this.pins = pins;
      this.pinLayer.innerHTML = "";
      for (const p of pins) {
        const d = document.createElement("button");
        d.type = "button";
        d.className = "m-pin" + (p.fav ? " fav" : "") + (p.items.length > 1 ? " multi" : "");
        d.innerHTML = `<span class="pin-in"><i class="dot"></i><b class="lbl">${esc(p.label)}</b>${p.items.length > 1 ? `<em class="cnt">${p.items.length}</em>` : ""}</span>`;
        d.setAttribute("aria-label", p.items.length > 1 ? `${p.items.length} woningen, ${p.items[0].address}` : `${p.items[0].address}, ${p.label}`);
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

    _scheduleRender() {
      if (this._rr) return;
      this._rr = requestAnimationFrame(() => {
        this._rr = null;
        this.render();
      });
    }

    render() {
      const { w, h } = this.size();
      if (!w || !h) return;
      const z = this.z;
      const tz = Math.round(z); // tegels van het dichtstbijzijnde hele niveau, geschaald
      this.el.dataset.zoom = z >= NEAR_Z - 0.4 ? "near" : "far";
      const tl = this.topLeft();
      const n = 2 ** tz;
      const ts = TILE * 2 ** (z - tz);
      const x0 = Math.floor(tl.x / ts), x1 = Math.floor((tl.x + w) / ts);
      const y0 = Math.max(0, Math.floor(tl.y / ts)), y1 = Math.min(n - 1, Math.floor((tl.y + h) / ts));
      const want = new Set();
      let allLoaded = true;
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const key = `${tz}/${x}/${y}`;
          want.add(key);
          let img = this.tiles.get(key);
          if (!img) {
            img = document.createElement("img");
            img.className = "m-tile";
            img.draggable = false;
            img.alt = "";
            img._z = tz; img._x = x; img._y = y;
            img.onload = () => {
              img.classList.add("ok");
              // pas als "klaar" tellen na het infaden, zodat oude tegels niet te vroeg verdwijnen
              setTimeout(() => {
                img._ok = true;
                this._scheduleRender();
              }, 220);
            };
            img.onerror = () => {
              img._ok = true;
              this._scheduleRender();
            };
            img.src = `https://tile.openstreetmap.org/${tz}/${((x % n) + n) % n}/${y}.png`;
            this.tiles.set(key, img);
            this.tileLayer.appendChild(img);
          }
          if (!img._ok) allLoaded = false;
        }
      }
      // Alle tegels (ook van vorige niveaus) op de juiste plek en schaal zetten.
      // Oude niveaus blijven eronder liggen tot het nieuwe niveau geladen is.
      for (const [key, img] of this.tiles) {
        const s = TILE * 2 ** (z - img._z);
        const left = img._x * s - tl.x, top = img._y * s - tl.y;
        const current = img._z === tz;
        const off = left > w || top > h || left + s < 0 || top + s < 0;
        if ((current && !want.has(key)) || (!current && (allLoaded || off || Math.abs(img._z - tz) > 3))) {
          img.remove();
          this.tiles.delete(key);
          continue;
        }
        img.style.zIndex = current ? 2 : 1;
        img.style.transform = `translate3d(${left}px, ${top}px, 0) scale(${s / TILE})`;
      }
      for (const p of this.pins) {
        const pp = project(p.lat, p.lng, z);
        p.el.style.transform = `translate3d(${Math.round(pp.x - tl.x)}px, ${Math.round(pp.y - tl.y)}px, 0)`;
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

  const SELECT_ARROW =
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2356707A' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")";

  const OVERLAY_CSS = `
  :host{all:initial}
  *,*::before,*::after{box-sizing:border-box;margin:0}
  .wrap{
    --ink:#0F3440;--ink2:#56707A;--ink3:#8A9DA3;--line:#DFE6E7;--bg:#F1F5F5;--paper:#fff;
    --sun:#FFC23D;--sun-ink:#4A3300;--sun-soft:#FFF6DF;--water:#1F7A8C;--water-soft:#E6F0F2;
    --display:ui-rounded,"SF Pro Rounded","Nunito","Segoe UI",system-ui,sans-serif;
    position:fixed;inset:0;z-index:2147483600;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);
    font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;
    -webkit-tap-highlight-color:transparent}
  button,input,select{font:inherit;color:inherit}
  button{cursor:pointer;background:none;border:0;padding:0}
  a{color:inherit}
  :focus-visible{outline:2px solid var(--water);outline-offset:2px}
  svg{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  .star{width:15px;height:15px;fill:var(--sun);stroke:#E0A100;stroke-width:1.2}

  /* ── Kopbalk ── */
  .bar{position:relative;z-index:3;display:grid;gap:10px;padding:12px 16px 12px;background:var(--paper);border-bottom:1px solid var(--line)}
  .top{display:flex;align-items:center;gap:10px;min-height:38px}
  .title{font:700 21px/1.1 var(--display);letter-spacing:-.01em}
  .count{color:var(--ink2);font-size:14px;font-variant-numeric:tabular-nums}
  .spacer{flex:1}
  .icon-btn{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;color:var(--ink)}
  .icon-btn:hover{background:var(--bg)}
  .settings{display:none}
  .searchrow{display:flex;gap:8px}
  .search{flex:1;display:flex;align-items:center;gap:8px;height:44px;padding:0 12px;border-radius:12px;background:var(--bg);color:var(--ink2)}
  .search:focus-within{box-shadow:0 0 0 2px var(--water)}
  .search input{flex:1;min-width:0;height:100%;border:0;background:none;outline:none;color:var(--ink);font-size:16px}
  .search input::placeholder{color:var(--ink3)}
  .filterbtn{display:flex;align-items:center;gap:8px;height:44px;padding:0 14px;border-radius:12px;background:var(--ink);color:#fff;font-weight:600}
  .badge{display:none;place-items:center;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:var(--sun);color:var(--sun-ink);font-size:12px;font-weight:700}
  .filterbtn.has .badge{display:grid}
  .quick{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;margin:0 -16px;padding:0 16px}
  .quick::-webkit-scrollbar{display:none}
  .qchip{flex:none;display:flex;align-items:center;gap:6px;height:34px;padding:0 13px;border:1px solid var(--line);border-radius:999px;background:var(--paper);font-size:14px;font-weight:500;white-space:nowrap}
  .qchip:hover{border-color:var(--ink3)}
  .qchip.on{background:var(--ink);border-color:var(--ink);color:#fff}
  .qchip.fav.on{background:var(--sun);border-color:var(--sun);color:var(--sun-ink)}
  .qchip.fav.on .star{fill:var(--sun-ink);stroke:var(--sun-ink)}

  /* ── Indeling ── */
  main{position:relative;flex:1;display:flex;min-height:0}
  .list{width:430px;flex:none;overflow-y:auto;overscroll-behavior:contain;background:var(--paper);border-right:1px solid var(--line)}
  .map{position:relative;flex:1;overflow:hidden;background:#E3E9E9;cursor:grab;touch-action:none;user-select:none}
  .map.dragging{cursor:grabbing}

  /* ── Lijst ── */
  .city{display:flex;align-items:baseline;gap:8px;padding:24px 16px 8px;font:700 22px/1.2 var(--display);letter-spacing:-.01em}
  .city:first-child{padding-top:16px}
  .city small{font:500 14px/1 system-ui,sans-serif;color:var(--ink3)}
  .wijk{position:sticky;top:0;z-index:2;width:100%;display:flex;align-items:center;gap:8px;padding:10px 16px;
    background:rgba(255,255,255,.94);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
    border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-weight:650;text-align:left}
  .wijk.fav{background:rgba(255,246,223,.96)}
  .wijk .n{margin-left:auto;color:var(--ink3);font-weight:500;font-size:14px;font-variant-numeric:tabular-nums}
  .wijk .chev{color:var(--ink3);transition:transform .15s}
  .wijk.collapsed .chev{transform:rotate(-90deg)}
  .item{position:relative;display:flex;gap:14px;padding:14px 16px;cursor:pointer;border-bottom:1px solid var(--line)}
  .item:last-child{border-bottom:0}
  .item:hover{background:#F8FAFA}
  .item.sel{background:var(--sun-soft)}
  .item.sel::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:4px;border-radius:0 3px 3px 0;background:var(--sun)}
  .thumb{width:108px;height:86px;flex:none;border-radius:10px;object-fit:cover;background:var(--bg)}
  .info{flex:1;min-width:0}
  .price{font:700 19px/1.2 var(--display);font-variant-numeric:tabular-nums;letter-spacing:-.01em}
  .price small{margin-left:4px;font:500 13px/1 system-ui,sans-serif;color:var(--ink3);letter-spacing:0}
  .addr{margin-top:3px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .where{color:var(--ink2);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .facts{display:flex;flex-wrap:wrap;gap:2px 14px;margin-top:6px;font-size:13.5px}
  .facts span{white-space:nowrap}
  .tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .tag{padding:3px 8px;border-radius:6px;background:var(--water-soft);color:var(--water);font-size:12px;font-weight:600;line-height:1.35}
  .tag.age{background:var(--sun-soft);color:var(--sun-ink)}
  .tag.soft{background:var(--bg);color:var(--ink2);font-weight:500}
  .go{flex:none;align-self:flex-start;width:36px;height:36px;margin:-6px -8px 0 0;border-radius:10px;display:grid;place-items:center;color:var(--ink3)}
  .go:hover{background:var(--bg);color:var(--ink)}
  .status,.empty{padding:56px 28px;text-align:center;color:var(--ink2)}
  .status b,.empty b{display:block;margin-bottom:6px;color:var(--ink);font:700 18px/1.3 var(--display)}
  .empty .btn-primary{margin-top:16px;padding:0 18px;flex:none}
  .err b{color:#A3341F}

  /* ── Kaart ── */
  .m-tiles,.m-pins{position:absolute;inset:0}
  .m-pins{pointer-events:none}
  .m-tile{position:absolute;left:0;top:0;width:256px;height:256px;transform-origin:0 0;will-change:transform;user-select:none;-webkit-user-drag:none;filter:saturate(.55) brightness(1.03);opacity:0;transition:opacity .2s}
  .m-tile.ok{opacity:1}
  .m-pin{position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:auto;cursor:pointer;z-index:1;will-change:transform}
  .m-tiles{z-index:0}.m-pins{z-index:3}
  .m-pin.fav{z-index:2}
  .m-pin.sel{z-index:5}
  .pin-in{position:absolute;left:0;top:0;transform:translate(-50%,-50%);display:flex;align-items:center}
  .dot{display:block;width:12px;height:12px;border-radius:50%;background:var(--ink);border:2px solid #fff;box-shadow:0 1px 3px rgba(15,52,64,.45)}
  .m-pin.multi .dot{width:16px;height:16px}
  .m-pin.fav .dot{background:var(--sun);border-color:var(--ink)}
  .m-pin.sel .dot{background:var(--water);transform:scale(1.35)}
  .lbl,.cnt{display:none}
  .map[data-zoom=near] .dot{display:none}
  .map[data-zoom=near] .lbl{display:block;padding:6px 10px;border-radius:999px;background:#fff;color:var(--ink);
    font:700 13px/1 var(--display);font-variant-numeric:tabular-nums;white-space:nowrap;box-shadow:0 1px 5px rgba(15,52,64,.28)}
  .map[data-zoom=near] .cnt{display:grid;place-items:center;min-width:20px;height:20px;margin-left:-7px;padding:0 5px;border:2px solid #fff;border-radius:10px;
    background:var(--ink);color:#fff;font:700 11px/1 system-ui,sans-serif;font-style:normal}
  .map[data-zoom=near] .m-pin.fav .lbl{background:var(--sun);color:var(--sun-ink)}
  .map[data-zoom=near] .m-pin.sel .lbl{background:var(--ink);color:#fff;transform:scale(1.08)}
  .map[data-zoom=near] .m-pin.sel .cnt{background:var(--sun);color:var(--sun-ink)}
  .m-zoom{position:absolute;z-index:6;right:12px;top:12px;display:flex;flex-direction:column;border-radius:12px;background:#fff;box-shadow:0 2px 10px rgba(15,52,64,.18);overflow:hidden}
  .m-zoom button{width:40px;height:40px;display:grid;place-items:center;color:var(--ink)}
  .m-zoom button+button{border-top:1px solid var(--line)}
  .m-zoom button:hover{background:var(--bg)}
  .m-attr{position:absolute;z-index:6;right:0;bottom:0;padding:2px 7px;background:rgba(255,255,255,.85);font-size:11px;color:var(--ink2)}

  /* Woning-kaart onderin de kaart */
  .mcard{position:absolute;left:12px;bottom:14px;z-index:6;display:none;width:min(390px,calc(100% - 24px));
    border-radius:18px;background:#fff;box-shadow:0 10px 30px rgba(15,52,64,.28);overflow:hidden;cursor:default;touch-action:pan-x pan-y}
  .mcard.show{display:block}
  .mc-close{position:absolute;top:8px;right:8px;z-index:2;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.92);color:var(--ink);box-shadow:0 1px 4px rgba(15,52,64,.2)}
  .mc-scroll{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none}
  .mc-scroll::-webkit-scrollbar{display:none}
  .mc-item{flex:0 0 100%;display:flex;gap:12px;padding:12px;scroll-snap-align:start}
  .mc-item .thumb{width:104px;height:104px;border-radius:12px}
  .mc-item .info{padding-right:28px}
  .mc-open{display:inline-flex;align-items:center;gap:6px;height:36px;margin-top:10px;padding:0 13px;border-radius:10px;background:var(--ink);color:#fff;font-size:14px;font-weight:600;text-decoration:none}
  .mc-open svg{width:16px;height:16px}
  .mc-hint{padding:0 12px 11px;color:var(--ink3);font-size:12.5px}

  /* ── Filterpaneel ── */
  .backdrop{position:absolute;inset:0;z-index:10;background:rgba(15,52,64,.38);opacity:0;pointer-events:none;transition:opacity .2s}
  .fsheet{position:absolute;z-index:11;top:0;left:0;bottom:0;width:410px;max-width:100%;display:flex;flex-direction:column;background:#fff;
    box-shadow:0 0 40px rgba(15,52,64,.25);transform:translateX(-105%);transition:transform .25s cubic-bezier(.2,.8,.2,1);visibility:hidden}
  .wrap.sheet-open .backdrop{opacity:1;pointer-events:auto}
  .wrap.sheet-open .fsheet{transform:none;visibility:visible}
  .fs-head{display:flex;align-items:center;gap:10px;padding:16px 16px 8px 20px}
  .fs-head h2{flex:1;font:700 21px/1.2 var(--display)}
  .fs-body{flex:1;overflow-y:auto;display:grid;grid-auto-rows:max-content;align-content:start;gap:20px;padding:8px 20px 20px}
  .field{display:grid;gap:7px}
  .field>span,.group-title{font-size:13px;font-weight:600;color:var(--ink2)}
  .row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .inp{width:100%;height:46px;padding:0 12px;border:1px solid var(--line);border-radius:12px;background:#fff;font-size:16px;color:var(--ink);appearance:none;-webkit-appearance:none}
  .inp:focus{outline:none;border-color:var(--water);box-shadow:0 0 0 3px var(--water-soft)}
  select.inp{padding-right:36px;background-image:${SELECT_ARROW};background-repeat:no-repeat;background-position:right 11px center;background-size:16px}
  .euro{position:relative}
  .euro::before{content:"€";position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--ink3);pointer-events:none}
  .euro .inp{padding-left:28px}
  .beds{display:grid;grid-template-columns:repeat(5,1fr);gap:3px;padding:3px;border-radius:12px;background:var(--bg)}
  .beds button{height:40px;border-radius:9px;font-weight:600;color:var(--ink2)}
  .beds button.on{background:#fff;color:var(--ink);box-shadow:0 1px 3px rgba(15,52,64,.15)}
  .switches{display:grid;border:1px solid var(--line);border-radius:14px;overflow:hidden}
  .switch{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;padding:0 14px;cursor:pointer}
  .switch+.switch{border-top:1px solid var(--line)}
  .switch input{appearance:none;-webkit-appearance:none;position:relative;flex:none;width:48px;height:29px;border-radius:15px;background:#CBD6D8;cursor:pointer;transition:background .15s}
  .switch input::after{content:"";position:absolute;top:3px;left:3px;width:23px;height:23px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .15s}
  .switch input:checked{background:var(--water)}
  .switch input:checked::after{transform:translateX(19px)}
  .fs-meta{display:flex;align-items:center;gap:10px;color:var(--ink3);font-size:13px}
  .linkbtn{display:inline-flex;align-items:center;gap:5px;color:var(--water);font-weight:600}
  .linkbtn svg{width:15px;height:15px}
  .fs-foot{display:flex;gap:10px;padding:12px 20px calc(12px + env(safe-area-inset-bottom));border-top:1px solid var(--line)}
  .btn-ghost{height:48px;padding:0 16px;border-radius:12px;font-weight:600}
  .btn-ghost:hover{background:var(--bg)}
  .btn-primary{flex:1;height:48px;border-radius:12px;background:var(--ink);color:#fff;font-weight:700}
  .btn-primary:hover{background:#174654}

  /* ── Wisselknop lijst/kaart (telefoon) ── */
  .seg{display:none}

  /* ── Losse app ── */
  .wrap.app .settings{display:grid}
  .wrap.app .close{display:none}
  .wrap.app .bar{padding-top:max(12px, env(safe-area-inset-top))}
  .wrap.app .m-attr{padding-bottom:max(2px, env(safe-area-inset-bottom))}

  /* ── Telefoon ── */
  @media (max-width:800px){
    .bar{padding:10px 14px 12px;gap:9px}
    .quick{margin:0 -14px;padding:0 14px}
    .title{font-size:20px}
    main{display:block}
    .list,.map{position:absolute;inset:0;width:auto;border:0}
    .list{padding-bottom:calc(92px + env(safe-area-inset-bottom))}
    .wrap[data-tab=list] .map,.wrap[data-tab=map] .list{visibility:hidden;pointer-events:none}
    .thumb{width:96px;height:80px}
    .item{gap:12px;padding:14px}
    .seg{position:absolute;left:50%;bottom:calc(18px + env(safe-area-inset-bottom));z-index:7;display:flex;gap:2px;padding:4px;transform:translateX(-50%);
      border-radius:999px;background:var(--ink);box-shadow:0 8px 24px rgba(15,52,64,.35)}
    .seg button{display:flex;align-items:center;gap:7px;height:42px;padding:0 18px;border-radius:999px;color:rgba(255,255,255,.72);font-weight:650}
    .seg button.on{background:#fff;color:var(--ink)}
    .mcard{left:10px;right:10px;width:auto;bottom:calc(80px + env(safe-area-inset-bottom))}
    .m-attr{bottom:auto;top:0;right:auto;left:0;border-radius:0 0 8px 0}
    .fsheet{top:auto;right:0;width:auto;max-height:90%;border-radius:22px 22px 0 0;transform:translateY(105%)}
    .fsheet::before{content:"";align-self:center;width:38px;height:5px;margin-top:8px;border-radius:3px;background:var(--line)}
    .fs-head{padding-top:8px}
  }
  @media (prefers-reduced-motion:reduce){*{transition:none!important}}
  `;

  const advUrl = (i) => `${SITE}/nl-NL/aanbod/advertentie/${i.slug}`;
  const whereText = (i) => [...new Set([i.buurt || i.wijk, i.city].filter(Boolean))].join(", ");

  function factsHtml(i) {
    const f = [];
    if (i.beds) f.push(`${i.beds} ${i.beds === 1 ? "slaapkamer" : "slaapkamers"}`);
    if (i.m2) f.push(`${i.m2} m²`);
    if (i.energy) f.push(`Label ${esc(i.energy)}`);
    if (i.balcony) f.push(esc(i.balcony));
    return f.length ? `<div class="facts">${f.map((x) => `<span>${x}</span>`).join("")}</div>` : "";
  }

  function tagsHtml(i) {
    const t = [];
    if (i.model) t.push(`<span class="tag">${esc(i.model)}</span>`);
    if (i.doelgroep) t.push(`<span class="tag age">${esc(i.doelgroep)}</span>`);
    for (const h of highlightsNl(i.highlights)) t.push(`<span class="tag soft">${esc(h)}</span>`);
    const s = startText(i.start);
    if (s) t.push(`<span class="tag soft">${esc(s)}</span>`);
    return t.length ? `<div class="tags">${t.join("")}</div>` : "";
  }

  function priceHtml(i) {
    return `<div class="price" title="Kale huur ${esc(moneyText(i.rent))}, totaal ${esc(moneyText(i.gross))}">${moneyKort(i.rent)}<small>kaal, ${moneyKort(i.gross)} totaal</small></div>`;
  }

  const thumbHtml = (i, lazy = true) =>
    i.thumb ? `<img class="thumb"${lazy ? ' loading="lazy"' : ""} src="${esc(i.thumb)}" alt="">` : `<div class="thumb"></div>`;

  function itemHtml(i) {
    return `<article class="item${i.id === selectedId ? " sel" : ""}" data-id="${esc(i.id)}">
      ${thumbHtml(i)}
      <div class="info">
        ${priceHtml(i)}
        <div class="addr">${i.fav && filters.sort !== "wijk" ? I.star + " " : ""}${esc(i.address)}</div>
        <div class="where">${esc(whereText(i))}</div>
        ${factsHtml(i)}
        ${tagsHtml(i)}
      </div>
      <a class="go" href="${esc(advUrl(i))}" target="_blank" rel="noopener" aria-label="Open advertentie op Woonnet">${I.ext}</a>
    </article>`;
  }

  function cardItemHtml(i) {
    return `<div class="mc-item">
      ${thumbHtml(i, false)}
      <div class="info">
        ${priceHtml(i)}
        <div class="addr">${esc(i.address)}</div>
        <div class="where">${esc(whereText(i))}</div>
        ${factsHtml(i)}
        <a class="mc-open" href="${esc(advUrl(i))}" target="_blank" rel="noopener">Open op Woonnet ${I.ext}</a>
      </div>
    </div>`;
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

  function saveFilters() {
    store.set(FILTER_KEY, filters, localStorage);
  }

  function buildOverlay() {
    const host = document.createElement("div");
    host.id = "wnr-overzicht-host";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${OVERLAY_CSS}</style>
      <div class="wrap${APP_MODE ? " app" : ""}" data-tab="list">
        <header class="bar">
          <div class="top">
            <h1 class="title">Woonnet kaart</h1>
            <span class="count"></span>
            <span class="spacer"></span>
            <button class="icon-btn settings" data-act="settings" aria-label="Favoriete gebieden instellen">${I.gear}</button>
            <button class="icon-btn close" data-act="close" aria-label="Sluiten">${I.x}</button>
          </div>
          <div class="searchrow">
            <label class="search">${I.search}<input type="search" data-f="q" placeholder="Zoek straat of buurt" enterkeyhint="search"></label>
            <button class="filterbtn" data-act="filters">${I.sliders}<span>Filters</span><span class="badge"></span></button>
          </div>
          <div class="quick">
            <button class="qchip fav" data-quick="favOnly">${I.star}Favorieten</button>
            <button class="qchip" data-quick="beds2">2+ slaapkamers</button>
            <button class="qchip" data-quick="balcony">Balkon</button>
            <button class="qchip" data-quick="noage">Zonder leeftijdseis</button>
            <button class="qchip" data-quick="loting">WoningLoting</button>
          </div>
        </header>
        <main>
          <div class="list"></div>
          <div class="map"></div>
        </main>
        <nav class="seg" aria-label="Weergave">
          <button data-tab="list" class="on">${I.list}Lijst</button>
          <button data-tab="map">${I.map}Kaart</button>
        </nav>
        <div class="backdrop" data-act="sheet-close"></div>
        <aside class="fsheet" aria-label="Filters">
          <div class="fs-head"><h2>Filters</h2><button class="icon-btn" data-act="sheet-close" aria-label="Filters sluiten">${I.x}</button></div>
          <div class="fs-body">
            <div class="row2">
              <label class="field"><span>Plaats</span><select class="inp" data-f="city"></select></label>
              <label class="field"><span>Wijk</span><select class="inp" data-f="wijk"></select></label>
            </div>
            <div class="row2">
              <label class="field"><span>Max. kale huur</span><span class="euro"><input class="inp" data-f="maxRent" inputmode="decimal" placeholder="Geen max."></span></label>
              <label class="field"><span>Min. oppervlakte</span><input class="inp" data-f="minM2" inputmode="numeric" placeholder="m²"></label>
            </div>
            <div class="field"><span class="group-title">Slaapkamers</span>
              <div class="beds" role="group" aria-label="Minimaal aantal slaapkamers">
                <button data-beds="0">Alle</button><button data-beds="1">1+</button><button data-beds="2">2+</button><button data-beds="3">3+</button><button data-beds="4">4+</button>
              </div>
            </div>
            <div class="row2">
              <label class="field"><span>Zoekmodel</span><select class="inp" data-f="model"></select></label>
              <label class="field"><span>Doelgroep</span><select class="inp" data-f="doelgroep"></select></label>
            </div>
            <div class="switches">
              <label class="switch"><span>Alleen favoriete gebieden</span><input type="checkbox" data-f="favOnly"></label>
              <label class="switch"><span>Met balkon</span><input type="checkbox" data-f="balcony"></label>
            </div>
            <label class="field"><span>Sorteren</span>
              <select class="inp" data-f="sort">
                <option value="wijk">Per wijk, goedkoopste eerst</option>
                <option value="prijs">Huur, laag naar hoog</option>
                <option value="prijsAf">Huur, hoog naar laag</option>
                <option value="m2">Grootste eerst</option>
                <option value="start">Reageerdatum</option>
              </select>
            </label>
            <div class="fs-meta"><span class="updated"></span><button class="linkbtn" data-act="refresh">${I.refresh}Ververs aanbod</button></div>
          </div>
          <div class="fs-foot">
            <button class="btn-ghost" data-act="reset">Wis alles</button>
            <button class="btn-primary apply" data-act="sheet-close">Toon woningen</button>
          </div>
        </aside>
      </div>`;
    document.body.appendChild(host);

    const $ = (s) => root.querySelector(s);
    const o = { host, root, $, wrap: $(".wrap"), list: $(".list"), count: $(".count") };
    o.map = new TinyMap($(".map"), {
      onPinClick: (pin) => selectPin(pin, false),
      onBackgroundClick: () => clearSelection(),
    });
    o.mcard = document.createElement("div");
    o.mcard.className = "mcard";
    $(".map").appendChild(o.mcard);

    root.addEventListener("input", (e) => {
      const f = e.target.dataset?.f;
      if (!f) return;
      filters[f] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
      if (f === "city") filters.wijk = "";
      saveFilters();
      render(true);
    });

    root.addEventListener("click", (e) => {
      const actEl = e.target.closest("[data-act]");
      const act = actEl?.dataset.act;
      if (act === "close") return closeOverlay();
      if (act === "filters") return o.wrap.classList.add("sheet-open");
      if (act === "sheet-close") return o.wrap.classList.remove("sheet-open");
      if (act === "card-close") return clearSelection();
      if (act === "reset") {
        filters = { ...DEFAULT_FILTERS };
        saveFilters();
        return render(true);
      }
      if (act === "refresh") {
        o.wrap.classList.remove("sheet-open");
        return refresh(true);
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
      const quick = e.target.closest("[data-quick]")?.dataset.quick;
      if (quick) {
        if (quick === "favOnly") filters.favOnly = !filters.favOnly;
        if (quick === "balcony") filters.balcony = !filters.balcony;
        if (quick === "beds2") filters.minBeds = filters.minBeds === "2" ? "0" : "2";
        if (quick === "noage") filters.doelgroep = filters.doelgroep === "geen" ? "" : "geen";
        if (quick === "loting") filters.model = filters.model === "WoningLoting" ? "" : "WoningLoting";
        saveFilters();
        return render(true);
      }
      const beds = e.target.closest("[data-beds]")?.dataset.beds;
      if (beds !== undefined) {
        filters.minBeds = beds;
        saveFilters();
        return render(true);
      }
      const tab = e.target.closest(".seg [data-tab]")?.dataset.tab;
      if (tab) return setTab(tab);
      const wijkBtn = e.target.closest(".wijk");
      if (wijkBtn) {
        const k = wijkBtn.dataset.key;
        collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k);
        return renderList();
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
      o.pins?.forEach((p) =>
        p.el.classList.toggle("sel", p.items.some((i) => i.id === selectedId) || (!!it && p.items.some((i) => i.id === it.dataset.id)))
      );
    });
    return o;
  }

  const isMobile = () => window.matchMedia("(max-width: 800px)").matches;

  function setTab(tab) {
    overlay.wrap.dataset.tab = tab;
    overlay.root.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    if (tab === "map") overlay.map.render();
  }

  function activeFilterCount() {
    return Object.keys(DEFAULT_FILTERS).filter(
      (k) => k !== "sort" && k !== "q" && String(filters[k]) !== String(DEFAULT_FILTERS[k])
    ).length;
  }

  function showCard(pin) {
    const n = pin.items.length;
    overlay.mcard.innerHTML =
      `<button class="mc-close" data-act="card-close" aria-label="Sluiten">${I.x}</button>` +
      `<div class="mc-scroll">${pin.items.map(cardItemHtml).join("")}</div>` +
      (n > 1 ? `<div class="mc-hint">Veeg voor de andere ${n - 1} ${n - 1 === 1 ? "woning" : "woningen"} op dit adres</div>` : "");
    overlay.mcard.classList.add("show");
  }

  function clearSelection() {
    selectedId = null;
    overlay.mcard.classList.remove("show");
    overlay.pins?.forEach((p) => p.el.classList.remove("sel"));
    renderList();
  }

  function selectPin(pin, fromList) {
    if (!fromList) selectedId = pin.items[0].id;
    overlay.pins.forEach((p) => p.el.classList.toggle("sel", p === pin));
    if (fromList) overlay.map.flyTo(pin.lat, pin.lng, Math.max(Math.round(overlay.map.z), 15));
    showCard(pin);
    renderList();
    const el = overlay.list.querySelector(`.item[data-id="${CSS.escape(selectedId)}"]`);
    if (el && !fromList && !isMobile()) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  let lastFiltered = [];

  function render(refit) {
    if (!overlay || !data) return;
    const o = overlay;
    const all = data.items;
    for (const i of all) i.fav = isFav(i.line3 || i.city); // favorieten kunnen veranderd zijn

    // Keuzelijsten vullen
    const cities = uniq(all.map((i) => i.city));
    const wijken = uniq(all.filter((i) => !filters.city || i.city === filters.city).map((i) => i.wijk));
    const models = uniq(all.map((i) => i.model));
    const groepen = uniq(all.map((i) => i.doelgroep));
    o.$('[data-f="city"]').innerHTML = options(cities, filters.city, "Alle plaatsen");
    o.$('[data-f="wijk"]').innerHTML = options(wijken, filters.wijk, "Alle wijken");
    o.$('[data-f="model"]').innerHTML = options(models, filters.model, "Alle");
    o.$('[data-f="doelgroep"]').innerHTML =
      `<option value="">Iedereen</option><option value="geen"${filters.doelgroep === "geen" ? " selected" : ""}>Zonder leeftijdseis</option>` +
      groepen.map((g) => `<option value="${esc(g)}"${g === filters.doelgroep ? " selected" : ""}>Alleen ${esc(g)}</option>`).join("");
    for (const el of o.root.querySelectorAll("[data-f]")) {
      const f = el.dataset.f;
      if (el.type === "checkbox") el.checked = !!filters[f];
      else if (el.tagName !== "SELECT" || f === "sort") {
        if (el !== o.root.activeElement) el.value = filters[f];
      }
    }
    o.root.querySelectorAll("[data-beds]").forEach((b) => b.classList.toggle("on", b.dataset.beds === String(filters.minBeds || "0")));
    const quickOn = {
      favOnly: !!filters.favOnly,
      balcony: !!filters.balcony,
      beds2: filters.minBeds === "2",
      noage: filters.doelgroep === "geen",
      loting: filters.model === "WoningLoting",
    };
    o.root.querySelectorAll("[data-quick]").forEach((b) => b.classList.toggle("on", !!quickOn[b.dataset.quick]));

    lastFiltered = applyFilters(all);
    const n = lastFiltered.length;
    o.count.textContent = n === all.length ? `${all.length} woningen` : `${n} van ${all.length}`;
    const nf = activeFilterCount();
    o.$(".filterbtn").classList.toggle("has", nf > 0);
    o.$(".badge").textContent = nf;
    o.$(".apply").textContent = n === 0 ? "Geen woningen" : `Toon ${n} ${n === 1 ? "woning" : "woningen"}`;
    o.$(".updated").textContent = "Bijgewerkt om " + new Date(data.time).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });

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
    for (const p of o.pins) {
      const lo = Math.min(...p.items.map((i) => (i.rent ? i.rent.lo : Infinity)));
      p.label = isFinite(lo) ? euroKort(lo) + (p.items.length > 1 ? "+" : "") : "?";
    }
    o.mcard.classList.remove("show");
    o.map.setPins(o.pins);
    if (selectedId) {
      const sel = o.pins.find((p) => p.items.some((i) => i.id === selectedId));
      if (sel) sel.el.classList.add("sel");
      else selectedId = null;
    }
    if (refit) o.map.fit(o.pins);
    renderList();
  }

  function renderList() {
    const o = overlay;
    if (!lastFiltered.length) {
      o.list.innerHTML = `<div class="empty"><b>Geen woningen gevonden</b>Pas je filters aan of wis ze om weer alles te zien.<br><button class="btn-primary" data-act="reset">Wis filters</button></div>`;
      return;
    }
    const scroll = o.list.scrollTop;
    if (filters.sort !== "wijk") {
      o.list.innerHTML = lastFiltered.map(itemHtml).join("");
      o.list.scrollTop = scroll;
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
      const total = [...wijken.values()].reduce((s, l) => s + l.length, 0);
      html += `<h2 class="city">${esc(city)}<small>${total}</small></h2>`;
      const wList = [...wijken.entries()].sort((a, b) => favScore(a[1]) - favScore(b[1]) || a[0].localeCompare(b[0], "nl"));
      for (const [wijk, items] of wList) {
        const key = city + "|" + wijk;
        const fav = items.some((i) => i.fav);
        const shut = collapsed.has(key);
        html += `<button class="wijk${fav ? " fav" : ""}${shut ? " collapsed" : ""}" data-key="${esc(key)}" aria-expanded="${!shut}">
          ${fav ? I.star : ""}<span>${esc(wijk)}</span><span class="n">${items.length}</span>${I.chev}</button>`;
        if (!shut) html += items.map(itemHtml).join("");
      }
    }
    o.list.innerHTML = html;
    o.list.scrollTop = scroll;
  }

  function setStatus(html) {
    if (!overlay) return;
    overlay.list.innerHTML = html;
  }

  function refresh(force) {
    if (!data || force) setStatus(`<div class="status"><b>Aanbod ophalen</b>Even geduld…</div>`);
    loadAll(force)
      .then(() => render(true))
      .catch((e) =>
        setStatus(`<div class="status err"><b>Het aanbod kon niet worden opgehaald</b>${esc(e.message || e)}<br><br><button class="btn-primary" data-act="refresh">Probeer opnieuw</button></div>`)
      );
  }

  listeners.add((m) => {
    if (overlay && m.loading)
      setStatus(`<div class="status"><b>Aanbod ophalen</b>${m.count ? `${m.count} woningen binnen…` : "Even geduld…"}</div>`);
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
    if (e.key !== "Escape" || !overlay || overlay.host.style.display === "none") return;
    if (overlay.wrap.classList.contains("sheet-open")) overlay.wrap.classList.remove("sheet-open");
    else if (overlay.mcard.classList.contains("show")) clearSelection();
    else if (!APP_MODE) closeOverlay();
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
    b.innerHTML = `${I.map}Kaart &amp; overzicht`;
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
