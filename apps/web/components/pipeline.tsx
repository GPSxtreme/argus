const stages = ["Collect", "Normalize", "Store", "Query"] as const;

export function Pipeline() {
  return (
    <section className="pipeline" aria-labelledby="pipeline-title">
      <p className="eyebrow">Pipeline</p>
      <h2 id="pipeline-title">Evidence stays attached.</h2>
      <ol>
        {stages.map((stage, index) => (
          <li key={stage}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            {stage}
          </li>
        ))}
      </ol>
      <p>Revisioned records and deterministic queries keep every result traceable to its source.</p>
    </section>
  );
}
