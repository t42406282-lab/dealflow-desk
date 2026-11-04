# DealFlow — Autonomous Deal & Portfolio Desk

A working prototype of a multi-agent desk for off-market Dubai / global real estate, built for a family-office mandate. Five specialist agents prepare a deal end to end; a human signs at four gates. Everything you see in the app is computed live in the browser — no server, no API keys, no database.

Live app: single-page site (`index.html` + `app.js` + `engine.js` + `data.js` + `styles.css`).

---

## 1. What actually runs today (and what does not)

| Piece | Status |
|---|---|
| Underwriting engine — NOI, debt service, DSCR, exit value, levered/unlevered IRR, equity multiple, breakeven occupancy | **Real code, tested** (35 assertions in `test_engine.mjs`) |
| Monte Carlo — 1,500 seeded simulations over rent growth, exit cap, vacancy | **Real code, tested**, reproducible |
| AGI scenario engine — 4 worlds, each moving rents, caps, vacancy, hold | **Real code, tested** |
| Negotiation agent — solves the price that hits the hurdle, builds a 5-round offer ladder, walk-away price, terms | **Real code, tested** |
| Portfolio optimiser — risk-adjusted ranking with per-asset cap and dry-powder floor | **Real code, tested** |
| Legal/structure agent — Dubai cost stack, entity options, 10-point checklist | **Rules in code**, facts to be verified by counsel |
| Deal sourcing — portal sweep, broker network, off-market scoring | **Simulated** in the prototype; the live version needs portal/broker integrations |
| LLM reasoning layer (reading a rent roll PDF, drafting broker emails, summarising title) | **Not built.** Needs an LLM API key. The prototype shows the structure the LLM would fill |
| Client meetings | **Human, always.** The agent prepares the brief; it does not attend |

No numbers are hardcoded to look good. Change an input in the Underwriting tab and every figure downstream — scenarios, ladder, allocation — recomputes.

---

## 2. The five agents

| Agent | Job | Stops when |
|---|---|---|
| **Deal Sourcing** | Sweeps portals and the broker network, filters against the mandate, kills bad title early | A shortlist reaches the desk |
| **Underwriting & Valuation** | Cash flows, DSCR, exit value, IRR, sensitivity grid, Monte Carlo | A price ceiling exists |
| **Negotiation** | Works backwards from the hurdle to a ceiling price, then a 5-round ladder with term trades | The seller's number crosses the walk-away |
| **Legal & Structure** | Cost stack, entity choice, escrow, title, tax, exit route | A red flag or a clean file |
| **Risk & Portfolio** | Sizes the ticket inside the mandate, stresses the four AGI worlds, protects the book | Allocation proposed |

Each agent writes an artefact the next one reads. That is the whole architecture: **artefacts, not chat.** Agents never negotiate with each other in free text; they pass structured numbers, which is why a human can audit any decision.

---

## 3. The four human gates

1. **Mandate** — client sets capital, hurdle IRR, hold period, per-asset cap. Agents cannot move these.
2. **Offer** — nothing above the walk-away price leaves the desk without an approval on record (the Pipeline tab gate).
3. **Client meeting** — a human goes. The Approvals & Brief tab generates the brief: numbers to quote, questions to ask, what not to commit to.
4. **SPA signature** — a human signs, always. No agent holds signature authority.

The approval log is stored in the browser (`localStorage`) in the prototype; in production it goes to a database with an immutable trail.

---

## 4. How the maths works

**Underwriting.** Gross rent = units × rent × occupancy. NOI = gross rent − opex. Total cost = price + acquisition costs + capex. Equity = total cost − loan. Debt service is an amortising annuity. Exit value = forward NOI ÷ exit cap. Levered IRR is solved by bisection on the cash-flow vector.

**Monte Carlo.** Rent growth, exit cap and vacancy are drawn from seeded normal distributions around the base case; every draw is re-underwritten. Seeded means the same deal always gives the same distribution — reproducible, not decorative. Reported as P10 / P50 / P90 plus the probability of missing the hurdle.

**Negotiation.** The engine bisects on *price* until the levered IRR equals the client's hurdle. That price is the ceiling. The opening offer sits 7% below it, the walk-away 1.5% above, and the ladder walks from one to the other. This is why the agent can say "the ask is 16% above the price that clears your hurdle" and be exactly right.

**Portfolio.** Each deal gets a score = expected IRR − 0.6 × volatility + 0.25 × worst AGI scenario. Capital is allocated in score order subject to the per-asset cap and the dry-powder floor. Portfolio IRR is reported on deployed capital, with the cash-drag number shown separately so nobody confuses the two.

**AGI scenarios.** Four worlds: base (AGI delayed), boom (capital flood, cap compression), displacement (office and retail demand shock, residential firm), liquidity winter (exit market freezes, holds extend). Commercial assets take a harder displacement hit than residential — the `commercialOnly` override in `engine.js`.

---

## 5. What the production build needs

**Data and integrations**
- Property portals (Property Finder, Bayut) + broker inbox for sourcing. Needs API access or a scraper.
- Dubai Land Department / Ejari for title and tenancy verification — or a data vendor.
- Comparables feed for valuation.
- Email/WhatsApp for broker negotiation drafts, with a human send button.
- Supabase (already connected) for the deal book, approval log and audit trail.

**LLM layer** — the only place an API key is needed. Placeholders, never in code:
```
LLM_API_KEY=            # provider key, set in Netlify env vars
LLM_MODEL=              # e.g. a frontier model for drafting, a cheap one for extraction
```
The LLM does four narrow jobs: extract rent rolls and title docs into structured JSON, draft broker emails, summarise legal documents, and write the client brief in prose. **Every number stays in the deterministic engine.** An LLM that does arithmetic in a deal desk is a liability.

**Backend shape**
- Supabase: `deals`, `agent_runs`, `approvals`, `documents`, `scenarios`.
- Netlify functions for the agent calls (LLM + document parsing), because the sandbox that built this cannot host a long-running server.
- Scheduled sourcing sweep: GitHub Actions cron or Netlify scheduled functions.

---

## 6. Honest limits of this prototype

- Deal data is illustrative and internally consistent, not market data. Verify every input before it goes near a client.
- Dubai fee conventions (4% DLD, 2% agency, trustee fees, mortgage registration) are assumptions in `DUBAI_COSTS`, not advice. Counsel signs off.
- No document ingestion yet — rent rolls are typed in by hand in this build.
- No live broker negotiation. The ladder is the plan; sending it needs email integration and a human send.
- Sourcing is a scored sample list, not a live sweep.
- The optimiser uses a fixed 0.5 correlation assumption between assets. Real correlation estimates need history.
- Nothing here is investment, legal or tax advice.

---

## 7. Running it

```bash
cd dealflow
python3 -m http.server 8000      # any static server works
# open http://localhost:8000

node test_engine.mjs             # 35 assertions on the maths
```

Deploy: it is a static site — drag the folder onto Netlify, or push to a repo and let Netlify/GitHub Pages serve it. No build step, no dependencies.
