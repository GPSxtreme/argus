import Link from "next/link";

export default function SkillPage() {
  return (
    <main className="skill-page">
      <p className="eyebrow">Argus Agent Skills</p>
      <h1>Set up the data layer. Then research through it.</h1>
      <p>
        Two small, portable skills give Codex, Claude Code, and compatible agents the exact Argus boundaries they need.
      </p>
      <h2>Setup</h2>
      <p>Install, configure, diagnose, repair, and update through the stable CLI.</p>
      <p>
        <a className="button primary" href="/skill/argus-skill.zip">Download setup</a>
        <Link className="button" href="/skill/SKILL.md">Read setup skill</Link>
      </p>
      <h2>Research</h2>
      <p>Query stored context, traverse source primitives, and produce bounded sourced briefs.</p>
      <p>
        <a className="button primary" href="/skill/argus-research.zip">Download research</a>
        <Link className="button" href="/skill/research/SKILL.md">Read research skill</Link>
      </p>
    </main>
  );
}
