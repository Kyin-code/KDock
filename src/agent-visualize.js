const CHART_TYPES = new Set([
  "line", "area", "bar", "barh", "scatter", "pie", "donut", "sparkline",
]);

const SVG_NS = "http://www.w3.org/2000/svg";
const paletteKeys = ["--primary", "--success", "--warning", "--destructive", "--muted-foreground"];
const renderCache = new WeakMap();
let themeObserver = null;
let resizeObserver = null;

const el = (name, attrs = {}, text = "") => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value != null) node.setAttribute(key, String(value));
  }
  if (text) node.textContent = text;
  return node;
};

const html = (name, className, text = "") => {
  const node = document.createElement(name);
  node.className = className;
  if (text) node.textContent = text;
  return node;
};

const color = (key) =>
  key.startsWith("--")
    ? `hsl(${getComputedStyle(document.documentElement).getPropertyValue(key).trim()})`
    : key;

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

function formatNumber(value) {
  const n = number(value);
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${+(n / 1e9).toFixed(2)}G`;
  if (abs >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${+(n / 1e3).toFixed(2)}k`;
  if (abs > 0 && abs < 0.01) return n.toExponential(2);
  return `${+n.toFixed(2)}`;
}

function normalize(config) {
  if (!config || typeof config !== "object") throw new Error("visualize 配置必须是 JSON 对象");
  const type = CHART_TYPES.has(config.type) ? config.type : "line";
  const x = Array.isArray(config.x) ? config.x : Array.isArray(config.labels) ? config.labels : [];
  let series = Array.isArray(config.series) ? config.series : [];
  if (!series.length && Array.isArray(config.values)) {
    series = [{ name: config.name || "Series 1", values: config.values }];
  }
  series = series.map((item, index) => ({
    name: String(item?.name || `Series ${index + 1}`),
    values: Array.isArray(item?.values) ? item.values : [],
    points: Array.isArray(item?.points) ? item.points : [],
    color: item?.color || paletteKeys[index % paletteKeys.length],
  }));
  if (!series.length) throw new Error("visualize 缺少 series");
  return {
    ...config,
    type,
    x,
    series,
    title: String(config.title || ""),
    subtitle: String(config.subtitle || ""),
    xLabel: String(config.x_label || ""),
    yLabel: String(config.y_label || ""),
    yUnit: String(config.y_unit || ""),
    height: Math.max(140, Math.min(420, Number(config.height) || (type === "sparkline" ? 120 : 260))),
  };
}

function valuesOf(config) {
  if (config.type === "scatter") {
    return config.series.flatMap((item) =>
      item.points.length
        ? item.points.map((point) => number(point?.y))
        : item.values.map((value, index) => {
            const point = value && typeof value === "object" ? value : null;
            return number(point?.y ?? value ?? index);
          }),
    );
  }
  return config.series.flatMap((item) => item.values.map(number));
}

function extent(config, tickCount = 5) {
  const values = valuesOf(config);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  if (["bar", "barh", "area"].includes(config.type)) min = Math.min(0, min);
  if (min === max) {
    const pad = Math.abs(min || 1) * 0.2;
    min -= pad;
    max += pad;
  }
  const rawStep = (max - min) / Math.max(1, tickCount - 1);
  const power = 10 ** Math.floor(Math.log10(Math.max(rawStep, Number.EPSILON)));
  const fraction = rawStep / power;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  const step = niceFraction * power;
  return [
    Math.floor(min / step + 1e-9) * step,
    Math.ceil(max / step - 1e-9) * step,
    step,
  ];
}

function chartHeader(config) {
  if (!config.title && !config.subtitle) return null;
  const head = html("div", "agviz-head");
  if (config.title) head.appendChild(html("strong", "", config.title));
  if (config.subtitle) head.appendChild(html("span", "", config.subtitle));
  return head;
}

function chartLegend(config) {
  if (config.series.length <= 1 || ["pie", "donut", "barh"].includes(config.type)) return null;
  const legend = html("div", "agviz-legend");
  config.series.forEach((item, index) => {
    const row = html("span", "agviz-legend-item");
    const dot = html("i", "");
    dot.style.background = color(item.color || paletteKeys[index % paletteKeys.length]);
    row.append(dot, document.createTextNode(item.name));
    legend.appendChild(row);
  });
  return legend;
}

