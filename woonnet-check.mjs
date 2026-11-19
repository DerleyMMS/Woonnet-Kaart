// Woonnet Rijnmond – meldingen bij nieuwe woningen
// Draait via GitHub Actions (zie .github/workflows/woonnet-meldingen.yml).
// Haalt het aanbod op, vergelijkt met de vorige keer en stuurt nieuwe,
// passende woningen als melding naar de ntfy-app op je telefoon.
//
// Instellingen (GitHub → Settings → Secrets and variables → Actions):
//   Secret   NTFY_TOPIC           jouw geheime ntfy-onderwerp (verplicht)
//   Variable GEBIEDEN             bijv. "Bergschenhoek, Berkel en Rodenrijs, Hillegersberg, Schiebroek"
//   Variable MAX_HUUR             max. kale huur, bijv. 1100
//   Variable MIN_SLAAPKAMERS      bijv. 1
//   Variable ZONDER_LEEFTIJDSEIS  "ja" om 55+/65+/jongerenwoningen over te slaan
//   Variable APP_URL              (optioneel) adres van je Woonnet-kaart-app
// Leeg laten = geen filter op dat punt.

import { readFile, writeFile } from "node:fs/promises";

const env = (k) => (process.env[k] || "").trim();
const TOPIC = env("NTFY_TOPIC");
const GEBIEDEN = env("GEBIEDEN").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const MAX_HUUR = parseFloat(env("MAX_HUUR").replace(",", ".")) || 0;
const MIN_SLPK = parseInt(env("MIN_SLAAPKAMERS"), 10) || 0;
const ZONDER_LEEFTIJD = /^(ja|yes|true|1)$/i.test(env("ZONDER_LEEFTIJDSEIS"));
const APP_URL = env("APP_URL");
const NTFY_SERVER = env("NTFY_SERVER") || "https://ntfy.sh";
const STATE_FILE = new URL("./woonnet-gezien.json", import.meta.url);

const SITE = "https://www.woonnetrijnmond.nl";
const GRAPHQL_URL = "https://housing.mesh-router.embracecloud.nl/graphql";
const HEADERS = {
  accept: "application/graphql-response+json,application/json;q=0.9",
  "apollographql-client-name": "Portal UI - woonnetrijnmond",
  "apollographql-client-version": "1.0.0",
  "content-type": "application/json",
  "x-ec-portal-id": "UG9ydGFsUHJvdmlkZXJQb3J0YWw6NDg0MDExNWQtZTk4NC00MzQwLTgxYTktZjNjODZiYjM0MDk2",
  "x-ec-tenant-id": "woonnetrijnmond",
};
const QUERY = `query wnrOverzicht($first: Int, $after: String, $filter: HousingWherePublicationFilterInput, $locale: String) {
  housingPublications(orderBy: STARTDATE_ASC, filter: $filter, locale: $locale) {
    nodes(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id startTime
        allocationProcess { name }
        unit {
          slug { value }
          suitability
          basicRent { exact min max }
          grossRent { exact min max }
          numberOfBedrooms { exact min max }
          dimensions { edges { node { area surfaceArea } } }
          thumbnails: photos(size: PRESENTATION) { edges { node { url } } }
          location { addressLine1 addressLine2 addressLine3 }
        }
      } }
    }
  }
}`;
const FILTER = {
  and: [
    { or: [{ suitability: { eq: "NO_PREFERENCE" } }] },
    { or: [{ unitUsageType: { eq: "STANDARD" } }, { unitUsageType: { eq: "CLUSTER" } }] },
  ],
};

const money = (v) => (v ? v.exact || v.min || v.max || 0 : 0);
const euro = (n) => "€ " + Math.round(n).toLocaleString("nl-NL");

