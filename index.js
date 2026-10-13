/* =====================================================================
   Trajet Model 3 — mise à jour automatique de la liste des bornes
   Chaque lundi à 4 h (heure de Paris) :
   1. télécharge la base nationale officielle IRVE (Tesla + Powerdot + Electra) pour la France
      + les bornes Tesla, Powerdot et Electra d'Espagne et d'Italie (OpenStreetMap)
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

// 0 = Tesla, 1 = Powerdot, 2 = Electra (« Electrabel » etc. exclus)
function opCode(txt) {
  txt = String(txt || "").toLowerCase();
  return txt.includes("tesla") ? 0 : /power ?dot/.test(txt) ? 1 : /(^|[^a-z])electra([^a-z]|$)/.test(txt) ? 2 : -1;
}

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
    const op = opCode(txt);
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
      const where = '"tesla" OR "powerdot" OR "power dot" OR "electra"';
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
  const op = opCode(txt);
  if (op < 0) return null;
  if (op === 0 && /destination/.test(txt)) return null; // chargeurs "destination" (lents, hôtels)
  let kw = 0;
  for (const [k, v] of Object.entries(t)) {
    if (!/(^|:)output$/.test(k) && k !== "maxpower") continue;
    const str = String(v), isW = /\d\s*W\b/.test(str) && !/kW/i.test(str);
    (str.match(/[\d.]+/g) || []).forEach((n) => { let x = parseFloat(n); if (isW && x > 1000) x /= 1000; if (x > kw && x <= 400) kw = x; });
  }
  const addr = [[t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" "), [t["addr:postcode"], t["addr:city"]].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [+(+lat).toFixed(5), +(+lon).toFixed(5), op, kw, String(t.name || ["Tesla Supercharger", "Powerdot", "Electra"][op]).slice(0, 60),
    parseInt(t.capacity, 10) || 1, String(t["addr:city"] || "").slice(0, 40), addr.slice(0, 90)];
}

const UA = { "User-Agent": "TrajetModel3/1.0 (maj hebdo bornes)" };

// Un pays : on interroge tous les serveurs Overpass EN MÊME TEMPS, le premier qui répond gagne.
async function paysOverpass(code, ms) {
  // On lit UNE seule fois toutes les bornes du pays, puis on filtre (beaucoup plus rapide, surtout pour l'Italie)
  const f = ["operator", "brand", "network", "name"].map((k) => `nwr.b["${k}"~"tesla|power ?dot|electra",i];`).join("");
  const q = `[out:json][timeout:${Math.floor(ms / 1000) - 10}][maxsize:268435456];area["ISO3166-1"="${code}"][admin_level=2]->.p;nwr["amenity"="charging_station"](area.p)->.b;(${f});out center tags;`;
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

/* ---------- Espagne : liste OFFICIELLE de la DGT (Punto de Acceso Nacional, DATEX II) ----------
   Tous les opérateurs espagnols sont obligés d'y déclarer leurs bornes (loi 7/2021).
   Gros fichier XML (~80 Mo) : lu en flux, site par site, sans tout charger en mémoire. */