function axes(svg, config, width, height, min, max, yStep, labels) {
  const compact = width < 480;
  const left = compact ? 42 : 56;
  const right = compact ? 12 : 20;
  const top = 12;
  const bottom = compact ? 32 : 38;
  const plotW = Math.max(1, width - left - right);
  const plotH = Math.max(1, height - top - bottom);
  const intervals = Math.max(1, Math.round((max - min) / yStep));
  for (let i = 0; i <= intervals; i++) {
    const y = top + (plotH * i) / intervals;
    const value = max - yStep * i;
    svg.appendChild(el("line", {
      x1: left, x2: left + plotW, y1: y, y2: y, class: "agviz-grid",
    }));
    svg.appendChild(el("text", {
      x: left - 7, y: y + 3.5, "text-anchor": "end", class: "agviz-tick",
    }, formatNumber(value)));
  }
  svg.appendChild(el("line", {
    x1: left, x2: left, y1: top, y2: top + plotH, class: "agviz-axis",
  }));
  svg.appendChild(el("line", {
    x1: left, x2: left + plotW, y1: top + plotH, y2: top + plotH, class: "agviz-axis",
  }));
  if (config.yLabel) {
    svg.appendChild(el("text", {
      x: 9, y: top + plotH / 2, "text-anchor": "middle",
      transform: `rotate(-90 9 ${top + plotH / 2})`, class: "agviz-label",
    }, `${config.yLabel}${config.yUnit ? ` (${config.yUnit})` : ""}`));
  }
  if (config.xLabel) {
    svg.appendChild(el("text", {
      x: left + plotW / 2, y: height - 5, "text-anchor": "middle", class: "agviz-label",
    }, config.xLabel));
  }
  const maxLabels = compact ? 5 : 8;
  const xStep = Math.max(1, Math.ceil(labels.length / maxLabels));
  labels.forEach((label, index) => {
    if (index % xStep !== 0 && index !== labels.length - 1) return;
    const x = labels.length === 1 ? left + plotW / 2 : left + (plotW * index) / (labels.length - 1);
    svg.appendChild(el("text", {
      x, y: top + plotH + 17, "text-anchor": "middle", class: "agviz-tick",
    }, String(label)));
  });
  return { left, top, plotW, plotH };
}

function xAt(index, count, area) {
  return count <= 1 ? area.left + area.plotW / 2 : area.left + (area.plotW * index) / (count - 1);
}

function yAt(value, min, max, area) {
  return area.top + area.plotH - ((number(value) - min) / (max - min)) * area.plotH;
}

function linePath(values, min, max, area, close = false) {
  const points = values.map((value, index) => `${xAt(index, values.length, area)},${yAt(value, min, max, area)}`);
  if (!points.length) return "";
  if (!close) return `M${points.join("L")}`;
  const baseline = area.top + area.plotH;
  return `M${area.left},${baseline}L${points.join("L")}L${xAt(values.length - 1, values.length, area)},${baseline}Z`;
}

