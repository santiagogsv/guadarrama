const PRECIP_LIGHT = 2.5;
const PRECIP_MODERATE = 7.6;
const CHART_H = 160;
const CHART_PAD = { t: 4, r: 6, b: 18, l: 28 };
const WEATHER_URL = (lat, lon) =>
  `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=apparent_temperature,precipitation,uv_index,is_day&timezone=auto&past_days=1&forecast_days=8`;

const LOCATION_URL = (lat, lon) =>
  `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&accept-language=en`;

const $hourly = () => document.getElementById("hourly");
const $status = () => document.getElementById("hourly-status");
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

const formatDayAxisLabel = (dateStr, todayStr) => {
  if (dateStr === todayStr) return "Now";
  return new Date(`${dateStr}T00:00:00`)
    .toLocaleDateString(undefined, { weekday: "short" })
    .slice(0, 3);
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

const TEMP_BANDS = {
  light: [
    [-8, "#0040ff"],
    [-6, "#0066ff"],
    [-4, "#007aff"],
    [-2, "#0091ff"],
    [0, "#00a8ff"],
    [2, "#00b8d4"],
    [4, "#00b4a0"],
    [6, "#00b86b"],
    [8, "#2dd36f"],
    [10, "#4cd964"],
    [12, "#7ed321"],
    [14, "#9acd32"],
    [16, "#c6e000"],
    [18, "#e6e600"],
    [20, "#ffe600"],
    [22, "#ffd000"],
    [24, "#ffb800"],
    [26, "#ffa000"],
    [28, "#ff8800"],
    [30, "#ff6f00"],
    [32, "#ff5500"],
    [34, "#ff3300"],
    [36, "#ff0055"],
    [38, "#e600e6"],
    [Infinity, "#b300ff"],
  ],
  dark: [
    [-8, "#6eb6ff"],
    [-6, "#82cfff"],
    [-4, "#90d5ff"],
    [-2, "#99e0ff"],
    [0, "#4dd0e1"],
    [2, "#26c6da"],
    [4, "#1de9b6"],
    [6, "#00e5a0"],
    [8, "#69f0ae"],
    [10, "#66bb6a"],
    [12, "#9ccc65"],
    [14, "#aed581"],
    [16, "#c5e17a"],
    [18, "#dce775"],
    [20, "#fff176"],
    [22, "#ffee58"],
    [24, "#ffd54f"],
    [26, "#ffca28"],
    [28, "#ffb74d"],
    [30, "#ffa726"],
    [32, "#ff9800"],
    [34, "#ff7043"],
    [36, "#ff5252"],
    [38, "#ff4081"],
    [Infinity, "#ea80fc"],
  ],
};

const tempLineColor = (temp, dark) => {
  const bands = dark ? TEMP_BANDS.dark : TEMP_BANDS.light;
  for (const [max, color] of bands) {
    if (temp < max) return color;
  }
  return bands.at(-1)[1];
};

const TEMP_LINE_LAYERS = [
  { blur: 18, alpha: 0.5, width: 14 },
  { blur: 10, alpha: 0.68, width: 8.5 },
  { blur: 4, alpha: 0.85, width: 5.5 },
  { blur: 0, alpha: 1, width: 3.25 },
];

const tempChartPoints = (times, temps, xAt, yTemp) =>
  times.map((t, i) => ({ x: xAt(t), y: yTemp(temps[i]), temp: temps[i] }));

const tempStrokeGradient = (ctx, points, dark) => {
  const grad = ctx.createLinearGradient(points[0].x, 0, points.at(-1).x, 0);
  const span = points.at(-1).x - points[0].x || 1;
  for (const point of points) {
    grad.addColorStop((point.x - points[0].x) / span, tempLineColor(point.temp, dark));
  }
  return grad;
};

const traceSmoothPath = (ctx, points) => {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  if (points.length === 2) {
    ctx.lineTo(points[1].x, points[1].y);
    return;
  }
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
  }
};

const clipPlot = (ctx, pad, plotW, plotH, fn) => {
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.l, pad.t, plotW, plotH);
  ctx.clip();
  fn();
  ctx.restore();
};

const chartSize = (canvas, fallbackH = CHART_H) => {
  const box = canvas.parentElement.getBoundingClientRect();
  return {
    width: Math.max(1, Math.floor(box.width)),
    height: Math.max(1, Math.floor(box.height) || fallbackH),
  };
};

