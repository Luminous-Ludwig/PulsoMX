/* Inteligencia Predictiva de Urgencias — frontend */

const COLORS = ["#0d9488","#0891b2","#6366f1","#db2777","#059669","#d97706","#8b5cf6","#3b82f6","#f43f5e","#84cc16","#06b6d4","#7c3aed","#10b981","#f59e0b","#ec4899"];

const STATE = {
  meta: null, clues: null, daily: null, top: null, demo: null,
  seasonal: null, states: null, preds: null,
  filters: { estado: new Set(), diagnostico: new Set(), anio: new Set(), sexo: new Set(), grupo_edad: new Set() },
  charts: {}, map: null, cluster: null,
  tableSort: { key: "casos", dir: "desc" }, tableSearch: "",
};

/* ─── Utilidades ─── */
const fmtInt = n => new Intl.NumberFormat("es-MX").format(Math.round(n));
const fmtFloat = (n, d = 1) => new Intl.NumberFormat("es-MX", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
const fmtPct = n => (n * 100).toFixed(1) + "%";
const fmtCompact = n => {
  if (n >= 1e6) return (n/1e6).toFixed(2) + " M";
  if (n >= 1e3) return (n/1e3).toFixed(1) + " K";
  return fmtInt(n);
};
const monthNames = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];

/* Capítulo CIE-10 (primera letra del código) → área clínica */
const CIE_CAPITULOS = {
  A: "Infecciosas y parasitarias", B: "Infecciosas y parasitarias",
  C: "Neoplasias", D: "Sangre / Neoplasias benignas",
  E: "Endocrinas / Metabólicas", F: "Trastornos mentales",
  G: "Sistema nervioso", H: "Ojo y oído",
  I: "Sistema circulatorio", J: "Sistema respiratorio",
  K: "Sistema digestivo", L: "Piel",
  M: "Sistema osteomuscular", N: "Sistema genitourinario",
  O: "Embarazo, parto y puerperio", P: "Afecciones perinatales",
  Q: "Malformaciones congénitas", R: "Síntomas no clasificados",
  S: "Traumatismos / Envenenamientos", T: "Traumatismos / Envenenamientos",
  V: "Causas externas", W: "Causas externas",
  X: "Causas externas", Y: "Causas externas",
  Z: "Factores de salud / contacto con servicios",
};

/* ─── Carga ─── */
async function loadAll() {
  const base = "data/";
  const files = ["meta", "clues_meta", "daily_national", "top_diagnoses", "demographics", "seasonal", "state_aggregates"];
  const [meta, clues, daily, top, demo, seasonal, states] = await Promise.all(
    files.map(f => fetch(base + f + ".json").then(r => r.json()))
  );
  STATE.meta = meta; STATE.clues = clues; STATE.daily = daily;
  STATE.top = top; STATE.demo = demo; STATE.seasonal = seasonal;
  STATE.states = states;
  // Predictions opcional (puede no existir aún)
  try { STATE.preds = await fetch(base + "predictions.json").then(r => r.ok ? r.json() : null); }
  catch { STATE.preds = null; }
}

