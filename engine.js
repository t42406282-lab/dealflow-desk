/* DealFlow engine — pure functions, no DOM, no dependencies.
   Works in the browser and in node (test_engine.mjs).
   All money in AED unless stated. Rates are decimals (0.06 = 6%). */

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------- basic finance ---------- */

export function npv(rate, cfs) {
  return cfs.reduce((s, cf, i) => s + cf / Math.pow(1 + rate, i), 0);
}

export function irr(cfs, lo = -0.95, hi = 5) {
  let flo = npv(lo, cfs), fhi = npv(hi, cfs);
  if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid, cfs);
    if (Math.abs(fm) < 1e-6) return mid;
    if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

export function annualDebtService(loan, rate, years) {
  if (loan <= 0) return 0;
  if (rate === 0) return loan / years;
  return (loan * rate) / (1 - Math.pow(1 + rate, -years));
}

export function loanBalance(loan, rate, years, paid) {
  if (loan <= 0) return 0;
  const pmt = annualDebtService(loan, rate, years);
  if (rate === 0) return Math.max(0, loan - pmt * paid);
  const bal = loan * Math.pow(1 + rate, paid) - pmt * ((Math.pow(1 + rate, paid) - 1) / rate);
  return Math.max(0, bal);
}

/* ---------- underwriting ---------- */

export function underwrite(deal, sc = {}) {
  const g = (deal.rentGrowth || 0) + (sc.rentGrowthDelta || 0);
  const occ = clamp(deal.occupancy + (sc.vacancyDelta || 0), 0.2, 0.99);
  const exitCap = Math.max(0.02, deal.exitCapRate + (sc.exitCapDelta || 0));
  const hold = Math.max(1, Math.round(deal.holdYears + (sc.holdDelta || 0)));

  const grossRent = deal.units * deal.rentPerUnitYear * occ;
  const opex = grossRent * deal.opexPct;
  const noi = grossRent - opex;

  const acqCosts = deal.price * deal.acqCostsPct;
  const capex = deal.units * deal.capexPerUnit;
  const totalCost = deal.price + acqCosts + capex;

  const loan = totalCost * deal.financing.ltv;
  const equity = totalCost - loan;
  const ds = annualDebtService(loan, deal.financing.rate, deal.financing.years);

  const levered = [-equity];
  const unlevered = [-totalCost];
  let exitValue = 0, exitProceeds = 0, cumCF = 0;

  for (let y = 1; y <= hold; y++) {
    const noiY = noi * Math.pow(1 + g, y - 1);
    let cf = noiY - ds;
    let ucf = noiY;
    if (y === hold) {
      exitValue = (noiY * (1 + g)) / exitCap;
      const sellingCosts = exitValue * deal.sellCostsPct;
      const bal = loanBalance(loan, deal.financing.rate, deal.financing.years, y);
      exitProceeds = exitValue - sellingCosts - bal;
      cf += exitProceeds;
      ucf += exitValue - sellingCosts;
    }
    cumCF += cf;
    levered.push(cf);
    unlevered.push(ucf);
  }

  const irrL = irr(levered);
  const irrU = irr(unlevered);
  const profit = cumCF - equity;
  const equityMultiple = equity > 0 ? (cumCF + equity) / equity : null;
  const y1cf = levered[1];
  const breakevenOcc = grossRent > 0
    ? clamp((noi ? (grossRent - noi) : 0) + ds, 0, 1e12) / (deal.units * deal.rentPerUnitYear)
    : null;

  return {
    hold, occupancy: occ, rentGrowth: g, exitCap,
    grossRent, opex, noi, acqCosts, capex, totalCost, loan, equity, debtService: ds,
    yieldOnCost: noi / totalCost,
    dscr: ds > 0 ? noi / ds : null,
    cashOnCash: equity > 0 ? y1cf / equity : null,
    breakevenOccupancy: breakevenOcc,
    exitValue, exitProceeds, profit, equityMultiple,
    irrLevered: irrL, irrUnlevered: irrU,
    flows: levered, flowsUnlevered: unlevered,
  };
}