function normalize(node) {
  const u = node.unit || {};
  const loc = u.location || {};
  const parts = String(loc.addressLine3 || "").split(",").map((s) => s.trim()).filter(Boolean);
  const total = (u.dimensions?.edges || []).map((e) => e.node).find((n) => n.area === "TOTAL");
  return {
    id: node.id,
    url: `${SITE}/nl-NL/aanbod/advertentie/${u.slug?.value || ""}`,
    address: loc.addressLine1 || "",
    city: loc.addressLine2 || parts[parts.length - 1] || "",
    wijk: parts.length >= 3 ? parts[0] : parts[0] || "",
    buurt: parts.length >= 3 ? parts[1] : "",
    line3: loc.addressLine3 || "",
    rent: money(u.basicRent),
    gross: money(u.grossRent),
    beds: u.numberOfBedrooms ? u.numberOfBedrooms.exact || u.numberOfBedrooms.min || 0 : 0,
    m2: total && total.surfaceArea ? Math.round(total.surfaceArea / 1e6) : 0,
    model: node.allocationProcess?.name || "",
    suitability: u.suitability || "",
    start: node.startTime || "",
    thumb: u.thumbnails?.edges?.[0]?.node?.url || "",
  };
}

async function fetchAll() {
  const items = [];
  let after = null;
  for (let page = 0; page < 40; page++) {
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ operationName: "wnrOverzicht", query: QUERY, variables: { first: 30, after, locale: "nl-NL", filter: FILTER } }),
    });
    if (!res.ok) throw new Error(`Woonnet gaf status ${res.status}`);
    const json = await res.json();
    if (json.errors?.length && !json.data) throw new Error(json.errors[0].message);
    const nodes = json?.data?.housingPublications?.nodes;
    for (const e of nodes?.edges || []) items.push(normalize(e.node));
    if (!nodes?.pageInfo?.hasNextPage) break;
    after = nodes.pageInfo.endCursor;
  }
  return items;
}

const heeftLeeftijdseis = (s) => s && s !== "NONE" && s !== "NO_PREFERENCE";

function past(i) {
  if (GEBIEDEN.length && !GEBIEDEN.some((g) => `${i.line3} ${i.city}`.toLowerCase().includes(g))) return false;
  if (MAX_HUUR && (!i.rent || i.rent > MAX_HUUR)) return false;
  if (MIN_SLPK && i.beds < MIN_SLPK) return false;
  if (ZONDER_LEEFTIJD && heeftLeeftijdseis(i.suitability)) return false;
  return true;
}

function startTekst(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d) || d <= new Date()) return "Reageren kan nu";
  const opts = { timeZone: "Europe/Amsterdam" };
  const dag = d.toLocaleDateString("nl-NL", { ...opts, weekday: "short", day: "numeric", month: "short" });
  const tijd = d.toLocaleTimeString("nl-NL", { ...opts, hour: "2-digit", minute: "2-digit" });
  return `Reageren vanaf ${dag}, ${tijd}`;
}

// Verstuurt een melding; probeert het tot 3 keer. Geeft true terug als het lukte.
async function stuur(msg) {
  for (let poging = 1; poging <= 3; poging++) {
    try {
      const res = await fetch(NTFY_SERVER, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: TOPIC, ...msg }),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return true;
      console.warn(`ntfy gaf status ${res.status}: ${await res.text()}`);
      if (res.status < 500 && res.status !== 429) return false; // opnieuw proberen heeft geen zin
    } catch (e) {
      console.warn(`ntfy niet bereikbaar (poging ${poging}/3): ${e.cause?.code || e.name || e.message}`);
    }
    if (poging < 3) await new Promise((r) => setTimeout(r, poging * 5000));
  }
  return false;
}