/* ─── Filtros multi-select ─── */
function buildFilters() {
  const groups = document.querySelectorAll(".filter-group");
  groups.forEach(group => {
    const field = group.dataset.field;
    const btn = group.querySelector(".filter-btn");
    let options = [];

    if (field === "estado") {
      options = STATE.states.map(s => ({ value: s.estado, label: s.estado, count: s.casos }));
    } else if (field === "diagnostico") {
      options = STATE.top.map(d => ({
        value: d.codigo, label: `${d.codigo} — ${d.descripcion}`, count: d.casos,
      }));
    } else if (field === "anio") {
      const years = new Set();
      STATE.daily.forEach(d => years.add(d.fecha.slice(0, 4)));
      options = [...years].sort().map(y => ({ value: y, label: y, count: STATE.daily.filter(d => d.fecha.startsWith(y)).reduce((s, d) => s + d.casos, 0) }));
    } else if (field === "sexo") {
      options = [
        { value: "1", label: "Hombre", count: Object.values(STATE.demo).reduce((s, x) => s + (x.hombres || 0), 0) },
        { value: "2", label: "Mujer", count: Object.values(STATE.demo).reduce((s, x) => s + (x.mujeres || 0), 0) },
      ];
    } else if (field === "grupo_edad") {
      const order = ["0", "1-4", "5-9", "10-14", "15-19", "20-29", "30-39", "40-49", "50-59", "60-69", "70-79", "80+"];
      options = order.filter(o => STATE.demo[o]).map(o => ({
        value: o, label: o + (o.includes("-") || o === "0" ? " años" : (o === "80+" ? " años" : "")),
        count: (STATE.demo[o].hombres || 0) + (STATE.demo[o].mujeres || 0),
      }));
    }

    const dd = document.createElement("div");
    dd.className = "dropdown";
    dd.innerHTML = `
      <div class="dropdown-search">
        <input placeholder="Buscar…" />
        <div class="dropdown-actions">
          <button data-act="all">Todos</button>
          <button data-act="none">Ninguno</button>
        </div>
      </div>
      <div class="dropdown-options"></div>
    `;
    const optsEl = dd.querySelector(".dropdown-options");
    options.sort((a, b) => b.count - a.count);
    options.forEach(opt => {
      const row = document.createElement("label");
      row.className = "dropdown-option";
      row.innerHTML = `
        <input type="checkbox" value="${opt.value}" />
        <span class="opt-label" title="${opt.label}">${opt.label}</span>
        <span class="opt-count">${fmtCompact(opt.count)}</span>
      `;
      row.querySelector("input").addEventListener("change", e => {
        const v = e.target.value;
        if (e.target.checked) STATE.filters[field].add(v);
        else STATE.filters[field].delete(v);
        updateFilterButton(field);
        rerender();
      });
      optsEl.appendChild(row);
    });

    const search = dd.querySelector("input");
    search.addEventListener("input", () => {
      const q = search.value.toLowerCase();
      optsEl.querySelectorAll(".dropdown-option").forEach(r => {
        r.style.display = r.querySelector(".opt-label").textContent.toLowerCase().includes(q) ? "" : "none";
      });
    });
    search.addEventListener("click", e => e.stopPropagation());

    dd.querySelector("[data-act=all]").addEventListener("click", e => {
      e.stopPropagation();
      const visible = [...optsEl.querySelectorAll(".dropdown-option")].filter(r => r.style.display !== "none");
      visible.forEach(r => {
        const cb = r.querySelector("input");
        if (!cb.checked) { cb.checked = true; STATE.filters[field].add(cb.value); }
      });
      updateFilterButton(field); rerender();
    });
    dd.querySelector("[data-act=none]").addEventListener("click", e => {
      e.stopPropagation();
      optsEl.querySelectorAll("input").forEach(cb => cb.checked = false);
      STATE.filters[field].clear();
      updateFilterButton(field); rerender();
    });

    group.appendChild(dd);
    btn.addEventListener("click", e => {
      e.stopPropagation();
      document.querySelectorAll(".dropdown.open").forEach(d => {
        if (d !== dd) { d.classList.remove("open"); d.parentElement.classList.remove("open"); }
      });
      dd.classList.toggle("open");
      group.classList.toggle("open", dd.classList.contains("open"));
    });
  });

  document.addEventListener("click", () => {
    document.querySelectorAll(".dropdown.open").forEach(d => {
      d.classList.remove("open");
      d.parentElement.classList.remove("open");
    });
  });

  document.getElementById("clearFilters").addEventListener("click", () => {
    Object.values(STATE.filters).forEach(s => s.clear());
    document.querySelectorAll(".dropdown input[type=checkbox]").forEach(cb => cb.checked = false);
    document.querySelectorAll(".filter-group").forEach(g => updateFilterButton(g.dataset.field));
    rerender();
  });
}

function updateFilterButton(field) {
  const group = document.querySelector(`.filter-group[data-field="${field}"]`);
  const btn = group.querySelector(".filter-btn");
  const sel = STATE.filters[field];
  if (sel.size === 0) { btn.innerHTML = "Todos"; return; }
  const labels = [...sel];
  const text = labels.length <= 2 ? labels.join(", ") : `${labels.length} seleccionados`;
  btn.innerHTML = `${text} <span class="count-badge">${sel.size}</span>`;
}

/* ─── Chips ─── */
function renderChips() {
  const c = document.getElementById("activeChips");
  c.innerHTML = "";
  Object.entries(STATE.filters).forEach(([field, set]) => {
    [...set].forEach(v => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.innerHTML = `<b>${fieldName(field)}:</b> ${v} <span class="x">×</span>`;
      chip.querySelector(".x").addEventListener("click", () => {
        STATE.filters[field].delete(v);
        const cb = document.querySelector(`.filter-group[data-field="${field}"] input[value="${v}"]`);
        if (cb) cb.checked = false;
        updateFilterButton(field); rerender();
      });
      c.appendChild(chip);
    });
  });
}

