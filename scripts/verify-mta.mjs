/**
 * Verifies selective MTA feed fetching against live api-endpoint.mta.info (no API key).
 * Run: bun scripts/verify-mta.mjs
 */

const FEED_SLUGS = ["", "-ace", "-bdfm", "-nqrw", "-l", "-g", "-jz", "-si"];

const ROUTE_FEED = {
  1: "", 2: "", 3: "", 4: "", 5: "", 6: "", "6X": "", 7: "", "7X": "", S: "",
  SIR: "-si",
  A: "-ace", C: "-ace", E: "-ace", H: "-ace",
  B: "-bdfm", D: "-bdfm", F: "-bdfm", FX: "-bdfm", M: "-bdfm",
  N: "-nqrw", Q: "-nqrw", R: "-nqrw", W: "-nqrw",
  L: "-l", G: "-g", J: "-jz", Z: "-jz",
};

const getBaseRoute = (routeId) =>
  routeId?.endsWith("X") ? routeId.slice(0, -1) : routeId;

function feedsForStations(stations) {
  const slugs = new Set();
  for (const s of stations) {
    for (const r of s.routes) {
      const slug = ROUTE_FEED[r] ?? ROUTE_FEED[getBaseRoute(r)];
      if (slug !== undefined) slugs.add(slug);
    }
  }
  return [...slugs];
}

function watchStopIds(stations) {
  const ids = new Set();
  for (const s of stations) {
    for (const id of s.ids) {
      ids.add(id);
      ids.add(`${id}N`);
      ids.add(`${id}S`);
    }
  }
  return ids;
}

// Times Sq-ish test stations (from STOPS_DATA)
const testStations = [
  {
    name: "Times Sq-42 St",
    ids: ["127", "725", "R16", "902", "A27"],
    routes: ["1", "2", "3", "7", "A", "C", "E", "N", "Q", "R", "S", "W"],
  },
  {
    name: "Grand Central-42 St",
    ids: ["631", "723", "901"],
    routes: ["4", "5", "6", "7", "S"],
  },
];

const selective = feedsForStations(testStations);
const watchIds = watchStopIds(testStations);

async function fetchBytes(slug) {
  const url = `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs${slug}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${slug}: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.length;
}

let allBytes = 0;
let selectiveBytes = 0;

for (const slug of FEED_SLUGS) allBytes += await fetchBytes(slug);
for (const slug of selective) selectiveBytes += await fetchBytes(slug);

console.log("Test stations:", testStations.map((s) => s.name).join(", "));
console.log("Watch stop IDs:", watchIds.size);
console.log("All feeds:", FEED_SLUGS.length, "→", allBytes, "bytes");
console.log("Selective feeds:", selective.length, selective, "→", selectiveBytes, "bytes");
console.log(
  "Savings:",
  Math.round((1 - selectiveBytes / allBytes) * 100) + "%",
);

if (selective.length >= FEED_SLUGS.length) {
  console.error("FAIL: selective should fetch fewer feeds");
  process.exit(1);
}

if (selectiveBytes >= allBytes) {
  console.error("FAIL: selective should download less data");
  process.exit(1);
}

// Spot-check API works without key
const probe = await fetch(
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l",
);
if (!probe.ok) {
  console.error("FAIL: MTA API returned", probe.status, "(expected no API key)");
  process.exit(1);
}

console.log("OK: selective feeds work, API needs no key");