const sources = [
  ["X", "Accounts and search through your own FxEmbed Worker"],
  ["Telegram", "Public announcement channels only"],
  ["Web", "URLs, feeds, and managed SearXNG queries"],
] as const;

export function FlowDiagram() {
  return (
    <section className="flow-section" aria-labelledby="flow-title">
      <p className="eyebrow">How it works</p>
      <h2 id="flow-title">Signals in. Receipts out.</h2>
      <div className="flow">
        <div className="flow-sources">
          {sources.map(([name, detail], i) => (
            <div className="flow-node" key={name}>
              <span className="flow-node-name"><span className="flow-live" style={{ animationDelay: `${i * 0.8}s` }}>◉</span> {name}</span>
              <span className="flow-node-detail">{detail}</span>
            </div>
          ))}
        </div>
        <div className="flow-wires" aria-hidden="true">
          <span className="wire" /><span className="wire wire-2" /><span className="wire wire-3" />
        </div>
        <div className="flow-node flow-core">
          <span className="flow-node-name">ARGUS</span>
          <span className="flow-node-detail">normalize · revision<br />store · dedupe</span>
          <span className="flow-rev">rev 412</span>
        </div>
        <div className="flow-wires" aria-hidden="true">
          <span className="wire wire-back" />
        </div>
        <div className="flow-node">
          <span className="flow-node-name">Your agent</span>
          <span className="flow-node-detail">query &quot;since 9am&quot;</span>
          <span className="flow-answer">3 records · sourced</span>
        </div>
      </div>
      <p className="flow-caption">Revisioned records and deterministic queries keep every result traceable to its source.</p>
    </section>
  );
}