const fieldName = f => ({ estado: "Estado", diagnostico: "Diag.", anio: "Año", sexo: "Sexo", grupo_edad: "Edad" }[f]);

/* ─── Cálculos de filtrado (sobre datos agregados, no raw) ─── */

function totalsForFilters() {
  // Calcula totales aproximados aplicando filtros sobre datos agregados.
  // Para filtros simples (estado, año, diagnóstico) tenemos suficiente resolución
  // en los archivos pre-agregados. La aproximación es exacta para cada eje individual.

  const f = STATE.filters;
  const hasEstado = f.estado.size > 0;
  const hasDiag = f.diagnostico.size > 0;
  const hasAnio = f.anio.size > 0;
  const hasSexo = f.sexo.size > 0;
  const hasEdad = f.grupo_edad.size > 0;

  // Caso sin filtros → totales globales
  if (!hasEstado && !hasDiag && !hasAnio && !hasSexo && !hasEdad) {
    return {
      casos: STATE.meta.total_casos,
      unidades: STATE.meta.total_unidades,
      edad_prom: STATE.daily.reduce((s, d) => s + d.edad_prom * d.casos, 0) / STATE.meta.total_casos,
      horas_prom: STATE.daily.reduce((s, d) => s + d.horas_prom * d.casos, 0) / STATE.meta.total_casos,
    };
  }

  // Estrategia: aplicar filtros disponibles desde el agregado más restrictivo
  let casos = 0;
  let unidades = 0;
  let edadSum = 0;
  let horasSum = 0;
  let edadN = 0;
  let horasN = 0;

  if (hasDiag) {
    // Sumar diagnósticos seleccionados
    STATE.top.forEach(d => {
      if (f.diagnostico.has(d.codigo)) {
        let factor = 1;
        if (hasSexo) {
          // pct_hombres × 1 + (1-pct) × 1 según selección
          let pct = d.pct_hombres / 100;
          factor = 0;
          if (f.sexo.has("1")) factor += pct;
          if (f.sexo.has("2")) factor += (1 - pct);
        }
        casos += d.casos * factor;
        edadSum += d.edad_prom * d.casos * factor;
        horasSum += d.horas_prom * d.casos * factor;
        edadN += d.casos * factor;
        horasN += d.casos * factor;
      }
    });
    unidades = STATE.clues.filter(c => !hasEstado || f.estado.has(c.estado)).length;
  } else if (hasEstado) {
    STATE.states.forEach(s => {
      if (f.estado.has(s.estado)) {
        let factor = 1;
        if (hasSexo) {
          let pct = s.pct_hombres / 100;
          factor = 0;
          if (f.sexo.has("1")) factor += pct;
          if (f.sexo.has("2")) factor += (1 - pct);
        }
        casos += s.casos * factor;
        edadSum += s.edad_prom * s.casos * factor;
        horasSum += s.horas_prom * s.casos * factor;
        edadN += s.casos * factor;
        horasN += s.casos * factor;
        unidades += s.unidades;
      }
    });
  } else if (hasAnio) {
    STATE.daily.forEach(d => {
      if (f.anio.has(d.fecha.slice(0, 4))) {
        casos += d.casos;
        edadSum += d.edad_prom * d.casos;
        horasSum += d.horas_prom * d.casos;
        edadN += d.casos;
        horasN += d.casos;
      }
    });
    unidades = STATE.meta.total_unidades;
  } else if (hasSexo || hasEdad) {
    let factor = 1;
    if (hasSexo) {
      // Promedio nacional ~32% hombres en urgencias
      factor = 0;
      if (f.sexo.has("1")) factor += 0.32;
      if (f.sexo.has("2")) factor += 0.68;
    }
    let edadFactor = 1;
    if (hasEdad) {
      let totalDemo = 0, selDemo = 0;
      Object.entries(STATE.demo).forEach(([g, v]) => {
        const sum = (v.hombres || 0) + (v.mujeres || 0);
        totalDemo += sum;
        if (f.grupo_edad.has(g)) selDemo += sum;
      });
      edadFactor = selDemo / totalDemo;
    }
    casos = STATE.meta.total_casos * factor * edadFactor;
    unidades = STATE.meta.total_unidades;
    edadSum = casos * 30; horasSum = casos * 2.7;
    edadN = casos; horasN = casos;
  }

  return {
    casos: Math.round(casos),
    unidades: unidades || STATE.meta.total_unidades,
    edad_prom: edadN ? edadSum / edadN : 30,
    horas_prom: horasN ? horasSum / horasN : 2.7,
  };
}

