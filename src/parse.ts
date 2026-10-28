/**
 * Pure text parser for a congressional budget resolution (concurrent
 * resolution on the budget). No I/O, so it can be unit-tested on saved text.
 *
 * Every resolution since 1993 uses the same statutory shape: one section of
 * "recommended levels and amounts" (revenues, budget authority, outlays,
 * deficits, debt) and one of "major functional categories" (budget authority
 * and outlays per function, per fiscal year). The section NUMBERS differ
 * between resolutions (101/102, 101/104, 1101/1102, 2/6) so sections are found
 * by their heading text, never by number.
 */

export interface YearValue {
  fiscal_year: number;
  usd: number;
}

export interface ParsedFunction {
  code: string;
  name: string;
  years: { fiscal_year: number; budget_authority_usd: number | null; outlays_usd: number | null }[];
}

export interface ParsedResolution {
  /** The first fiscal year in the resolution's recommended levels = "the budget for fiscal year N". */
  first_fiscal_year: number | null;
  fiscal_years: number[];
  aggregates: Record<string, YearValue[]>;
  functions: ParsedFunction[];
}

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

// A minus sign can be left at the end of a wrapped line ("authority, -" / "$124,103,000,000"),
// and after whitespace collapse that reads "- $124,...", so allow one space.
const AMOUNT = '(-?) ?\\$([\\d,]+)';
const toUsd = (sign: string, digits: string): number => (sign ? -1 : 1) * Number(digits.replace(/,/g, ''));

const HEADING = /SEC\. \d+[A-Z]?\. [A-Z][A-Z ,'\-]{3,}\./g;

/** Text of the section whose uppercase heading contains `title`, up to the next uppercase section heading. */
function sectionByTitle(text: string, title: string): string | null {
  const heads: { idx: number; len: number; head: string }[] = [];
  for (const m of text.matchAll(HEADING)) heads.push({ idx: m.index ?? 0, len: m[0].length, head: m[0] });
  for (let i = 0; i < heads.length; i++) {
    if (heads[i].head.includes(title)) {
      const end = i + 1 < heads.length ? heads[i + 1].idx : text.length;
      return text.slice(heads[i].idx + heads[i].len, end);
    }
  }
  return null;
}

/** First unbroken run of "Fiscal year YYYY: $X." entries starting at or after `from`. */
function firstSeries(block: string): YearValue[] {
  const start = block.search(/Fiscal year \d{4}: /);
  if (start < 0) return [];
  const re = new RegExp(`\\s*Fiscal year (\\d{4}): ${AMOUNT}\\.`, 'y');
  const out: YearValue[] = [];
  let pos = start;
  for (;;) {
    re.lastIndex = pos;
    const m = re.exec(block);
    if (!m) break;
    const fy = Number(m[1]);
    if (out.length && fy <= out[out.length - 1].fiscal_year) break;
    out.push({ fiscal_year: fy, usd: toUsd(m[2], m[3]) });
    pos = re.lastIndex;
  }
  return out;
}

const AGG_ITEMS: { key: string; re: RegExp }[] = [
  { key: 'revenues', re: /\(\d+\) Federal revenues/ },
  { key: 'budget_authority', re: /\(\d+\) New budget authority/ },
  { key: 'outlays', re: /\(\d+\) Budget outlays/ },
  { key: 'deficit', re: /\(\d+\) Deficits?/ },
  { key: 'surplus', re: /\(\d+\) Surpluses?/ },
  { key: 'debt_subject_to_limit', re: /\(\d+\) Debt subject to limit/ },
  { key: 'debt_held_by_public', re: /\(\d+\) Debt held by (?:the )?public/ },
];

export function parseResolutionText(raw: string): ParsedResolution {
  const text = decode(raw).replace(/\s+/g, ' ');

  const levels = sectionByTitle(text, 'RECOMMENDED LEVELS AND AMOUNTS');
  const aggregates: Record<string, YearValue[]> = {};
  if (levels) {
    const starts: { key: string; idx: number }[] = [];
    for (const item of AGG_ITEMS) {
      const m = item.re.exec(levels);
      if (m) starts.push({ key: item.key, idx: m.index });
    }
    starts.sort((a, b) => a.idx - b.idx);
    for (let i = 0; i < starts.length; i++) {
      const end = i + 1 < starts.length ? starts[i + 1].idx : levels.length;
      const series = firstSeries(levels.slice(starts[i].idx, end));
      if (series.length) aggregates[starts[i].key] = series;
    }
  }

  const fsec = sectionByTitle(text, 'MAJOR FUNCTIONAL CATEGORIES');
  const functions: ParsedFunction[] = [];
  if (fsec) {
    const nameRe = /\((\d+)\) ([A-Z][A-Za-z ,&'\-]+?) \((\d{3})\):/g;
    const marks = [...fsec.matchAll(nameRe)].map((m) => ({
      idx: m.index ?? 0,
      endHead: (m.index ?? 0) + m[0].length,
      name: m[2].trim(),
      code: m[3],
    }));
    for (let i = 0; i < marks.length; i++) {
      const block = fsec.slice(marks[i].endHead, i + 1 < marks.length ? marks[i + 1].idx : fsec.length);
      const years: ParsedFunction['years'] = [];
      const yre = /Fiscal year (\d{4}):(.*?)(?=Fiscal year \d{4}:|$)/g;
      for (const ym of block.matchAll(yre)) {
        const ba = new RegExp(`\\(A\\) New budget authority, ${AMOUNT}`).exec(ym[2]);
        const ol = new RegExp(`\\(B\\) Outlays, ${AMOUNT}`).exec(ym[2]);
        years.push({
          fiscal_year: Number(ym[1]),
          budget_authority_usd: ba ? toUsd(ba[1], ba[2]) : null,
          outlays_usd: ol ? toUsd(ol[1], ol[2]) : null,
        });
      }
      if (years.length) functions.push({ code: marks[i].code, name: marks[i].name, years });
    }
  }

  const fyAll = new Set<number>();
  for (const s of Object.values(aggregates)) for (const v of s) fyAll.add(v.fiscal_year);
  const fiscal_years = [...fyAll].sort((a, b) => a - b);
  return { first_fiscal_year: fiscal_years[0] ?? null, fiscal_years, aggregates, functions };
}
