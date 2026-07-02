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
};

// Routes that need dark text for better contrast (yellow/light backgrounds)
const DARK_TEXT_ROUTES = new Set(["N", "Q", "R", "W"]);

function getBaseRoute(routeId) {
  return routeId?.endsWith("X") ? routeId.slice(0, -1) : routeId;
}

let cachedStations = null,
  lastRefreshTime = null,
  stopIdMap = null,
  lastRefreshPromise = null,
  refreshInterval = null,
  cachedAlerts = [],
  activeFilters = {};

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
const STOPS_DATA = [
  {
    n: "Times Sq-42 St",
    la: 40.7553,
    lo: -73.9875,
    ids: ["127", "725", "R16", "902", "A27"],
    r: ["1", "2", "3", "7", "A", "C", "E", "N", "Q", "R", "S", "W"],
  },
  { n: "Annadale", la: 40.5405, lo: -74.1782, ids: ["S17"], r: ["SIR"] },
  {
    n: "Franklin Av",
    la: 40.6806,
    lo: -73.9558,
    ids: ["S01", "A45"],
    r: ["C", "S"],
  },
  { n: "Junius St", la: 40.6635, lo: -73.9024, ids: ["254"], r: ["3"] },
  {
    n: "Middle Village-Metropolitan Av",
    la: 40.7114,
    lo: -73.8896,
    ids: ["M01"],
    r: ["M"],
  },
  {
    n: "34 St-Hudson Yards",
    la: 40.7559,
    lo: -74.0019,
    ids: ["726"],
    r: ["7"],
  },
  { n: "52 St", la: 40.7441, lo: -73.9125, ids: ["713"], r: ["7"] },
  { n: "E 149 St", la: 40.8121, lo: -73.9041, ids: ["615"], r: ["6"] },
  {
    n: "Myrtle Av",
    la: 40.6972,
    lo: -73.9357,
    ids: ["M11"],
    r: ["J", "M", "Z"],
  },
  {
    n: "East Broadway",
    la: 40.7137,
    lo: -73.9902,
    ids: ["F16"],
    r: ["F"],
  },
  { n: "Avenue N", la: 40.6151, lo: -73.9742, ids: ["F33"], r: ["F"] },
  {
    n: "Hoyt St",
    la: 40.6905,
    lo: -73.9851,
    ids: ["233"],
    r: ["2", "3"],
  },
  { n: "Forest Av", la: 40.7044, lo: -73.9031, ids: ["M05"], r: ["M"] },
  {
    n: "Tompkinsville",
    la: 40.6369,
    lo: -74.0748,
    ids: ["S30"],
    r: ["SIR"],
  },
  { n: "77 St", la: 40.6297, lo: -74.0255, ids: ["R43"], r: ["R"] },
  {
    n: "Chambers St",
    la: 40.7141,
    lo: -74.0086,
    ids: ["A36", "R25", "E01", "228"],
    r: ["2", "3", "A", "C", "E", "R", "W"],
  },
  {
    n: "Westchester Sq-E Tremont Av",
    la: 40.8399,
    lo: -73.843,
    ids: ["604"],
    r: ["6"],
  },
  { n: "170 St", la: 40.8393, lo: -73.9134, ids: ["D09"], r: ["B", "D"] },
  {
    n: "59 St",
    la: 40.7625,
    lo: -73.968,
    ids: ["629", "R11"],
    r: ["4", "5", "6", "N", "R", "W"],
  },
  {
    n: "Prospect Av",
    la: 40.8196,
    lo: -73.9018,
    ids: ["219"],
    r: ["2", "5"],
  },
  { n: "Neptune Av", la: 40.581, lo: -73.9746, ids: ["F39"], r: ["F"] },
  { n: "Avenue U", la: 40.5975, lo: -73.9791, ids: ["N09"], r: ["N"] },
  {
    n: "Morrison Av-Soundview",
    la: 40.8295,
    lo: -73.8745,
    ids: ["610"],
    r: ["6"],
  },
  { n: "Bay Pkwy", la: 40.6208, lo: -73.9753, ids: ["F32"], r: ["F"] },
  {
    n: "5 Av/59 St",
    la: 40.7648,
    lo: -73.9733,
    ids: ["R13"],
    r: ["N", "R", "W"],
  },
  { n: "25 Av", la: 40.5977, lo: -73.9868, ids: ["B22"], r: ["D"] },
  { n: "116 St", la: 40.7986, lo: -73.9416, ids: ["622"], r: ["6"] },
  {
    n: "Beach 105 St",
    la: 40.5832,
    lo: -73.8276,
    ids: ["H14"],
    r: ["A", "S"],
  },
  {
    n: "Briarwood",
    la: 40.7092,
    lo: -73.8206,
    ids: ["F05"],
    r: ["E", "F"],
  },
  { n: "23 St", la: 40.7413, lo: -73.9893, ids: ["R19"], r: ["R", "W"] },
  { n: "28 St", la: 40.7455, lo: -73.9887, ids: ["R18"], r: ["R", "W"] },
  { n: "145 St", la: 40.8266, lo: -73.9504, ids: ["114"], r: ["1"] },
  { n: "Dyckman St", la: 40.8655, lo: -73.9273, ids: ["A03"], r: ["A"] },
  {
    n: "Marcy Av",
    la: 40.7084,
    lo: -73.9578,
    ids: ["M16"],
    r: ["J", "M", "Z"],
  },
  {
    n: "Hunters Point Av",
    la: 40.7422,
    lo: -73.9489,
    ids: ["720"],
    r: ["7"],
  },
  { n: "116 St", la: 40.8051, lo: -73.9549, ids: ["A16"], r: ["B", "C"] },
  {
    n: "Jay St-MetroTech",
    la: 40.6923,
    lo: -73.9873,
    ids: ["A41", "R29"],
    r: ["A", "C", "F", "R"],
  },
  { n: "45 St", la: 40.6489, lo: -74.01, ids: ["R39"], r: ["R"] },
  { n: "Liberty Av", la: 40.6745, lo: -73.8965, ids: ["A52"], r: ["C"] },
  { n: "Classon Av", la: 40.6889, lo: -73.9601, ids: ["G34"], r: ["G"] },
  {
    n: "Cortelyou Rd",
    la: 40.6409,
    lo: -73.9639,
    ids: ["D30"],
    r: ["Q"],
  },
  { n: "36 St", la: 40.752, lo: -73.9288, ids: ["G20"], r: ["M", "R"] },
  {
    n: "Fulton St",
    la: 40.7104,
    lo: -74.0095,
    ids: ["418", "229", "A38", "M22"],
    r: ["2", "3", "4", "5", "A", "C", "J", "Z"],
  },
  {
    n: "Bronx Park East",
    la: 40.8488,
    lo: -73.8685,
    ids: ["212"],
    r: ["2", "5"],
  },
  { n: "Gun Hill Rd", la: 40.8695, lo: -73.8464, ids: ["503"], r: ["5"] },
  { n: "79 St", la: 40.6135, lo: -74.0006, ids: ["B18"], r: ["D"] },
  {
    n: "Metropolitan Av",
    la: 40.7128,
    lo: -73.9514,
    ids: ["G29", "L10"],
    r: ["G", "L"],
  },
  {
    n: "Queens Plaza",
    la: 40.749,
    lo: -73.9372,
    ids: ["G21"],
    r: ["E", "F", "R"],
  },
  {
    n: "Kingsbridge Rd",
    la: 40.8678,
    lo: -73.8972,
    ids: ["406"],
    r: ["4"],
  },
  {
    n: "Canal St",
    la: 40.7195,
    lo: -74.0018,
    ids: ["R23", "M20", "639", "Q01"],
    r: ["6", "J", "N", "Q", "R", "W", "Z"],
  },
  { n: "191 St", la: 40.8552, lo: -73.9294, ids: ["110"], r: ["1"] },
  { n: "67 Av", la: 40.7265, lo: -73.8527, ids: ["G09"], r: ["M", "R"] },
  {
    n: "Broadway Junction",
    la: 40.6783,
    lo: -73.9053,
    ids: ["A51", "J27", "L22"],
    r: ["A", "C", "J", "L", "Z"],
  },
  {
    n: "Astoria-Ditmars Blvd",
    la: 40.775,
    lo: -73.912,
    ids: ["R01"],
    r: ["N", "W"],
  },
  {
    n: "Newkirk Av-Little Haiti",
    la: 40.64,
    lo: -73.9484,
    ids: ["246"],
    r: ["2", "5"],
  },
  {
    n: "Jefferson St",
    la: 40.7066,
    lo: -73.9229,
    ids: ["L15"],
    r: ["L"],
  },
  {
    n: "Dongan Hills",
    la: 40.5888,
    lo: -74.0961,
    ids: ["S25"],
    r: ["SIR"],
  },
  {
    n: "Aqueduct Racetrack",
    la: 40.6721,
    lo: -73.8359,
    ids: ["H01"],
    r: ["A"],
  },
  {
    n: "Cleveland St",
    la: 40.6799,
    lo: -73.8846,
    ids: ["J22"],
    r: ["J"],
  },
  { n: "86 St", la: 40.7859, lo: -73.9689, ids: ["A20"], r: ["B", "C"] },
  { n: "Grant Av", la: 40.677, lo: -73.865, ids: ["A57"], r: ["A"] },
  { n: "65 St", la: 40.7497, lo: -73.8985, ids: ["G15"], r: ["M", "R"] },
  { n: "Avenue M", la: 40.6176, lo: -73.9594, ids: ["D34"], r: ["Q"] },
  { n: "238 St", la: 40.8847, lo: -73.9009, ids: ["103"], r: ["1"] },
  {
    n: "Eastern Pkws-Brooklyn Museum",
    la: 40.672,
    lo: -73.9644,
    ids: ["238"],
    r: ["2", "3"],
  },
  {
    n: "Bleecker St",
    la: 40.7259,
    lo: -73.9947,
    ids: ["637", "D21"],
    r: ["6", "B", "D", "F", "M"],
  },
  { n: "Beverley Rd", la: 40.644, lo: -73.9645, ids: ["D29"], r: ["Q"] },
  { n: "111 St", la: 40.7517, lo: -73.8553, ids: ["705"], r: ["7"] },
  {
    n: "125 St",
    la: 40.8111,
    lo: -73.9523,
    ids: ["A15"],
    r: ["A", "B", "C", "D"],
  },
  { n: "23 St", la: 40.7429, lo: -73.9928, ids: ["D18"], r: ["F", "M"] },
  {
    n: "Wall St",
    la: 40.7076,
    lo: -74.0119,
    ids: ["419"],
    r: ["4", "5"],
  },
  { n: "Kings Hwy", la: 40.6039, lo: -73.9804, ids: ["N08"], r: ["N"] },
  {
    n: "137 St-City College",
    la: 40.822,
    lo: -73.9537,
    ids: ["115"],
    r: ["1"],
  },
  { n: "116 St", la: 40.8021, lo: -73.9496, ids: ["226"], r: ["2", "3"] },
  { n: "Franklin St", la: 40.7193, lo: -74.0069, ids: ["136"], r: ["1"] },
  { n: "176 St", la: 40.8485, lo: -73.9118, ids: ["410"], r: ["4"] },
  {
    n: "7 Av",
    la: 40.7629,
    lo: -73.9816,
    ids: ["D14"],
    r: ["B", "D", "E"],
  },
  {
    n: "174-175 Sts",
    la: 40.8459,
    lo: -73.9101,
    ids: ["D08"],
    r: ["B", "D"],
  },
  { n: "23 St", la: 40.7459, lo: -73.998, ids: ["A30"], r: ["C", "E"] },
  {
    n: "Nostrand Av",
    la: 40.6804,
    lo: -73.9504,
    ids: ["A46"],
    r: ["A", "C"],
  },
  {
    n: "Fort Hamilton Pkwy",
    la: 40.6314,
    lo: -74.0054,
    ids: ["N03"],
    r: ["N"],
  },
  { n: "Pelham Pkwy", la: 40.859, lo: -73.8554, ids: ["504"], r: ["5"] },
  { n: "36 Av", la: 40.7568, lo: -73.9296, ids: ["R06"], r: ["N", "W"] },
  {
    n: "Bedford Park Blvd",
    la: 40.8732,
    lo: -73.8871,
    ids: ["D03"],
    r: ["B", "D"],
  },
  { n: "3 Av-138 St", la: 40.8105, lo: -73.9261, ids: ["619"], r: ["6"] },
  { n: "Central Av", la: 40.6979, lo: -73.9274, ids: ["M10"], r: ["M"] },
  {
    n: "Sterling St",
    la: 40.6627,
    lo: -73.9509,
    ids: ["242"],
    r: ["2", "5"],
  },
  {
    n: "Smith-9 Sts",
    la: 40.6736,
    lo: -73.996,
    ids: ["F22"],
    r: ["F", "G"],
  },
  { n: "Elder Av", la: 40.8286, lo: -73.8792, ids: ["611"], r: ["6"] },
  { n: "96 St", la: 40.7843, lo: -73.9472, ids: ["Q05"], r: ["Q"] },
  { n: "Stapleton", la: 40.6279, lo: -74.0752, ids: ["S29"], r: ["SIR"] },
  {
    n: "Fresh Pond Rd",
    la: 40.7062,
    lo: -73.8959,
    ids: ["M04"],
    r: ["M"],
  },
  {
    n: "163 St-Amsterdam Av",
    la: 40.836,
    lo: -73.9399,
    ids: ["A10"],
    r: ["C"],
  },
  {
    n: "DeKalb Av",
    la: 40.6906,
    lo: -73.9818,
    ids: ["R30"],
    r: ["B", "Q", "R"],
  },
  { n: "28 St", la: 40.7431, lo: -73.9843, ids: ["633"], r: ["6"] },
  { n: "103 St", la: 40.7994, lo: -73.9684, ids: ["119"], r: ["1"] },
  {
    n: "21 St-Queensbridge",
    la: 40.7542,
    lo: -73.9428,
    ids: ["B04"],
    r: ["M"],
  },
  {
    n: "Nereid Av",
    la: 40.8984,
    lo: -73.8544,
    ids: ["204"],
    r: ["2", "5"],
  },
  { n: "104 St", la: 40.6952, lo: -73.8443, ids: ["J14"], r: ["J", "Z"] },
  { n: "Atlantic Av", la: 40.6753, lo: -73.9031, ids: ["L24"], r: ["L"] },
  {
    n: "Nevins St",
    la: 40.6882,
    lo: -73.9805,
    ids: ["234"],
    r: ["2", "3", "4", "5"],
  },
  { n: "Sutter Av", la: 40.6694, lo: -73.902, ids: ["L25"], r: ["L"] },
  {
    n: "Atlantic Av-Barclays Ctr",
    la: 40.6845,
    lo: -73.9769,
    ids: ["D24", "R31", "235"],
    r: ["2", "3", "4", "5", "B", "D", "N", "Q", "R"],
  },
  { n: "Zerega Av", la: 40.8365, lo: -73.847, ids: ["606"], r: ["6"] },
  {
    n: "Church Av",
    la: 40.644,
    lo: -73.9797,
    ids: ["F27"],
    r: ["F", "G"],
  },
  {
    n: "W 8 St-NY Aquarium",
    la: 40.5761,
    lo: -73.9759,
    ids: ["D42"],
    r: ["F", "Q"],
  },
  { n: "Avenue P", la: 40.6089, lo: -73.973, ids: ["F34"], r: ["F"] },
  {
    n: "161 St-Yankee Stadium",
    la: 40.828,
    lo: -73.9258,
    ids: ["414", "D11"],
    r: ["4", "B", "D"],
  },
  {
    n: "Harlem-148 St",
    la: 40.8239,
    lo: -73.9365,
    ids: ["301"],
    r: ["3"],
  },
  {
    n: "14 St",
    la: 40.7378,
    lo: -74.0002,
    ids: ["132", "D19", "L02"],
    r: ["1", "2", "3", "F", "L", "M"],
  },
  { n: "Beach 44 St", la: 40.5929, lo: -73.776, ids: ["H08"], r: ["A"] },
  {
    n: "Intervale Av",
    la: 40.8222,
    lo: -73.8967,
    ids: ["218"],
    r: ["2", "5"],
  },
  {
    n: "Wakefield-241 St",
    la: 40.9031,
    lo: -73.8506,
    ids: ["201"],
    r: ["2"],
  },
  {
    n: "Delancey St-Essex St",
    la: 40.7186,
    lo: -73.9881,
    ids: ["F15", "M18"],
    r: ["F", "J", "M", "Z"],
  },
  { n: "111 St", la: 40.6974, lo: -73.8363, ids: ["J13"], r: ["J"] },
  {
    n: "Jamaica-179 St",
    la: 40.7126,
    lo: -73.7838,
    ids: ["F01"],
    r: ["F"],
  },
  { n: "Longwood Av", la: 40.8161, lo: -73.8964, ids: ["614"], r: ["6"] },
  {
    n: "Cathedral Pkwy (110 St)",
    la: 40.804,
    lo: -73.9668,
    ids: ["118"],
    r: ["1"],
  },
  {
    n: "57 St-7 Av",
    la: 40.7647,
    lo: -73.9807,
    ids: ["R14"],
    r: ["N", "Q", "R", "W"],
  },
  {
    n: "Castle Hill Av",
    la: 40.8343,
    lo: -73.8512,
    ids: ["607"],
    r: ["6"],
  },
  { n: "Bay Pkwy", la: 40.6019, lo: -73.9937, ids: ["B21"], r: ["D"] },
  { n: "110 St", la: 40.795, lo: -73.9442, ids: ["623"], r: ["6"] },
  {
    n: "Wall St",
    la: 40.7068,
    lo: -74.0091,
    ids: ["230"],
    r: ["2", "3"],
  },
  {
    n: "Beach 98 St",
    la: 40.5853,
    lo: -73.8206,
    ids: ["H13"],
    r: ["A", "S"],
  },
  {
    n: "49 St",
    la: 40.7599,
    lo: -73.9841,
    ids: ["R15"],
    r: ["N", "R", "W"],
  },
  { n: "155 St", la: 40.8301, lo: -73.9382, ids: ["D12"], r: ["B", "D"] },
  { n: "Huguenot", la: 40.5337, lo: -74.1918, ids: ["S16"], r: ["SIR"] },
  {
    n: "Pennsylvania Av",
    la: 40.6646,
    lo: -73.8949,
    ids: ["255"],
    r: ["3"],
  },
  {
    n: "46 St-Bliss St",
    la: 40.7431,
    lo: -73.9184,
    ids: ["714"],
    r: ["7"],
  },
  {
    n: "E 180 St",
    la: 40.8419,
    lo: -73.8735,
    ids: ["213"],
    r: ["2", "5"],
  },
  { n: "Burnside Av", la: 40.8535, lo: -73.9077, ids: ["409"], r: ["4"] },
  { n: "86 St", la: 40.7779, lo: -73.9518, ids: ["Q04"], r: ["Q"] },
  {
    n: "5 Av/53 St",
    la: 40.7602,
    lo: -73.9752,
    ids: ["F12"],
    r: ["E", "F"],
  },
  { n: "Broadway", la: 40.7061, lo: -73.9503, ids: ["G30"], r: ["G"] },
  {
    n: "59 St-Columbus Circle",
    la: 40.7683,
    lo: -73.9817,
    ids: ["A24", "125"],
    r: ["1", "A", "B", "C", "D"],
  },
  {
    n: "Gun Hill Rd",
    la: 40.8779,
    lo: -73.8663,
    ids: ["208"],
    r: ["2", "5"],
  },
  {
    n: "34 St-Penn Station",
    la: 40.7504,
    lo: -73.9911,
    ids: ["128"],
    r: ["1", "2", "3"],
  },
  { n: "Neck Rd", la: 40.5952, lo: -73.9552, ids: ["D38"], r: ["Q"] },
  {
    n: "Rockaway Blvd",
    la: 40.6804,
    lo: -73.8439,
    ids: ["A61"],
    r: ["A"],
  },
  { n: "Bay Ridge Av", la: 40.635, lo: -74.0234, ids: ["R42"], r: ["R"] },
  {
    n: "Coney Island-Stillwell Av",
    la: 40.5774,
    lo: -73.9812,
    ids: ["D43"],
    r: ["D", "F", "N", "Q"],
  },
  {
    n: "68 St-Hunter College",
    la: 40.7681,
    lo: -73.9639,
    ids: ["628"],
    r: ["6"],
  },
  {
    n: "Northern Blvd",
    la: 40.7529,
    lo: -73.906,
    ids: ["G16"],
    r: ["M", "R"],
  },
  {
    n: "Canarsie-Rockaway Pkwy",
    la: 40.6467,
    lo: -73.9018,
    ids: ["L29"],
    r: ["L"],
  },
  {
    n: "14 St",
    la: 40.7409,
    lo: -74.0017,
    ids: ["A31", "L01"],
    r: ["A", "C", "E", "L"],
  },
  {
    n: "Court Sq",
    la: 40.7466,
    lo: -73.9438,
    ids: ["G22", "719", "F09"],
    r: ["7", "E", "F", "G"],
  },
  {
    n: "Grand Army Plaza",
    la: 40.6752,
    lo: -73.971,
    ids: ["237"],
    r: ["2", "3"],
  },
  {
    n: "Kosciuszko St",
    la: 40.6933,
    lo: -73.9288,
    ids: ["J31"],
    r: ["J"],
  },
  {
    n: "Knickerbocker Av",
    la: 40.6987,
    lo: -73.9197,
    ids: ["M09"],
    r: ["M"],
  },
  { n: "Brook Av", la: 40.8076, lo: -73.9192, ids: ["618"], r: ["6"] },
  {
    n: "Aqueduct-N Conduit Av",
    la: 40.6682,
    lo: -73.8341,
    ids: ["H02"],
    r: ["A"],
  },
  {
    n: "Oakwood Heights",
    la: 40.5651,
    lo: -74.1263,
    ids: ["S21"],
    r: ["SIR"],
  },
  {
    n: "72 St",
    la: 40.7785,
    lo: -73.982,
    ids: ["123"],
    r: ["1", "2", "3"],
  },
  { n: "71 St", la: 40.6196, lo: -73.9989, ids: ["B17"], r: ["D"] },
  {
    n: "Crown Hts-Utica Av",
    la: 40.6689,
    lo: -73.9329,
    ids: ["250"],
    r: ["3", "4"],
  },
  {
    n: "82 St-Jackson Hts",
    la: 40.7477,
    lo: -73.8837,
    ids: ["709"],
    r: ["7"],
  },
  {
    n: "Van Siclen Av",
    la: 40.678,
    lo: -73.8917,
    ids: ["J23"],
    r: ["J", "Z"],
  },
  { n: "Graham Av", la: 40.7146, lo: -73.9441, ids: ["L11"], r: ["L"] },
  {
    n: "75 St-Elderts Ln",
    la: 40.6913,
    lo: -73.8671,
    ids: ["J17"],
    r: ["J", "Z"],
  },
  {
    n: "Mets-Willets Point",
    la: 40.7546,
    lo: -73.8456,
    ids: ["702"],
    r: ["7"],
  },
  { n: "Spring St", la: 40.7223, lo: -73.9971, ids: ["638"], r: ["6"] },
  { n: "57 St", la: 40.764, lo: -73.9775, ids: ["B10"], r: ["M"] },
  {
    n: "110 St-Malcolm X Plaza",
    la: 40.7991,
    lo: -73.9518,
    ids: ["227"],
    r: ["2", "3"],
  },
  { n: "96 St", la: 40.7916, lo: -73.9647, ids: ["A19"], r: ["B", "C"] },
  {
    n: "36 St",
    la: 40.6551,
    lo: -74.0035,
    ids: ["R36"],
    r: ["D", "N", "R"],
  },
  {
    n: "Sutphin Blvd",
    la: 40.7055,
    lo: -73.8107,
    ids: ["F04"],
    r: ["F"],
  },
  {
    n: "Euclid Av",
    la: 40.6754,
    lo: -73.8721,
    ids: ["A55"],
    r: ["A", "C"],
  },
  {
    n: "Prince St",
    la: 40.7243,
    lo: -73.9977,
    ids: ["R22"],
    r: ["R", "W"],
  },
  { n: "181 St", la: 40.8495, lo: -73.9336, ids: ["111"], r: ["1"] },
  { n: "Old Town", la: 40.5966, lo: -74.0874, ids: ["S26"], r: ["SIR"] },
  {
    n: "Canal St",
    la: 40.7208,
    lo: -74.0052,
    ids: ["A34"],
    r: ["A", "C", "E"],
  },
  {
    n: "Inwood-207 St",
    la: 40.8681,
    lo: -73.9199,
    ids: ["A02"],
    r: ["A"],
  },
  { n: "Avenue J", la: 40.625, lo: -73.9608, ids: ["D33"], r: ["Q"] },
  {
    n: "Beverly Rd",
    la: 40.6451,
    lo: -73.949,
    ids: ["245"],
    r: ["2", "5"],
  },
  {
    n: "90 St-Elmhurst Av",
    la: 40.7484,
    lo: -73.8766,
    ids: ["708"],
    r: ["7"],
  },
  {
    n: "Hewes St",
    la: 40.7069,
    lo: -73.9534,
    ids: ["M14"],
    r: ["J", "M"],
  },
  {
    n: "Bedford Park Blvd-Lehman College",
    la: 40.8734,
    lo: -73.8901,
    ids: ["405"],
    r: ["4"],
  },
  {
    n: "14 St-Union Sq",
    la: 40.7348,
    lo: -73.9907,
    ids: ["L03", "635", "R20"],
    r: ["4", "5", "6", "L", "N", "Q", "R", "W"],
  },
  { n: "Morgan Av", la: 40.7062, lo: -73.9331, ids: ["L14"], r: ["L"] },
  {
    n: "47-50 Sts-Rockefeller Ctr",
    la: 40.7587,
    lo: -73.9813,
    ids: ["D15"],
    r: ["B", "D", "F", "M"],
  },
  { n: "Canal St", la: 40.7229, lo: -74.0063, ids: ["135"], r: ["1"] },
  { n: "104 St", la: 40.6817, lo: -73.8377, ids: ["A63"], r: ["A"] },
  {
    n: "Chambers St",
    la: 40.7132,
    lo: -74.0034,
    ids: ["M21", "640"],
    r: ["4", "5", "6", "J", "Z"],
  },
  { n: "3 Av", la: 40.7328, lo: -73.9861, ids: ["L05"], r: ["L"] },
  {
    n: "Kingsbridge Rd",
    la: 40.867,
    lo: -73.8935,
    ids: ["D04"],
    r: ["B", "D"],
  },
  { n: "Kingston Av", la: 40.6694, lo: -73.9422, ids: ["249"], r: ["3"] },
  {
    n: "Rector St",
    la: 40.7072,
    lo: -74.0133,
    ids: ["R26"],
    r: ["R", "W"],
  },
  {
    n: "Cypress Hills",
    la: 40.6899,
    lo: -73.8726,
    ids: ["J19"],
    r: ["J"],
  },
  {
    n: "High St",
    la: 40.6993,
    lo: -73.9905,
    ids: ["A40"],
    r: ["A", "C"],
  },
  {
    n: "Forest Hills-71 Av",
    la: 40.7217,
    lo: -73.8445,
    ids: ["G08"],
    r: ["E", "F", "M", "R"],
  },
  { n: "Wilson Av", la: 40.6888, lo: -73.904, ids: ["L20"], r: ["L"] },
  {
    n: "Bedford-Nostrand Avs",
    la: 40.6896,
    lo: -73.9535,
    ids: ["G33"],
    r: ["G"],
  },
  {
    n: "Arthur Kill",
    la: 40.5166,
    lo: -74.2421,
    ids: ["S11"],
    r: ["SIR"],
  },
  { n: "Livonia Av", la: 40.664, lo: -73.9006, ids: ["L26"], r: ["L"] },
  { n: "18 St", la: 40.741, lo: -73.9979, ids: ["131"], r: ["1"] },
  { n: "Halsey St", la: 40.6956, lo: -73.9041, ids: ["L19"], r: ["L"] },
  {
    n: "5 Av",
    la: 40.7538,
    lo: -73.982,
    ids: ["724", "D16"],
    r: ["7", "B", "D", "F", "M"],
  },
  {
    n: "Carroll St",
    la: 40.6803,
    lo: -73.995,
    ids: ["F21"],
    r: ["F", "G"],
  },
  {
    n: "President St-Medgar Evers College",
    la: 40.6679,
    lo: -73.9507,
    ids: ["241"],
    r: ["2", "5"],
  },
  { n: "Ditmas Av", la: 40.6361, lo: -73.9782, ids: ["F29"], r: ["F"] },
  { n: "Kings Hwy", la: 40.6032, lo: -73.9724, ids: ["F35"], r: ["F"] },
  {
    n: "149 St-Grand Concourse",
    la: 40.8184,
    lo: -73.9274,
    ids: ["415", "222"],
    r: ["2", "4", "5"],
  },
  { n: "New Dorp", la: 40.5735, lo: -74.1172, ids: ["S22"], r: ["SIR"] },
  { n: "Beach 60 St", la: 40.5924, lo: -73.7885, ids: ["H07"], r: ["A"] },
  {
    n: "Burke Av",
    la: 40.8714,
    lo: -73.8672,
    ids: ["209"],
    r: ["2", "5"],
  },
  { n: "7 Av", la: 40.6771, lo: -73.9724, ids: ["D25"], r: ["B", "Q"] },
  {
    n: "Sheepshead Bay",
    la: 40.5869,
    lo: -73.9542,
    ids: ["D39"],
    r: ["B", "Q"],
  },
  { n: "9 Av", la: 40.6463, lo: -73.9943, ids: ["B12"], r: ["D"] },
  {
    n: "W 4 St-Wash Sq",
    la: 40.7323,
    lo: -74.0005,
    ids: ["A32", "D20"],
    r: ["A", "B", "C", "D", "E", "F", "M"],
  },
  {
    n: "Jamaica-Van Wyck",
    la: 40.7026,
    lo: -73.8169,
    ids: ["G07"],
    r: ["E"],
  },
  { n: "21 St", la: 40.7441, lo: -73.9497, ids: ["G24"], r: ["G"] },
  { n: "155 St", la: 40.8305, lo: -73.9415, ids: ["A11"], r: ["C"] },
  { n: "167 St", la: 40.8355, lo: -73.9214, ids: ["413"], r: ["4"] },
  {
    n: "Van Cortlandt Park-242 St",
    la: 40.8892,
    lo: -73.8986,
    ids: ["101"],
    r: ["1"],
  },
  { n: "50 St", la: 40.7625, lo: -73.986, ids: ["A25"], r: ["C", "E"] },
  { n: "33 St", la: 40.7461, lo: -73.9821, ids: ["632"], r: ["6"] },
  { n: "79 St", la: 40.7839, lo: -73.9799, ids: ["122"], r: ["1"] },
  {
    n: "Kingston-Throop Avs",
    la: 40.6799,
    lo: -73.9409,
    ids: ["A47"],
    r: ["C"],
  },
  { n: "219 St", la: 40.8839, lo: -73.8626, ids: ["207"], r: ["2", "5"] },
  {
    n: "Grand Av-Newtown",
    la: 40.737,
    lo: -73.8772,
    ids: ["G12"],
    r: ["M", "R"],
  },
  {
    n: "New Utrecht Av",
    la: 40.6248,
    lo: -73.9964,
    ids: ["N04", "B16"],
    r: ["D", "N"],
  },
  {
    n: "145 St",
    la: 40.8248,
    lo: -73.9442,
    ids: ["A12", "D13"],
    r: ["A", "B", "C", "D"],
  },
  {
    n: "Broadway",
    la: 40.7618,
    lo: -73.9255,
    ids: ["R05"],
    r: ["N", "W"],
  },
  {
    n: "Lafayette Av",
    la: 40.6861,
    lo: -73.9739,
    ids: ["A43"],
    r: ["C"],
  },
  { n: "Avenue U", la: 40.5993, lo: -73.9559, ids: ["D37"], r: ["Q"] },
  { n: "88 St", la: 40.6798, lo: -73.8515, ids: ["A60"], r: ["A"] },
  { n: "25 St", la: 40.6604, lo: -73.9981, ids: ["R35"], r: ["R"] },
  { n: "46 St", la: 40.7563, lo: -73.9133, ids: ["G18"], r: ["M", "R"] },
  { n: "Fulton St", la: 40.6871, lo: -73.9754, ids: ["G36"], r: ["G"] },
  {
    n: "Borough Hall",
    la: 40.6924,
    lo: -73.9902,
    ids: ["423", "232", "R28"],
    r: ["2", "3", "4", "5", "R"],
  },
  {
    n: "116 St-Columbia University",
    la: 40.8077,
    lo: -73.9641,
    ids: ["117"],
    r: ["1"],
  },
  { n: "Parkchester", la: 40.8332, lo: -73.8608, ids: ["608"], r: ["6"] },
  {
    n: "23 St-Baruch College",
    la: 40.7399,
    lo: -73.9866,
    ids: ["634"],
    r: ["6"],
  },
  { n: "Beach 67 St", la: 40.5909, lo: -73.7969, ids: ["H06"], r: ["A"] },
  { n: "183 St", la: 40.8584, lo: -73.9039, ids: ["408"], r: ["4"] },
  {
    n: "Lexington Av/53 St",
    la: 40.7576,
    lo: -73.9691,
    ids: ["F11", "630"],
    r: ["6", "E", "F"],
  },
  {
    n: "Prospect Park",
    la: 40.6616,
    lo: -73.9622,
    ids: ["D26"],
    r: ["B", "Q", "S"],
  },
  { n: "28 St", la: 40.7472, lo: -73.9934, ids: ["129"], r: ["1"] },
  {
    n: "City Hall",
    la: 40.7133,
    lo: -74.007,
    ids: ["R24"],
    r: ["R", "W"],
  },
  { n: "75 Av", la: 40.7183, lo: -73.8373, ids: ["F07"], r: ["E", "F"] },
  { n: "18 Av", la: 40.6207, lo: -73.9904, ids: ["N05"], r: ["N"] },
  {
    n: "168 St-Washington Hts",
    la: 40.8406,
    lo: -73.9401,
    ids: ["112", "A09"],
    r: ["1", "A", "C"],
  },
  { n: "145 St", la: 40.8204, lo: -73.9362, ids: ["302"], r: ["3"] },
  { n: "181 St", la: 40.8517, lo: -73.938, ids: ["A06"], r: ["A"] },
  { n: "215 St", la: 40.8694, lo: -73.9153, ids: ["107"], r: ["1"] },
  {
    n: "Gates Av",
    la: 40.6896,
    lo: -73.9223,
    ids: ["J30"],
    r: ["J", "Z"],
  },
  {
    n: "40 St-Lowery St",
    la: 40.7438,
    lo: -73.924,
    ids: ["715"],
    r: ["7"],
  },
  {
    n: "Bergen St",
    la: 40.6861,
    lo: -73.9909,
    ids: ["F20"],
    r: ["F", "G"],
  },
  {
    n: "Utica Av",
    la: 40.6794,
    lo: -73.9307,
    ids: ["A48"],
    r: ["A", "C"],
  },
  { n: "72 St", la: 40.7688, lo: -73.9584, ids: ["Q03"], r: ["Q"] },
  {
    n: "Clark St",
    la: 40.6975,
    lo: -73.9931,
    ids: ["231"],
    r: ["2", "3"],
  },
  { n: "72 St", la: 40.7756, lo: -73.9764, ids: ["A22"], r: ["B", "C"] },
  { n: "Shepherd Av", la: 40.6741, lo: -73.8808, ids: ["A54"], r: ["C"] },
  { n: "59 St", la: 40.6414, lo: -74.0179, ids: ["R41"], r: ["N", "R"] },
  { n: "Buhre Av", la: 40.8468, lo: -73.8326, ids: ["602"], r: ["6"] },
  { n: "77 St", la: 40.7736, lo: -73.9599, ids: ["627"], r: ["6"] },
  { n: "Avenue H", la: 40.6293, lo: -73.9616, ids: ["D32"], r: ["Q"] },
  { n: "Rector St", la: 40.7075, lo: -74.0138, ids: ["139"], r: ["1"] },
  {
    n: "39 Av-Dutch Kills",
    la: 40.7529,
    lo: -73.9328,
    ids: ["R08"],
    r: ["N", "W"],
  },
  {
    n: "Bay Terrace",
    la: 40.5564,
    lo: -74.1369,
    ids: ["S20"],
    r: ["SIR"],
  },
  { n: "121 St", la: 40.7005, lo: -73.8283, ids: ["J12"], r: ["J", "Z"] },
  { n: "Houston St", la: 40.7283, lo: -74.0054, ids: ["134"], r: ["1"] },
  { n: "169 St", la: 40.7105, lo: -73.7936, ids: ["F02"], r: ["F"] },
  { n: "18 Av", la: 40.6298, lo: -73.977, ids: ["F30"], r: ["F"] },
  {
    n: "Eastchester-Dyre Av",
    la: 40.8883,
    lo: -73.8308,
    ids: ["501"],
    r: ["5"],
  },
  { n: "Flushing Av", la: 40.7004, lo: -73.9502, ids: ["G31"], r: ["G"] },
  {
    n: "Sutter Av-Rutland Rd",
    la: 40.6647,
    lo: -73.9226,
    ids: ["251"],
    r: ["3"],
  },
  {
    n: "West Farms Sq-E Tremont Av",
    la: 40.8403,
    lo: -73.88,
    ids: ["214"],
    r: ["2", "5"],
  },
  { n: "103 St", la: 40.7906, lo: -73.9475, ids: ["624"], r: ["6"] },
  { n: "Beach 25 St", la: 40.6001, lo: -73.7614, ids: ["H10"], r: ["A"] },
  {
    n: "8 St-NYU",
    la: 40.7303,
    lo: -73.9926,
    ids: ["R21"],
    r: ["R", "W"],
  },
  { n: "Grand St", la: 40.7119, lo: -73.9407, ids: ["L12"], r: ["L"] },
  {
    n: "Prince's Bay",
    la: 40.5255,
    lo: -74.2001,
    ids: ["S15"],
    r: ["SIR"],
  },
  {
    n: "Van Siclen Av",
    la: 40.6654,
    lo: -73.8894,
    ids: ["256"],
    r: ["3"],
  },
  {
    n: "Flushing-Main St",
    la: 40.7596,
    lo: -73.83,
    ids: ["701"],
    r: ["7"],
  },
  {
    n: "Botanic Garden",
    la: 40.6703,
    lo: -73.9592,
    ids: ["S04", "239"],
    r: ["2", "3", "4", "5", "S"],
  },
  {
    n: "Fordham Rd",
    la: 40.8613,
    lo: -73.8977,
    ids: ["D05"],
    r: ["B", "D"],
  },
  {
    n: "Bergen St",
    la: 40.6808,
    lo: -73.9751,
    ids: ["236"],
    r: ["2", "3"],
  },
  {
    n: "Myrtle-Wyckoff Avs",
    la: 40.6994,
    lo: -73.9124,
    ids: ["M08", "L17"],
    r: ["L", "M"],
  },
  {
    n: "66 St-Lincoln Center",
    la: 40.7734,
    lo: -73.9822,
    ids: ["124"],
    r: ["1"],
  },
  { n: "7 Av", la: 40.6663, lo: -73.9803, ids: ["F24"], r: ["F", "G"] },
  { n: "Cypress Av", la: 40.8054, lo: -73.914, ids: ["617"], r: ["6"] },
  { n: "103 St", la: 40.7961, lo: -73.9615, ids: ["A18"], r: ["B", "C"] },
  {
    n: "Howard Beach-JFK Airport",
    la: 40.6605,
    lo: -73.8303,
    ids: ["H03"],
    r: ["A"],
  },
  {
    n: "Church Av",
    la: 40.6508,
    lo: -73.9496,
    ids: ["244"],
    r: ["2", "5"],
  },
  {
    n: "74 St-Broadway",
    la: 40.7468,
    lo: -73.8914,
    ids: ["710", "G14"],
    r: ["7", "E", "F", "M", "R"],
  },
  {
    n: "Alabama Av",
    la: 40.677,
    lo: -73.8987,
    ids: ["J24"],
    r: ["J", "Z"],
  },
  {
    n: "Bushwick Av-Aberdeen St",
    la: 40.6828,
    lo: -73.9052,
    ids: ["L21"],
    r: ["L"],
  },
  { n: "Union St", la: 40.6773, lo: -73.9831, ids: ["R32"], r: ["R"] },
  {
    n: "Grand Central-42 St",
    la: 40.7518,
    lo: -73.9768,
    ids: ["631", "723", "901"],
    r: ["4", "5", "6", "7", "S"],
  },
  {
    n: "85 St-Forest Pkwy",
    la: 40.6924,
    lo: -73.86,
    ids: ["J16"],
    r: ["J"],
  },
  {
    n: "Lexington Av/63 St",
    la: 40.7646,
    lo: -73.9661,
    ids: ["B08"],
    r: ["M", "Q"],
  },
  {
    n: "Whitehall St-South Ferry",
    la: 40.7031,
    lo: -74.013,
    ids: ["R27", "142"],
    r: ["1", "R", "W"],
  },
  {
    n: "Simpson St",
    la: 40.8241,
    lo: -73.8931,
    ids: ["217"],
    r: ["2", "5"],
  },
  { n: "New Lots Av", la: 40.6587, lo: -73.8992, ids: ["L27"], r: ["L"] },
  {
    n: "Allerton Av",
    la: 40.8655,
    lo: -73.8674,
    ids: ["210"],
    r: ["2", "5"],
  },
  { n: "Avenue U", la: 40.5961, lo: -73.9734, ids: ["F36"], r: ["F"] },
  {
    n: "138 St-Grand Concourse",
    la: 40.8132,
    lo: -73.9298,
    ids: ["416"],
    r: ["4", "5"],
  },
  { n: "20 Av", la: 40.6046, lo: -73.9982, ids: ["B20"], r: ["D"] },
  {
    n: "Fort Hamilton Pkwy",
    la: 40.6409,
    lo: -73.9943,
    ids: ["B13"],
    r: ["D"],
  },
  {
    n: "15 St-Prospect Park",
    la: 40.6604,
    lo: -73.9795,
    ids: ["F25"],
    r: ["F", "G"],
  },
  {
    n: "WTC Cortlandt",
    la: 40.7118,
    lo: -74.0122,
    ids: ["138"],
    r: ["1"],
  },
  {
    n: "Greenpoint Av",
    la: 40.7314,
    lo: -73.9544,
    ids: ["G26"],
    r: ["G"],
  },
  { n: "1 Av", la: 40.731, lo: -73.9816, ids: ["L06"], r: ["L"] },
  {
    n: "Brighton Beach",
    la: 40.5776,
    lo: -73.9614,
    ids: ["D40"],
    r: ["B", "Q"],
  },
  { n: "30 Av", la: 40.7668, lo: -73.9215, ids: ["R04"], r: ["N", "W"] },
  {
    n: "Mosholu Pkwy",
    la: 40.8798,
    lo: -73.8847,
    ids: ["402"],
    r: ["4"],
  },
  {
    n: "Far Rockaway-Mott Av",
    la: 40.604,
    lo: -73.7554,
    ids: ["H11"],
    r: ["A"],
  },
  {
    n: "Pelham Bay Park",
    la: 40.8525,
    lo: -73.8281,
    ids: ["601"],
    r: ["6"],
  },
  {
    n: "Hunts Point Av",
    la: 40.8209,
    lo: -73.8905,
    ids: ["613"],
    r: ["6"],
  },
  { n: "Grasmere", la: 40.6031, lo: -74.0841, ids: ["S27"], r: ["SIR"] },
  {
    n: "Crescent St",
    la: 40.6832,
    lo: -73.8738,
    ids: ["J20"],
    r: ["J", "Z"],
  },
  { n: "111 St", la: 40.6843, lo: -73.8322, ids: ["A64"], r: ["A"] },
  { n: "175 St", la: 40.8474, lo: -73.9397, ids: ["A07"], r: ["A"] },
  {
    n: "Marble Hill-225 St",
    la: 40.8746,
    lo: -73.9098,
    ids: ["106"],
    r: ["1"],
  },
  { n: "86 St", la: 40.7886, lo: -73.9762, ids: ["121"], r: ["1"] },
  { n: "225 St", la: 40.888, lo: -73.8603, ids: ["206"], r: ["2", "5"] },
  {
    n: "Elmhurst Av",
    la: 40.7425,
    lo: -73.882,
    ids: ["G13"],
    r: ["M", "R"],
  },
  { n: "Parkside Av", la: 40.6553, lo: -73.9615, ids: ["D27"], r: ["Q"] },
  { n: "Nostrand Av", la: 40.6698, lo: -73.9505, ids: ["248"], r: ["3"] },
  {
    n: "Junction Blvd",
    la: 40.7491,
    lo: -73.8695,
    ids: ["707"],
    r: ["7"],
  },
  { n: "86 St", la: 40.6227, lo: -74.0284, ids: ["R44"], r: ["R"] },
  { n: "170 St", la: 40.8401, lo: -73.9178, ids: ["412"], r: ["4"] },
  {
    n: "3 Av-149 St",
    la: 40.8161,
    lo: -73.9178,
    ids: ["221"],
    r: ["2", "5"],
  },
  { n: "207 St", la: 40.8646, lo: -73.9188, ids: ["108"], r: ["1"] },
  {
    n: "Broad Channel",
    la: 40.6084,
    lo: -73.8159,
    ids: ["H04"],
    r: ["A", "S"],
  },
  {
    n: "Clinton-Washington Avs",
    la: 40.6833,
    lo: -73.9658,
    ids: ["A44"],
    r: ["C"],
  },
  { n: "Ralph Av", la: 40.6788, lo: -73.9208, ids: ["A49"], r: ["C"] },
  { n: "69 St", la: 40.7463, lo: -73.8964, ids: ["711"], r: ["7"] },
  { n: "Bay 50 St", la: 40.5888, lo: -73.9838, ids: ["B23"], r: ["D"] },
  {
    n: "Woodhaven Blvd",
    la: 40.7331,
    lo: -73.8692,
    ids: ["G11"],
    r: ["M", "R"],
  },
  {
    n: "Tottenville",
    la: 40.5128,
    lo: -74.252,
    ids: ["S09"],
    r: ["SIR"],
  },
  {
    n: "Queensboro Plaza",
    la: 40.7506,
    lo: -73.9402,
    ids: ["R09", "718"],
    r: ["7", "N", "W"],
  },
  {
    n: "Lorimer St",
    la: 40.7039,
    lo: -73.9474,
    ids: ["M13"],
    r: ["J", "M"],
  },
  { n: "Grant City", la: 40.579, lo: -74.1097, ids: ["S23"], r: ["SIR"] },
  {
    n: "Sutphin Blvd-Archer Av-JFK Airport",
    la: 40.7005,
    lo: -73.808,
    ids: ["G06"],
    r: ["E", "J", "Z"],
  },
  {
    n: "33 St-Rawson St",
    la: 40.7446,
    lo: -73.931,
    ids: ["716"],
    r: ["7"],
  },
  {
    n: "Cathedral Pkwy (110 St)",
    la: 40.8006,
    lo: -73.9582,
    ids: ["A17"],
    r: ["B", "C"],
  },
  {
    n: "Kew Gardens-Union Tpke",
    la: 40.7144,
    lo: -73.831,
    ids: ["F06"],
    r: ["E", "F"],
  },
  { n: "23 St", la: 40.7441, lo: -73.9957, ids: ["130"], r: ["1"] },
  {
    n: "Hoyt-Schermerhorn Sts",
    la: 40.6885,
    lo: -73.985,
    ids: ["A42"],
    r: ["A", "C", "G"],
  },
  { n: "135 St", la: 40.8142, lo: -73.9408, ids: ["224"], r: ["2", "3"] },
  { n: "20 Av", la: 40.6174, lo: -73.985, ids: ["N06"], r: ["N"] },
  { n: "190 St", la: 40.859, lo: -73.9342, ids: ["A05"], r: ["A"] },
  {
    n: "Clinton-Washington Avs",
    la: 40.6881,
    lo: -73.9668,
    ids: ["G35"],
    r: ["G"],
  },
  {
    n: "E 143 St-St Mary's St",
    la: 40.8087,
    lo: -73.9077,
    ids: ["616"],
    r: ["6"],
  },
  { n: "Halsey St", la: 40.6864, lo: -73.9166, ids: ["J29"], r: ["J"] },
  {
    n: "Grand St",
    la: 40.7183,
    lo: -73.9938,
    ids: ["D22"],
    r: ["B", "D"],
  },
  { n: "86 St", la: 40.5927, lo: -73.9782, ids: ["N10"], r: ["N"] },
  { n: "Saratoga Av", la: 40.6615, lo: -73.9163, ids: ["252"], r: ["3"] },
  {
    n: "Great Kills",
    la: 40.5512,
    lo: -74.1514,
    ids: ["S19"],
    r: ["SIR"],
  },
  { n: "Seneca Av", la: 40.7028, lo: -73.9077, ids: ["M06"], r: ["M"] },
  {
    n: "Rockaway Park-Beach 116 St",
    la: 40.5809,
    lo: -73.8356,
    ids: ["H15"],
    r: ["A", "S"],
  },
  { n: "Montrose Av", la: 40.7077, lo: -73.9399, ids: ["L13"], r: ["L"] },
  { n: "167 St", la: 40.8338, lo: -73.9184, ids: ["D10"], r: ["B", "D"] },
  { n: "New Lots Av", la: 40.6662, lo: -73.8841, ids: ["257"], r: ["3"] },
  {
    n: "Pleasant Plains",
    la: 40.5224,
    lo: -74.2178,
    ids: ["S14"],
    r: ["SIR"],
  },
  {
    n: "Baychester Av",
    la: 40.8787,
    lo: -73.8386,
    ids: ["502"],
    r: ["5"],
  },
  {
    n: "Myrtle-Willoughby Avs",
    la: 40.6946,
    lo: -73.949,
    ids: ["G32"],
    r: ["G"],
  },
  { n: "174 St", la: 40.8373, lo: -73.8877, ids: ["215"], r: ["2", "5"] },
  { n: "Fordham Rd", la: 40.8628, lo: -73.901, ids: ["407"], r: ["4"] },
  {
    n: "81 St-Museum of Natural History",
    la: 40.7814,
    lo: -73.9721,
    ids: ["A21"],
    r: ["B", "C"],
  },
  { n: "St George", la: 40.6437, lo: -74.0736, ids: ["S31"], r: ["SIR"] },
  {
    n: "Van Siclen Av",
    la: 40.6727,
    lo: -73.8904,
    ids: ["A53"],
    r: ["C"],
  },
  { n: "157 St", la: 40.834, lo: -73.9449, ids: ["113"], r: ["1"] },
  {
    n: "Middletown Rd",
    la: 40.8439,
    lo: -73.8363,
    ids: ["603"],
    r: ["6"],
  },
  { n: "Prospect Av", la: 40.6654, lo: -73.9929, ids: ["R34"], r: ["R"] },
  { n: "Park Pl", la: 40.6748, lo: -73.9576, ids: ["S03"], r: ["S"] },
  {
    n: "Newkirk Plaza",
    la: 40.6351,
    lo: -73.9628,
    ids: ["D31"],
    r: ["B", "Q"],
  },
  {
    n: "Steinway St",
    la: 40.7569,
    lo: -73.9207,
    ids: ["G19"],
    r: ["M", "R"],
  },
  {
    n: "Parsons Blvd",
    la: 40.7076,
    lo: -73.8033,
    ids: ["F03"],
    r: ["F"],
  },
  {
    n: "Christopher St-Stonewall",
    la: 40.7334,
    lo: -74.0029,
    ids: ["133"],
    r: ["1"],
  },
  {
    n: "Bowling Green",
    la: 40.7048,
    lo: -74.0141,
    ids: ["420"],
    r: ["4", "5"],
  },
  {
    n: "St Lawrence Av",
    la: 40.8315,
    lo: -73.8676,
    ids: ["609"],
    r: ["6"],
  },
  { n: "125 St", la: 40.8156, lo: -73.9584, ids: ["116"], r: ["1"] },
  { n: "York St", la: 40.7014, lo: -73.9868, ids: ["F18"], r: ["F"] },
  { n: "Avenue I", la: 40.6253, lo: -73.9761, ids: ["F31"], r: ["F"] },
  { n: "55 St", la: 40.6314, lo: -73.9955, ids: ["B15"], r: ["D"] },
  { n: "Beach 36 St", la: 40.5954, lo: -73.7682, ids: ["H09"], r: ["A"] },
  {
    n: "Broad St",
    la: 40.7065,
    lo: -74.0111,
    ids: ["M23"],
    r: ["J", "Z"],
  },
  { n: "96 St", la: 40.7857, lo: -73.9511, ids: ["625"], r: ["6"] },
  {
    n: "34 St-Herald Sq",
    la: 40.7496,
    lo: -73.9879,
    ids: ["R17", "D17"],
    r: ["B", "D", "F", "M", "N", "Q", "R", "W"],
  },
  {
    n: "182-183 Sts",
    la: 40.8561,
    lo: -73.9007,
    ids: ["D06"],
    r: ["B", "D"],
  },
  { n: "135 St", la: 40.8179, lo: -73.9476, ids: ["A14"], r: ["B", "C"] },
  {
    n: "Pelham Pkwy",
    la: 40.8572,
    lo: -73.8676,
    ids: ["211"],
    r: ["2", "5"],
  },
  { n: "Bay Pkwy", la: 40.6118, lo: -73.9818, ids: ["N07"], r: ["N"] },
  { n: "125 St", la: 40.8078, lo: -73.9455, ids: ["225"], r: ["2", "3"] },
  { n: "50 St", la: 40.6363, lo: -73.9948, ids: ["B14"], r: ["D"] },
  {
    n: "Bay Ridge-95 St",
    la: 40.6166,
    lo: -74.0309,
    ids: ["R45"],
    r: ["R"],
  },
  { n: "Nassau Av", la: 40.7246, lo: -73.9513, ids: ["G28"], r: ["G"] },
  {
    n: "Spring St",
    la: 40.7262,
    lo: -74.0037,
    ids: ["A33"],
    r: ["C", "E"],
  },
  { n: "Mt Eden Av", la: 40.8444, lo: -73.9147, ids: ["411"], r: ["4"] },
  {
    n: "Jamaica Center-Parsons/Archer",
    la: 40.7021,
    lo: -73.8011,
    ids: ["G05"],
    r: ["E", "J", "Z"],
  },
  { n: "Dyckman St", la: 40.8605, lo: -73.9255, ids: ["109"], r: ["1"] },
  { n: "53 St", la: 40.6451, lo: -74.014, ids: ["R40"], r: ["R"] },
  { n: "80 St", la: 40.6794, lo: -73.859, ids: ["A59"], r: ["A"] },
  { n: "Rockaway Av", la: 40.6783, lo: -73.9119, ids: ["A50"], r: ["C"] },
  {
    n: "Kings Hwy",
    la: 40.6087,
    lo: -73.9577,
    ids: ["D35"],
    r: ["B", "Q"],
  },
  {
    n: "86 St",
    la: 40.7795,
    lo: -73.9556,
    ids: ["626"],
    r: ["4", "5", "6"],
  },
  {
    n: "Astoria Blvd",
    la: 40.7703,
    lo: -73.9178,
    ids: ["R03"],
    r: ["N", "W"],
  },
  {
    n: "Freeman St",
    la: 40.83,
    lo: -73.8919,
    ids: ["216"],
    r: ["2", "5"],
  },
  {
    n: "Norwood-205 St",
    la: 40.8748,
    lo: -73.8789,
    ids: ["D01"],
    r: ["D"],
  },
  {
    n: "103 St-Corona Plaza",
    la: 40.7499,
    lo: -73.8627,
    ids: ["706"],
    r: ["7"],
  },
  {
    n: "Winthrop St",
    la: 40.6567,
    lo: -73.9502,
    ids: ["243"],
    r: ["2", "5"],
  },
  {
    n: "4 Av-9 St",
    la: 40.6703,
    lo: -73.9898,
    ids: ["F23", "R33"],
    r: ["F", "G", "R"],
  },
  {
    n: "Fort Hamilton Pkwy",
    la: 40.6508,
    lo: -73.9758,
    ids: ["F26"],
    r: ["F", "G"],
  },
  { n: "Avenue X", la: 40.5896, lo: -73.9742, ids: ["F38"], r: ["F"] },
  { n: "233 St", la: 40.8932, lo: -73.8575, ids: ["205"], r: ["2", "5"] },
  { n: "DeKalb Av", la: 40.7038, lo: -73.9184, ids: ["L16"], r: ["L"] },
  { n: "East 105 St", la: 40.6506, lo: -73.8995, ids: ["L28"], r: ["L"] },
  {
    n: "Vernon Blvd-Jackson Av",
    la: 40.7426,
    lo: -73.9536,
    ids: ["721"],
    r: ["7"],
  },
  {
    n: "125 St",
    la: 40.8041,
    lo: -73.9376,
    ids: ["621"],
    r: ["4", "5", "6"],
  },
  {
    n: "Jefferson Av",
    la: 40.5836,
    lo: -74.1033,
    ids: ["S24"],
    r: ["SIR"],
  },
  {
    n: "Chambers St",
    la: 40.7155,
    lo: -74.0093,
    ids: ["137"],
    r: ["1", "2", "3"],
  },
  {
    n: "Ozone Park-Lefferts Blvd",
    la: 40.686,
    lo: -73.8258,
    ids: ["A65"],
    r: ["A"],
  },
  { n: "18 Av", la: 40.608, lo: -74.0017, ids: ["B19"], r: ["D"] },
  { n: "Bowery", la: 40.7203, lo: -73.9939, ids: ["M19"], r: ["J", "Z"] },
  { n: "Astor Pl", la: 40.7301, lo: -73.9911, ids: ["636"], r: ["6"] },
  {
    n: "Church Av",
    la: 40.6505,
    lo: -73.963,
    ids: ["D28"],
    r: ["B", "Q"],
  },
  {
    n: "Chauncey St",
    la: 40.6829,
    lo: -73.9105,
    ids: ["J28"],
    r: ["J", "Z"],
  },
  {
    n: "61 St-Woodside",
    la: 40.7456,
    lo: -73.903,
    ids: ["712"],
    r: ["7"],
  },
  { n: "Ocean Pkwy", la: 40.5763, lo: -73.9685, ids: ["D41"], r: ["Q"] },
  {
    n: "Norwood Av",
    la: 40.6814,
    lo: -73.88,
    ids: ["J21"],
    r: ["J", "Z"],
  },
  { n: "231 St", la: 40.8789, lo: -73.9048, ids: ["104"], r: ["1"] },
  {
    n: "63 Dr-Rego Park",
    la: 40.7298,
    lo: -73.8616,
    ids: ["G10"],
    r: ["M", "R"],
  },
  {
    n: "34 St-Penn Station",
    la: 40.7523,
    lo: -73.9934,
    ids: ["A28"],
    r: ["A", "C", "E"],
  },
  {
    n: "Beach 90 St",
    la: 40.588,
    lo: -73.8136,
    ids: ["H12"],
    r: ["A", "S"],
  },
  { n: "50 St", la: 40.7617, lo: -73.9838, ids: ["126"], r: ["1"] },
  {
    n: "96 St",
    la: 40.7939,
    lo: -73.9723,
    ids: ["120"],
    r: ["1", "2", "3"],
  },
  { n: "8 Av", la: 40.6351, lo: -74.0117, ids: ["N02"], r: ["N"] },
  {
    n: "Richmond Valley",
    la: 40.5196,
    lo: -74.2291,
    ids: ["S13"],
    r: ["SIR"],
  },
  {
    n: "Flatbush Av-Brooklyn College",
    la: 40.6328,
    lo: -73.9476,
    ids: ["247"],
    r: ["2", "5"],
  },
  { n: "Woodlawn", la: 40.886, lo: -73.8788, ids: ["401"], r: ["4"] },
  { n: "Morris Park", la: 40.8544, lo: -73.8605, ids: ["505"], r: ["5"] },
  { n: "Whitlock Av", la: 40.8265, lo: -73.8863, ids: ["612"], r: ["6"] },
  {
    n: "Flushing Av",
    la: 40.7003,
    lo: -73.9411,
    ids: ["M12"],
    r: ["J", "M"],
  },
  { n: "Clifton", la: 40.6213, lo: -74.0714, ids: ["S28"], r: ["SIR"] },
  {
    n: "Jackson Av",
    la: 40.8165,
    lo: -73.9078,
    ids: ["220"],
    r: ["2", "5"],
  },
  {
    n: "Tremont Av",
    la: 40.8504,
    lo: -73.9052,
    ids: ["D07"],
    r: ["B", "D"],
  },
  { n: "Bedford Av", la: 40.7173, lo: -73.9569, ids: ["L08"], r: ["L"] },
  {
    n: "Roosevelt Island",
    la: 40.7591,
    lo: -73.9533,
    ids: ["B06"],
    r: ["M"],
  },
  {
    n: "Woodhaven Blvd",
    la: 40.6939,
    lo: -73.8516,
    ids: ["J15"],
    r: ["J", "Z"],
  },
  {
    n: "Eltingville",
    la: 40.5446,
    lo: -74.1646,
    ids: ["S18"],
    r: ["SIR"],
  },
  { n: "2 Av", la: 40.7234, lo: -73.9899, ids: ["F14"], r: ["F"] },
  { n: "Rockaway Av", la: 40.6625, lo: -73.9089, ids: ["253"], r: ["3"] },
];

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
  for (const s of STOPS_DATA)
    if (s.ids.includes(cleanId))
      return { name: s.n, lat: s.la, lon: s.lo, ids: s.ids, routes: s.r };
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