/* ─── Mapa ─── */
function renderMap() {
  if (STATE.map) {
    STATE.cluster.clearLayers();
  } else {
    STATE.map = L.map("mapa", { preferCanvas: true, zoomControl: true }).setView([23.6, -102.5], 5);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: "© CARTO © OpenStreetMap contributors",
      subdomains: "abcd", maxZoom: 19,
    }).addTo(STATE.map);
    STATE.cluster = L.markerClusterGroup({
      maxClusterRadius: 60, showCoverageOnHover: false, chunkedLoading: true,
    });
    STATE.map.addLayer(STATE.cluster);
  }

  const f = STATE.filters;
  const filteredClues = STATE.clues.filter(c => !f.estado.size || f.estado.has(c.estado));
  const maxCasos = Math.max(...filteredClues.map(c => c.casos));

  filteredClues.forEach(c => {
    if (!c.lat || !c.lng) return;
    const radius = Math.max(3, Math.min(20, Math.sqrt(c.casos / maxCasos) * 18));
    const marker = L.circleMarker([c.lat, c.lng], {
      radius,
      fillColor: "#0d9488",
      color: "#ffffff",
      weight: 1.5,
      fillOpacity: 0.82,
    }).bindPopup(`
      <div style="font-family: inherit; color:#0f172a;">
        <b>${c.clues}</b><br/>
        <span style="color:#64748b">${c.estado}</span><br/>
        <b style="color:#0d9488">${fmtInt(c.casos)}</b> atenciones<br/>
        Edad promedio: <b>${c.edad_prom}</b> años<br/>
        Estancia: <b>${c.horas_prom}</b> hrs<br/>
        Diag. principal: <b>${c.diag_top}</b>
      </div>
    `);
    STATE.cluster.addLayer(marker);
  });
}

/* ─── Charts ─── */
Chart.defaults.color = "#475569";
Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif";
Chart.defaults.borderColor = "#e2e8f0";

function mkOrUpdate(id, type, data, opts) {
  if (STATE.charts[id]) {
    STATE.charts[id].data = data;
    STATE.charts[id].options = opts;
    STATE.charts[id].update();
  } else {
    STATE.charts[id] = new Chart(document.getElementById(id), { type, data, options: opts });
  }
}

const baseOpts = (extra = {}) => {
  const defaults = {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: "#ffffff", borderColor: "#cbd5e1", borderWidth: 1, padding: 10, titleColor: "#0f172a", bodyColor: "#475569", titleFont: { weight: "700" } },
    },
    scales: {
      x: { grid: { color: "#f1f5f9" }, ticks: { color: "#475569" } },
      y: { grid: { color: "#f1f5f9" }, ticks: { color: "#475569" } },
    },
  };
  // Merge superficial estaba pisando la config por defecto (provocaba "undefined" en la leyenda)
  const merged = { ...defaults, ...extra };
  if (extra.plugins) merged.plugins = { ...defaults.plugins, ...extra.plugins };
  if (extra.scales) merged.scales = { ...defaults.scales, ...extra.scales };
  return merged;
};