/* ---------- seeded random + Monte Carlo ---------- */

export function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function gauss(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function monteCarlo(deal, n = 2000, seed = 7) {
  const rand = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const sc = {
      rentGrowthDelta: gauss(rand) * 0.015,
      exitCapDelta: gauss(rand) * 0.004,
      vacancyDelta: gauss(rand) * 0.05,
    };
    const m = underwrite(deal, sc);
    if (m.irrLevered !== null) out.push(m.irrLevered);
  }
  out.sort((a, b) => a - b);
  const q = (p) => out.length ? out[Math.min(out.length - 1, Math.floor(p * out.length))] : null;
  const mean = out.reduce((a, b) => a + b, 0) / (out.length || 1);
  const sd = Math.sqrt(out.reduce((a, b) => a + (b - mean) ** 2, 0) / (out.length || 1));
  return { n: out.length, p10: q(0.1), p50: q(0.5), p90: q(0.9), mean, sd, samples: out };
}

export function probBelow(mc, target) {
  if (!mc || !mc.samples || !mc.samples.length) return null;
  return mc.samples.filter((x) => x < target).length / mc.samples.length;
}

/* ---------- AGI scenarios ---------- */

export const AGI_SCENARIOS = [
  {
    id: "base",
    name: "Base — AGI delayed",
    tagline: "2029+, gradual automation",
    thesis: "Agentic AI keeps improving but no step change in 24 months. Dubai rents grow with population and visa inflow; cap rates stay where they are.",
    params: {},
    portfolio: { rentGrowthDelta: 0, exitCapDelta: 0, vacancyDelta: 0, holdDelta: 0 },
  },
  {
    id: "boom",
    name: "AGI boom — capital flood",
    tagline: "2027 step change",
    thesis: "AGI lands early, global productivity jumps, capital chases hard assets. Prime Dubai yields compress and rents re-rate upward; exit is faster.",
    params: { rentGrowthDelta: 0.02, exitCapDelta: -0.0075, vacancyDelta: -0.01 },
    portfolio: { rentGrowthDelta: 0.02, exitCapDelta: -0.0075, vacancyDelta: -0.01, holdDelta: 0 },
  },
  {
    id: "displacement",
    name: "AGI displacement — space demand shock",
    tagline: "office & retail repriced",
    thesis: "AI removes back-office headcount; office and retail tenants shrink. Residential stays firm, commercial cap rates widen sharply and vacancies rise.",
    params: { rentGrowthDelta: -0.03, exitCapDelta: 0.0125, vacancyDelta: 0.07 },
    commercialOnly: { rentGrowthDelta: -0.045, exitCapDelta: 0.0175, vacancyDelta: 0.11 },
    portfolio: { rentGrowthDelta: -0.02, exitCapDelta: 0.009, vacancyDelta: 0.05, holdDelta: 0 },
  },
  {
    id: "liquidity",
    name: "AGI shock — liquidity winter",
    tagline: "exit market freezes",
    thesis: "Risk appetite collapses for 18 months. Nothing breaks fundamentally but you cannot sell on schedule; holds extend and exit caps widen.",
    params: { rentGrowthDelta: -0.01, exitCapDelta: 0.0075, vacancyDelta: 0.03, holdDelta: 2 },
    portfolio: { rentGrowthDelta: -0.01, exitCapDelta: 0.0075, vacancyDelta: 0.03, holdDelta: 2 },
  },
];

export function scenarioParams(sc, deal) {
  if (sc.commercialOnly && deal.asset !== "Residential") return sc.commercialOnly;
  return sc.params || {};
}

export function scenarioTable(deals) {
  return deals.map((d) => {
    const base = underwrite(d);
    const rows = AGI_SCENARIOS.map((s) => ({
      id: s.id, name: s.name,
      irr: underwrite(d, scenarioParams(s, d)).irrLevered,
    }));
    return { deal: d, base, rows };
  });
}

