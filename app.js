import { DEALS, MANDATE, SOURCING_NOTES } from "./data.js";
import * as E from "./engine.js";

/* ---------- helpers ---------- */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pct = (v, d = 1) => (v === null || v === undefined || !isFinite(v) ? "n/a" : `${(v * 100).toFixed(d)}%`);
const m = (v) => (v === null || v === undefined || !isFinite(v) ? "n/a" : `${(v / 1e6).toFixed(2)}m`);
const aed = (v) => `AED ${m(v)}`;
const num = (v, d = 2) => (v === null || v === undefined || !isFinite(v) ? "n/a" : v.toFixed(d));
const cls = (verdict) => (verdict === "PROCEED" ? "proceed" : verdict === "CONDITIONAL" ? "cond" : verdict === "REJECT" ? "reject" : "neutral");

const state = {
  tab: "pipeline",
  deals: structuredClone(DEALS),
  selected: DEALS[0].id,
  mandate: { ...MANDATE },
  stage: 5,
  audit: loadAudit(),
  timer: null,
};

function loadAudit() {
  try { return JSON.parse(localStorage.getItem("dealflow.audit") || "[]"); } catch { return []; }
}
function saveAudit() {
  try { localStorage.setItem("dealflow.audit", JSON.stringify(state.audit.slice(-60))); } catch { /* ignore */ }
}
function log(what, dealName, verdict) {
  state.audit.push({ at: new Date().toISOString(), what, deal: dealName, verdict });
  saveAudit();
}

const TABS = [
  ["pipeline", "Pipeline"],
  ["underwriting", "Underwriting"],
  ["negotiation", "Negotiation"],
  ["structure", "Structure & Legal"],
  ["scenarios", "AGI Scenarios"],
  ["portfolio", "Portfolio"],
  ["brief", "Approvals & Brief"],
];

const dealById = (id) => state.deals.find((d) => d.id === id) || state.deals[0];

/* ---------- charts ---------- */

function bars(items) {
  const rowH = 34, padTop = 10, labelW = 200, chartW = 320;
  const max = Math.max(...items.map((i) => Math.abs(i.value || 0)), 0.0001);
  const h = padTop * 2 + items.length * rowH;
  let out = `<svg viewBox="0 0 620 ${h}" role="img">`;
  items.forEach((it, i) => {
    const y = padTop + i * rowH;
    const w = Math.max(2, (Math.abs(it.value || 0) / max) * chartW);
    out += `<text x="0" y="${y + 17}" fill="#8ba0bf" font-size="11">${esc(it.label)}</text>`;
    out += `<rect x="${labelW}" y="${y + 6}" width="${w}" height="16" rx="4" fill="${it.color || "#5b9cff"}"/>`;
    out += `<text x="${labelW + w + 8}" y="${y + 18}" fill="#e7eef9" font-size="11">${esc(it.text)}</text>`;
  });
  return out + "</svg>";
}

/* ---------- shared bits ---------- */

function mandateBar() {
  return `
    <div class="kv">Client<b>${esc(state.mandate.client)}</b></div>
    <div class="kv">Capital (AED m)
      <input type="number" step="10" min="20" data-edit="capital" value="${(state.mandate.capital / 1e6).toFixed(0)}" />
    </div>
    <div class="kv">Hurdle IRR (%)
      <input type="number" step="0.5" min="1" max="40" data-edit="targetIRR" value="${(state.mandate.targetIRR * 100).toFixed(1)}" />
    </div>
    <div class="kv">Max per asset (%)
      <input type="number" step="5" min="5" max="100" data-edit="maxTicketPct" value="${(state.mandate.maxTicketPct * 100).toFixed(0)}" />
    </div>`;
}

