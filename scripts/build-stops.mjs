/**
 * Build static/stops.json from MTA GTFS static data.
 * Run: node scripts/build-stops.mjs
 */

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "static/stops.json");
const GTFS_URL =
  "http://web.mta.info/developers/data/nyct/subway/google_transit.zip";
const MERGE_KM = 0.2;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
      continue;
    }
    if (c === '"') q = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (cell !== "" || row.length) row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += c;
  }
  if (cell !== "" || row.length) row.push(cell), rows.push(row);
  const headers = rows.shift();
  return rows.map((r) => Object.fromEntries(headers.map((h, j) => [h, r[j] ?? ""])));
}

function haversine(lat1, lon1, lat2, lon2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const x = dLon * Math.cos(((lat1 + lat2) * Math.PI) / 360);
  return Math.sqrt(x * x + dLat * dLat) * 6371;
}

function sortRoutes(routes) {
  return [...routes].sort((a, b) => {
    const na = /^\d/.test(a),
      nb = /^\d/.test(b);
    if (na !== nb) return na ? -1 : 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
}

function routeTag(routes) {
  return routes.join("/");
}

function downloadGtfs(dir) {
  const zip = join(dir, "gtfs.zip");
  execSync(`curl -fsSL -o "${zip}" "${GTFS_URL}"`, { stdio: "inherit" });
  execSync(`unzip -qo "${zip}" -d "${dir}"`, { stdio: "inherit" });
}

function buildStations(dir) {
  const stops = parseCsv(readFileSync(join(dir, "stops.txt"), "utf8"));
  const trips = parseCsv(readFileSync(join(dir, "trips.txt"), "utf8"));
  const stopTimes = parseCsv(readFileSync(join(dir, "stop_times.txt"), "utf8"));

  const tripRoute = new Map(trips.map((t) => [t.trip_id, t.route_id]));

  const parents = stops.filter((s) => s.location_type === "1");
  const children = new Map();
  for (const s of stops) {
    if (s.parent_station) {
      let list = children.get(s.parent_station);
      if (!list) children.set(s.parent_station, (list = []));
      list.push(s.stop_id);
    }
  }

  const routesByStop = new Map();
  for (const st of stopTimes) {
    const route = tripRoute.get(st.trip_id);
    if (!route) continue;
    let set = routesByStop.get(st.stop_id);
    if (!set) routesByStop.set(st.stop_id, (set = new Set()));
    set.add(route);
  }

  const raw = parents.map((p) => {
    const routeSet = new Set();
    const addRoutes = (id) => {
      for (const r of routesByStop.get(id) ?? []) routeSet.add(r);
    };
    addRoutes(`${p.stop_id}N`);
    addRoutes(`${p.stop_id}S`);
    for (const c of children.get(p.stop_id) ?? []) {
      addRoutes(c);
      addRoutes(`${c}N`);
      addRoutes(`${c}S`);
    }
    return {
      n: p.stop_name,
      la: +p.stop_lat,
      lo: +p.stop_lon,
      ids: [p.stop_id],
      r: sortRoutes([...routeSet]),
    };
  });

  const merged = [];
  for (const s of raw) {
    let hit = null;
    for (const m of merged) {
      if (m.n === s.n && haversine(m.la, m.lo, s.la, s.lo) <= MERGE_KM) {
        hit = m;
        break;
      }
    }
    if (hit) {
      for (const id of s.ids) if (!hit.ids.includes(id)) hit.ids.push(id);
      hit.ids.sort();
      hit.r = sortRoutes([...new Set([...hit.r, ...s.r])]);
      hit.la = (hit.la + s.la) / 2;
      hit.lo = (hit.lo + s.lo) / 2;
    } else merged.push({ ...s, ids: [...s.ids] });
  }

  const nameCount = new Map();
  for (const s of merged) nameCount.set(s.n, (nameCount.get(s.n) ?? 0) + 1);
  for (const s of merged) {
    if (nameCount.get(s.n) > 1) s.l = `${s.n} · ${routeTag(s.r)}`;
  }

  merged.sort((a, b) => a.n.localeCompare(b.n) || a.la - b.la);
  return merged;
}

const tmp = mkdtempSync(join(tmpdir(), "mta-gtfs-"));
try {
  console.log("Downloading GTFS…");
  downloadGtfs(tmp);
  const stations = buildStations(tmp);
  writeFileSync(OUT, JSON.stringify(stations));
  console.log(`Wrote ${stations.length} stations → ${OUT} (${readFileSync(OUT).length} bytes)`);
} finally {
  execSync(`rm -rf "${tmp}"`);
}