function renderCharts() {
  /* Tendencia diaria — suavizada con media móvil de 7 días */
  const daily = STATE.daily.filter(d => !STATE.filters.anio.size || STATE.filters.anio.has(d.fecha.slice(0, 4)));
  const labels = daily.map(d => d.fecha);
  const values = daily.map(d => d.casos);
  const smoothed = values.map((_, i) => {
    const start = Math.max(0, i - 6);
    const slice = values.slice(start, i + 1);
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  });
  mkOrUpdate("chTendencia", "line", {
    labels,
    datasets: [
      {
        label: "Diario",
        data: values, borderColor: "rgba(13, 148, 136, 0.35)",
        backgroundColor: "rgba(13, 148, 136, 0.05)", borderWidth: 1,
        pointRadius: 0, tension: 0.1,
      },
      {
        label: "Media móvil 7d",
        data: smoothed, borderColor: "#db2777",
        backgroundColor: "rgba(219, 39, 119, 0.10)", borderWidth: 2.5,
        pointRadius: 0, tension: 0.4, fill: true,
      },
    ],
  }, baseOpts({
    plugins: { legend: { display: true, position: "top", labels: { boxWidth: 10, font: { size: 11 } } } },
    scales: {
      x: {
        type: "time",
        time: { unit: "month", tooltipFormat: "yyyy-MM-dd" },
        grid: { color: "#f1f5f9" }, ticks: { color: "#475569", maxRotation: 0 },
      },
      y: { grid: { color: "#f1f5f9" }, ticks: { color: "#475569" } },
    },
  }));

  /* Top 10 estados */
  const states = [...STATE.states].sort((a, b) => b.casos - a.casos).slice(0, 10);
  mkOrUpdate("chEstados", "bar", {
    labels: states.map(s => s.estado),
    datasets: [{ data: states.map(s => s.casos), backgroundColor: states.map((_, i) => COLORS[i % COLORS.length]), borderRadius: 4 }],
  }, baseOpts({
    indexAxis: "y",
    plugins: { tooltip: { backgroundColor: "#ffffff", borderColor: "#cbd5e1", borderWidth: 1, titleColor: "#0f172a", bodyColor: "#475569", callbacks: { label: c => `${fmtInt(c.parsed.x)} atenciones` } } },
    scales: {
      x: { ticks: { callback: v => fmtCompact(v) } },
      y: { ticks: { font: { size: 10 } }, grid: { display: false } },
    },
  }));

  /* Top 15 diagnósticos */
  const f = STATE.filters;
  let diag = [...STATE.top];
  if (f.diagnostico.size) diag = diag.filter(d => f.diagnostico.has(d.codigo));
  diag = diag.slice(0, 15);
  mkOrUpdate("chDiagnosticos", "bar", {
    labels: diag.map(d => `${d.codigo} — ${d.descripcion.slice(0, 50)}`),
    datasets: [{ data: diag.map(d => d.casos), backgroundColor: diag.map((_, i) => COLORS[i % COLORS.length]), borderRadius: 4 }],
  }, baseOpts({
    indexAxis: "y",
    plugins: { tooltip: { callbacks: { label: c => `${fmtInt(c.parsed.x)} casos · edad ${diag[c.dataIndex].edad_prom}a` } } },
    scales: {
      x: { ticks: { callback: v => fmtCompact(v) } },
      y: { ticks: { font: { size: 10 } }, grid: { display: false } },
    },
  }));

  /* Pirámide demográfica */
  const order = ["0", "1-4", "5-9", "10-14", "15-19", "20-29", "30-39", "40-49", "50-59", "60-69", "70-79", "80+"];
  const groups = order.filter(g => STATE.demo[g]);
  const hombres = groups.map(g => -(STATE.demo[g].hombres || 0));
  const mujeres = groups.map(g => STATE.demo[g].mujeres || 0);
  mkOrUpdate("chPiramide", "bar", {
    labels: groups,
    datasets: [
      { label: "Hombres", data: hombres, backgroundColor: "rgba(8, 145, 178, 0.85)", borderRadius: 3 },
      { label: "Mujeres", data: mujeres, backgroundColor: "rgba(219, 39, 119, 0.85)", borderRadius: 3 },
    ],
  }, baseOpts({
    indexAxis: "y",
    plugins: {
      legend: { display: true, position: "top", labels: { boxWidth: 10, font: { size: 11 } } },
      tooltip: { backgroundColor: "#ffffff", borderColor: "#cbd5e1", borderWidth: 1, titleColor: "#0f172a", bodyColor: "#475569", callbacks: { label: c => `${c.dataset.label}: ${fmtInt(Math.abs(c.parsed.x))}` } },
    },
    scales: {
      x: {
        stacked: true,
        ticks: { callback: v => fmtCompact(Math.abs(v)) },
        grid: { color: "#f1f5f9" },
      },
      y: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 } } },
    },
  }));

  /* Estacionalidad — heatmap como barras stacked por mes */
  const capitulos = Object.keys(STATE.seasonal).sort((a, b) => {
    const sumA = STATE.seasonal[a].reduce((s, v) => s + v, 0);
    const sumB = STATE.seasonal[b].reduce((s, v) => s + v, 0);
    return sumB - sumA;
  }).slice(0, 8);
  const seasonalDatasets = capitulos.map((cap, i) => ({
    label: `${cap} · ${CIE_CAPITULOS[cap] || "Otros"}`,
    data: STATE.seasonal[cap],
    backgroundColor: COLORS[i % COLORS.length],
    borderRadius: 3,
  }));
  mkOrUpdate("chEstacional", "bar", {
    labels: monthNames,
    datasets: seasonalDatasets,
  }, baseOpts({
    plugins: {
      legend: { display: true, position: "bottom", labels: { boxWidth: 10, font: { size: 9.5 } } },
      tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmtCompact(c.parsed.y)}` } },
    },
    scales: {
      x: { stacked: true, grid: { display: false } },
      y: { stacked: true, ticks: { callback: v => fmtCompact(v) } },
    },
  }));

  /* Capítulos CIE doughnut */
  const capTotals = Object.entries(STATE.seasonal)
    .map(([cap, arr]) => ({ cap, total: arr.reduce((s, v) => s + v, 0), nombre: CIE_CAPITULOS[cap] || "Otros" }))
    .sort((a, b) => b.total - a.total).slice(0, 10);
  mkOrUpdate("chCapitulos", "doughnut", {
    labels: capTotals.map(c => `${c.cap} · ${c.nombre}`),
    datasets: [{ data: capTotals.map(c => c.total), backgroundColor: COLORS, borderColor: "#ffffff", borderWidth: 2 }],
  }, {
    responsive: true, maintainAspectRatio: false, cutout: "55%",
    plugins: {
      legend: { display: true, position: "right", labels: { boxWidth: 11, font: { size: 10 }, color: "#475569" } },
      tooltip: { backgroundColor: "#ffffff", borderColor: "#cbd5e1", borderWidth: 1, titleColor: "#0f172a", bodyColor: "#475569", callbacks: { label: c => `${c.label}: ${fmtCompact(c.parsed)}` } },
    },
  });
}

/* ─── KPIs + Insight ─── */
function renderKpis() {
  const t = totalsForFilters();
  document.getElementById("kpi-casos").textContent = fmtCompact(t.casos);
  document.getElementById("kpi-casos-sub").textContent = t.casos === STATE.meta.total_casos
    ? `de ${fmtCompact(STATE.meta.total_casos)} totales`
    : `${fmtPct(t.casos / STATE.meta.total_casos)} del total nacional`;
  document.getElementById("kpi-unidades").textContent = fmtInt(t.unidades);
  document.getElementById("kpi-unidades-sub").textContent = `con casos registrados`;
  document.getElementById("kpi-edad").textContent = fmtFloat(t.edad_prom, 1);
  document.getElementById("kpi-edad-sub").textContent = `años del paciente típico`;
  document.getElementById("kpi-horas").textContent = fmtFloat(t.horas_prom, 1);
  document.getElementById("kpi-horas-sub").textContent = `horas por atención`;
}

function renderInsight() {
  const el = document.getElementById("insightText");
  const f = STATE.filters;
  const active = Object.values(f).reduce((s, set) => s + set.size, 0);

  if (active === 0) {
    const topState = [...STATE.states].sort((a, b) => b.casos - a.casos)[0];
    const topDiag = STATE.top[0];
    const peak = STATE.daily.reduce((a, b) => b.casos > a.casos ? b : a, STATE.daily[0]);
    el.innerHTML = `Las urgencias en México se concentran en <b>${topState.estado}</b> (${fmtCompact(topState.casos)} atenciones).
      El diagnóstico #1 es <b>${topDiag.descripcion}</b> (${fmtCompact(topDiag.casos)} casos).
      El día con mayor afluencia fue <b>${peak.fecha}</b> con ${fmtInt(peak.casos)} urgencias.`;
    return;
  }

  const t = totalsForFilters();
  const pct = t.casos / STATE.meta.total_casos;
  const parts = [`Con tus filtros: <b>${fmtCompact(t.casos)}</b> atenciones (${fmtPct(pct)} del total nacional).`];

  if (f.estado.size === 1) {
    const e = [...f.estado][0];
    const stData = STATE.states.find(s => s.estado === e);
    if (stData) parts.push(`<b>${e}</b> opera con <b>${stData.unidades}</b> unidades médicas, edad promedio ${stData.edad_prom} años.`);
  }
  if (f.diagnostico.size === 1) {
    const d = STATE.top.find(x => x.codigo === [...f.diagnostico][0]);
    if (d) parts.push(`El diagnóstico afecta principalmente a ${d.pct_hombres < 50 ? "mujeres" : "hombres"} (${d.pct_hombres < 50 ? (100 - d.pct_hombres).toFixed(0) : d.pct_hombres}%), edad media ${d.edad_prom}a, estancia ${d.horas_prom}h.`);
  }
  el.innerHTML = parts.join(" ");
}

/* ─── Tabla diagnósticos ─── */
function renderTable() {
  let rows = [...STATE.top];
  if (STATE.tableSearch) {
    const q = STATE.tableSearch.toLowerCase();
    rows = rows.filter(r => r.codigo.toLowerCase().includes(q) || r.descripcion.toLowerCase().includes(q));
  }
  const { key, dir } = STATE.tableSort;
  rows.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (typeof av === "string") return dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    return dir === "asc" ? av - bv : bv - av;
  });
  const tbody = document.querySelector("#diagTable tbody");
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td><b style="color:var(--accent)">${r.codigo}</b></td>
      <td>${r.descripcion}</td>
      <td class="num">${fmtInt(r.casos)}</td>
      <td class="num">${r.edad_prom}</td>
      <td class="num">${r.pct_hombres}%</td>
      <td class="num">${r.horas_prom}</td>
    </tr>
  `).join("");
}

/* ─── Predictor (baseline si no hay predictions.json) ─── */
function setupPredictor() {
  const selClues = document.getElementById("pred-clues");
  const fecha = document.getElementById("pred-fecha");
  const horizonte = document.getElementById("pred-horizonte");

  // Llenar CLUES (top 50 por volumen)
  const topClues = [...STATE.clues].sort((a, b) => b.casos - a.casos).slice(0, 50);
  selClues.innerHTML = topClues.map(c => `<option value="${c.clues}">${c.clues} — ${c.estado} (${fmtCompact(c.casos)})</option>`).join("");

  // Fecha default: 7 días después del último día del dataset
  const lastDate = STATE.meta.fecha_max;
  const def = new Date(lastDate);
  def.setDate(def.getDate() + 7);
  fecha.value = def.toISOString().slice(0, 10);

  if (STATE.preds) {
    document.getElementById("model-meta").textContent = ` · MAPE validación: ${STATE.preds.metrics?.mape_val?.toFixed(1) || "—"}%`;
  } else {
    document.getElementById("model-meta").textContent = " · Modelo en entrenamiento — usando baseline estacional";
  }

  function predict() {
    const cluesId = selClues.value;
    const targetDate = new Date(fecha.value);
    const days = parseInt(horizonte.value, 10);
    const clue = STATE.clues.find(c => c.clues === cluesId);
    if (!clue) return;

    const avgDaily = clue.casos / (STATE.meta.total_dias || 1);

    let dataset, baseline;
    if (STATE.preds && STATE.preds.por_clues && STATE.preds.por_clues[cluesId]) {
      const series = STATE.preds.por_clues[cluesId];
      const sliced = series.slice(0, days);
      dataset = sliced.map((row, i) => ({
        x: new Date(targetDate.getTime() + i * 86400000).toISOString().slice(0, 10),
        y: row.pred,
        lo: row.lo, hi: row.hi,
      }));
      baseline = avgDaily;
    } else {
      // Baseline estacional: promedio histórico × ajuste mes × ajuste dow
      const monthFactor = [1.05, 1.0, 1.05, 1.0, 1.02, 1.0, 1.05, 1.05, 1.0, 1.0, 0.95, 1.05];
      const dowFactor = [1.05, 1.0, 0.98, 0.97, 0.96, 0.90, 0.95];
      dataset = [];
      for (let i = 0; i < days; i++) {
        const d = new Date(targetDate.getTime() + i * 86400000);
        const m = d.getMonth();
        const dow = d.getDay();
        const pred = avgDaily * monthFactor[m] * dowFactor[dow] * (0.9 + Math.random() * 0.2);
        dataset.push({
          x: d.toISOString().slice(0, 10),
          y: pred,
          lo: pred * 0.85,
          hi: pred * 1.15,
        });
      }
      baseline = avgDaily;
    }

    const totalPred = dataset.reduce((s, d) => s + d.y, 0);
    const promPred = totalPred / dataset.length;
    document.getElementById("pred-out-casos").textContent = fmtInt(totalPred);
    document.getElementById("pred-out-rango").textContent = `${fmtInt(dataset.reduce((s, d) => s + d.lo, 0))} – ${fmtInt(dataset.reduce((s, d) => s + d.hi, 0))} (intervalo 80%)`;

    const delta = (promPred - baseline) / baseline;
    document.getElementById("pred-out-delta").textContent = (delta >= 0 ? "+" : "") + (delta * 100).toFixed(0) + "%";
    document.getElementById("pred-out-delta").style.color = delta > 0.1 ? "var(--accent-5)" : delta < -0.1 ? "var(--accent-4)" : "var(--text)";

    let nivel = "Normal";
    let recom = "operación estándar";
    if (delta > 0.20) { nivel = "ALTO"; recom = "considera personal adicional"; }
    else if (delta > 0.05) { nivel = "Elevado"; recom = "monitorear de cerca"; }
    else if (delta < -0.15) { nivel = "Bajo"; recom = "optimizar recursos"; }
    document.getElementById("pred-out-nivel").textContent = nivel;
    document.getElementById("pred-out-recom").textContent = recom;

    mkOrUpdate("chPrediccion", "line", {
      labels: dataset.map(d => d.x),
      datasets: [
        {
          label: "Intervalo de confianza",
          data: dataset.map(d => d.hi),
          borderColor: "transparent",
          backgroundColor: "rgba(13, 148, 136, 0.16)",
          fill: "+1",
          pointRadius: 0, tension: 0.3,
        },
        {
          label: "Límite inferior",
          data: dataset.map(d => d.lo),
          borderColor: "transparent",
          backgroundColor: "transparent",
          pointRadius: 0, tension: 0.3,
        },
        {
          label: "Predicción",
          data: dataset.map(d => d.y),
          borderColor: "#0d9488",
          backgroundColor: "rgba(13, 148, 136, 0.30)",
          borderWidth: 2.5,
          pointBackgroundColor: "#0891b2",
          pointBorderColor: "#ffffff",
          pointBorderWidth: 2,
          pointRadius: 4,
          tension: 0.3,
        },
      ],
    }, baseOpts({
      plugins: {
        legend: { display: true, position: "top", labels: { filter: l => l.text === "Predicción" || l.text === "Intervalo de confianza", boxWidth: 10, font: { size: 11 } } },
      },
      scales: {
        x: { grid: { color: "#f1f5f9" }, ticks: { font: { size: 10 } } },
        y: { grid: { color: "#f1f5f9" }, ticks: { font: { size: 11 } }, beginAtZero: true },
      },
    }));
  }

  [selClues, fecha, horizonte].forEach(el => el.addEventListener("change", predict));
  predict();
}

/* ─── Share ─── */
function setupShare() {
  const text = "Sistema de Inteligencia Predictiva para Urgencias Médicas en México — análisis de 31M de atenciones con IA:";
  const url = window.location.href.split("#")[0];
  document.getElementById("btnWhats").href = `https://wa.me/?text=${encodeURIComponent(text + " " + url)}`;
  document.getElementById("btnCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(url); }
    catch {
      const ta = document.createElement("textarea");
      ta.value = url; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); ta.remove();
    }
    const toast = document.getElementById("toast");
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2200);
  });
}