function dealTable(rows) {
  return `<table>
    <thead><tr><th>Asset</th><th>Ask</th><th>Yield on cost</th><th>IRR</th><th>Verdict</th></tr></thead>
    <tbody>
    ${rows.map(({ d, p }) => `
      <tr class="click ${d.id === state.selected ? "sel" : ""}" data-act="select" data-id="${d.id}">
        <td>${esc(d.name)}<br><span class="note">${esc(d.city)}</span></td>
        <td>${m(d.price)}</td>
        <td>${pct(p.underwriting.yieldOnCost)}</td>
        <td>${pct(p.underwriting.irrLevered)}</td>
        <td><span class="chip ${cls(p.verdict)}">${p.verdict}</span></td>
      </tr>`).join("")}
    </tbody></table>`;
}

/* ---------- views ---------- */

function pipelineView() {
  const rows = state.deals.map((d) => ({ d, p: E.runPipeline(d, state.mandate) }));
  const sel = rows.find((r) => r.d.id === state.selected) || rows[0];
  const p = sel.p;
  const agents = [
    {
      a: E.AGENTS[0],
      lines: [p.sourcing.notes, `Sourcing score ${p.sourcing.score}/100`, p.sourcing.verdict],
    },
    {
      a: E.AGENTS[1],
      lines: [
        `NOI ${aed(p.underwriting.noi)} · yield on cost ${pct(p.underwriting.yieldOnCost)}`,
        `Levered IRR base ${pct(p.underwriting.irrLevered)} · P10 ${pct(p.underwriting.mc.p10)} · P90 ${pct(p.underwriting.mc.p90)}`,
        `Equity ${aed(p.underwriting.equity)} · DSCR ${num(p.underwriting.dscr)}x`,
      ],
    },
    {
      a: E.AGENTS[2],
      lines: p.negotiation.feasible
        ? [
          `Open ${aed(p.negotiation.opening)} · walk away ${aed(p.negotiation.walkAway)}`,
          `Ask ${aed(sel.d.price)} vs ceiling ${aed(p.negotiation.maxPrice)} (gap ${pct(p.negotiation.gapPct)})`,
          `${p.negotiation.ladder.length} counter rounds modelled`,
        ]
        : [p.negotiation.note],
    },
    {
      a: E.AGENTS[3],
      lines: p.legal.flags,
    },
    {
      a: E.AGENTS[4],
      lines: [
        `Downside AGI IRR ${pct(p.risk.downside)}`,
        `${pct(p.risk.probBelow, 0)} of simulations miss the hurdle`,
        `Portfolio cap for this ticket ${pct(state.mandate.maxTicketPct, 0)} of capital`,
      ],
    },
  ];

  return `
  <div class="grid g2">
    <section class="card">
      <h2>Deal book</h2>
      <p class="sub">${rows.length} live opportunities · sourcing agent sweeps portals and the broker network daily</p>
      ${dealTable(rows)}
      <ul class="flags">${SOURCING_NOTES.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
    </section>

    <section class="card">
      <h2>${esc(sel.d.name)} <span class="chip ${cls(p.verdict)}">${p.verdict}</span></h2>
      <p class="sub">${esc(sel.d.note)}</p>
      <div class="btns" style="margin-top:0;margin-bottom:14px">
        <button class="act primary" data-act="run">Run the five agents</button>
        <button class="act" data-act="brief" data-id="${sel.d.id}">Build client brief</button>
      </div>
      <div class="grid" style="gap:10px">
        ${agents.map((g, i) => `
          <div class="agent ${i < state.stage ? "" : "pending"}">
            <h3>${esc(g.a.name)} <span class="pill">${i < state.stage ? "done" : "queued"}</span></h3>
            <p class="role">${esc(g.a.role)}</p>
            <ul>${g.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
          </div>`).join("")}
      </div>
      <div class="btns">
        <button class="act ok" data-act="gate" data-id="${sel.d.id}" data-v="approved">Human gate: approve to offer</button>
        <button class="act" data-act="gate" data-id="${sel.d.id}" data-v="hold">Hold</button>
        <button class="act no" data-act="gate" data-id="${sel.d.id}" data-v="rejected">Reject</button>
      </div>
      <p class="note" style="margin-top:8px">No offer leaves the desk without this gate. Agents prepare, a human signs.</p>
    </section>
  </div>`;
}

function underwritingView() {
  const d = dealById(state.selected);
  const uw = E.underwrite(d);
  const mc = E.monteCarlo(d, 1200, 11);
  const sens = [];
  const priceSteps = [-0.1, -0.05, 0, 0.05, 0.1];
  const capSteps = [-0.005, -0.0025, 0, 0.0025, 0.005];

  const fields = [
    ["price", "Asking price (AED m)", (d.price / 1e6).toFixed(1), 1e6],
    ["rentPerUnitYear", "Rent per unit / year (AED)", d.rentPerUnitYear, 1],
    ["occupancy", "Occupancy (%)", (d.occupancy * 100).toFixed(0), 0.01],
    ["opexPct", "Opex (% of gross rent)", (d.opexPct * 100).toFixed(0), 0.01],
    ["rentGrowth", "Rent growth (%)", (d.rentGrowth * 100).toFixed(1), 0.01],
    ["exitCapRate", "Exit cap rate (%)", (d.exitCapRate * 100).toFixed(2), 0.01],
    ["holdYears", "Hold (years)", d.holdYears, 1],
    ["ltv", "LTV (%)", (d.financing.ltv * 100).toFixed(0), 0.01],
    ["rate", "Interest rate (%)", (d.financing.rate * 100).toFixed(2), 0.01],
  ];

  return `
  <div class="grid g2">
    <section class="card">
      <h2>Assumptions — ${esc(d.name)}</h2>
      <p class="sub">Change any input, the model recomputes instantly. Nothing is sent anywhere.</p>
      ${fields.map(([k, label, val, scale]) => `
        <div class="field"><span>${label}</span>
          <input class="num" type="number" step="any" data-edit="deal" data-id="${d.id}" data-k="${k}" data-scale="${scale}" value="${val}" />
        </div>`).join("")}
    </section>

    <section class="card">
      <h2>Underwriting output</h2>
      <p class="sub">Unlevered and levered, with debt service on a ${d.financing.years}-year amortising loan</p>
      <div class="grid g3" style="margin-bottom:12px">
        <div class="stat"><div class="lbl">Levered IRR</div><div class="big">${pct(uw.irrLevered)}</div></div>
        <div class="stat"><div class="lbl">Unlevered IRR</div><div class="big">${pct(uw.irrUnlevered)}</div></div>
        <div class="stat"><div class="lbl">Equity multiple</div><div class="big">${num(uw.equityMultiple)}x</div></div>
      </div>
      <div class="row"><span class="k">Gross rent</span><span class="v">${aed(uw.grossRent)}</span></div>
      <div class="row"><span class="k">Operating expenses</span><span class="v">${aed(uw.opex)}</span></div>
      <div class="row"><span class="k">Net operating income</span><span class="v">${aed(uw.noi)}</span></div>
      <div class="row"><span class="k">Yield on cost</span><span class="v">${pct(uw.yieldOnCost)}</span></div>
      <div class="row"><span class="k">Total cost (incl. ${pct(d.acqCostsPct, 1)} acquisition costs)</span><span class="v">${aed(uw.totalCost)}</span></div>
      <div class="row"><span class="k">Debt / equity</span><span class="v">${m(uw.loan)} / ${m(uw.equity)}</span></div>
      <div class="row"><span class="k">Debt service (year 1)</span><span class="v">${aed(uw.debtService)}</span></div>
      <div class="row"><span class="k">DSCR</span><span class="v">${num(uw.dscr)}x</span></div>
      <div class="row"><span class="k">Cash-on-cash (year 1)</span><span class="v">${pct(uw.cashOnCash)}</span></div>
      <div class="row"><span class="k">Breakeven occupancy</span><span class="v">${pct(uw.breakevenOccupancy)}</span></div>
      <div class="row"><span class="k">Exit value (year ${uw.hold} @ ${pct(uw.exitCap)})</span><span class="v">${aed(uw.exitValue)}</span></div>
      <div class="row"><span class="k">Profit to equity</span><span class="v">${aed(uw.profit)}</span></div>
      <div class="row"><span class="k">Monte Carlo IRR P10 / P50 / P90</span><span class="v">${pct(mc.p10)} / ${pct(mc.p50)} / ${pct(mc.p90)}</span></div>
    </section>
  </div>

  <div class="grid g2" style="margin-top:16px">
    <section class="card">
      <h2>Cash flow — levered</h2>
      <p class="sub">AED millions, exit net of selling costs and loan balance</p>
      <table>
        <thead><tr><th>Year</th><th>NOI</th><th>Debt service</th><th>Equity cash flow</th></tr></thead>
        <tbody>
        ${uw.flows.map((cf, i) => {
    if (i === 0) return `<tr><td>0</td><td>—</td><td>—</td><td>${(cf / 1e6).toFixed(2)}</td></tr>`;
    const noi = uw.noi * Math.pow(1 + uw.rentGrowth, i - 1);
    return `<tr><td>${i}</td><td>${(noi / 1e6).toFixed(2)}</td><td>${(uw.debtService / 1e6).toFixed(2)}</td><td>${(cf / 1e6).toFixed(2)}</td></tr>`;
  }).join("")}
        </tbody>
      </table>
    </section>

    <section class="card">
      <h2>Sensitivity — levered IRR</h2>
      <p class="sub">Rows: price change. Columns: exit cap change (bps)</p>
      <table>
        <thead><tr><th>Price</th>${capSteps.map((c) => `<th>${(c * 10000).toFixed(0)}bp</th>`).join("")}</tr></thead>
        <tbody>
        ${priceSteps.map((ps) => `<tr>
          <td>${(ps * 100).toFixed(0)}%</td>
          ${capSteps.map((cs) => {
    const r = E.underwrite({ ...d, price: d.price * (1 + ps) }, { exitCapDelta: cs }).irrLevered;
    return `<td>${pct(r)}</td>`;
  }).join("")}
        </tr>`).join("")}
        </tbody>
      </table>
      <p class="note" style="margin-top:10px">The agent reports the whole grid, not one number — a deal that only works at the base case is not a deal.</p>
    </section>
  </div>`;
}

function negotiationView() {
  const d = dealById(state.selected);
  const plan = E.negotiationPlan(d, state.mandate.targetIRR);
  if (!plan.feasible) {
    return `<section class="card"><h2>Negotiation — ${esc(d.name)}</h2><p class="sub">${esc(plan.note)}</p></section>`;
  }
  return `
  <div class="grid g2">
    <section class="card">
      <h2>Offer ladder — ${esc(d.name)}</h2>
      <p class="sub">Built backwards from the price that clears a ${pct(state.mandate.targetIRR)} levered IRR</p>
      <div class="grid g3" style="margin-bottom:14px">
        <div class="stat"><div class="lbl">Ceiling price</div><div class="big">${m(plan.maxPrice)}</div></div>
        <div class="stat"><div class="lbl">Opening offer</div><div class="big">${m(plan.opening)}</div></div>
        <div class="stat"><div class="lbl">Walk-away</div><div class="big">${m(plan.walkAway)}</div></div>
      </div>
      <table>
        <thead><tr><th>Round</th><th>Price (AED m)</th><th>IRR at that price</th><th>Logic</th></tr></thead>
        <tbody>
        ${plan.ladder.map((s) => `<tr><td>${s.round}</td><td>${(s.price / 1e6).toFixed(2)}</td><td>${pct(s.irr)}</td><td style="text-align:left;color:#8ba0bf">${esc(s.concession)}</td></tr>`).join("")}
        </tbody>
      </table>
      <ul class="flags">${plan.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
    </section>

    <section class="card">
      <h2>Terms the agent trades on</h2>
      <p class="sub">Price is only one lever. These are the concessions the desk will ask for before it moves on price.</p>
      <ul class="flags">${plan.terms.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
      <h2 style="margin-top:18px">What the agent will not do</h2>
      <ul class="flags">
        <li>Bid above the walk-away price without a human approval on record.</li>
        <li>Waive the escrow or the title check to win a round.</li>
        <li>Promise the seller a timeline it cannot control.</li>
        <li>Sign anything — the SPA is signed by a human, always.</li>
      </ul>
    </section>
  </div>`;
}

function structureView() {
  const d = dealById(state.selected);
  const stack = E.structureStack(d);
  const opts = E.structureOptions(d);
  return `
  <div class="grid g2">
    <section class="card">
      <h2>Acquisition cost stack — ${esc(d.name)}</h2>
      <p class="sub">Dubai cost conventions, treated as assumptions to verify with counsel</p>
      <table>
        <thead><tr><th>Line</th><th>AED</th></tr></thead>
        <tbody>${stack.lines.map((l) => `<tr><td>${esc(l.label)}</td><td>${(l.value / 1e6).toFixed(3)}m</td></tr>`).join("")}
          <tr><td><b>Total</b></td><td><b>${(stack.total / 1e6).toFixed(3)}m</b></td></tr>
        </tbody>
      </table>
      <p class="note" style="margin-top:10px">${(stack.pctOfPrice * 100).toFixed(2)}% of the purchase price, before any fit-out.</p>
      <h2 style="margin-top:18px">Entity options</h2>
      <div class="grid" style="gap:10px">
        ${opts.map((o) => `<div class="agent">
          <h3>${esc(o.name)} <span class="pill">${esc(o.fit)}</span></h3>
          <p class="role">${esc(o.why)}</p>
          <ul><li>${esc(o.watch)}</li></ul>
        </div>`).join("")}
      </div>
    </section>

    <section class="card">
      <h2>Legal checklist the agent runs</h2>
      <p class="sub">Every line is a kill-switch. Any red flag stops the deal before money moves.</p>
      <ul class="flags">${E.LEGAL_CHECKLIST.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
      <p class="note" style="margin-top:14px">This is a prototype checklist, not legal advice. A licensed UAE lawyer signs off before any deposit.</p>
    </section>
  </div>`;
}

function scenarioView() {
  const table = E.scenarioTable(state.deals);
  const d = dealById(state.selected);
  const mc = E.monteCarlo(d, 1500, 7);
  const scen = E.AGI_SCENARIOS.map((s) => ({
    label: s.name,
    value: E.underwrite(d, E.scenarioParams(s, d)).irrLevered || 0,
    text: pct(E.underwrite(d, E.scenarioParams(s, d)).irrLevered),
    color: s.id === "boom" ? "#35c48b" : s.id === "base" ? "#5b9cff" : s.id === "displacement" ? "#f0b429" : "#ef5f5f",
  }));
  return `
  <section class="card">
    <h2>AGI scenario matrix — levered IRR by asset</h2>
    <p class="sub">Same cash flows, four different worlds. This is what "AGI-ready" means: the book is tested against the world changing, not just against the market.</p>
    <table>
      <thead><tr><th>Asset</th><th>Ask</th>${E.AGI_SCENARIOS.map((s) => `<th>${esc(s.name.split(" — ")[0])}</th>`).join("")}<th>Downside</th></tr></thead>
      <tbody>
      ${table.map((row) => {
    const worst = Math.min(...row.rows.map((r) => r.irr ?? -1));
    return `<tr class="click ${row.deal.id === state.selected ? "sel" : ""}" data-act="select" data-id="${row.deal.id}">
          <td>${esc(row.deal.name)}</td><td>${m(row.deal.price)}</td>
          ${row.rows.map((r) => `<td>${pct(r.irr)}</td>`).join("")}
          <td><span class="chip ${worst > 0.08 ? "proceed" : worst > 0 ? "cond" : "reject"}">${pct(worst)}</span></td>
        </tr>`;
  }).join("")}
      </tbody>
    </table>
  </section>

  <div class="grid g2" style="margin-top:16px">
    <section class="card">
      <h2>${esc(d.name)} — IRR by scenario</h2>
      <p class="sub">The four scenario theses are in the engine, each one moves rents, exit caps, vacancy and hold period</p>
      ${bars(scen)}
      <div class="legend">
        <span><i style="background:#35c48b"></i>upside</span>
        <span><i style="background:#5b9cff"></i>base</span>
        <span><i style="background:#f0b429"></i>displacement</span>
        <span><i style="background:#ef5f5f"></i>liquidity shock</span>
      </div>
    </section>

    <section class="card">
      <h2>Monte Carlo — 1,500 simulations</h2>
      <p class="sub">Rent growth, exit cap and occupancy drawn around the base case</p>
      <div class="grid g3">
        <div class="stat"><div class="lbl">P10 (bad)</div><div class="big">${pct(mc.p10)}</div></div>
        <div class="stat"><div class="lbl">P50</div><div class="big">${pct(mc.p50)}</div></div>
        <div class="stat"><div class="lbl">P90 (good)</div><div class="big">${pct(mc.p90)}</div></div>
      </div>
      <div class="row"><span class="k">Mean IRR</span><span class="v">${pct(mc.mean)}</span></div>
      <div class="row"><span class="k">Standard deviation</span><span class="v">${pct(mc.sd)}</span></div>
      <div class="row"><span class="k">Probability of missing the ${pct(state.mandate.targetIRR)} hurdle</span><span class="v">${pct(E.probBelow(mc, state.mandate.targetIRR), 0)}</span></div>
      <p class="note" style="margin-top:10px">Seeded random numbers, so the same deal always produces the same distribution — results are reproducible, not decorative.</p>
    </section>
  </div>

  <section class="card" style="margin-top:16px">
    <h2>What the scenarios actually assume</h2>
    <div class="grid g3" style="margin-top:12px">
      ${E.AGI_SCENARIOS.map((s) => `<div class="agent"><h3>${esc(s.name)}</h3><p class="role">${esc(s.tagline)}</p><ul><li>${esc(s.thesis)}</li></ul></div>`).join("")}
    </div>
  </section>`;
}

function portfolioView() {
  const res = E.optimisePortfolio(state.deals, state.mandate.capital, {
    targetIRR: state.mandate.targetIRR,
    maxAssetPct: state.mandate.maxTicketPct,
    maxCashPct: state.mandate.minCashPct,
  });
  const scenBars = res.scenarios.map((s) => ({
    label: s.name,
    value: s.irr,
    text: pct(s.irr),
    color: s.irr >= state.mandate.targetIRR ? "#35c48b" : s.irr > 0 ? "#f0b429" : "#ef5f5f",
  }));
  const ranked = [...res.analyses].sort((a, b) => b.score - a.score);
  return `
  <div class="grid g2">
    <section class="card">
      <h2>Proposed allocation</h2>
      <p class="sub">Capital ${aed(res.capital)} · risk-adjusted ranking · max ${pct(state.mandate.maxTicketPct, 0)} per asset · ${pct(state.mandate.minCashPct, 0)} dry powder</p>
      <table>
        <thead><tr><th>Asset</th><th>Allocation</th><th>Weight</th><th>Expected IRR</th><th>Downside</th></tr></thead>
        <tbody>
        ${res.allocations.map((a) => `<tr>
          <td>${esc(a.name)}<br><span class="note">${esc(a.city)}${a.partial ? " · partial ticket" : ""}</span></td>
          <td>${m(a.amount)}</td><td>${pct(a.weight, 1)}</td>
          <td>${pct(a.expectedIRR)}</td><td>${pct(a.downside)}</td>
        </tr>`).join("")}
          <tr><td><b>Cash held back</b></td><td>${m(res.cash)}</td><td>${pct(res.cash / res.capital, 1)}</td><td>—</td><td>—</td></tr>
        </tbody>
      </table>
      <div class="grid g3" style="margin-top:14px">
        <div class="stat"><div class="lbl">Expected IRR (deployed)</div><div class="big">${pct(res.expectedIRR)}</div></div>
        <div class="stat"><div class="lbl">Portfolio volatility</div><div class="big">${pct(res.sd)}</div></div>
        <div class="stat"><div class="lbl">Capital deployed</div><div class="big">${pct(res.investedPct, 0)}</div></div>
      </div>
      <div class="row" style="margin-top:8px"><span class="k">Expected IRR on the whole cheque, cash drag included</span><span class="v">${pct(res.expectedIRROnCapital)}</span></div>
      <div class="row"><span class="k">Hurdle the client set</span><span class="v">${pct(state.mandate.targetIRR)}</span></div>
    </section>

    <section class="card">
      <h2>How the book performs if the world changes</h2>
      <p class="sub">Portfolio-level IRR under each AGI scenario — the number a family office should be shown before it commits</p>
      ${bars(scenBars)}
      <p class="note" style="margin-top:10px">Diversification is enforced, not assumed: no single asset may take more than ${pct(state.mandate.maxTicketPct, 0)} of capital, and ${pct(state.mandate.minCashPct, 0)} stays liquid.</p>
    </section>
  </div>

  <section class="card" style="margin-top:16px">
    <h2>Agent ranking — why each asset got the size it got</h2>
    <p class="sub">Score = expected IRR − 0.6 × volatility + 0.25 × worst AGI scenario</p>
    <table>
      <thead><tr><th>Asset</th><th>Base IRR</th><th>Expected IRR</th><th>Volatility</th><th>Worst scenario</th><th>Score</th><th>Equity needed</th></tr></thead>
      <tbody>
      ${ranked.map((a) => `<tr class="click ${a.deal.id === state.selected ? "sel" : ""}" data-act="select" data-id="${a.deal.id}">
        <td>${esc(a.deal.name)}</td><td>${pct(a.base.irrLevered)}</td><td>${pct(a.mc.mean)}</td>
        <td>${pct(a.mc.sd)}</td><td>${pct(a.downside)}</td><td>${num(a.score * 100, 1)}</td><td>${m(a.requiredEquity)}</td>
      </tr>`).join("")}
      </tbody>
    </table>
  </section>`;
}

function briefView() {
  const d = dealById(state.selected);
  const p = E.runPipeline(d, state.mandate);
  const brief = E.meetingBrief(d, p, state.mandate.targetIRR);
  return `
  <div class="grid g2">
    <section class="card">
      <h2>Client meeting brief — the human handoff</h2>
      <p class="sub">The agents stop here. This is the page a human takes into the room.</p>
      <textarea id="briefBox" spellcheck="false">${esc(brief)}</textarea>
      <div class="btns">
        <button class="act primary" data-act="copy">Copy brief</button>
        <button class="act" data-act="download" data-id="${d.id}">Download .txt</button>
        <button class="act" data-act="gate" data-id="${d.id}" data-v="meeting-scheduled">Mark meeting scheduled</button>
      </div>
    </section>

    <section class="card">
      <h2>Approval log</h2>
      <p class="sub">Every gate a human has touched, newest first. Stored in this browser only.</p>
      ${state.audit.length ? `<div class="audit">${[...state.audit].reverse().map((a) => `
        <div class="line"><span class="t">${esc(new Date(a.at).toLocaleString())}</span><br>
        <b>${esc(a.deal)}</b> — ${esc(a.what)} <span class="chip ${a.verdict === "approved" ? "proceed" : a.verdict === "rejected" ? "reject" : "cond"}">${esc(a.verdict)}</span></div>`).join("")}</div>`
      : `<p class="note">No approvals yet. Use the gate buttons on the Pipeline tab.</p>`}
      <div class="btns">
        <button class="act" data-act="clearAudit">Clear log</button>
      </div>

      <h2 style="margin-top:20px">Where the humans sit in this system</h2>
      <ul class="flags">
        <li>Mandate: the client sets capital, hurdle and hold. Agents never move these.</li>
        <li>Offer: any price above the walk-away needs a signed approval.</li>
        <li>Meeting: a human goes to every client meeting. The agent prepares, it does not attend.</li>
        <li>SPA: signing is human, always — no agent holds a signature authority.</li>
      </ul>
    </section>
  </div>`;
}

/* ---------- render ---------- */

function render() {
  document.getElementById("mandateBar").innerHTML = mandateBar();
  document.getElementById("tabs").innerHTML = TABS.map(([id, label]) => `<button class="${state.tab === id ? "on" : ""}" data-act="tab" data-tab="${id}">${label}</button>`).join("");
  const views = {
    pipeline: pipelineView, underwriting: underwritingView, negotiation: negotiationView,
    structure: structureView, scenarios: scenarioView, portfolio: portfolioView, brief: briefView,
  };
  document.getElementById("view").innerHTML = views[state.tab]();
}

/* ---------- events ---------- */

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;

  if (act === "tab") { state.tab = t.dataset.tab; render(); return; }

  if (act === "select") {
    state.selected = t.dataset.id;
    state.stage = 5;
    render(); return;
  }

  if (act === "run") {
    state.stage = 0;
    render();
    clearInterval(state.timer);
    state.timer = setInterval(() => {
      state.stage += 1;
      render();
      if (state.stage >= 5) { clearInterval(state.timer); state.timer = null; }
    }, 260);
    return;
  }

  if (act === "gate") {
    const d = dealById(t.dataset.id);
    log(`human gate: ${t.dataset.v}`, d.name, t.dataset.v);
    state.tab = "brief";
    render(); return;
  }

  if (act === "brief") {
    state.selected = t.dataset.id;
    state.tab = "brief";
    render(); return;
  }

  if (act === "copy") {
    const box = document.getElementById("briefBox");
    box.select();
    navigator.clipboard?.writeText(box.value).then(
      () => { t.textContent = "Copied"; setTimeout(() => { t.textContent = "Copy brief"; }, 1500); },
      () => { document.execCommand("copy"); },
    );
    return;
  }

  if (act === "download") {
    const d = dealById(t.dataset.id);
    const p = E.runPipeline(d, state.mandate);
    const blob = new Blob([E.meetingBrief(d, p, state.mandate.targetIRR)], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `brief-${d.id}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    return;
  }

  if (act === "clearAudit") {
    state.audit = []; saveAudit(); render(); return;
  }
});

document.addEventListener("change", (e) => {
  const t = e.target.closest("[data-edit]");
  if (!t) return;
  const kind = t.dataset.edit;
  const val = Number(t.value);

  if (kind === "capital") { state.mandate.capital = Math.max(20e6, val * 1e6); render(); return; }
  if (kind === "targetIRR") { state.mandate.targetIRR = Math.min(0.4, Math.max(0.01, val / 100)); render(); return; }
  if (kind === "maxTicketPct") { state.mandate.maxTicketPct = Math.min(1, Math.max(0.05, val / 100)); render(); return; }

  if (kind === "deal") {
    const d = dealById(t.dataset.id);
    const k = t.dataset.k;
    const scale = Number(t.dataset.scale) || 1;
    const v = val * scale;
    if (k === "ltv") d.financing.ltv = Math.min(0.85, Math.max(0, v));
    else if (k === "rate") d.financing.rate = Math.max(0, v);
    else if (k === "holdYears") d.holdYears = Math.max(1, Math.round(v));
    else d[k] = v;
    render();
  }
});

render();
