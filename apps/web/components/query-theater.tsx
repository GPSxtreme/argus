"use client";

import { useEffect, useState } from "react";

const demos = [
  {
    query: 'argus query "what did @base announce this week"',
    records: 3, revision: 412, sources: ['"x.com/base/…"', '"t.me/…"'],
  },
  {
    query: 'argus query "new listings since 9am"',
    records: 5, revision: 413, sources: ['"t.me/…"', '"rss/…"'],
  },
  {
    query: 'argus query "changes to pricing page"',
    records: 1, revision: 414, sources: ['"web/…"'],
  },
] as const;

const CYCLE_MS = 6000;

export function QueryTheater() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % demos.length), CYCLE_MS);
    return () => clearInterval(id);
  }, []);
  const demo = demos[index] ?? demos[0];
  return (
    <section className="query-section" aria-labelledby="query-title">
      <p className="eyebrow">Query</p>
      <h2 id="query-title">Ask. Get receipts.</h2>
      <div className="query-theater" key={index}>
        <div className="term">
          <div className="term-bar"><span>you → argus</span></div>
          <div className="term-body">
            <div className="qt-prompt"><span className="t-accent">$</span> <span className="typeline">{demo.query}</span></div>
            <div className="t-faint qt-late">→ searching x · telegram · web</div>
          </div>
        </div>
        <div className="term">
          <div className="term-bar"><span>argus → you · 12ms</span></div>
          <div className="term-body qt-late">
            <div>{"{"}</div>
            <div>&nbsp;&nbsp;<span className="t-verb">&quot;records&quot;</span>: {demo.records}, <span className="t-verb">&quot;revision&quot;</span>: {demo.revision},</div>
            <div>&nbsp;&nbsp;<span className="t-verb">&quot;sources&quot;</span>: [<span className="t-str">{demo.sources.join(", ")}</span>]</div>
            <div>{"}"}</div>
          </div>
        </div>
      </div>
      <p className="flow-caption">Deterministic answers with source links on every record. No LLM in the loop.</p>
    </section>
  );
}