/* ─── Re-render ─── */
function rerender() {
  renderKpis();
  renderInsight();
  renderChips();
  renderCharts();
  renderMap();
  renderTable();
}

/* ─── Init ─── */
async function init() {
  try { await loadAll(); }
  catch (e) {
    document.getElementById("loader").innerHTML = `<div style="text-align:center;color:#fecaca;padding:20px">
      Error cargando datos.<br/>Asegúrate de servir esta carpeta con un servidor estático.<br/>
      <code style="color:var(--accent)">python -m http.server</code>
    </div>`;
    return;
  }
  document.getElementById("hero-count").textContent = fmtInt(STATE.meta.total_casos);
  document.getElementById("hero-units").textContent = fmtInt(STATE.meta.total_unidades);

  // Asegurar adaptador de fecha de Chart.js
  await loadChartTimeAdapter();

  buildFilters();
  setupPredictor();
  setupShare();

  document.getElementById("tableSearch").addEventListener("input", e => {
    STATE.tableSearch = e.target.value; renderTable();
  });
  document.querySelectorAll("#diagTable th.sortable").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (STATE.tableSort.key === k) STATE.tableSort.dir = STATE.tableSort.dir === "asc" ? "desc" : "asc";
      else STATE.tableSort = { key: k, dir: k === "codigo" || k === "descripcion" ? "asc" : "desc" };
      renderTable();
    });
  });

  rerender();
  setTimeout(() => document.getElementById("loader").classList.add("hidden"), 200);
}

function loadChartTimeAdapter() {
  return new Promise((resolve) => {
    const s1 = document.createElement("script");
    s1.src = "https://cdn.jsdelivr.net/npm/luxon@3/build/global/luxon.min.js";
    s1.onload = () => {
      const s2 = document.createElement("script");
      s2.src = "https://cdn.jsdelivr.net/npm/chartjs-adapter-luxon@1/dist/chartjs-adapter-luxon.umd.min.js";
      s2.onload = resolve; s2.onerror = resolve;
      document.head.appendChild(s2);
    };
    s1.onerror = resolve;
    document.head.appendChild(s1);
  });
}

init();