/* ---------- negotiation ---------- */

function priceForIRR(deal, targetIRR) {
  const f = (p) => {
    const m = underwrite({ ...deal, price: p });
    return m.irrLevered === null ? -1 : m.irrLevered - targetIRR;
  };
  let lo = deal.price * 0.4, hi = deal.price * 1.6;
  let flo = f(lo), fhi = f(hi);
  if (flo * fhi > 0) return null;
  for (let i = 0; i < 120; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

export function negotiationPlan(deal, targetIRR = 0.12, opts = {}) {
  const maxPrice = priceForIRR(deal, targetIRR);
  if (maxPrice === null) {
    return { feasible: false, targetIRR, note: "No price solves to this target — the deal cannot clear the hurdle even at a deep discount." };
  }
  const openPctBelow = opts.openPctBelow ?? 0.07;
  const opening = maxPrice * (1 - openPctBelow);
  const walkAway = maxPrice * 1.015;
  const ladder = [];
  const steps = 5;
  for (let i = 0; i < steps; i++) {
    const p = opening + ((walkAway - opening) * i) / (steps - 1);
    const m = underwrite({ ...deal, price: p });
    ladder.push({
      round: i + 1,
      price: p,
      irr: m.irrLevered,
      concession: i === 0 ? "Opening — below reserve, signals price discipline"
        : i === steps - 1 ? "Final — at walk-away, only with seller concessions"
        : "Counter — price up only against a term we gain",
    });
  }
  const gap = (deal.price - maxPrice) / deal.price;
  const flags = [];
  if (gap > 0) flags.push(`Asking price is ${(gap * 100).toFixed(1)}% above the price that clears a ${(targetIRR * 100).toFixed(1)}% IRR. Do not chase it.`);
  else flags.push(`Asking price already clears the ${(targetIRR * 100).toFixed(1)}% hurdle — protect terms, not price.`);
  const base = underwrite(deal);
  if (base.dscr !== null && base.dscr < 1.2) flags.push(`DSCR ${base.dscr.toFixed(2)}x is thin; lenders will price this higher or cut leverage.`);
  if (base.occupancy < 0.85) flags.push(`Occupancy assumption ${(base.occupancy * 100).toFixed(0)}% needs rent roll verification before offer.`);
  return {
    feasible: true, targetIRR, askingPrice: deal.price, maxPrice, walkAway, opening, ladder, flags,
    terms: [
      "45-day due diligence, 15-day extension against a fee",
      "Seller to fund its share of transfer costs; buyer caps agency at 2%",
      "Deposit in escrow with a trustee, released only on title transfer",
      "Price adjustment if verified rent roll differs by more than 5%",
      "Vacant possession of unsold units at completion",
    ],
    gapPct: gap,
  };
}

/* ---------- Dubai structure / legal checklist ---------- */

export const DUBAI_COSTS = {
  dldTransfer: 0.04,     // Dubai Land Department transfer fee, usually buyer
  agency: 0.02,          // broker commission, typical
  trustee: 4200,         // trustee office fee, AED, indicative
  mortgageRegistration: 0.0025,
  bankArrangement: 0.01,
  noc: 500,
};

export function structureStack(deal) {
  const dld = deal.price * DUBAI_COSTS.dldTransfer;
  const agency = deal.price * DUBAI_COSTS.agency;
  const mortgage = deal.price * deal.financing.ltv * DUBAI_COSTS.mortgageRegistration;
  const arrangement = deal.price * deal.financing.ltv * DUBAI_COSTS.bankArrangement;
  const total = dld + agency + DUBAI_COSTS.trustee + mortgage + arrangement + DUBAI_COSTS.noc;
  return {
    lines: [
      { label: "DLD transfer fee (4%)", value: dld },
      { label: "Agency commission (2%)", value: agency },
      { label: "Trustee office fee", value: DUBAI_COSTS.trustee },
      { label: "Mortgage registration (0.25% of loan)", value: mortgage },
      { label: "Bank arrangement fee (1% of loan)", value: arrangement },
      { label: "NOC / admin", value: DUBAI_COSTS.noc },
    ],
    total,
    pctOfPrice: total / deal.price,
  };
}

export function structureOptions(deal) {
  const opts = [
    {
      name: "DIFC / ADGM SPV (holding)",
      fit: deal.price > 50e6 ? "Recommended" : "Consider",
      why: "Common-law courts, familiar to family offices and lenders, clean asset ring-fencing per deal.",
      watch: "Setup and audit cost; economic substance rules; transfer of shares (not property) on exit avoids a second 4% DLD charge.",
    },
    {
      name: "Mainland LLC",
      fit: deal.asset === "Residential" ? "Workable" : "Consider",
      why: "Simplest for direct title, local banking and property management.",
      watch: "51% local partner questions for some activities; exit by share transfer is messier.",
    },
    {
      name: "Freehold zone title in personal / family name",
      fit: "Only for small tickets",
      why: "Cheapest, fastest, no entity upkeep.",
      watch: "No ring-fencing, inheritance exposure, weak for multi-investor family office structures.",
    },
  ];
  return opts;
}

export const LEGAL_CHECKLIST = [
  "Verify freehold / leasehold status and the master developer's NOC",
  "Title deed and Oqood check with DLD; confirm no encumbrance or mortgage",
  "Service charge history for 3 years — arrears transfer with the asset",
  "Rent roll vs Ejari registrations (the only enforceable tenancy record)",
  "Off-plan only: confirm escrow account under Law 8/2007 and RERA registration",
  "Corporate tax position — 9% on business profits, check the real-estate exemption tests",
  "VAT: no VAT on sale of property; 5% VAT on commercial rent",
  "Mortgage pre-approval before any offer, and rate-fix tenor vs hold period",
  "Exit route: share sale vs asset sale, and who pays the second DLD fee",
  "Sanctions / KYC on the seller and the source of funds for the SPV",
];

/* ---------- portfolio ---------- */

export function analyseDeal(deal, targetIRR = 0.12) {
  const base = underwrite(deal);
  const mc = monteCarlo(deal, 1500, hashSeed(deal.id));
  const scen = AGI_SCENARIOS.map((s) => ({
    id: s.id, name: s.name, irr: underwrite(deal, scenarioParams(s, deal)).irrLevered,
  }));
  const downside = Math.min(...scen.map((s) => s.irr ?? -1));
  const score = (mc.mean ?? 0) - 0.6 * (mc.sd ?? 0) + 0.25 * downside;
  return {
    deal, base, mc, scenarios: scen, downside, score,
    requiredEquity: base.equity,
    belowTarget: probBelow(mc, targetIRR),
  };
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100000;
}

export function optimisePortfolio(deals, capital, opts = {}) {
  const maxAssetPct = opts.maxAssetPct ?? 0.35;
  const maxCashPct = opts.maxCashPct ?? 0.15;
  const analyses = deals.map((d) => analyseDeal(d, opts.targetIRR ?? 0.12));
  const ranked = [...analyses].sort((a, b) => b.score - a.score);

  let remaining = capital * (1 - maxCashPct);
  const allocations = [];
  for (const a of ranked) {
    if (remaining <= 0) break;
    const cap = capital * maxAssetPct;
    const amount = Math.min(a.requiredEquity, cap, remaining);
    if (amount < capital * 0.02) continue;
    allocations.push({
      id: a.deal.id, name: a.deal.name, city: a.deal.city, asset: a.deal.asset,
      amount, weight: amount / capital,
      expectedIRR: a.mc.mean, sd: a.mc.sd, downside: a.downside,
      scenarios: a.scenarios, baseIRR: a.base.irrLevered,
      partial: amount < a.requiredEquity * 0.999,
    });
    remaining -= amount;
  }
  const invested = allocations.reduce((s, x) => s + x.amount, 0);
  const cash = capital - invested;
  const investedPct = capital > 0 ? invested / capital : 0;
  // weights normalised on deployed capital, so cash does not masquerade as a zero-return asset
  const w = allocations.map((x) => (invested > 0 ? x.amount / invested : 0));
  const expectedIRR = allocations.reduce((s, x, i) => s + w[i] * (x.expectedIRR ?? 0), 0);
  const varP = allocations.reduce((s, x, i) => s + (w[i] ** 2) * ((x.sd ?? 0) ** 2), 0)
    + 2 * 0.5 * allocations.reduce((s, x, i) => s
      + allocations.reduce((t, y, j) => (i < j ? t + w[i] * w[j] * (x.sd ?? 0) * (y.sd ?? 0) : t), 0), 0);
  const scenarioIRR = AGI_SCENARIOS.map((s) => ({
    id: s.id, name: s.name,
    irr: allocations.reduce((t, x, i) => t + w[i] * ((x.scenarios.find((y) => y.id === s.id)?.irr) ?? 0), 0),
  }));
  return {
    capital, allocations, cash, invested, investedPct,
    expectedIRR, sd: Math.sqrt(varP),
    // same numbers but measured on the whole cheque, with the cash drag included
    expectedIRROnCapital: expectedIRR * investedPct,
    scenariosOnCapital: scenarioIRR.map((s) => ({ ...s, irr: s.irr * investedPct })),
    scenarios: scenarioIRR,
    analyses,
  };
}

/* ---------- the five agents ---------- */

export const AGENTS = [
  { id: "sourcing", name: "Deal Sourcing", role: "Find off-market supply, score it against the mandate, reject fast." },
  { id: "underwriting", name: "Underwriting & Valuation", role: "Model the cash flows, value against comps, set the price ceiling." },
  { id: "negotiation", name: "Negotiation", role: "Build the offer ladder, trade terms, know when to walk." },
  { id: "legal", name: "Legal & Structure", role: "Entity, fees, escrow, title, tax — flag what kills the deal." },
  { id: "risk", name: "Risk & Portfolio", role: "Size the position, stress the scenarios, protect the whole book." },
];

export function runPipeline(deal, mandate = { targetIRR: 0.12, maxTicketPct: 0.35 }) {
  const uw = underwrite(deal);
  const mc = monteCarlo(deal, 1200, hashSeed(deal.id));
  const neg = negotiationPlan(deal, mandate.targetIRR);
  const stack = structureStack(deal);
  const scen = AGI_SCENARIOS.map((s) => ({
    name: s.name, irr: underwrite(deal, scenarioParams(s, deal)).irrLevered,
  }));
  const downside = Math.min(...scen.map((s) => s.irr ?? -1));
  const dscrOk = uw.dscr === null || uw.dscr >= 1.2;
  const priceOk = neg.feasible && neg.gapPct <= 0.05;
  const verdict = !neg.feasible ? "REJECT"
    : priceOk && dscrOk && downside > 0 ? "PROCEED"
      : priceOk || dscrOk ? "CONDITIONAL" : "REJECT";

  return {
    dealId: deal.id,
    sourcing: {
      verdict: deal.offMarket ? "Off-market, sourced from broker network" : "Listed on portal",
      score: Math.round(clamp(60 + (uw.yieldOnCost * 400) + (deal.offMarket ? 8 : 0), 0, 99)),
      notes: `${deal.asset} in ${deal.city}, ${deal.units} units, ask AED ${(deal.price / 1e6).toFixed(1)}m.`,
    },
    underwriting: {
      noi: uw.noi, yieldOnCost: uw.yieldOnCost, irrLevered: uw.irrLevered,
      equity: uw.equity, dscr: uw.dscr, exitValue: uw.exitValue,
      mc, notes: `Base IRR ${pct(uw.irrLevered)}, P10 ${pct(mc.p10)}, P90 ${pct(mc.p90)}.`,
    },
    negotiation: neg,
    legal: {
      stack, flags: [
        `Acquisition costs add ${(stack.pctOfPrice * 100).toFixed(2)}% to the ticket (AED ${(stack.total / 1e6).toFixed(2)}m).`,
        deal.asset !== "Residential" ? "Commercial: 5% VAT on rent, check the tenant's registration." : "Residential: service charge arrears travel with the asset.",
        "Confirm freehold status and developer NOC before deposit.",
      ],
    },
    risk: {
      scen, downside, probBelow: probBelow(mc, mandate.targetIRR),
      notes: `Worst AGI scenario IRR ${pct(downside)}; ${(probBelow(mc, mandate.targetIRR) * 100).toFixed(0)}% of simulations miss the ${pct(mandate.targetIRR)} hurdle.`,
    },
    verdict,
  };
}

export const pct = (v) => (v === null || v === undefined || !isFinite(v) ? "n/a" : `${(v * 100).toFixed(1)}%`);
export const money = (v) => (v === null || v === undefined ? "n/a" : `AED ${(v / 1e6).toFixed(2)}m`);

export function meetingBrief(deal, pipeline, targetIRR) {
  const uw = pipeline.underwriting;
  const neg = pipeline.negotiation;
  const lines = [
    `CLIENT MEETING BRIEF — ${deal.name} (${deal.city})`,
    ``,
    `WHAT WE RECOMMEND: ${pipeline.verdict}`,
    pipeline.verdict === "PROCEED"
      ? `Proceed to offer. Open at AED ${(neg.opening / 1e6).toFixed(2)}m, walk away above AED ${(neg.walkAway / 1e6).toFixed(2)}m.`
      : pipeline.verdict === "CONDITIONAL"
        ? `Proceed only if the seller closes the gap. Ceiling AED ${(neg.maxPrice / 1e6).toFixed(2)}m against an ask of AED ${(deal.price / 1e6).toFixed(2)}m.`
        : `Do not proceed at the current ask. The price that clears a ${pct(targetIRR)} IRR is AED ${(neg.maxPrice / 1e6).toFixed(2)}m.`,
    ``,
    `NUMBERS TO QUOTE`,
    `Net operating income: AED ${(uw.noi / 1e6).toFixed(2)}m`,
    `Yield on cost: ${pct(uw.yieldOnCost)}`,
    `Levered IRR (base): ${pct(uw.irrLevered)} | P10 ${pct(uw.mc.p10)} | P90 ${pct(uw.mc.p90)}`,
    `Equity required: AED ${(uw.equity / 1e6).toFixed(2)}m`,
    `DSCR: ${uw.dscr === null ? "n/a (unlevered)" : uw.dscr.toFixed(2) + "x"}`,
    `Acquisition costs: AED ${(pipeline.legal.stack.total / 1e6).toFixed(2)}m (${(pipeline.legal.stack.pctOfPrice * 100).toFixed(2)}% of price)`,
    ``,
    `AGI SCENARIO RANGE`,
    ...pipeline.risk.scen.map((s) => `- ${s.name}: ${pct(s.irr)}`),
    `Downside case IRR: ${pct(pipeline.risk.downside)}`,
    ``,
    `QUESTIONS TO ASK THE CLIENT`,
    `- Is this ticket funded from the current allocation or does it need a new capital call?`,
    `- What is the hard floor on hold period — 5 years or can it stretch to 7?`,
    `- Who signs the SPA, the SPV or the family entity?`,
    `- Preferred currency for reporting, AED or USD?`,
    ``,
    `DO NOT COMMIT TO (needs human sign-off)`,
    `- Any price above AED ${(neg.walkAway / 1e6).toFixed(2)}m`,
    `- Hold period below ${deal.holdYears} years`,
    `- Removing the escrow condition`,
    `- Any guarantee of returns or of exit timing`,
    ``,
    `OPEN ITEMS FOR THE AGENTS AFTER THE MEETING`,
    `- Re-run underwriting with the client's hold period and financing`,
    `- Refresh the three most recent comparables before a formal offer`,
    `- Legal to confirm the entity and the DLD fee split`,
  ];
  return lines.join("\n");
}