function drawCartesian(config, width) {
  const height = config.height;
  const labels = config.x.length ? config.x : config.series[0].values.map((_, index) => index + 1);
  const tickCount = width < 480 ? 4 : 5;
  const [min, max, step] = extent(config, tickCount);
  const svg = el("svg", {
    viewBox: `0 0 ${width} ${height}`, width, height,
    role: "img", "aria-label": config.title || "Visualization",
  });
  svg.appendChild(el("title", {}, config.title || "Visualization"));
  const area = config.type === "sparkline"
    ? { left: 8, top: 8, plotW: Math.max(1, width - 16), plotH: Math.max(1, height - 16) }
    : axes(svg, config, width, height, min, max, step, labels);
  const count = Math.max(1, labels.length);
  config.series.forEach((item, seriesIndex) => {
    const stroke = color(item.color);
    if (config.type === "bar") {
      const groupW = area.plotW / Math.max(1, labels.length);
      const barW = Math.max(2, (groupW * 0.72) / config.series.length);
      item.values.forEach((value, index) => {
        const x = area.left + groupW * index + groupW * 0.14 + barW * seriesIndex;
        const y = yAt(value, min, max, area);
        const bar = el("rect", {
          x, y, width: barW, height: Math.max(0, area.top + area.plotH - y),
          rx: 2, fill: stroke, class: "agviz-mark",
        });
        bar.appendChild(el("title", {}, `${labels[index]} · ${item.name}: ${formatNumber(value)}${config.yUnit}`));
        svg.appendChild(bar);
      });
    } else if (config.type === "scatter") {
      item.values.forEach((value, index) => {
        const point = value && typeof value === "object" ? value : null;
        const xValue = point?.x ?? labels[index] ?? index;
        const x = typeof xValue === "number"
          ? area.left + ((xValue - Math.min(...labels.map(number))) /
            Math.max(1, Math.max(...labels.map(number)) - Math.min(...labels.map(number)))) * area.plotW
          : xAt(index, item.values.length, area);
        const y = yAt(point?.y ?? value, min, max, area);
        const dot = el("circle", { cx: x, cy: y, r: 3.5, fill: stroke, class: "agviz-mark" });
        dot.appendChild(el("title", {}, `${item.name}: ${formatNumber(point?.y ?? value)}${config.yUnit}`));
        svg.appendChild(dot);
      });
    } else {
      if (config.type === "area") {
        svg.appendChild(el("path", {
          d: linePath(item.values, min, max, area, true),
          fill: stroke, opacity: 0.14, class: "agviz-area",
        }));
      }
      svg.appendChild(el("path", {
        d: linePath(item.values, min, max, area),
        fill: "none", stroke, "stroke-width": 2, "stroke-linejoin": "round",
        "stroke-linecap": "round", class: "agviz-line",
      }));
      if (config.type !== "sparkline" && labels.length <= 16) {
        item.values.forEach((value, index) => {
          const dot = el("circle", {
            cx: xAt(index, count, area), cy: yAt(value, min, max, area), r: 3.2,
            fill: stroke, class: "agviz-mark",
          });
          dot.appendChild(el("title", {}, `${labels[index]} · ${item.name}: ${formatNumber(value)}${config.yUnit}`));
          svg.appendChild(dot);
        });
      }
    }
  });
  return svg;
}

function drawHorizontalBars(config, width) {
  const labels = config.x.length ? config.x : config.series[0].values.map((_, index) => index + 1);
  const values = config.series[0].values;
  const height = Math.max(config.height, labels.length * 30 + 24);
  const left = Math.min(150, Math.max(72, width * 0.28));
  const right = 42;
  const max = Math.max(1, ...values.map(number));
  const svg = el("svg", {
    viewBox: `0 0 ${width} ${height}`, width, height,
    role: "img", "aria-label": config.title || "Ranking",
  });
  svg.appendChild(el("title", {}, config.title || "Ranking"));
  values.forEach((value, index) => {
    const y = 12 + index * 30;
    const barW = ((width - left - right) * number(value)) / max;
    svg.appendChild(el("text", {
      x: left - 8, y: y + 15, "text-anchor": "end", class: "agviz-tick",
    }, String(labels[index] ?? index + 1)));
    svg.appendChild(el("rect", {
      x: left, y, width: Math.max(0, barW), height: 20, rx: 4,
      fill: color(config.series[0].color), class: "agviz-mark",
    }));
    svg.appendChild(el("text", {
      x: left + barW + 6, y: y + 14, class: "agviz-value",
    }, `${formatNumber(value)}${config.yUnit}`));
  });
  return svg;
}

function arcPath(cx, cy, radius, inner, start, end) {
  const p = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const a0 = start - Math.PI / 2;
  const a1 = end - Math.PI / 2;
  const large = end - start > Math.PI ? 1 : 0;
  const [x0, y0] = p(radius, a0);
  const [x1, y1] = p(radius, a1);
  if (inner <= 0) {
    return `M${cx},${cy}L${x0},${y0}A${radius},${radius} 0 ${large} 1 ${x1},${y1}Z`;
  }
  const [ix1, iy1] = p(inner, a1);
  const [ix0, iy0] = p(inner, a0);
  return [
    `M${x0},${y0}A${radius},${radius} 0 ${large} 1 ${x1},${y1}`,
    `L${ix1},${iy1}A${inner},${inner} 0 ${large} 0 ${ix0},${iy0}Z`,
  ].join("");
}