const DGT_URL = "https://infocar.dgt.es/datex2/v3/miterd/EnergyInfrastructureTablePublication/electrolineras.xml";
const tag = (n) => `(?:[\\w-]+:)?${n}`;
const RE_SITE_END = new RegExp(`</${tag("energyInfrastructureSite")}>`, "g");
const RE_SITE_START = new RegExp(`<${tag("energyInfrastructureSite")}[\\s>]`);
function texts(xml) { return [...xml.matchAll(/>([^<>]+)</g)].map((m) => m[1].trim()).filter((x) => x && !/^[-\d.\s]+$/.test(x)); }
function block(xml, name) { const m = xml.match(new RegExp(`<${tag(name)}[\\s>][\\s\\S]*?</${tag(name)}>`)); return m ? m[0] : ""; }
function firstNum(xml, name) { const m = xml.match(new RegExp(`<${tag(name)}>\\s*(-?[\\d.]+)\\s*<`)); return m ? +m[1] : NaN; }
function decodeXml(x) { return x.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'"); }

function parseDgtSite(xml, stat) {
  stat.sites++;
  const opBlock = block(xml, "operator");
  const rest = opBlock ? xml.replace(opBlock, "") : xml;
  const nameBlock = block(rest, "name");
  const name = decodeXml(texts(nameBlock)[0] || "");
  const opTxt = decodeXml(texts(opBlock).join(" "));
  const op = opCode(opTxt + " " + name);
  // sonde de diagnostic : stations Powerdot connues (Ibis Cornellà, Diagonal Mar) -> sous quel opérateur sont-elles déclarées ?
  if ((/maresme/i.test(xml) && /cornell/i.test(xml)) || /diagonal mar/i.test(xml) || (/ibis/i.test(name) && /cornell/i.test(xml)))
    stat.probe.push(`${opTxt || "?"} / ${name} / ${texts(block(rest, "address")).filter((x) => !/^[a-z][a-zA-Z]*$/.test(x)).join(" ").slice(0, 60)}`);
  if (opTxt) stat.ops.set(opTxt.slice(0, 40), (stat.ops.get(opTxt.slice(0, 40)) || 0) + 1);
  if (op < 0) return null;
  const lat = firstNum(xml, "latitude"), lon = firstNum(xml, "longitude");
  if (!isFinite(lat) || !isFinite(lon)) return null;
  let kw = 0;
  for (const m of xml.matchAll(new RegExp(`<${tag("(?:maxPowerAtSocket|availableChargingPower|maximumPower|power)")}>\\s*([\\d.]+)\\s*<`, "g"))) {
    let x = +m[1]; if (x > 1000) x /= 1000; if (x > kw && x <= 400) kw = x;
  }
  const pts = (xml.match(new RegExp(`<${tag("refillPoint")}[\\s>]`, "g")) || []).length || 1;
  // adresse : lignes d'adresse (rue, code postal, ville…) ; les mots-clés techniques (« street », « town »…) sont ignorés
  const lines = [...rest.matchAll(new RegExp(`<${tag("addressLine")}[\\s>][\\s\\S]*?</${tag("addressLine")}>`, "g"))].map((m) => {
    const ty = (m[0].match(new RegExp(`<${tag("type")}>\\s*([^<]+?)\\s*<`)) || [])[1] || "";
    return { ty, val: texts(m[0]).filter((x) => x !== ty && !/^[a-z][a-zA-Z]*$/.test(x)).map(decodeXml).join(" ") };
  }).filter((l) => l.val);
  let city = "", addrTxt = [];
  if (lines.length) { addrTxt = lines.map((l) => l.val); city = (lines.find((l) => /town|city|municipal|place/i.test(l.ty)) || {}).val || ""; }
  else addrTxt = texts(block(rest, "address")).filter((x) => !/^[a-z][a-zA-Z]*$/.test(x)).map(decodeXml);
  return [+lat.toFixed(5), +lon.toFixed(5), op, kw, (name || ["Tesla Supercharger", "Powerdot", "Electra"][op]).slice(0, 60), pts,
    city.slice(0, 40), [...new Set(addrTxt)].join(", ").replace(/\s+/g, " ").slice(0, 90)];
}

async function downloadDGT(ms) {
  const t0 = Date.now();
  const r = await fetch(DGT_URL, { headers: UA, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const dec = new TextDecoder("utf-8"), out = [], stat = { sites: 0, ops: new Map(), probe: [] };
  let buf = "", bytes = 0;
  const flush = (final) => {
    RE_SITE_END.lastIndex = 0;
    let cut = 0, m;
    while ((m = RE_SITE_END.exec(buf))) {
      const end = m.index + m[0].length, chunk = buf.slice(cut, end);
      const st = chunk.search(RE_SITE_START);
      if (st >= 0) { const c = parseDgtSite(chunk.slice(st), stat); if (c) out.push(c); }
      cut = end;
    }
    buf = final ? "" : buf.slice(cut);
  };
  for await (const part of r.body) { bytes += part.length; buf += dec.decode(part, { stream: true }); if (buf.length > 2e6) flush(false); }
  buf += dec.decode(); flush(true);
  const n = [0, 1, 2].map((k) => out.filter((c) => c[2] === k).length);
  logger.info(`DGT Espagne : ${Math.round(bytes / 1e6)} Mo lus en ${Math.round((Date.now() - t0) / 1000)} s, ${stat.sites} sites -> Tesla ${n[0]}, Powerdot ${n[1]}, Electra ${n[2]}`);
  // aide au réglage : opérateurs dont le nom ressemble à Tesla / Powerdot / Electra (avec le nombre de sites)
  const proches = [...stat.ops.entries()].filter(([k]) => /tesla|pow|dot|electr|pdot/i.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${k} (${v})`).join(" | ");
  logger.info(`DGT opérateurs proches : ${proches || "aucun"}`);
  logger.info(`DGT sonde Powerdot (Ibis Cornellà / Diagonal Mar) : ${stat.probe.slice(0, 8).join(" || ") || "introuvable"}`);
  if (out.length < 20) throw new Error(`liste DGT trop courte (${out.length} sur ${stat.sites} sites)`);
  return out;
}

function addDedupe(out, c) {
  // doublons (même opérateur à moins de ~120 m) : on garde la plus puissante
  const dup = out.find((o) => o[2] === c[2] && Math.abs(o[0] - c[0]) < 0.0011 && Math.abs(o[1] - c[1]) < 0.0015);
  if (dup) { if (c[3] > dup[3]) dup[3] = c[3]; if (!dup[7] && c[7]) dup[7] = c[7]; if (c[5] > dup[5]) dup[5] = c[5]; } else out.push(c);
}

async function downloadEU(ms) {
  // en parallèle : Espagne officielle (DGT) + OpenStreetMap Espagne (secours) + OpenStreetMap Italie
  const [dgt, osmES, osmIT] = await Promise.allSettled([downloadDGT(ms), paysOverpass("ES", ms), paysOverpass("IT", ms)]);
  const out = [], ok = [];
  if (dgt.status === "fulfilled") {
    ok.push("ES"); dgt.value.forEach((c) => addDedupe(out, c));
    // complément OpenStreetMap : bornes absentes de la liste DGT (ex. Powerdot, non déclarée sous son nom en Espagne)
    let plus = 0;
    if (osmES.status === "fulfilled") osmES.value.forEach((el) => { const c = parseOsm(el); if (c) { const n0 = out.length; addDedupe(out, c); plus += out.length - n0; } });
    logger.info(`Espagne : liste officielle DGT utilisée (${dgt.value.length} stations) + ${plus} complétées par OpenStreetMap`);
  }
  else {
    logger.warn(`Espagne : liste officielle DGT en échec (${dgt.reason && (dgt.reason.cause ? dgt.reason.cause.code || dgt.reason.cause.message : dgt.reason.message)}), OpenStreetMap utilisé à la place`);
    if (osmES.status === "fulfilled") { ok.push("ES"); osmES.value.forEach((el) => { const c = parseOsm(el); if (c) addDedupe(out, c); }); }
  }
  if (osmIT.status === "fulfilled") { ok.push("IT"); osmIT.value.forEach((el) => { const c = parseOsm(el); if (c) addDedupe(out, c); }); }
  return { out, ok };
}

exports.majBornesHebdo = onSchedule(
  { schedule: "every monday 04:00", timeZone: "Europe/Paris", region: "europe-west1", timeoutSeconds: 540, memory: "1GiB", retryCount: 2 },
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
      // Pays en échec cette fois-ci : on garde ses bornes de la semaine précédente (Espagne = ouest, Italie = est)
      const garde = [];
      let ancien = []; try { ancien = JSON.parse(cur.dataEU || "[]"); } catch (e) { /* rien */ }
      if (!ok.includes("ES")) garde.push(...ancien.filter((b) => b[1] < 5));
      if (!ok.includes("IT")) garde.push(...ancien.filter((b) => b[1] >= 5));
      if (garde.length) logger.info(`Anciennes bornes conservées pour le pays en échec : ${garde.length}`);
      out.push(...garde);
      const dataEU = JSON.stringify(out);
      if ((cur.data || "").length + dataEU.length > 950000) throw new Error("liste trop volumineuse pour un document Firestore");
      await ref.set({ tEU: Date.now(), dataEU, nEu: out.length, nFr, n: nFr + out.length, pays: ["FR", ...new Set([...ok, ...(cur.pays || []).filter((c) => c !== "FR")])] }, { merge: true });
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
