const lines = [
  ["watch", "x/@base .........", "rev 412"],
  ["watch", "tg/announcements .", "rev 89"],
  ["fetch", "web/rss ..........", "+3 new"],
  ["query", '"listings since 9am"', ""],
] as const;

export function LiveLog() {
  return (
    <div className="term live-log" aria-hidden="true">
      <div className="term-bar">
        <span className="term-dot" /><span className="term-dot" /><span className="term-dot" />
        <span>argus — live</span>
      </div>
      <div className="term-body">
        {lines.map(([verb, subject, result], i) => (
          <div className="log-line" style={{ animationDelay: `${i * 0.5}s` }} key={subject}>
            <span className="t-verb">{verb}</span> {subject} <span className="t-accent">{result}</span>
          </div>
        ))}
        <div className="log-line" style={{ animationDelay: "2s" }}>
          <span className="t-faint">→ 3 records · 3 sources · 12ms</span>
          <span className="cursor">▌</span>
        </div>
      </div>
    </div>
  );
}