function drawPie(config, width) {
  const values = config.series[0].values.map((value) => Math.max(0, number(value)));
  const total = values.reduce((sum, value) => sum + value, 0) || 1;
  const height = config.height;
  const svg = el("svg", {
    viewBox: `0 0 ${width} ${height}`, width, height,
    role: "img", "aria-label": config.title || "Proportion",
  });
  svg.appendChild(el("title", {}, config.title || "Proportion"));
  const radius = Math.min(width * 0.25, height * 0.42);
  const inner = config.type === "donut" ? radius * 0.58 : 0;
  const cx = width < 480 ? width / 2 : Math.min(width * 0.32, 240);
  const cy = height / 2;
  let start = 0;
  values.forEach((value, index) => {
    const end = start + (value / total) * Math.PI * 2;
    const slice = el("path", {
      d: arcPath(cx, cy, radius, inner, start, end),
      fill: color(paletteKeys[index % paletteKeys.length]),
      class: "agviz-mark",
    });
    slice.appendChild(el("title", {}, `${config.x[index] ?? index + 1}: ${formatNumber(value)}${config.yUnit}`));
    svg.appendChild(slice);
    start = end;
  });
  return svg;
}

function pieLegend(config) {
  const legend = html("div", "agviz-legend agviz-pie-legend");
  config.series[0].values.forEach((value, index) => {
    const row = html("span", "agviz-legend-item");
    const dot = html("i", "");
    dot.style.background = color(paletteKeys[index % paletteKeys.length]);
    row.append(dot, document.createTextNode(`${config.x[index] ?? index + 1}  ${formatNumber(value)}`));
    legend.appendChild(row);
  });
  return legend;
}

export function renderVisualization(mount, configOverride) {
  if (!mount) return;
  let config;
  try {
    const raw = configOverride ?? decodeURIComponent(mount.dataset.viz || "");
    config = normalize(typeof raw === "string" ? JSON.parse(raw) : raw);
  } catch (error) {
    mount.innerHTML = "";
    mount.appendChild(html("div", "agviz-error", error?.message || String(error)));
    return;
  }
  const width = Math.max(300, Math.min(860, Math.round(mount.clientWidth || 720)));
  const height = config.height;
  mount.innerHTML = "";
  mount.classList.add("agviz");
  mount.setAttribute("role", "figure");
  if (config.title) mount.setAttribute("aria-label", config.title);
  const head = chartHeader(config);
  if (head) mount.appendChild(head);
  const canvas = html("div", "agviz-canvas");
  canvas.appendChild(
    ["pie", "donut"].includes(config.type)
      ? drawPie(config, width)
      : config.type === "barh"
        ? drawHorizontalBars(config, width)
        : drawCartesian(config, width),
  );
  if (["pie", "donut"].includes(config.type)) canvas.appendChild(pieLegend(config));
  mount.appendChild(canvas);
  const legend = chartLegend(config);
  if (legend) mount.appendChild(legend);
  renderCache.set(mount, config);
}

export function renderVisualizations(root = document) {
  root.querySelectorAll?.(".agvizmount").forEach((mount) => renderVisualization(mount));
  if (!themeObserver && typeof MutationObserver === "function") {
    themeObserver = new MutationObserver(() => {
      document.querySelectorAll(".agvizmount").forEach((mount) => renderVisualization(mount));
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style", "data-lang"],
    });
  }
  if (!resizeObserver && typeof ResizeObserver === "function") {
    let queued = false;
    resizeObserver = new ResizeObserver((entries) => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        entries.forEach(({ target }) => {
          if (target.isConnected && renderCache.has(target)) renderVisualization(target);
        });
      });
    });
    document.querySelectorAll(".agvizmount").forEach((mount) => resizeObserver.observe(mount));
  } else if (resizeObserver) {
    document.querySelectorAll(".agvizmount").forEach((mount) => resizeObserver.observe(mount));
  }
}
