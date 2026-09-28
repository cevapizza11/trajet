/* =====================================================================
   Trajet Model 3 — mise à jour automatique de la liste des bornes
   Chaque lundi à 4 h (heure de Paris) :
   1. télécharge la base nationale officielle IRVE (Tesla + Powerdot) pour la France
      + les Superchargers Tesla et bornes Powerdot d'Espagne et d'Italie (OpenStreetMap)
   2. la regroupe par station (format compact identique à l'app)
   3. l'enregistre dans Firestore : bornes/france  { t, n, data }
   L'app lit ce document : tous tes appareils ont la même liste à jour.
   ===================================================================== */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

// Deux sources officielles (si la 1re est en panne, on essaie la 2e)
const ODS = [
  { host: "https://odre.opendatasoft.com", ds: "bornes-irve" },
  { host: "https://public.opendatasoft.com", ds: "mobilityref-france-irve-220" },
];

async function getJSON(url, ms) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status} sur ${url}`);
  return r.json();
}

// Regroupe les points de charge par station -> [lat, lon, op(0=Tesla,1=Powerdot), kW max, nom, nb points, commune, adresse]
function groupBase(rows, f) {
  const m = new Map();
  for (const r of rows) {
    const txt = [r[f.op], r[f.en], r[f.st]].filter(Boolean).join(" ").toLowerCase();
    const op = txt.includes("tesla") ? 0 : /power ?dot/.test(txt) ? 1 : -1;
    if (op < 0) continue;
    let lat, lon;
    const g = f.geo && r[f.geo];
    if (g && typeof g === "object") { lat = +g.lat; lon = +g.lon; }
    else if (f.xy && r[f.xy]) {
      const x = String(r[f.xy]).match(/-?\d+(\.\d+)?/g);
      if (x && x.length >= 2) { lon = +x[0]; lat = +x[1]; }
    }
    if (!isFinite(lat) || !isFinite(lon)) continue;
    if (lat < 35 && lon > 35) { const t = lat; lat = lon; lon = t; } // coordonnées inversées
    if (lat < 35 || lat > 72) continue;
    let kw = parseFloat(r[f.kw]) || 0;
    if (kw > 1000) kw /= 1000;
    const key = (r[f.id] || "") + "|" + lat.toFixed(3) + "," + lon.toFixed(3);
    const e = m.get(key);
    if (e) { e[3] = Math.max(e[3], kw); e[5]++; }
    else m.set(key, [+lat.toFixed(5), +lon.toFixed(5), op, kw, String(r[f.st] || "").slice(0, 60), 1, String(r[f.city] || "").slice(0, 40),
      String(r[f.addr] || "").replace(/\s+/g, " ").trim().slice(0, 90)]);
  }
  return [...m.values()];
}

async function downloadBase() {
  let lastErr;
  for (const src of ODS) {
    try {
      const api = `${src.host}/api/explore/v2.1/catalog/datasets/${src.ds}`;
      const meta = await getJSON(api, 20000);
      const F = meta.fields || [];
      const find = (...res) => { for (const re of res) { const x = F.find((f) => re.test(f.name)); if (x) return x.name; } };
      const f = {
        op: find(/^nom_operateur$/, /operateur/), en: find(/^nom_enseigne$/, /enseigne/), st: find(/^nom_station$/, /station$/),
        id: find(/^id_station_itinerance$/, /id_station/), kw: find(/^puissance_nominale$/, /puissance/),
        geo: (F.find((x) => x.type === "geo_point_2d") || {}).name, xy: find(/coordonnees/i),
        city: find(/^consolidated_commune$/, /^commune$/, /commune/),
        addr: find(/^adresse_station$/, /adresse/),
      };
      if (!f.kw || !(f.geo || f.xy) || !(f.op || f.en)) throw new Error("format de données inattendu");
      const sel = [...new Set(Object.values(f).filter(Boolean))].join(",");
      const where = '"tesla" OR "powerdot" OR "power dot"';
      const rows = await getJSON(`${api}/exports/json?select=${encodeURIComponent(sel)}&where=${encodeURIComponent(where)}`, 120000);
      const list = groupBase(rows, f);
      if (list.length < 20) throw new Error(`liste trop courte (${list.length})`);
      logger.info(`Source ${src.host} : ${rows.length} points de charge -> ${list.length} stations`);
      return list;
    } catch (e) {
      logger.warn(`Source ${src.host} en échec : ${e.message}`);
      lastErr = e;
    }
  }
  throw lastErr || new Error("aucune source disponible");
}


/* ---------- Espagne + Italie : OpenStreetMap (Overpass) ---------- */
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const PAYS_EU = ["ES", "IT"];

function parseOsm(el) {
  const t = el.tags || {};
  const lat = el.lat ?? (el.center && el.center.lat), lon = el.lon ?? (el.center && el.center.lon);
  if (lat == null || lon == null) return null;
  if (t.access === "private" || t.access === "no") return null;
  const txt = [t.operator, t.brand, t.name, t.network].filter(Boolean).join(" ").toLowerCase();
  const op = txt.includes("tesla") ? 0 : /power ?dot/.test(txt) ? 1 : -1;
  if (op < 0) return null;
  if (op === 0 && /destination/.test(txt)) return null; // chargeurs "destination" (lents, hôtels)
  let kw = 0;
  for (const [k, v] of Object.entries(t)) {
    if (!/(^|:)output$/.test(k) && k !== "maxpower") continue;
    const str = String(v), isW = /\d\s*W\b/.test(str) && !/kW/i.test(str);
    (str.match(/[\d.]+/g) || []).forEach((n) => { let x = parseFloat(n); if (isW && x > 1000) x /= 1000; if (x > kw && x <= 400) kw = x; });
  }
  const addr = [[t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" "), [t["addr:postcode"], t["addr:city"]].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [+(+lat).toFixed(5), +(+lon).toFixed(5), op, kw, String(t.name || (op === 0 ? "Tesla Supercharger" : "Powerdot")).slice(0, 60),
    parseInt(t.capacity, 10) || 1, String(t["addr:city"] || "").slice(0, 40), addr.slice(0, 90)];
}

async function downloadEU() {
  const area = PAYS_EU.map((c) => `area["ISO3166-1"="${c}"][admin_level=2];`).join("");
  const f = ["operator", "brand", "network", "name"].map((k) => `nwr["amenity"="charging_station"]["${k}"~"tesla|power ?dot",i](area.pays);`).join("");
  const q = `[out:json][timeout:240];(${area})->.pays;(${f});out center tags;`;
  let lastErr;
  for (const ep of OVERPASS) {
    try {
      const r = await fetch(ep, { method: "POST", body: new URLSearchParams({ data: q }), signal: AbortSignal.timeout(250000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.remark && !(j.elements || []).length) throw new Error(j.remark);
      const out = [];
      for (const el of j.elements || []) {
        const c = parseOsm(el); if (!c) continue;
        // doublons (même opérateur à moins de ~120 m) : on garde la plus puissante
        const dup = out.find((o) => o[2] === c[2] && Math.abs(o[0] - c[0]) < 0.0011 && Math.abs(o[1] - c[1]) < 0.0015);
        if (dup) { if (c[3] > dup[3]) dup[3] = c[3]; if (!dup[7] && c[7]) dup[7] = c[7]; } else out.push(c);
      }
      if (out.length < 20) throw new Error(`liste trop courte (${out.length})`);
      logger.info(`Overpass ${ep} : ${out.length} stations en ${PAYS_EU.join(" + ")}`);
      return out;
    } catch (e) {
      logger.warn(`Overpass ${ep} en échec : ${e.message}`);
      lastErr = e;
    }
  }
  throw lastErr || new Error("Overpass indisponible");
}

exports.majBornesHebdo = onSchedule(
  { schedule: "every monday 04:00", timeZone: "Europe/Paris", region: "europe-west1", timeoutSeconds: 540, memory: "512MiB", retryCount: 2 },
  async () => {
    const ref = admin.firestore().collection("bornes").doc("france");
    const prev = (await ref.get()).data() || {};
    let fr = null, eu = null;
    try { fr = await downloadBase(); } catch (e) { logger.error(`France : ${e.message} (ancienne liste conservée)`); }
    try { eu = await downloadEU(); } catch (e) { logger.error(`Espagne/Italie : ${e.message} (ancienne liste conservée)`); }
    if (!fr && !eu) throw new Error("aucune source disponible : nouvel essai automatique");
    const data = fr ? JSON.stringify(fr) : prev.data, dataEU = eu ? JSON.stringify(eu) : (prev.dataEU || "[]");
    if (!data) throw new Error("pas de liste France disponible");
    if (data.length + dataEU.length > 950000) throw new Error("liste trop volumineuse pour un document Firestore");
    const nFr = JSON.parse(data).length, nEu = JSON.parse(dataEU).length;
    await ref.set({ t: fr ? Date.now() : (prev.t || Date.now()), tEU: eu ? Date.now() : (prev.tEU || 0), n: nFr + nEu, nFr, nEu, pays: ["FR", ...PAYS_EU], data, dataEU });
    logger.info(`bornes/france mis à jour : ${nFr} stations France + ${nEu} Espagne/Italie`);
  }
);