const drawChart = (canvas, day, opts) => {
  const { colors, tempMin, tempMax, precipMax, weekDays, todayStr } = opts;
  const fallbackH = opts.chartH ?? CHART_H;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const { width, height: chartH } = chartSize(canvas, fallbackH);
  canvas.width = width * dpr;
  canvas.height = chartH * dpr;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const plotW = width - CHART_PAD.l - CHART_PAD.r;
  const plotH = chartH - CHART_PAD.t - CHART_PAD.b;
  const temps = smooth(day.temps, 3);
  const n = day.times.length;
  if (!n) return;

  const xMin = day.times[0];
  const xMax = day.times[n - 1];
  const xSpan = xMax - xMin || 1;
  const xAt = (t) => CHART_PAD.l + ((t - xMin) / xSpan) * plotW;
  const yTemp = (v) => CHART_PAD.t + plotH - ((v - tempMin) / (tempMax - tempMin || 1)) * plotH;
  const barW = Math.max(2, plotW / n - 1);

  ctx.clearRect(0, 0, width, chartH);

  clipPlot(ctx, CHART_PAD, plotW, plotH, () => {
    ctx.filter = "blur(10px)";
    for (let i = 0; i < n; i++) {
      const x0 = i === 0 ? CHART_PAD.l : (xAt(day.times[i - 1]) + xAt(day.times[i])) / 2;
      const x1 = i < n - 1 ? (xAt(day.times[i]) + xAt(day.times[i + 1])) / 2 : CHART_PAD.l + plotW;
      const c0 = uvBgColor(day.uv[i], day.isDay[i], colors);
      if (i < n - 1) {
        const grad = ctx.createLinearGradient(x0, 0, x1, 0);
        grad.addColorStop(0, c0);
        grad.addColorStop(1, uvBgColor(day.uv[i + 1], day.isDay[i + 1], colors));
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = c0;
      }
      ctx.fillRect(x0, CHART_PAD.t - 8, x1 - x0, plotH + 16);
    }
    ctx.filter = "none";
  });

  ctx.font = "11px system-ui, sans-serif";
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;

  for (let t = Math.ceil(tempMin / 5) * 5; t <= tempMax; t += 5) {
    const y = yTemp(t);
    ctx.beginPath();
    ctx.moveTo(CHART_PAD.l, y);
    ctx.lineTo(CHART_PAD.l + plotW, y);
    ctx.stroke();
    ctx.fillStyle = colors.text;
    ctx.fillText(`${t}°`, 2, y + 4);
  }

  if (weekDays) {
    for (let d = 1; d < weekDays.length; d++) {
      const x = xAt(day.times[weekDays[d].index]);
      ctx.beginPath();
      ctx.moveTo(x, CHART_PAD.t);
      ctx.lineTo(x, CHART_PAD.t + plotH);
      ctx.stroke();
    }
    ctx.textAlign = "center";
    for (let d = 0; d < weekDays.length; d++) {
      const { date, index } = weekDays[d];
      if (index >= n) continue;
      const xStart = d === 0 ? CHART_PAD.l : xAt(day.times[index]);
      const xEnd =
        d < weekDays.length - 1
          ? xAt(day.times[weekDays[d + 1].index])
          : CHART_PAD.l + plotW;
      const label = formatDayAxisLabel(date, todayStr);
      ctx.fillStyle = colors.text;
      ctx.fillText(label, (xStart + xEnd) / 2, chartH - 6);
    }
    ctx.textAlign = "start";
  } else {
    const hourStep = n > 12 ? 3 : 2;
    for (let i = 0; i < n; i += hourStep) {
      ctx.fillStyle = colors.text;
      ctx.fillText(formatHourLabel(day.times[i]), xAt(day.times[i]) - 10, chartH - 6);
    }
  }

  for (let i = 0; i < n; i++) {
    const p = day.precip[i];
    if (p <= 0) continue;
    const h = (p / precipMax) * plotH * 0.45;
    ctx.fillStyle = bandColor(p, colors.precip);
    ctx.fillRect(xAt(day.times[i]) - barW / 2, CHART_PAD.t + plotH - h, barW, h);
  }

  const tempPoints = tempChartPoints(day.times, temps, xAt, yTemp);
  for (const { blur, alpha, width } of TEMP_LINE_LAYERS) {
    clipPlot(ctx, CHART_PAD, plotW, plotH, () => {
      ctx.filter = blur ? `blur(${blur}px)` : "none";
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      traceSmoothPath(ctx, tempPoints);
      ctx.strokeStyle = tempStrokeGradient(ctx, tempPoints, colors.dark);
      ctx.stroke();
      ctx.filter = "none";
    });
  }
  ctx.globalAlpha = 1;

  if (opts.isToday || opts.showNow) {
    const now = Date.now() / 1000;
    if (now >= xMin && now <= xMax) {
      const x = xAt(now);
      ctx.strokeStyle = colors.now;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, CHART_PAD.t);
      ctx.lineTo(x, CHART_PAD.t + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  canvas._meta = { day, temps, xAt, yTemp, pad: CHART_PAD, plotW, weekDays, todayStr };
};

const bindTooltip = (canvas, tooltip) => {
  const show = (clientX) => {
    const { day, temps, xAt, yTemp, pad, plotW, weekDays } = canvas._meta || {};
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
    const temp = formatTemp(temps[best]);
    const uvPart = uv == null ? "" : ` · UV ${Math.round(uv)}`;
    tooltip.textContent = weekDays
      ? `${new Date(day.times[best] * 1000).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ${formatHourLabel(day.times[best])} · ${temp}${uvPart}`
      : `${temp}${uvPart}`;
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

const mergeWeek = (grouped, dates) => {
  const week = { times: [], temps: [], precip: [], uv: [], isDay: [] };
  const weekDays = [];
  for (const date of dates) {
    weekDays.push({ date, index: week.times.length });
    const d = grouped[date];
    week.times.push(...d.times);
    week.temps.push(...d.temps);
    week.precip.push(...d.precip);
    week.uv.push(...d.uv);
    week.isDay.push(...d.isDay);
  }
  return { week, weekDays };
};

const createChartCard = (title, day, scales, chartOpts = {}) => {
  const card = document.createElement("div");
  card.className = chartOpts.weekDays ? "day-card day-card--week" : "day-card";
  if (title) {
    const heading = document.createElement("h4");
    heading.textContent = title;
    card.append(heading);
  }
  const wrap = document.createElement("div");
  wrap.className = "day-chart";
  const canvas = document.createElement("canvas");
  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  wrap.append(canvas, tooltip);
  card.append(wrap);
  const opts = { colors: getColors(), ...scales, ...chartOpts };
  bindTooltip(canvas, tooltip);
  return { card, canvas, wrap, day, opts };
};

const showWeatherError = (message) => {
  const root = $hourly();
  root.querySelectorAll("#weather-now, #week-chart, #chart-grid").forEach((el) => el.remove());
  const status = $status();
  if (status) status.textContent = message;
  else root.innerHTML = `<p>${message}</p>`;
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

  if (!dates.length) {
    showWeatherError("No hourly data available.");
    return;
  }

  const nowEl = document.getElementById("weather-now");
  const feelsValue = document.getElementById("feels-value");
  const locationEl = document.getElementById("location-name");
  if (curFeels != null && nowEl && feelsValue) {
    feelsValue.textContent = formatTemp(curFeels);
    if (locationName && locationEl) {
      locationEl.textContent = locationName;
      locationEl.hidden = false;
    }
    nowEl.hidden = false;
  }

  const status = $status();
  if (status) status.remove();

  const charts = [];
  const { week, weekDays } = mergeWeek(grouped, dates);
  const weekWrap = document.getElementById("week-chart");
  weekWrap.innerHTML = "";
  const weekChart = createChartCard("Full week", week, scales, {
    weekDays,
    todayStr,
    showNow: true,
  });
  weekWrap.append(weekChart.card);
  charts.push(weekChart);

  const grid = document.getElementById("chart-grid");
  grid.classList.remove("chart-grid-skeleton");
  grid.replaceChildren();
  const scrollToToday = () => {
    const todayCard = grid.querySelector(".day-card:not(.day-card--week)");
    if (todayCard) todayCard.scrollIntoView({ inline: "start", block: "nearest" });
  };
  for (const date of dates) {
    const chart = createChartCard(formatDateLabel(date, todayStr), grouped[date], scales, {
      isToday: date === todayStr,
      todayStr,
    });
    grid.append(chart.card);
    charts.push(chart);
  }

  const redraw = () => {
    const colors = getColors();
    for (const c of charts) {
      c.opts.colors = colors;
      drawChart(c.canvas, c.day, c.opts);
    }
  };

  requestAnimationFrame(() => {
    redraw();
    scrollToToday();
  });

  let resizeRaf;
  const scheduleRedraw = () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(redraw);
  };

  const resizeObserver = new ResizeObserver(scheduleRedraw);
  for (const c of charts) resizeObserver.observe(c.wrap);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);
};

if (!navigator.geolocation) {
  showWeatherError("Geolocation not supported");
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
        showWeatherError("Unable to fetch weather");
      }
    },
    () => {
      showWeatherError("Location access denied");
    },
  );
}