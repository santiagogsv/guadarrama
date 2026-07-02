const PRECIP_LIGHT = 2.5;
const PRECIP_MODERATE = 7.6;
const CHART_H = 190;
const PAD = { t: 8, r: 8, b: 24, l: 32 };
const LEGEND =
  '<span class="legend-item"><span class="legend-dot legend-temp"></span>Feels like</span><span class="legend-item"><span class="legend-dot legend-precip"></span>Precip</span><span class="legend-item"><span class="legend-dot legend-uv"></span>UV</span>';

const WEATHER_URL = (lat, lon) =>
  `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=apparent_temperature,precipitation,uv_index,is_day&timezone=auto&past_days=1&forecast_days=8`;

const LOCATION_URL = (lat, lon) =>
  `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&accept-language=en`;

const $hourly = () => document.getElementById("hourly");
const fetchJson = (url) =>
  fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))));

const toLocalDateString = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const formatDateLabel = (dateStr, todayStr) => {
  if (dateStr === todayStr) return "Today";
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
};

const formatHourLabel = (ts) => {
  const h = new Date(ts * 1000).getHours();
  return `${h % 12 || 12}${h < 12 ? "am" : "pm"}`;
};

const formatTemp = (v) => (v == null || Number.isNaN(v) ? "--" : `${Math.round(v)}°`);

const smooth = (values, r = 1) => {
  if (values.length < 3) return values.slice();
  return values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(values.length - 1, i + r); j++) {
      sum += values[j];
      n++;
    }
    return sum / n;
  });
};

const bandColor = (value, bands) => {
  for (const [max, color] of bands) {
    if (value <= max) return color;
  }
  return bands.at(-1)[1];
};

const nearestIndex = (times, targetMs = Date.now()) => {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < times.length; i++) {
    const ms = typeof times[i] === "number" ? times[i] * 1000 : Date.parse(times[i]);
    const dist = Math.abs(ms - targetMs);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
};

const isJunkPlace = (v) => /community board|county|united states/i.test(v || "");

const pickPlace = (address, keys) => {
  for (const key of keys) {
    const v = address[key];
    if (v && !isJunkPlace(v)) return v;
  }
  return null;
};

const formatLocation = (data) => {
  if (!data) return null;
  const a = data.address;
  if (a) {
    const parts = [
      pickPlace(a, ["neighbourhood", "quarter", "commercial", "hamlet"]),
      pickPlace(a, ["suburb", "borough", "city_district"]),
      pickPlace(a, ["city", "town", "municipality"]),
    ].filter((p, i, arr) => p && arr.indexOf(p) === i);
    const line = parts.join(", ");
    if (line) return a.postcode ? `${line} ${a.postcode}` : line;
  }
  if (!data.display_name) return null;
  const zip = data.display_name.match(/\b(\d{5})(?:-\d{4})?\b/)?.[1];
  const parts = data.display_name
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && !isJunkPlace(p) && !/^\d{5}(?:-\d{4})?$/.test(p));
  const borough = parts.findIndex((p) =>
    /^(manhattan|brooklyn|queens|bronx|staten island)$/i.test(p),
  );
  if (borough >= 0) {
    const line = [
      borough > 0 ? parts[borough - 1] : null,
      parts[borough],
      parts.slice(borough + 1).find((p) => p !== parts[borough]),
    ]
      .filter(Boolean)
      .join(", ");
    return zip ? `${line} ${zip}` : line || null;
  }
  const line = parts.slice(0, 3).join(", ");
  return zip ? `${line} ${zip}` : line || null;
};

let colorProbe;

const resolveCss = (name, prop, fallback) => {
  if (!colorProbe) {
    colorProbe = document.createElement("span");
    colorProbe.hidden = true;
    document.body.appendChild(colorProbe);
  }
  colorProbe.style.setProperty(prop, `var(${name})`);
  const value = getComputedStyle(colorProbe)[prop];
  colorProbe.style.removeProperty(prop);
  return value && value !== "rgba(0, 0, 0, 0)" ? value : fallback;
};

