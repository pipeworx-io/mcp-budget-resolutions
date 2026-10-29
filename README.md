# @pipeworx/budget-resolutions

Congressional budget-resolution targets (concurrent resolutions on the budget, H.Con.Res. / S.Con.Res.) by budget function and fiscal year, beside U.S. Treasury actuals for the same year.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1858+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `budget_resolution_find(fiscal_year)` - which budget resolutions exist for a fiscal year and how far each got: adopted by both chambers, passed one chamber, or only introduced. A year with none returns `found:false` with a named `reason_code` (`no_resolution_exists`, `no_adopted_resolution`, `before_coverage`), never an empty list.
- `budget_resolution_targets(fiscal_year, function?, target_year?, adopted_only?, package_id?)` - the levels the resolution sets: revenues, new budget authority, outlays, deficit and debt, plus budget authority and outlays for each budget function (National Defense, Health, Medicare, Net Interest, ...) for the budget year and the later years the resolution covers. Returns the adopted resolution; if none was adopted, the most advanced proposal that passed a chamber, clearly marked `adopted:false`. Every response carries a `reconciliation` block: the function figures added up per year, beside the total the resolution states.
- `budget_vs_actual(fiscal_year, function?, adopted_only?)` - the targets next to Treasury's actual revenues, outlays, implied deficit and outlays by function: budget, actual, difference, percent. A year with no resolution still returns the actuals plus a named reason for the missing budget side. An unfinished fiscal year is flagged `comparable:false`.

## Auth

Platform key (`PLATFORM_DATAGOV_KEY`, the data.gov key the `govinfo` and `congress` packs already use) with BYO override via `_apiKey`.

## Data sources

- U.S. Congress, concurrent resolutions on the budget, as published by the U.S. Government Publishing Office (Congressional Bills). Bill text begins with the 103rd Congress (1993), so the first covered budget year is fiscal 1994.
- U.S. Treasury, Monthly Treasury Statement (outlays by budget function; on-budget and off-budget totals).

Public domain U.S. federal data. Nothing is stored: each call reads the resolution text and parses it.

## Things the next person would otherwise rediscover

- **On-budget basis.** Resolution revenue, outlay and function levels leave out Social Security's off-budget part. `budget_vs_actual` therefore compares totals against Treasury's on-budget totals (unified totals are returned beside them as a reference), and flags the Social Security function (650) as not like-for-like.
- **Allowances and savings placeholders** (functions 920, 930) are in the resolution and have no Treasury line. They are returned with a note, not dropped; they are why a resolution's total outlays can sit far below actual spending.
- **Status is read from the version code** of the bill text: `enr` is adopted by both chambers; a House-originated resolution received in the Senate (`pcs`, `rfs`, `eh`) passed the House only. A House plan that never cleared the Senate is therefore `adopted:false`.
- **The enrolled copy's metadata title is sometimes another resolution's title.** Matching is by resolution family, and the parsed text must start at the requested fiscal year or the call refuses (`text_year_mismatch`).
- **Totals do not always add up**, and that is reported rather than hidden: older resolutions state totals on a different basis (FY1994 differs by tens of billions), and one FY2022 resolution's own text is $5 billion apart. See `reconciliation.years[].matches`.
- Fiscal years before 1994 are before the source begins and return `before_coverage`.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "budget-resolutions": {
      "url": "https://gateway.pipeworx.io/budget-resolutions/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/budget-resolutions/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1858+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/budget_resolution_find \
  -H 'Content-Type: application/json' \
  -d '{"fiscal_year":2025}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/budget_resolution_find`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-budget-resolutions` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/budget-resolutions/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "budget-resolutions": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-budget-resolutions"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Budget Resolutions data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