async function loadLocationsAndStations() {
  try {
    const pos = await new Promise((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, {
          timeout: 10000,
        }),
      ),
      userLat = pos.coords.latitude,
      userLon = pos.coords.longitude,
      stops = STOPS_DATA.map((s) => ({
        name: s.n,
        lat: s.la,
        lon: s.lo,
        ids: s.ids,
        routes: s.r,
        dist: haversine(userLat, userLon, s.la, s.lo),
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

async function fetchTrainTimes(_stations) {
  try {
    const feeds = [
      "",
      "-ace",
      "-bdfm",
      "-nqrw",
      "-l",
      "-g",
      "-jz",
      "-si",
    ];
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
    // Clear old trip stops and rebuild
    tripStopsMap.clear();
    // First pass: collect all stops for each trip
    allEntities.forEach((e) => {
      if (e.tripUpdate?.trip?.tripId && e.tripUpdate?.stopTimeUpdate) {
        const tripId = e.tripUpdate.trip.tripId;
        const stops = e.tripUpdate.stopTimeUpdate
          .map((stu) => stu.stopId)
          .filter(Boolean);
        tripStopsMap.set(tripId, stops);
      }
    });
    const now = Date.now() / 1e3,
      arrivals = [];
    allEntities.forEach((e) => {
      e.tripUpdate?.stopTimeUpdate?.forEach((stu) => {
        const arrivalTime = stu.arrival?.time || stu.departure?.time;
        if (arrivalTime > now && stu.stopId) {
          const station = getStop(stu.stopId);
          const tripId = e.tripUpdate.trip.tripId || null;
          const routeId = e.tripUpdate.trip.routeId;
          const tripStops = tripStopsMap.get(tripId);
          const lastStopId =
            tripStops && tripStops.length > 0
              ? tripStops[tripStops.length - 1]
              : null;
          const destStation = lastStopId ? getStop(lastStopId) : null;
          const destination = destStation ? destStation.name : null;
          const stopIdx = tripStops ? tripStops.indexOf(stu.stopId) : -1;
          const upcomingStops =
            stopIdx >= 0 && tripStops
              ? tripStops
                  .slice(stopIdx + 1)
                  .map((s) => {
                    const futureStu = e.tripUpdate.stopTimeUpdate.find(
                      (stu) => stu.stopId === s,
                    );
                    const time = futureStu
                      ? futureStu.arrival?.time ||
                        futureStu.departure?.time
                      : null;
                    return {
                      name: getStop(s)?.name,
                      time: time ? new Date(1e3 * time) : null,
                    };
                  })
                  .filter((obj) => obj.name)
              : [];
          station &&
            arrivals.push({
              route: routeId,
              minutes: Math.round((arrivalTime - now) / 60),
              time: new Date(1e3 * arrivalTime),
              stationName: station.name,
              stopId: stu.stopId,
              direction: stu.stopId.slice(-1),
              tripId: tripId,
              destination: destination,
              upcomingStops: upcomingStops,
            });
        }
      });
    });
    return { arrivals, failCount, feeds };
  } catch (e) {
    console.error("Error fetching train times:", e);
    throw e;
  }
}

function renderStations(stations, arrivals, failCount, feeds, alerts) {
  const timeStr = lastRefreshTime
      ? `Last refresh: ${lastRefreshTime.toLocaleTimeString()} · Auto-refresh every 30s`
      : "Auto-refresh every 30s",
    container = document.createDocumentFragment(),
    timeDiv = document.createElement("div");
  timeDiv.className = "refresh-meta";
  timeDiv.textContent = timeStr;
  container.appendChild(timeDiv);
  const carousel = document.createElement("div");
  carousel.className = "carousel carousel--station";
  carousel.setAttribute("tabindex", "0");
  carousel.setAttribute("aria-label", "Nearby subway stations");
  const stationDivs = stations.map((s) => {
    const stationDiv = document.createElement("div");
    stationDiv.className = "station-card";
    const headerDiv = document.createElement("div");
    headerDiv.className = "station-header";
    const infoDiv = document.createElement("div");
    infoDiv.className = "station-info";
    const nameSpan = document.createElement("span");
    nameSpan.className = "station-name";
    nameSpan.textContent = s.name;
    infoDiv.appendChild(nameSpan);
    const distSpan = document.createElement("span");
    distSpan.className = "distance";
    distSpan.textContent = `${Math.round(1e3 * s.dist)}m`;
    infoDiv.appendChild(distSpan);
    headerDiv.appendChild(infoDiv);
    const badgesDiv = document.createElement("div");
    badgesDiv.className = "station-badges";
    let activeFilter = activeFilters[s.name] || null;
    const stationStopIds = new Set(
      s.ids.flatMap((id) => [id, `${id}N`, `${id}S`]),
    );
    const stationArrivals = arrivals.filter(
      (a) => a.stopId && stationStopIds.has(a.stopId),
    );
    const directionsDiv = document.createElement("div");
    directionsDiv.className = "directions";
    s.routes.forEach((r) => {
      const badge = document.createElement("span");
      badge.className = "route-badge";
      badge.style.background = ROUTE_COLORS[r] || "#666";
      if (DARK_TEXT_ROUTES.has(r)) badge.style.color = "#000";
      badge.textContent = r;
      badge.dataset.route = r;
      badge.onclick = (e) => {
        e.stopPropagation();
        const clickedRoute = badge.dataset.route;
        const allBadges = badgesDiv.querySelectorAll(".route-badge");
        if (activeFilter === clickedRoute) {
          activeFilter = null;
          activeFilters[s.name] = null;
          allBadges.forEach((b) => {
            b.classList.remove("filter-inactive");
          });
          renderTrains(null);
        } else {
          activeFilter = clickedRoute;
          activeFilters[s.name] = clickedRoute;
          allBadges.forEach((b) => {
            b.classList.toggle(
              "filter-inactive",
              b.dataset.route !== clickedRoute,
            );
          });
          renderTrains(clickedRoute);
        }
      };
      badgesDiv.appendChild(badge);
    });
    if (activeFilter) {
      const allBadges = badgesDiv.querySelectorAll(".route-badge");
      allBadges.forEach((b) => {
        b.classList.toggle(
          "filter-inactive",
          b.dataset.route !== activeFilter,
        );
      });
    }
    headerDiv.appendChild(badgesDiv);
    stationDiv.appendChild(headerDiv);
    const createDirectionCol = (title, trains) => {
      const col = document.createElement("div");
      col.className = "direction-col";
      const h4 = document.createElement("h4");
      h4.textContent = title;
      col.appendChild(h4);
      if (trains.length > 0) {
        const trainElements = trains.map((t) => {
          const trainDiv = document.createElement("div"),
            badge = document.createElement("span");
          trainDiv.className = "train";
          trainDiv.dataset.route = t.route;
          const baseRoute = getBaseRoute(t.route);
          badge.className = "route-badge";
          badge.style.background =
            ROUTE_COLORS[t.route] || ROUTE_COLORS[baseRoute] || "#666";
          if (
            DARK_TEXT_ROUTES.has(t.route) ||
            DARK_TEXT_ROUTES.has(baseRoute)
          ) {
            badge.style.color = "#000";
          }
          badge.textContent = t.route;
          trainDiv.appendChild(badge);
          const timeDest = document.createElement("div");
          timeDest.className = "time-dest";
          const timeSpan = document.createElement("span");
          timeSpan.className = "time-text";
          timeSpan.textContent = `${t.minutes} min`;
          timeDest.appendChild(timeSpan);
          if (t.destination) {
            const destSpan = document.createElement("span");
            destSpan.className = "destination";
            destSpan.textContent = t.destination;
            timeDest.appendChild(destSpan);
          }
          trainDiv.appendChild(timeDest);
          if (t.upcomingStops && t.upcomingStops.length > 0) {
            trainDiv.onclick = (e) => {
              e.stopPropagation();
              showStopsModal(t);
            };
          }
          return trainDiv;
        });
        trainElements.forEach((el) => {
          col.appendChild(el);
        });
      } else {
        const noTrainsDiv = document.createElement("div");
        noTrainsDiv.className = "train";
        noTrainsDiv.textContent = "No upcoming trains";
        col.appendChild(noTrainsDiv);
      }
      return col;
    };
    const renderTrains = (filterRoute) => {
      const filtered = filterRoute
        ? stationArrivals.filter((a) => a.route === filterRoute)
        : stationArrivals;
      const northbound = filtered
        .filter((a) => "N" === a.direction)
        .sort((a, b) => a.time - b.time)
        .slice(0, 6);
      const southbound = filtered
        .filter((a) => "S" === a.direction)
        .sort((a, b) => a.time - b.time)
        .slice(0, 6);
      directionsDiv.innerHTML = "";
      directionsDiv.appendChild(createDirectionCol("Uptown", northbound));
      directionsDiv.appendChild(
        createDirectionCol("Downtown", southbound),
      );
    };
    renderTrains(activeFilter);
    stationDiv.appendChild(directionsDiv);
    const stationAlerts = (alerts || []).filter((a) =>
      a.routes.some((r) => s.routes.includes(r)),
    );
    stationAlerts.slice(0, 2).forEach((alert) => {
      const alertDiv = document.createElement("div");
      alertDiv.className = "station-alert";
      alertDiv.textContent = `⚠ ${(alert.header || alert.description).slice(0, 120)}`;
      stationDiv.appendChild(alertDiv);
    });
    return stationDiv;
  });
  stationDivs.forEach((div) => {
    carousel.appendChild(div);
  });
  container.appendChild(carousel);
  if (failCount > 0) {
    const warningDiv = document.createElement("div");
    warningDiv.className = "warning";
    warningDiv.textContent = `Note: ${failCount} of ${feeds} feeds failed to load. Some trains may not be shown.`;
    container.appendChild(warningDiv);
  }
  return container;
}

function showStopsModal(train) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const baseRoute = getBaseRoute(train.route);
  const content = document.createElement("div");
  content.className = "modal-content";
  content.style.position = "relative";
  content.innerHTML = `<button class="modal-close" aria-label="Close">&times;</button><div class="modal-header"><span class="route-badge" style="background:${ROUTE_COLORS[train.route] || ROUTE_COLORS[baseRoute] || "#666"};${DARK_TEXT_ROUTES.has(train.route) || DARK_TEXT_ROUTES.has(baseRoute) ? "color:#000;" : ""}">${train.route}</span><div><div class="modal-title">${train.destination || "Unknown"}</div><div class="modal-subtitle">${train.minutes} min</div></div></div><div class="modal-stops">${train.upcomingStops.map((stop, i, arr) => `<div class="modal-stop${i === arr.length - 1 ? " terminal" : ""}"><span class="modal-arrow">${i === arr.length - 1 ? "●" : "↓"}</span><span class="modal-stop-text">${stop.name}</span>${stop.time ? `<span class="arrival-time">${stop.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>` : ""}</div>`).join("")}</div>`;
  overlay.appendChild(content);
  overlay.onclick = () => overlay.remove();
  document.body.appendChild(overlay);
}

function mtaRoot() {
  return document.getElementById("mta-content");
}

async function load() {
  const el = mtaRoot();
  if (!el) return;
  el.innerHTML = '<div class="loading">Loading...</div>';
  try {
    let stations = cachedStations,
      trainData,
      alerts;
    if (!stations) {
      const trainFetchPromise = fetchTrainTimes([]),
        alertsPromise = fetchServiceAlerts(),
        geolocationPromise = loadLocationsAndStations().catch((e) => {
          if (e.message === "Location permission denied") {
            throw e;
          }
          console.warn("Geolocation failed", e);
          return STOPS_DATA.slice(0, 6).map((s, idx) => ({
            name: s.n,
            lat: s.la,
            lon: s.lo,
            ids: s.ids,
            routes: s.r,
            dist: idx,
          }));
        });
      [stations, trainData, alerts] = await Promise.all([
        geolocationPromise,
        trainFetchPromise,
        alertsPromise,
      ]);
      initStopIdMap(stations);
      cachedStations = stations;
    } else {
      [trainData, alerts] = await Promise.all([
        fetchTrainTimes(stations),
        fetchServiceAlerts(),
      ]);
    }
    const fragment = renderStations(
      stations,
      trainData.arrivals,
      trainData.failCount,
      trainData.feeds.length,
      alerts,
    );
    el.innerHTML = "";
    el.appendChild(fragment);
  } catch (e) {
    console.error("Full error:", e);
    if (e.message === "Location permission denied") {
      el.innerHTML =
        '<div><strong>Location Access Required</strong><br>To show nearby train stations, this app needs permission to access your location.<br><br><strong>On iPhone/iPad (Safari):</strong><br>1. Open the Settings app<br>2. Scroll down and tap Safari<br>3. Tap Location<br>4. Choose "Allow" or ensure it\'s not "Deny"<br>5. Return to this app and refresh the page<br><br><strong>On Android (Chrome):</strong><br>1. Tap the lock icon or "i" in the address bar<br>2. Tap Site settings > Location<br>3. Choose "Allow"<br>4. Refresh the page</div>';
    } else {
      el.innerHTML = `<div class="error">Error: ${e.message}</div>`;
    }
  }
}

function startRefreshInterval() {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(refreshTrainTimes, 3e4);
}

function stopRefreshInterval() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

async function refreshTrainTimes() {
  if (lastRefreshPromise) return;
  const el = mtaRoot();
  if (!el) return;
  try {
    if (!cachedStations) {
      return;
    }
    lastRefreshPromise = Promise.all([
      fetchTrainTimes(cachedStations),
      fetchServiceAlerts(),
    ]);
    const [trainData, alerts] = await lastRefreshPromise;
    lastRefreshTime = new Date();
    const fragment = renderStations(
      cachedStations,
      trainData.arrivals,
      trainData.failCount,
      trainData.feeds.length,
      alerts,
    );
    el.innerHTML = "";
    el.appendChild(fragment);
  } catch (e) {
    console.error("Error refreshing train times:", e);
    el.innerHTML = `<div class="error">Error: ${e.message}</div>`;
  } finally {
    lastRefreshPromise = null;
  }
}

async function refreshLocation() {
  cachedStations = null;
  await load();
}

document.addEventListener("visibilitychange", () => {
  document.hidden ? stopRefreshInterval() : startRefreshInterval();
});

window.addEventListener("DOMContentLoaded", () => {
  if (!mtaRoot()) return;
  load();
  startRefreshInterval();
});