function meldingVoor(i) {
  const waar = [i.buurt || i.wijk, i.city].filter(Boolean).join(", ");
  const kenmerken = [i.beds ? `${i.beds} ${i.beds === 1 ? "slaapkamer" : "slaapkamers"}` : "", i.m2 ? `${i.m2} m²` : ""].filter(Boolean).join(", ");
  const actions = [{ action: "view", label: "Open op Woonnet", url: i.url }];
  if (APP_URL) actions.push({ action: "view", label: "Open kaart", url: APP_URL });
  return {
    title: `Nieuw: ${i.address}, ${i.city}`,
    message: [
      `${euro(i.rent)} kaal, ${euro(i.gross)} totaal`,
      [kenmerken, waar].filter(Boolean).join(" in "),
      [i.model, startTekst(i.start)].filter(Boolean).join(". "),
    ].filter(Boolean).join("\n"),
    tags: ["house"],
    priority: 4,
    click: i.url,
    ...(i.thumb ? { attach: i.thumb, filename: "woning.jpg" } : {}),
    actions,
  };
}

async function main() {
  if (!TOPIC) {
    console.error("NTFY_TOPIC ontbreekt. Voeg het toe onder Settings → Secrets and variables → Actions.");
    process.exitCode = 1;
    return;
  }

  let state = null;
  try {
    state = JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch (_) {}

  let items;
  try {
    items = await fetchAll();
  } catch (e) {
    // Tijdelijke storing bij Woonnet: volgende keer opnieuw, geen foutmelding-mails.
    console.warn("Woonnet niet bereikbaar:", e.message);
    return;
  }
  if (!items.length) {
    console.warn("Geen woningen ontvangen; vorige stand blijft bewaard.");
    return;
  }

  const gezien = new Set(state?.ids || []);
  const nieuw = items.filter((i) => !gezien.has(i.id));
  const passend = nieuw.filter(past);
  console.log(`${items.length} woningen, ${nieuw.length} nieuw, ${passend.length} passend.`);
  console.log(
    `Filters: gebieden=${GEBIEDEN.length ? GEBIEDEN.join(" | ") : "(alle)"}, max huur=${MAX_HUUR || "(geen)"}, ` +
      `min slaapkamers=${MIN_SLPK || "(geen)"}, zonder leeftijdseis=${ZONDER_LEEFTIJD ? "ja" : "nee"}`
  );

  let verstuurd = true;
  if (!state) {
    const nu = items.filter(past).length;
    verstuurd = await stuur({
      title: "Woonnet-meldingen staan aan",
      message: `Ik houd ${items.length} woningen in de gaten, waarvan ${nu} nu al bij je filters passen. Voortaan krijg je alleen een melding bij nieuwe woningen.`,
      tags: ["white_check_mark"],
      ...(APP_URL ? { click: APP_URL } : {}),
    });
  } else if (passend.length > 5) {
    const regels = passend.slice(0, 8).map((i) => `${euro(i.rent)}  ${i.address}, ${i.buurt || i.city}`);
    if (passend.length > 8) regels.push(`en nog ${passend.length - 8}`);
    verstuurd = await stuur({
      title: `${passend.length} nieuwe woningen op Woonnet`,
      message: regels.join("\n"),
      tags: ["house"],
      priority: 4,
      click: APP_URL || SITE,
    });
  } else {
    for (const i of passend) verstuurd = (await stuur(meldingVoor(i))) && verstuurd;
  }

  if (!verstuurd) {
    // Niets opslaan: de volgende run probeert dezelfde woningen opnieuw te melden.
    console.log("::warning title=Melding niet verstuurd::ntfy.sh was niet bereikbaar. De volgende run probeert het opnieuw.");
    return;
  }

  // Alleen opslaan als de lijst veranderd is (voorkomt een commit elk kwartier).
  const ids = items.map((i) => i.id).sort();
  if (!state || JSON.stringify(ids) !== JSON.stringify([...(state.ids || [])].sort())) {
    await writeFile(STATE_FILE, JSON.stringify({ bijgewerkt: new Date().toISOString(), ids }, null, 1) + "\n");
    console.log("Stand opgeslagen.");
  }
}

await main();
