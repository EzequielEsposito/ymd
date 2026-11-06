// Lee el feed RSS del podcast y regenera episodes.js (los episodios que muestra la página).
//
// Uso:
//   node update-episodes.mjs                       -> usa el feed configurado abajo
//   node update-episodes.mjs https://otro-feed.xml  -> usa otro feed
//   node update-episodes.mjs ruta/al/feed.xml      -> lee un archivo local (para pruebas)
//
// Requiere Node 18 o superior. No tiene dependencias.
// Si el feed no responde o viene vacío, termina con error SIN tocar episodes.js.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const DEFAULT_FEED = "https://feeds.acast.com/public/shows/ymd";
const MAX_EPISODES = 11; // cuántos guarda; la página muestra los primeros 5 (CONFIG.maxEpisodes)

const source = process.argv[2] || process.env.FEED_URL || DEFAULT_FEED;
const outFile = new URL("./episodes.js", import.meta.url);

function fail(msg) {
  console.error("Error: " + msg + " (episodes.js no se modificó).");
  process.exit(1);
}

async function readFeed(src) {
  if (!/^https?:\/\//i.test(src)) {
    if (!existsSync(src)) fail("no existe el archivo " + src);
    return readFileSync(src, "utf8");
  }
  let res;
  try {
    res = await fetch(src, {
      headers: { "user-agent": "podlink-propio/1.0 (actualizador de episodios)" },
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    fail("no se pudo leer el feed (" + (e && e.message ? e.message : e) + ")");
  }
  if (!res.ok) fail("el feed respondió HTTP " + res.status);
  return res.text();
}

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);

const pick = (block, tag) => {
  const m = block.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">"));
  if (!m) return "";
  return decode(m[1].replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim());
};

const toSec = (d) => {
  if (!d) return null;
  const parts = d.split(":").map(Number);
  if (!parts.length || parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
};

const xml = await readFeed(source);
const items = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
if (!items.length) fail("el feed no tiene episodios");

const all = items.map((it) => {
  const pub = new Date(pick(it, "pubDate"));
  const enclosure = it.match(/<enclosure[^>]*\burl="([^"]+)"/);
  return {
    title: pick(it, "title"),
    date: Number.isNaN(pub.getTime()) ? null : pub.toISOString().slice(0, 10),
    durationSec: toSec(pick(it, "itunes:duration")),
    url: pick(it, "link") || null,
    audio: enclosure ? decode(enclosure[1]) : null,
  };
});
if (all.some((e) => !e.title)) fail("hay episodios sin título en el feed");

// Cantidad de episodios que muestra la página: el número más alto que aparece como "#NN" en los
// títulos (así coincide con la numeración del podcast). Si ningún título lo tiene, se cuentan los ítems.
const numbers = all.map((e) => (e.title.match(/#\s*(\d+)/) || [])[1]).filter(Boolean).map(Number);
const count = numbers.length ? Math.max(...numbers) : all.length;

const lines = all.slice(0, MAX_EPISODES).map(
  (e) =>
    "    { " +
    ["title", "date", "durationSec", "url", "audio"].map((k) => JSON.stringify(k) + ": " + JSON.stringify(e[k])).join(", ") +
    " }"
);
const out =
  "/* Archivo generado por update-episodes.mjs a partir del feed de Acast. Regeneralo con: node update-episodes.mjs */\n" +
  "window.EPISODES = {\n" +
  '  "count": ' + count + ",\n" +
  '  "episodes": [\n' +
  lines.join(",\n") +
  "\n  ]\n};\n";

const previous = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
if (previous === out) {
  console.log("Sin cambios: episodes.js ya está al día (" + count + " episodios, último: " + all[0].title + ").");
} else {
  writeFileSync(outFile, out);
  console.log("episodes.js actualizado: " + count + " episodios, último: " + all[0].title + ".");
}
