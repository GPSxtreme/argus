const sources = [
  ["X", "Accounts and search through your own FxEmbed Worker"],
  ["Telegram", "Public announcement channels only"],
  ["Web", "URLs, feeds, and managed SearXNG queries"],
] as const;

export function DataTrinity() {
  return (
    <section className="data-trinity" aria-labelledby="sources-title">
      <p className="eyebrow">Sources</p>
      <h2 id="sources-title">Public signal, under your control.</h2>
      <div className="source-grid">
        {sources.map(([name, detail]) => (
          <article key={name} className="source-card">
            <span className="source-mark" aria-hidden="true" />
            <h3>{name}</h3>
            <p>{detail}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
