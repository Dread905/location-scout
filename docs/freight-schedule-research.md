# Freight schedule research spike

~10 minutes of web research (September 2026) into whether ARTC or HVCCC publish a
machine-readable or PDF freight schedule usable for *planned* paths (not live
positions — nothing public gives those; see the README's "Freight and coal
trains" limitation).

## ARTC Master Train Plan (MTP)

ARTC publishes a Master Train Plan — "a complete listing of all contracted
path schedules" — at
[artc.com.au/customers/operations/mtp](https://www.artc.com.au/customers/operations/mtp/),
as dated PDFs like
[MTP_2026-01-18_NSWVIC-500.pdf](https://www.artc.com.au/uploads/MTP_2026-01-18_NSWVIC-500.pdf).

- **Format**: PDF timetable grids (train number, days of operation, path
  type, operator, commodity, times per timing point). No CSV or API found.
- **Corridors published**: NSW–VIC and NSW–QLD *interstate* corridors —
  the Defined Interstate Rail Network ARTC leases (Main West through to
  Broken Hill, the north–south corridors, Hunter Valley coal network).
- **Coverage gap for this app**: the coal branch that matters most here —
  Gulgong–Ulan (Sandy Hollow–Gulgong line) — is on the **Country Regional
  Network (CRN)**, owned by Transport for NSW and operated by UGL Regional
  Linx, not ARTC. No published CRN working timetable turned up in this
  search; UGL Regional Linx's own site describes the network but not a
  timetable. The Main Western line through Bathurst/Lithgow itself *is*
  part of ARTC's interstate network, so an MTP PDF likely mentions any
  interstate-classified freight paths that use it, but the coal traffic
  that turns off onto CRN branches (Ulan, Gwabegar, etc.) would drop out of
  ARTC's own plan at that junction.

## HVCCC (Hunter Valley Coal Chain Coordinator)

HVCCC coordinates Hunter Valley coal logistics (rail plans, vessel/stockpile
plans) through internal systems — "Whole-of-Coal-Chain model", "Integrated
Planning System" — described on
[hvccc.com.au](https://www.hvccc.com.au/). No public dataset, API, or
published schedule surfaced. This is squarely a members' coordination tool,
not a public feed, and the Hunter Valley chain isn't the corridor this app
cares about (Lithgow/Ulan, not the Hunter).

## Recommendation: **No**

Don't build a parser for either source:

1. **Format**: PDF table extraction is brittle (layout-dependent, breaks on
   every ARTC template change) for a "planned path" feature that's already
   a nice-to-have.
2. **Coverage**: the MTP doesn't cover the CRN-operated Ulan/Gulgong branch,
   which is where the coal traffic this app is most interested in actually
   runs. HVCCC publishes nothing public at all.
3. **Value vs. effort**: per the plan, "if none does, layers 1 and 2 are the
   feature" — the OSM rail network layer plus crowdsourced sightings
   (with pass-time histograms building up over time, and syncing between
   instances via share links) already cover "where coal trains *can* be"
   and "when they usually pass here" reasonably well without a parser that
   would need ongoing maintenance against a PDF ARTC didn't design to be
   machine-read.

If this changes — e.g. CRN or HVCCC start publishing structured data, or
ARTC starts covering CRN-connected branches in a non-PDF format — revisit.