const getColors = () => {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const a = dark ? 0.42 : 0.32;
  return {
    dark,
    grid: resolveCss("--grid-line", "color", dark ? "#3a3a3c" : "#e5e5e5"),
    text: resolveCss("--axis-text", "color", dark ? "#ededed" : "#111111"),
    now: resolveCss("--now-line", "color", dark ? "#a3a3a3" : "#666666"),
    precip: [
      [PRECIP_LIGHT, resolveCss("--precip-light", "background-color", "rgba(90,200,250,0.35)")],
      [PRECIP_MODERATE, resolveCss("--precip-moderate", "background-color", "rgba(90,200,250,0.55)")],
      [Infinity, resolveCss("--precip-heavy", "background-color", "rgba(255,69,58,0.55)")],
    ],
    night: dark ? "rgba(0,0,0,0.62)" : "rgba(0,0,0,0.24)",
    cloudy: dark ? "rgba(88,98,118,0.42)" : "rgba(168,178,198,0.5)",
    overcast: dark ? "rgba(118,128,148,0.36)" : "rgba(198,206,218,0.42)",
    uvDay: [
      [3, `rgba(255,248,200,${a * 0.55})`],
      [4, `rgba(255,236,140,${a * 0.65})`],
      [5, `rgba(255,220,80,${a * 0.75})`],
      [6, `rgba(255,200,50,${a * 0.82})`],
      [7, `rgba(255,175,40,${a * 0.88})`],
      [8, `rgba(255,145,35,${a * 0.92})`],
      [9, `rgba(255,110,45,${a * 0.95})`],
      [10, `rgba(255,75,55,${a})`],
      [11, `rgba(230,45,60,${a})`],
      [Infinity, dark ? "rgba(175,82,222,0.45)" : "rgba(175,82,222,0.34)"],
    ],
  };
};

const uvBgColor = (uv, isDay, colors) => {
  if (!isDay) return colors.night;
  if (uv <= 1) return colors.cloudy;
  if (uv <= 2) return colors.overcast;
  return bandColor(uv, colors.uvDay);
};

const tempLineColor = (temp, dark) => {
  if (temp < 0) return dark ? "#6eb5ff" : "#4a9eff";
  if (temp < 8) return dark ? "#5ac8fa" : "#32ade6";
  if (temp < 15) return dark ? "#63d68a" : "#34c759";
  if (temp < 20) return dark ? "#b8e986" : "#8bc34a";
  if (temp < 25) return dark ? "#ffd60a" : "#ffcc00";
  if (temp < 30) return dark ? "#ffb340" : "#ff9500";
  if (temp < 35) return dark ? "#ff6961" : "#ff3b30";
  return dark ? "#bf5af2" : "#af52de";
};

const clipPlot = (ctx, pad, plotW, plotH, fn) => {
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.l, pad.t, plotW, plotH);
  ctx.clip();
  fn();
  ctx.restore();
};

