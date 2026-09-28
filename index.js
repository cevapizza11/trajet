/* =====================================================================
   Trajet Model 3 — mise à jour automatique de la liste des bornes
   Chaque lundi à 4 h (heure de Paris) :
   1. télécharge la base nationale officielle IRVE (Tesla + Powerdot) pour la France
      + les Superchargers Tesla et bornes Powerdot d'Espagne et d'Italie (OpenStreetMap)
   2. la regroupe par station (format compact identique à l'app)
   3. l'enregistre dans Firestore : bornes/france  { t, n, nFr, nEu, data, dataEU }
      (la France est enregistrée tout de suite, l'Europe ensuite, avec un temps limité)
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

const UA = { "User-Agent": "TrajetModel3/1.0 (maj hebdo bornes)" };

// Un pays : on interroge tous les serveurs Overpass EN MÊME TEMPS, le premier qui répond gagne.
async function paysOverpass(code, ms) {
  const f = ["operator", "brand", "network", "name"].map((k) => `nwr["amenity"="charging_station"]["${k}"~"tesla|power ?dot",i](area.p);`).join("");
  const q = `[out:json][timeout:${Math.floor(ms / 1000) - 10}];area["ISO3166-1"="${code}"][admin_level=2]->.p;(${f});out center tags;`;
  const stop = new AbortController();
  let gagne = false;
  const timer = setTimeout(() => stop.abort(), ms);
  try {
    return await Promise.any(OVERPASS.map(async (ep) => {
      const t0 = Date.now();
      try {
        const r = await fetch(ep, { method: "POST", headers: UA, body: new URLSearchParams({ data: q }), signal: stop.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        const els = j.elements || [];
        if (j.remark && !els.length) throw new Error(j.remark.slice(0, 120));
        if (els.length < 5) throw new Error(`réponse trop courte (${els.length})`);
        gagne = true;
        logger.info(`Overpass ${code} : ${ep} a répondu ${els.length} éléments en ${Math.round((Date.now() - t0) / 1000)} s`);
        return els;
      } catch (e) {
        if (!gagne) logger.warn(`Overpass ${code} : ${ep} en échec (${stop.signal.aborted ? "délai dépassé" : e.message})`);
        throw e;
      }
    }));
  } finally { clearTimeout(timer); stop.abort(); }
}

async function downloadEU(ms) {
  const res = await Promise.allSettled(PAYS_EU.map((c) => paysOverpass(c, ms)));
  const out = [], ok = [];
  res.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    ok.push(PAYS_EU[i]);
    for (const el of r.value) {
      const c = parseOsm(el); if (!c) continue;
      // doublons (même opérateur à moins de ~120 m) : on garde la plus puissante
      const dup = out.find((o) => o[2] === c[2] && Math.abs(o[0] - c[0]) < 0.0011 && Math.abs(o[1] - c[1]) < 0.0015);
      if (dup) { if (c[3] > dup[3]) dup[3] = c[3]; if (!dup[7] && c[7]) dup[7] = c[7]; } else out.push(c);
    }
  });
  return { out, ok };
}

exports.majBornesHebdo = onSchedule(
  { schedule: "every monday 04:00", timeZone: "Europe/Paris", region: "europe-west1", timeoutSeconds: 540, memory: "512MiB", retryCount: 2 },
  async () => {
    const debut = Date.now();
    const ref = admin.firestore().collection("bornes").doc("france");
    const prev = (await ref.get()).data() || {};

    // 1) FRANCE d'abord, enregistrée tout de suite (même si l'Europe échoue ensuite)
    let frOk = false;
    try {
      const fr = await downloadBase();
      await ref.set({ t: Date.now(), data: JSON.stringify(fr), nFr: fr.length, n: fr.length + (prev.nEu || 0) }, { merge: true });
      frOk = true;
      logger.info(`France : ${fr.length} stations enregistrées`);
    } catch (e) { logger.error(`France : ${e.message} (ancienne liste conservée)`); }

    // 2) ESPAGNE + ITALIE, avec un temps limité pour ne jamais dépasser les 9 min
    const reste = 540000 - (Date.now() - debut) - 40000;
    const budget = Math.max(60000, Math.min(240000, reste));
    let euOk = false;
    try {
      const { out, ok } = await downloadEU(budget);
      if (out.length < 20) throw new Error(`liste trop courte (${out.length}), pays reçus : ${ok.join(", ") || "aucun"}`);
      const cur = (await ref.get()).data() || {};
      const nFr = cur.data ? JSON.parse(cur.data).length : 0;
      const dataEU = JSON.stringify(out);
      if ((cur.data || "").length + dataEU.length > 950000) throw new Error("liste trop volumineuse pour un document Firestore");
      await ref.set({ tEU: Date.now(), dataEU, nEu: out.length, nFr, n: nFr + out.length, pays: ["FR", ...ok] }, { merge: true });
      euOk = true;
      logger.info(`Espagne/Italie : ${out.length} stations enregistrées (${ok.join(" + ")})`);
    } catch (e) {
      const msg = e && e.errors ? e.errors.map((x) => x.message).join(" | ") : e.message;
      logger.error(`Espagne/Italie : ${msg} (ancienne liste conservée)`);
    }

    logger.info(`Terminé en ${Math.round((Date.now() - debut) / 1000)} s — France ${frOk ? "OK" : "échec"}, Espagne/Italie ${euOk ? "OK" : "échec"}`);
    if (!frOk && !euOk) throw new Error("aucune source disponible : nouvel essai automatique");
  }
);
