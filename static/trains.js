const ROUTE_COLORS = {
  1: "#EE352E",
  2: "#EE352E",
  3: "#EE352E",
  4: "#00933C",
  5: "#00933C",
  6: "#00933C",
  "6X": "#00933C",
  7: "#B933AD",
  "7X": "#B933AD",
  A: "#0039A6",
  C: "#0039A6",
  E: "#0039A6",
  B: "#FF6319",
  D: "#FF6319",
  F: "#FF6319",
  FX: "#FF6319",
  M: "#FF6319",
  N: "#FCCC0A",
  Q: "#FCCC0A",
  R: "#FCCC0A",
  W: "#FCCC0A",
  L: "#A7A9AC",
  G: "#6CBE45",
  J: "#996633",
  Z: "#996633",
  S: "#808183",
  SI: "#808183",
};

function sortRoutes(routes) {
  return [...routes].sort((a, b) => {
    const na = /^\d/.test(a),
      nb = /^\d/.test(b);
    if (na !== nb) return na ? -1 : 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
}

// Routes that need dark text for better contrast (yellow/light backgrounds)
const DARK_TEXT_ROUTES = new Set(["N", "Q", "R", "W"]);

const FEED_SLUGS = ["", "-ace", "-bdfm", "-nqrw", "-l", "-g", "-jz", "-si"];

// MTA splits GTFS-RT by line group — see api.mta.info feed list
const ROUTE_FEED = {
  1: "",
  2: "",
  3: "",
  4: "",
  5: "",
  6: "",
  "6X": "",
  7: "",
  "7X": "",
  S: "",
  SI: "-si",
  SIR: "-si",
  A: "-ace",
  C: "-ace",
  E: "-ace",
  H: "-ace",
  B: "-bdfm",
  D: "-bdfm",
  F: "-bdfm",
  FX: "-bdfm",
  M: "-bdfm",
  N: "-nqrw",
  Q: "-nqrw",
  R: "-nqrw",
  W: "-nqrw",
  L: "-l",
  G: "-g",
  J: "-jz",
  Z: "-jz",
};

const REFRESH_MS = 3e4;

function getBaseRoute(routeId) {
  return routeId?.endsWith("X") ? routeId.slice(0, -1) : routeId;
}

function stationKey(station) {
  return station.ids.join("/");
}

function formatCountdown(arrivalTime, now = Date.now() / 1e3) {
  const secs = Math.max(0, Math.round((arrivalTime - now) / 5) * 5);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}s`;
}

const CLOCK_OPTS = { hour: "2-digit", minute: "2-digit", second: "2-digit" };

function feedsForStations(stations) {
  if (!stations?.length) return [...FEED_SLUGS];
  const slugs = new Set();
  for (const s of stations) {
    for (const r of s.routes) {
      const slug = ROUTE_FEED[r] ?? ROUTE_FEED[getBaseRoute(r)];
      if (slug !== undefined) slugs.add(slug);
    }
  }
  return slugs.size ? [...slugs] : [...FEED_SLUGS];
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

function getStationArrivals(arrivalsByStopId, station) {
  const out = [];
  for (const id of station.ids) {
    for (const suffix of ["N", "S", ""]) {
      const list = arrivalsByStopId.get(suffix ? `${id}${suffix}` : id);
      if (list) out.push(...list);
    }
  }
  return out;
}

let cachedStations = null,
  lastRefreshTime = null,
  stopIdMap = null,
  lastRefreshPromise = null,
  refreshInterval = null,
  countdownInterval = null,
  cachedAlerts = [],
  cachedArrivalsByStopId = null,
  activeFilters = {},
  mtaInView = true,
  mtaObserver = null;

// Minimal protobuf decoder - only decodes fields we need from GTFS-realtime
const PBF = {
  // Read varint (variable-length integer)
  varint(buf, pos) {
    let val = 0,
      shift = 0,
      b;
    do {
      b = buf[pos.i++];
      val |= (b & 0x7f) << shift;
      shift += 7;
    } while (b >= 0x80);
    return val >>> 0;
  },
  // Read 64-bit varint as number (loses precision for very large values, ok for timestamps)
  varint64(buf, pos) {
    let lo = 0,
      hi = 0,
      shift = 0,
      b;
    while (shift < 28) {
      b = buf[pos.i++];
      lo |= (b & 0x7f) << shift;
      if (b < 0x80) return lo >>> 0;
      shift += 7;
    }
    b = buf[pos.i++];
    lo |= (b & 0x7f) << 28;
    hi = (b & 0x7f) >> 4;
    if (b < 0x80) return (hi * 0x100000000 + lo) >>> 0;
    shift = 3;
    while (shift < 32) {
      b = buf[pos.i++];
      hi |= (b & 0x7f) << shift;
      if (b < 0x80) break;
      shift += 7;
    }
    return hi * 0x100000000 + (lo >>> 0);
  },
  // Read length-delimited bytes
  bytes(buf, pos) {
    const len = PBF.varint(buf, pos),
      start = pos.i;
    pos.i += len;
    return buf.subarray(start, pos.i);
  },
  // Read string
  string(buf, pos) {
    return new TextDecoder().decode(PBF.bytes(buf, pos));
  },
  // Skip a field based on wire type
  skip(buf, pos, wireType) {
    if (wireType === 0) PBF.varint(buf, pos);
    else if (wireType === 1) pos.i += 8;
    else if (wireType === 2) pos.i += PBF.varint(buf, pos);
    else if (wireType === 5) pos.i += 4;
  },
};

// Decode GTFS-realtime FeedMessage for train times
function decodeFeedMessage(buf) {
  const entities = [],
    pos = { i: 0 };
  while (pos.i < buf.length) {
    const tag = PBF.varint(buf, pos),
      field = tag >> 3,
      wireType = tag & 7;
    if (field === 2 && wireType === 2) {
      const entity = decodeEntity(PBF.bytes(buf, pos));
      if (entity) entities.push(entity);
    } else PBF.skip(buf, pos, wireType);
  }
  return { entity: entities };
}

function decodeEntity(buf) {
  const entity = { id: null, tripUpdate: null },
    pos = { i: 0 };
  while (pos.i < buf.length) {
    const tag = PBF.varint(buf, pos),
      field = tag >> 3,
      wireType = tag & 7;
    if (field === 1 && wireType === 2) entity.id = PBF.string(buf, pos);
    else if (field === 3 && wireType === 2)
      entity.tripUpdate = decodeTripUpdate(PBF.bytes(buf, pos));
    else PBF.skip(buf, pos, wireType);
  }
  return entity.tripUpdate ? entity : null;
}

function decodeTripUpdate(buf) {
  const tu = { trip: {}, stopTimeUpdate: [] },
    pos = { i: 0 };
  while (pos.i < buf.length) {
    const tag = PBF.varint(buf, pos),
      field = tag >> 3,
      wireType = tag & 7;
    if (field === 1 && wireType === 2)
      tu.trip = decodeTripDescriptor(PBF.bytes(buf, pos));
    else if (field === 2 && wireType === 2)
      tu.stopTimeUpdate.push(decodeStopTimeUpdate(PBF.bytes(buf, pos)));
    else PBF.skip(buf, pos, wireType);
  }
  return tu;
}

function decodeTripDescriptor(buf) {
  const trip = {},
    pos = { i: 0 };
  while (pos.i < buf.length) {
    const tag = PBF.varint(buf, pos),
      field = tag >> 3,
      wireType = tag & 7;
    if (field === 1 && wireType === 2) trip.tripId = PBF.string(buf, pos);
    else if (field === 2 && wireType === 2)
      trip.startTime = PBF.string(buf, pos);
    else if (field === 3 && wireType === 2)
      trip.startDate = PBF.string(buf, pos);
    else if (field === 5 && wireType === 2)
      trip.routeId = PBF.string(buf, pos);
    else PBF.skip(buf, pos, wireType);
  }
  // MTA encodes route in trip_id: extract if routeId not set
  // Format: "AFA24GEN-1037-Sunday-00_000600_1..S03R" - route is between _ and ..
  if (!trip.routeId && trip.tripId) {
    const match = trip.tripId.match(/_([A-Z0-9]+)\.\./i);
    if (match) trip.routeId = match[1];
  }
  return trip;
}

function decodeStopTimeUpdate(buf) {
  const stu = {},
    pos = { i: 0 };
  while (pos.i < buf.length) {
    const tag = PBF.varint(buf, pos),
      field = tag >> 3,
      wireType = tag & 7;
    if (field === 2 && wireType === 2)
      stu.arrival = decodeStopTimeEvent(PBF.bytes(buf, pos));
    else if (field === 3 && wireType === 2)
      stu.departure = decodeStopTimeEvent(PBF.bytes(buf, pos));
    else if (field === 4 && wireType === 2)
      stu.stopId = PBF.string(buf, pos);
    else PBF.skip(buf, pos, wireType);
  }
  return stu;
}

function decodeStopTimeEvent(buf) {
  const evt = {},
    pos = { i: 0 };
  while (pos.i < buf.length) {
    const tag = PBF.varint(buf, pos),
      field = tag >> 3,
      wireType = tag & 7;
    if (field === 2 && wireType === 0) evt.time = PBF.varint64(buf, pos);
    else PBF.skip(buf, pos, wireType);
  }
  return evt;
}

// Decode alerts feed
function decodeAlertFeed(buf) {
  const entities = [],
    pos = { i: 0 };
  while (pos.i < buf.length) {
    const tag = PBF.varint(buf, pos),
      field = tag >> 3,
      wireType = tag & 7;
    if (field === 2 && wireType === 2) {
      const entity = decodeAlertEntity(PBF.bytes(buf, pos));
      if (entity) entities.push(entity);
    } else PBF.skip(buf, pos, wireType);
  }
  return { entity: entities };
}

function decodeAlertEntity(buf) {
  const entity = { id: null, alert: null },
    pos = { i: 0 };
  while (pos.i < buf.length) {
    const tag = PBF.varint(buf, pos),
      field = tag >> 3,
      wireType = tag & 7;
    if (field === 1 && wireType === 2) entity.id = PBF.string(buf, pos);
    else if (field === 5 && wireType === 2)
      entity.alert = decodeAlert(PBF.bytes(buf, pos));
    else PBF.skip(buf, pos, wireType);
  }
  return entity.alert ? entity : null;
}

function decodeAlert(buf) {
  const alert = {
      activePeriod: [],
      informedEntity: [],
      headerText: null,
      descriptionText: null,
    },
    pos = { i: 0 };
  while (pos.i < buf.length) {
    const tag = PBF.varint(buf, pos),
      field = tag >> 3,
      wireType = tag & 7;
    if (field === 1 && wireType === 2)
      alert.activePeriod.push(decodeTimeRange(PBF.bytes(buf, pos)));
    else if (field === 5 && wireType === 2)
      alert.informedEntity.push(
        decodeEntitySelector(PBF.bytes(buf, pos)),
      );
    else if (field === 10 && wireType === 2)
      alert.headerText = decodeTranslatedString(PBF.bytes(buf, pos));
    else if (field === 11 && wireType === 2)
      alert.descriptionText = decodeTranslatedString(PBF.bytes(buf, pos));
    else PBF.skip(buf, pos, wireType);
  }
  return alert;
}

function decodeTimeRange(buf) {
  const tr = {},
    pos = { i: 0 };
  while (pos.i < buf.length) {
    const tag = PBF.varint(buf, pos),
      field = tag >> 3,
      wireType = tag & 7;
    if (field === 1 && wireType === 0) tr.start = PBF.varint64(buf, pos);
    else if (field === 2 && wireType === 0)
      tr.end = PBF.varint64(buf, pos);
    else PBF.skip(buf, pos, wireType);
  }
  return tr;
}

function decodeEntitySelector(buf) {
  const es = {},
    pos = { i: 0 };
  while (pos.i < buf.length) {
    const tag = PBF.varint(buf, pos),
      field = tag >> 3,
      wireType = tag & 7;
    if (field === 2 && wireType === 2) es.routeId = PBF.string(buf, pos);
    else PBF.skip(buf, pos, wireType);
  }
  return es;
}

function decodeTranslatedString(buf) {
  const ts = { translation: [] },
    pos = { i: 0 };
  while (pos.i < buf.length) {
    const tag = PBF.varint(buf, pos),
      field = tag >> 3,
      wireType = tag & 7;
    if (field === 1 && wireType === 2)
      ts.translation.push(decodeTranslation(PBF.bytes(buf, pos)));
    else PBF.skip(buf, pos, wireType);
  }
  return ts;
}

function decodeTranslation(buf) {
  const t = {},
    pos = { i: 0 };
  while (pos.i < buf.length) {
    const tag = PBF.varint(buf, pos),
      field = tag >> 3,
      wireType = tag & 7;
    if (field === 1 && wireType === 2) t.text = PBF.string(buf, pos);
    else PBF.skip(buf, pos, wireType);
  }
  return t;
}
let stopsCatalog = null,
  stopsCatalogPromise = null;

function stopsJsonUrl() {
  const el = document.querySelector('script[src*="trains.js"]');
  return el?.src ? new URL("stops.json", el.src).href : "/stops.json";
}

function normalizeStop(raw) {
  return {
    name: raw.n,
    label: raw.l || raw.n,
    lat: raw.la,
    lon: raw.lo,
    ids: raw.ids,
    routes: raw.r,
  };
}

async function loadStopsCatalog() {
  if (stopsCatalog) return stopsCatalog;
  if (!stopsCatalogPromise) {
    stopsCatalogPromise = fetch(stopsJsonUrl())
      .then((r) => {
        if (!r.ok) throw new Error(`stops.json: ${r.status}`);
        return r.json();
      })
      .then((rows) => {
        stopsCatalog = rows.map(normalizeStop);
        return stopsCatalog;
      });
  }
  return stopsCatalogPromise;
}

function routesForStation(station) {
  const routes = new Set(station.routes);
  if (cachedArrivalsByStopId) {
    for (const a of getStationArrivals(cachedArrivalsByStopId, station))
      routes.add(a.route);
  }
  return sortRoutes([...routes]);
}

// Store trip stop lists for express detection
const tripStopsMap = new Map();

function initStopIdMap(stations) {
  stopIdMap = new Map();
  stations.forEach((s) => {
    s.ids.forEach((id) => {
      stopIdMap.set(id, s);
      stopIdMap.set(`${id}N`, s);
      stopIdMap.set(`${id}S`, s);
    });
  });
}

async function fetchServiceAlerts() {
  try {
    const res = await fetch(
      "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts",
    );
    if (!res.ok) throw new Error(`Alerts feed failed: ${res.status}`);
    const buf = await res.arrayBuffer();
    const feed = decodeAlertFeed(new Uint8Array(buf));
    const now = Date.now() / 1000;
    const alerts = [];
    feed.entity.forEach((e) => {
      if (!e.alert) return;
      const alert = e.alert;
      const isActive =
        !alert.activePeriod ||
        alert.activePeriod.length === 0 ||
        alert.activePeriod.some(
          (p) => (!p.start || p.start <= now) && (!p.end || p.end >= now),
        );
      if (!isActive) return;
      const routes = [
        ...new Set(
          alert.informedEntity
            ?.filter((ie) => ie.routeId)
            .map((ie) => ie.routeId) || [],
        ),
      ];
      if (routes.length === 0) return;
      const headerText = alert.headerText?.translation?.[0]?.text || "";
      const descText =
        alert.descriptionText?.translation?.[0]?.text || "";
      if (!headerText && !descText) return;
      alerts.push({ routes, header: headerText, description: descText });
    });
    cachedAlerts = alerts;
    return alerts;
  } catch (e) {
    console.warn("Failed to fetch alerts:", e);
    return cachedAlerts;
  }
}

function getStop(stopId) {
  if (stopIdMap?.has(stopId)) return stopIdMap.get(stopId);
  const cleanId = stopId.replace(/[NS]$/, "");
  if (!stopsCatalog) return null;
  for (const s of stopsCatalog) if (s.ids.includes(cleanId)) return s;
  return null;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371,
    dLat = ((lat2 - lat1) * Math.PI) / 180,
    dLon = ((lon2 - lon1) * Math.PI) / 180,
    x = dLon * Math.cos(((lat1 + lat2) * Math.PI) / 360),
    y = dLat;
  return Math.sqrt(x * x + y * y) * R;
}

async function loadLocationsAndStations({ forceRefresh = false } = {}) {
  try {
    const catalog = await loadStopsCatalog();
    const { lat: userLat, lon: userLon } = await getSharedPosition({
        forceRefresh,
      }),
      stops = catalog
        .map((s) => ({
          ...s,
          dist: haversine(userLat, userLon, s.lat, s.lon),
        }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 6);
    stopIdMap = new Map();
    stops.forEach((s) => {
      s.ids.forEach((id) => {
        stopIdMap.set(id, s);
        stopIdMap.set(`${id}N`, s);
        stopIdMap.set(`${id}S`, s);
      });
    });
    cachedStations = stops;
    return stops;
  } catch (e) {
    if (e.code === 1) {
      // PERMISSION_DENIED
      throw new Error("Location permission denied");
    }
    console.error("Error loading locations and stations:", e);
    throw e;
  }
}

function entityTouchesStops(entity, watchIds) {
  const stus = entity.tripUpdate?.stopTimeUpdate;
  if (!stus) return false;
  for (const stu of stus) {
    if (stu.stopId && watchIds.has(stu.stopId)) return true;
  }
  return false;
}

async function fetchTrainTimes(stations) {
  try {
    const feeds = feedsForStations(stations);
    const watchIds = watchStopIds(stations);
    const filterStops = watchIds.size > 0;
    let failCount = 0;
    const results = await Promise.allSettled(
      feeds.map(async (slug) => {
        const res = await fetch(
          `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs${slug}`,
        );
        if (!res.ok) throw new Error(`Feed ${slug}: ${res.status}`);
        return decodeFeedMessage(new Uint8Array(await res.arrayBuffer()))
          .entity;
      }),
    );
    const allEntities = [];
    results.forEach((result) => {
      if (result.status === "fulfilled") {
        allEntities.push(...result.value);
      } else {
        failCount++;
        console.warn("Feed failed:", result.reason);
      }
    });
    tripStopsMap.clear();
    const relevant = filterStops
      ? allEntities.filter((e) => entityTouchesStops(e, watchIds))
      : allEntities;
    relevant.forEach((e) => {
      if (e.tripUpdate?.trip?.tripId && e.tripUpdate?.stopTimeUpdate) {
        tripStopsMap.set(
          e.tripUpdate.trip.tripId,
          e.tripUpdate.stopTimeUpdate
            .map((stu) => stu.stopId)
            .filter(Boolean),
        );
      }
    });
    const now = Date.now() / 1e3;
    const arrivalsByStopId = new Map();
    const pushArrival = (stopId, arrival) => {
      let list = arrivalsByStopId.get(stopId);
      if (!list) {
        list = [];
        arrivalsByStopId.set(stopId, list);
      }
      list.push(arrival);
    };
    relevant.forEach((e) => {
      const tripId = e.tripUpdate.trip.tripId || null;
      const routeId = e.tripUpdate.trip.routeId;
      const tripStops = tripStopsMap.get(tripId);
      const lastStopId =
        tripStops?.length > 0 ? tripStops[tripStops.length - 1] : null;
      const destStation = lastStopId ? getStop(lastStopId) : null;
      const destination = destStation ? destStation.name : null;
      const stuByStop = new Map();
      for (const stu of e.tripUpdate.stopTimeUpdate) {
        if (stu.stopId) stuByStop.set(stu.stopId, stu);
      }
      e.tripUpdate.stopTimeUpdate.forEach((stu) => {
        const arrivalTime = stu.arrival?.time || stu.departure?.time;
        if (!arrivalTime || arrivalTime <= now || !stu.stopId) return;
        if (filterStops && !watchIds.has(stu.stopId)) return;
        const station = getStop(stu.stopId);
        if (!station) return;
        const stopIdx = tripStops ? tripStops.indexOf(stu.stopId) : -1;
        const upcomingStops =
          stopIdx >= 0 && tripStops
            ? tripStops
                .slice(stopIdx + 1)
                .map((s) => {
                  const futureStu = stuByStop.get(s);
                  const time = futureStu
                    ? futureStu.arrival?.time || futureStu.departure?.time
                    : null;
                  return {
                    name: getStop(s)?.name,
                    time: time ? new Date(1e3 * time) : null,
                  };
                })
                .filter((obj) => obj.name)
            : [];
        const stopsLeft =
          stopIdx >= 0 && tripStops ? tripStops.length - stopIdx : null;
        pushArrival(stu.stopId, {
          route: routeId,
          minutes: Math.round((arrivalTime - now) / 60),
          arrivalTime,
          time: new Date(1e3 * arrivalTime),
          stationName: station.name,
          stopId: stu.stopId,
          direction: stu.stopId.slice(-1),
          tripId,
          destination,
          upcomingStops,
          stopsLeft,
        });
      });
    });
    return { arrivalsByStopId, failCount, feedCount: feeds.length };
  } catch (e) {
    console.error("Error fetching train times:", e);
    throw e;
  }
}

function refreshMetaText() {
  return lastRefreshTime
    ? `Refresh every 30s. Last refresh: ${lastRefreshTime.toLocaleTimeString()}`
    : "Refresh every 30s";
}

function splitByDirection(stationArrivals, filterRoute) {
  const filtered = filterRoute
    ? stationArrivals.filter((a) => a.route === filterRoute)
    : stationArrivals;
  return {
    northbound: filtered
      .filter((a) => a.direction === "N")
      .sort((a, b) => a.time - b.time)
      .slice(0, 6),
    southbound: filtered
      .filter((a) => a.direction === "S")
      .sort((a, b) => a.time - b.time)
      .slice(0, 6),
  };
}

function createTrainRow(t) {
  const trainDiv = document.createElement("div");
  trainDiv.className = "train";
  trainDiv.dataset.route = t.route;
  if (t.arrivalTime) trainDiv.dataset.arrival = String(t.arrivalTime);
  const baseRoute = getBaseRoute(t.route);
  const badgeWrap = document.createElement("div");
  badgeWrap.className = "route-badge-wrap";
  const badge = document.createElement("span");
  badge.className = "route-badge";
  badge.style.background =
    ROUTE_COLORS[t.route] || ROUTE_COLORS[baseRoute] || "#666";
  if (DARK_TEXT_ROUTES.has(t.route) || DARK_TEXT_ROUTES.has(baseRoute)) {
    badge.style.color = "#000";
  }
  badge.textContent = t.route;
  badgeWrap.appendChild(badge);
  trainDiv.appendChild(badgeWrap);
  const timeDest = document.createElement("div");
  timeDest.className = "time-dest";
  const timeRow = document.createElement("div");
  timeRow.className = "time-row";
  const timeSpan = document.createElement("span");
  timeSpan.className = "time-text";
  timeSpan.textContent = formatCountdown(t.arrivalTime);
  timeRow.appendChild(timeSpan);
  if (t.stopsLeft > 0) {
    const stopsLeft = document.createElement("span");
    stopsLeft.className = "stops-left";
    stopsLeft.textContent = String(t.stopsLeft);
    stopsLeft.title = `${t.stopsLeft} stops left`;
    timeRow.appendChild(stopsLeft);
  }
  timeDest.appendChild(timeRow);
  if (t.destination) {
    const destSpan = document.createElement("span");
    destSpan.className = "destination";
    destSpan.textContent = t.destination;
    timeDest.appendChild(destSpan);
  }
  trainDiv.appendChild(timeDest);
  if (t.upcomingStops?.length > 0) {
    trainDiv.onclick = (e) => {
      e.stopPropagation();
      showStopsModal(t);
    };
  }
  return trainDiv;
}

function createDirectionCol(title, trains) {
  const col = document.createElement("div");
  col.className = "direction-col";
  const h4 = document.createElement("h4");
  h4.textContent = title;
  col.appendChild(h4);
  if (trains.length > 0) {
    trains.forEach((t) => col.appendChild(createTrainRow(t)));
  } else {
    const noTrainsDiv = document.createElement("div");
    noTrainsDiv.className = "train";
    noTrainsDiv.textContent = "No upcoming trains";
    col.appendChild(noTrainsDiv);
  }
  return col;
}

function paintDirections(directionsDiv, station, filterRoute) {
  const { northbound, southbound } = splitByDirection(
    getStationArrivals(cachedArrivalsByStopId, station),
    filterRoute,
  );
  directionsDiv.replaceChildren(
    createDirectionCol("Uptown", northbound),
    createDirectionCol("Downtown", southbound),
  );
}

function paintStationAlerts(stationDiv, station, alerts) {
  stationDiv
    .querySelectorAll(".station-alert")
    .forEach((el) => el.remove());
  (alerts || [])
    .filter((a) => a.routes.some((r) => station.routes.includes(r)))
    .slice(0, 2)
    .forEach((alert) => {
      const alertDiv = document.createElement("div");
      alertDiv.className = "station-alert";
      alertDiv.textContent = `⚠ ${(alert.header || alert.description).slice(0, 120)}`;
      stationDiv.appendChild(alertDiv);
    });
}

function paintRouteBadges(badgesDiv, station) {
  if (!badgesDiv) return;
  const activeRoutes = new Set(
    getStationArrivals(cachedArrivalsByStopId, station).map((a) => a.route),
  );
  const activeFilter = activeFilters[stationKey(station)] || null;
  badgesDiv.querySelectorAll(".route-badge").forEach((badge) => {
    const route = badge.dataset.route;
    badge.classList.toggle("route-badge--empty", !activeRoutes.has(route));
    badge.classList.toggle("filter-inactive", !!activeFilter && route !== activeFilter);
  });
}

function syncStationBadges(badgesDiv, station) {
  if (!badgesDiv) return;
  badgesDiv.replaceChildren();
  routesForStation(station).forEach((r) => {
    const badge = document.createElement("span");
    badge.className = "route-badge";
    badge.style.background = ROUTE_COLORS[r] || "#666";
    if (DARK_TEXT_ROUTES.has(r)) badge.style.color = "#000";
    badge.textContent = r;
    badge.dataset.route = r;
    badgesDiv.appendChild(badge);
  });
}

function bindRouteFilters(badgesDiv, station, directionsDiv) {
  const key = stationKey(station);
  badgesDiv.querySelectorAll(".route-badge").forEach((badge) => {
    badge.onclick = (e) => {
      e.stopPropagation();
      const clickedRoute = badge.dataset.route;
      const activeFilter = activeFilters[key] || null;
      if (activeFilter === clickedRoute) {
        activeFilters[key] = null;
        paintDirections(directionsDiv, station, null);
      } else {
        activeFilters[key] = clickedRoute;
        paintDirections(directionsDiv, station, clickedRoute);
      }
      paintRouteBadges(badgesDiv, station);
    };
  });
  paintRouteBadges(badgesDiv, station);
}

function fillStationCard(cardEl, station, alerts) {
  cardEl.classList.remove("station-card--skeleton");
  cardEl.removeAttribute("aria-hidden");
  cardEl.dataset.station = station.label || station.name;
  cardEl.dataset.stationKey = stationKey(station);
  cardEl.hidden = false;

  const nameSpan = cardEl.querySelector(".station-name");
  const distSpan = cardEl.querySelector(".distance");
  if (nameSpan) {
    nameSpan.textContent = station.label || station.name;
    nameSpan.classList.remove("skeleton-bar");
  }
  if (distSpan) {
    distSpan.textContent = `${Math.round(1e3 * station.dist)}m`;
    distSpan.classList.remove("skeleton-bar", "skeleton-bar--short");
  }

  const headerDiv = cardEl.querySelector(".station-header");
  let badgesDiv = cardEl.querySelector(".station-badges");
  if (!badgesDiv && headerDiv) {
    badgesDiv = document.createElement("div");
    badgesDiv.className = "station-badges";
    headerDiv.appendChild(badgesDiv);
  }
  if (badgesDiv) {
    badgesDiv.classList.remove("skeleton-badges");
    badgesDiv.removeAttribute("aria-hidden");
    syncStationBadges(badgesDiv, station);
  }

  let directionsDiv = cardEl.querySelector(".directions");
  if (!directionsDiv) {
    directionsDiv = document.createElement("div");
    directionsDiv.className = "directions";
    cardEl.appendChild(directionsDiv);
  }
  bindRouteFilters(badgesDiv, station, directionsDiv);
  paintDirections(directionsDiv, station, activeFilters[stationKey(station)] || null);
  paintStationAlerts(cardEl, station, alerts);
  return cardEl;
}

function buildStationCard(station, alerts) {
  const stationDiv = document.createElement("div");
  stationDiv.className = "station-card";
  stationDiv.innerHTML =
    '<div class="station-header"><div class="station-info"><span class="station-name"></span><span class="distance"></span></div></div>';
  return fillStationCard(stationDiv, station, alerts);
}

function populateMtaView(stations, arrivalsByStopId, failCount, feedCount, alerts) {
  cachedArrivalsByStopId = arrivalsByStopId;
  const root = mtaRoot();
  if (!root) return;
  const meta = root.querySelector(".refresh-meta");
  if (meta) meta.textContent = refreshMetaText();
  const cards = root.querySelectorAll("[data-mta-carousel] .station-card");
  stations.forEach((station, i) => {
    if (cards[i]) fillStationCard(cards[i], station, alerts);
  });
  cards.forEach((card, i) => {
    card.hidden = i >= stations.length;
  });
  updateFeedWarning(root, failCount, feedCount);
}

function hasMtaCarousel() {
  return !!mtaRoot()?.querySelector("[data-mta-carousel]");
}

function updateFeedWarning(root, failCount, feedCount) {
  let warningDiv = root.querySelector(".warning");
  if (failCount > 0) {
    const text = `Note: ${failCount} of ${feedCount} feeds failed to load. Some trains may not be shown.`;
    if (warningDiv) {
      warningDiv.textContent = text;
    } else {
      warningDiv = document.createElement("div");
      warningDiv.className = "warning";
      warningDiv.textContent = text;
      root.appendChild(warningDiv);
    }
  } else if (warningDiv) {
    warningDiv.remove();
  }
}

function mountMtaView(stations, arrivalsByStopId, failCount, feedCount, alerts) {
  cachedArrivalsByStopId = arrivalsByStopId;
  const container = document.createDocumentFragment();
  const timeDiv = document.createElement("div");
  timeDiv.className = "refresh-meta";
  timeDiv.textContent = refreshMetaText();
  container.appendChild(timeDiv);
  const carousel = document.createElement("div");
  carousel.className = "carousel carousel--station";
  carousel.setAttribute("tabindex", "0");
  carousel.setAttribute("aria-label", "Nearby subway stations");
  stations.forEach((s) => carousel.appendChild(buildStationCard(s, alerts)));
  container.appendChild(carousel);
  if (failCount > 0) {
    const warningDiv = document.createElement("div");
    warningDiv.className = "warning";
    warningDiv.textContent = `Note: ${failCount} of ${feedCount} feeds failed to load. Some trains may not be shown.`;
    container.appendChild(warningDiv);
  }
  return container;
}

function updateMtaView(stations, arrivalsByStopId, failCount, feedCount, alerts) {
  cachedArrivalsByStopId = arrivalsByStopId;
  const root = mtaRoot();
  if (!root) return;
  const meta = root.querySelector(".refresh-meta");
  if (meta) meta.textContent = refreshMetaText();
  const cards = root.querySelectorAll("[data-mta-carousel] .station-card");
  stations.forEach((station, i) => {
    const card = cards[i];
    if (!card) return;
    const directionsDiv = card.querySelector(".directions");
    const badgesDiv = card.querySelector(".station-badges");
    if (badgesDiv && directionsDiv) {
      syncStationBadges(badgesDiv, station);
      bindRouteFilters(badgesDiv, station, directionsDiv);
    }
    if (directionsDiv) {
      paintDirections(
        directionsDiv,
        station,
        activeFilters[stationKey(station)] || null,
      );
    }
    paintStationAlerts(card, station, alerts);
  });
  updateFeedWarning(root, failCount, feedCount);
}

function showStopsModal(train) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const baseRoute = getBaseRoute(train.route);
  const content = document.createElement("div");
  content.className = "modal-content";
  content.style.position = "relative";
  content.innerHTML = `<button class="modal-close" aria-label="Close">&times;</button><div class="modal-header"><span class="route-badge" style="background:${ROUTE_COLORS[train.route] || ROUTE_COLORS[baseRoute] || "#666"};${DARK_TEXT_ROUTES.has(train.route) || DARK_TEXT_ROUTES.has(baseRoute) ? "color:#000;" : ""}">${train.route}</span><div><div class="modal-title">${train.destination || "Unknown"}</div><div class="modal-subtitle">${formatCountdown(train.arrivalTime)}</div></div></div><div class="modal-stops">${train.upcomingStops.map((stop, i, arr) => `<div class="modal-stop${i === arr.length - 1 ? " terminal" : ""}"><span class="modal-arrow">${i === arr.length - 1 ? "●" : "↓"}</span><span class="modal-stop-text">${stop.name}</span>${stop.time ? `<span class="arrival-time">${stop.time.toLocaleTimeString([], CLOCK_OPTS)}</span>` : ""}</div>`).join("")}</div>`;
  overlay.appendChild(content);
  overlay.onclick = () => overlay.remove();
  document.body.appendChild(overlay);
}

function mtaRoot() {
  return document.getElementById("mta-content");
}

async function resolveStations(forceRefresh = false) {
  if (cachedStations && !forceRefresh) return cachedStations;
  try {
    return await loadLocationsAndStations({ forceRefresh });
  } catch (e) {
    if (e.message === "Location permission denied") throw e;
    console.warn("Geolocation failed", e);
    const catalog = await loadStopsCatalog();
    return catalog.slice(0, 6).map((s, idx) => ({ ...s, dist: idx }));
  }
}

function setMtaLoadingMessage(message) {
  const meta = mtaRoot()?.querySelector(".refresh-meta");
  if (meta) meta.textContent = message;
}

async function load(forceRefresh = false) {
  const el = mtaRoot();
  if (!el) return;
  setMtaLoadingMessage("Loading nearby stations…");
  try {
    await loadStopsCatalog();
    const stations = await resolveStations(forceRefresh);
    initStopIdMap(stations);
    cachedStations = stations;
    const [trainData, alerts] = await Promise.all([
      fetchTrainTimes(stations),
      fetchServiceAlerts(),
    ]);
    lastRefreshTime = new Date();
    if (hasMtaCarousel()) {
      populateMtaView(
        stations,
        trainData.arrivalsByStopId,
        trainData.failCount,
        trainData.feedCount,
        alerts,
      );
    } else {
      el.replaceChildren(
        mountMtaView(
          stations,
          trainData.arrivalsByStopId,
          trainData.failCount,
          trainData.feedCount,
          alerts,
        ),
      );
    }
  } catch (e) {
    console.error("Full error:", e);
    if (e.message === "Location permission denied") {
      el.innerHTML =
        '<div><strong>Location Access Required</strong><br>To show nearby train stations, this app needs permission to access your location.<br><br><strong>On iPhone/iPad (Safari):</strong><br>1. Open the Settings app<br>2. Scroll down and tap Safari<br>3. Tap Location<br>4. Choose "Allow" or ensure it\'s not "Deny"<br>5. Return to this app and refresh the page<br><br><strong>On Android (Chrome):</strong><br>1. Tap the lock icon or "i" in the address bar<br>2. Tap Site settings > Location<br>3. Choose "Allow"<br>4. Refresh the page</div>';
    } else {
      setMtaLoadingMessage(`Error: ${e.message}`);
    }
  }
}

function shouldPollMta() {
  return !document.hidden && mtaInView;
}

function tickCountdowns() {
  const root = mtaRoot();
  if (!root) return;
  const now = Date.now() / 1e3;
  root.querySelectorAll(".train[data-arrival]").forEach((row) => {
    const arrival = Number(row.dataset.arrival);
    if (!arrival) return;
    const timeEl = row.querySelector(".time-text");
    if (timeEl) {
      timeEl.textContent = formatCountdown(arrival, now);
    }
  });
}

function syncRefreshInterval() {
  if (shouldPollMta()) {
    startRefreshInterval();
    startCountdownTick();
  } else {
    stopRefreshInterval();
    stopCountdownTick();
  }
}

function startRefreshInterval() {
  if (refreshInterval) return;
  refreshInterval = setInterval(refreshTrainTimes, REFRESH_MS);
}

function stopRefreshInterval() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

function startCountdownTick() {
  if (countdownInterval) return;
  countdownInterval = setInterval(tickCountdowns, 5e3);
}

function stopCountdownTick() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

function initMtaObserver() {
  const section = document.getElementById("mta");
  if (!section || mtaObserver) return;
  mtaObserver = new IntersectionObserver(
    ([entry]) => {
      mtaInView = entry.isIntersecting;
      syncRefreshInterval();
    },
    { threshold: 0.05 },
  );
  mtaObserver.observe(section);
}

async function refreshTrainTimes() {
  if (lastRefreshPromise || !shouldPollMta()) return;
  const el = mtaRoot();
  if (!el || !cachedStations) return;
  try {
    lastRefreshPromise = Promise.all([
      fetchTrainTimes(cachedStations),
      fetchServiceAlerts(),
    ]);
    const [trainData, alerts] = await lastRefreshPromise;
    lastRefreshTime = new Date();
    if (el.querySelector("[data-mta-carousel] .station-card[data-station-key]")) {
      updateMtaView(
        cachedStations,
        trainData.arrivalsByStopId,
        trainData.failCount,
        trainData.feedCount,
        alerts,
      );
    } else {
      el.replaceChildren(
        mountMtaView(
          cachedStations,
          trainData.arrivalsByStopId,
          trainData.failCount,
          trainData.feedCount,
          alerts,
        ),
      );
    }
  } catch (e) {
    console.error("Error refreshing train times:", e);
    el.innerHTML = `<div class="error">Error: ${e.message}</div>`;
  } finally {
    lastRefreshPromise = null;
  }
}

async function refreshLocation() {
  cachedStations = null;
  cachedArrivalsByStopId = null;
  await load(true);
}

document.addEventListener("visibilitychange", syncRefreshInterval);

window.addEventListener("DOMContentLoaded", () => {
  if (!mtaRoot()) return;
  initMtaObserver();
  load();
  syncRefreshInterval();
});