const drawChart = (canvas, day, opts) => {
  const { colors, tempMin, tempMax, precipMax } = opts;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const width = Math.max(240, Math.floor(canvas.parentElement.getBoundingClientRect().width));
  canvas.width = width * dpr;
  canvas.height = CHART_H * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${CHART_H}px`;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const plotW = width - PAD.l - PAD.r;
  const plotH = CHART_H - PAD.t - PAD.b;
  const temps = smooth(day.temps, 2);
  const n = day.times.length;
  if (!n) return;

  const xMin = day.times[0];
  const xMax = day.times[n - 1];
  const xSpan = xMax - xMin || 1;
  const xAt = (t) => PAD.l + ((t - xMin) / xSpan) * plotW;
  const yTemp = (v) => PAD.t + plotH - ((v - tempMin) / (tempMax - tempMin || 1)) * plotH;
  const barW = Math.max(2, plotW / n - 1);

  ctx.clearRect(0, 0, width, CHART_H);

  clipPlot(ctx, PAD, plotW, plotH, () => {
    ctx.filter = "blur(10px)";
    for (let i = 0; i < n; i++) {
      const x0 = i === 0 ? PAD.l : (xAt(day.times[i - 1]) + xAt(day.times[i])) / 2;
      const x1 = i < n - 1 ? (xAt(day.times[i]) + xAt(day.times[i + 1])) / 2 : PAD.l + plotW;
      const c0 = uvBgColor(day.uv[i], day.isDay[i], colors);
      if (i < n - 1) {
        const grad = ctx.createLinearGradient(x0, 0, x1, 0);
        grad.addColorStop(0, c0);
        grad.addColorStop(1, uvBgColor(day.uv[i + 1], day.isDay[i + 1], colors));
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = c0;
      }
      ctx.fillRect(x0, PAD.t - 8, x1 - x0, plotH + 16);
    }
    ctx.filter = "none";
  });

  ctx.font = "11px system-ui, sans-serif";
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;

  for (let t = Math.ceil(tempMin / 5) * 5; t <= tempMax; t += 5) {
    const y = yTemp(t);
    ctx.beginPath();
    ctx.moveTo(PAD.l, y);
    ctx.lineTo(PAD.l + plotW, y);
    ctx.stroke();
    ctx.fillStyle = colors.text;
    ctx.fillText(`${t}°`, 2, y + 4);
  }

  const hourStep = n > 12 ? 3 : 2;
  for (let i = 0; i < n; i += hourStep) {
    ctx.fillStyle = colors.text;
    ctx.fillText(formatHourLabel(day.times[i]), xAt(day.times[i]) - 10, CHART_H - 6);
  }

  for (let i = 0; i < n; i++) {
    const p = day.precip[i];
    if (p <= 0) continue;
    const h = (p / precipMax) * plotH * 0.45;
    ctx.fillStyle = bandColor(p, colors.precip);
    ctx.fillRect(xAt(day.times[i]) - barW / 2, PAD.t + plotH - h, barW, h);
  }

  const strokeTemp = (glow) => {
    clipPlot(ctx, PAD, plotW, plotH, () => {
      ctx.filter = glow ? "blur(6px)" : "none";
      ctx.globalAlpha = glow ? 0.75 : 1;
      ctx.lineWidth = glow ? 8 : 5.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      for (let i = 0; i < n - 1; i++) {
        ctx.strokeStyle = tempLineColor((temps[i] + temps[i + 1]) / 2, colors.dark);
        ctx.beginPath();
        ctx.moveTo(xAt(day.times[i]), yTemp(temps[i]));
        ctx.lineTo(xAt(day.times[i + 1]), yTemp(temps[i + 1]));
        ctx.stroke();
      }
      ctx.filter = "none";
    });
  };

  strokeTemp(true);
  strokeTemp(false);

  if (opts.isToday) {
    const now = Date.now() / 1000;
    if (now >= xMin && now <= xMax) {
      const x = xAt(now);
      ctx.strokeStyle = colors.now;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, PAD.t);
      ctx.lineTo(x, PAD.t + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  canvas._meta = { day, temps, xAt, yTemp, pad: PAD, plotW };
};

const bindTooltip = (canvas, tooltip) => {
  const show = (clientX) => {
    const { day, temps, xAt, yTemp, pad, plotW } = canvas._meta || {};
    if (!day) return;
    const x = clientX - canvas.getBoundingClientRect().left;
    if (x < pad.l || x > pad.l + plotW) {
      tooltip.style.opacity = 0;
      return;
    }
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < day.times.length; i++) {
      const dist = Math.abs(xAt(day.times[i]) - x);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    const uv = day.uv[best];
    const y = yTemp(temps[best]);
    tooltip.textContent = `${formatTemp(temps[best])}${uv == null ? "" : ` · UV ${Math.round(uv)}`}`;
    tooltip.style.left = `${xAt(day.times[best])}px`;
    tooltip.style.top = `${y}px`;
    tooltip.style.transform = y < 24 ? "translate(-50%, 12px)" : "translate(-50%, -120%)";
    tooltip.style.opacity = 1;
  };
  canvas.addEventListener("pointermove", (e) => show(e.clientX));
  canvas.addEventListener("pointerleave", () => {
    tooltip.style.opacity = 0;
  });
};

const groupHourly = (weatherData, todayStr, endStr) => {
  const hourly = weatherData.hourly ?? {};
  const feels = hourly.apparent_temperature;
  const times = hourly.time ?? [];
  const grouped = {};
  let minTemp = Infinity;
  let maxTemp = -Infinity;
  let maxPrecip = 0;

  for (let i = 0; i < times.length; i++) {
    const date = times[i].split("T")[0];
    if (date < todayStr || date > endStr) continue;
    const temp = feels[i];
    const precip = hourly.precipitation?.[i] ?? 0;
    if (!grouped[date]) grouped[date] = { times: [], temps: [], precip: [], uv: [], isDay: [] };
    grouped[date].times.push(Date.parse(times[i]) / 1000);
    grouped[date].temps.push(temp);
    grouped[date].precip.push(precip);
    grouped[date].uv.push(hourly.uv_index?.[i] ?? 0);
    grouped[date].isDay.push(hourly.is_day?.[i] ?? 1);
    if (temp < minTemp) minTemp = temp;
    if (temp > maxTemp) maxTemp = temp;
    if (precip > maxPrecip) maxPrecip = precip;
  }

  const tempPad = minTemp === maxTemp ? 1 : Math.max(1, (maxTemp - minTemp) * 0.1);
  return {
    grouped,
    dates: Object.keys(grouped).sort(),
    scales: {
      tempMin: Math.floor((minTemp - tempPad) / 5) * 5,
      tempMax: Math.ceil((maxTemp + tempPad) / 5) * 5,
      precipMax: Math.max(8, Math.ceil(maxPrecip)),
    },
    curFeels: feels?.[nearestIndex(times)],
  };
};

const createDayChart = (date, todayStr, day, scales) => {
  const card = document.createElement("div");
  card.className = "day-card";
  card.innerHTML = `<h4>${formatDateLabel(date, todayStr)}</h4>`;
  const wrap = document.createElement("div");
  wrap.className = "day-chart";
  const canvas = document.createElement("canvas");
  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  wrap.append(canvas, tooltip);
  const legend = document.createElement("div");
  legend.className = "legend";
  legend.innerHTML = LEGEND;
  card.append(wrap, legend);
  const opts = { colors: getColors(), ...scales, isToday: date === todayStr };
  drawChart(canvas, day, opts);
  bindTooltip(canvas, tooltip);
  return { card, canvas, day, opts };
};

const renderHourly = (weatherData, locationName) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + 7);
  const todayStr = toLocalDateString(today);
  const { grouped, dates, scales, curFeels } = groupHourly(
    weatherData,
    todayStr,
    toLocalDateString(end),
  );

  const root = $hourly();
  if (!dates.length) {
    root.innerHTML = "<p>No hourly data available.</p>";
    return;
  }

  root.innerHTML = [
    locationName ? `<h2 class="heading">${locationName}</h2>` : "",
    curFeels == null
      ? ""
      : `<div class="current-feels"><div class="current-feels__value">${formatTemp(curFeels)}</div><div class="current-feels__label">Feels like now</div></div>`,
    '<h3 class="heading">Hourly</h3><div id="chart-grid"></div>',
  ].join("");

  const grid = document.getElementById("chart-grid");
  const charts = dates.map((date) => {
    const chart = createDayChart(date, todayStr, grouped[date], scales);
    grid.append(chart.card);
    return chart;
  });

  const redraw = () => {
    const colors = getColors();
    for (const c of charts) {
      c.opts.colors = colors;
      drawChart(c.canvas, c.day, c.opts);
    }
  };

  let resizeTimer;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redraw, 100);
  }).observe(grid);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);
};

if (!navigator.geolocation) {
  $hourly().innerHTML = "<p>Geolocation not supported</p>";
} else {
  navigator.geolocation.getCurrentPosition(
    async ({ coords: { latitude: lat, longitude: lon } }) => {
      try {
        const [weather, location] = await Promise.allSettled([
          fetchJson(WEATHER_URL(lat, lon)),
          fetchJson(LOCATION_URL(lat, lon)),
        ]);
        if (weather.status !== "fulfilled") throw weather.reason;
        renderHourly(
          weather.value,
          location.status === "fulfilled" ? formatLocation(location.value) : undefined,
        );
      } catch {
        $hourly().innerHTML = "<p>Unable to fetch weather</p>";
      }
    },
    () => {
      $hourly().innerHTML = "<p>Location access denied</p>";
    },
  );
}