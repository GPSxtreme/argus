import Link from "next/link";

export default function SkillPage() {
  return (
    <main className="skill-page">
      <p className="eyebrow">Argus Agent Skill</p>
      <h1>Install, operate, and recover Argus through its stable CLI.</h1>
      <p>
        The portable skill keeps secrets out of chat and asks for approval before external changes.
      </p>
      <p>
        <a className="button primary" href="/skill/argus-skill.zip">Download ZIP</a>
        <Link className="button" href="/skill/SKILL.md">Read SKILL.md</Link>
      </p>
    </main>
  );
}
