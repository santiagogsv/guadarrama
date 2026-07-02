const GEO_CACHE_KEY = "guadarrama:geo";
const GEO_TTL_MS = 30 * 60 * 1000;
const COORD_PRECISION = 100;

const GEO_OPTIONS = {
  enableHighAccuracy: false,
  maximumAge: GEO_TTL_MS,
  timeout: 10000,
};

let geoPromise = null;

function roundCoord(n) {
  return Math.round(n * COORD_PRECISION) / COORD_PRECISION;
}

function readGeoCache() {
  try {
    const raw = sessionStorage.getItem(GEO_CACHE_KEY);
    if (!raw) return null;
    const { lat, lon, ts } = JSON.parse(raw);
    if (Date.now() - ts > GEO_TTL_MS) return null;
    return { lat, lon };
  } catch {
    return null;
  }
}

function writeGeoCache(lat, lon) {
  try {
    sessionStorage.setItem(
      GEO_CACHE_KEY,
      JSON.stringify({ lat, lon, ts: Date.now() }),
    );
  } catch {}
}

function clearGeoCache() {
  try {
    sessionStorage.removeItem(GEO_CACHE_KEY);
  } catch {}
}

function getSharedPosition({ forceRefresh = false } = {}) {
  if (forceRefresh) {
    clearGeoCache();
    geoPromise = null;
  } else {
    const cached = readGeoCache();
    if (cached) return Promise.resolve(cached);
  }

  if (!navigator.geolocation) {
    const err = new Error("Geolocation not supported");
    err.code = 0;
    return Promise.reject(err);
  }

  if (!geoPromise) {
    geoPromise = new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          geoPromise = null;
          const lat = pos.coords.latitude;
          const lon = pos.coords.longitude;
          writeGeoCache(lat, lon);
          resolve({ lat, lon });
        },
        (err) => {
          geoPromise = null;
          reject(err);
        },
        GEO_OPTIONS,
      );
    });
  }
  return geoPromise;
}

window.roundCoord = roundCoord;
window.clearGeoCache = clearGeoCache;
window.getSharedPosition = getSharedPosition;