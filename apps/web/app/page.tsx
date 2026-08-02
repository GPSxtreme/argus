import { CopyCommand } from "../components/copy-command";
import { DataTrinity } from "../components/data-trinity";
import { Pipeline } from "../components/pipeline";

const installCommand = "curl -fsSL https://argus.gpsxtre.me/install.sh | sh";

export default function Home() {
  return (
    <main className="landing">
      <nav className="site-nav" aria-label="Main navigation">
        <a href="/" className="wordmark">ARGUS</a>
        <div className="nav-links">
          <a href="/docs">Docs</a>
          <a href="/skill">Agent Skill</a>
        </div>
      </nav>

      <section className="hero">
        <p className="eyebrow">Self-hosted intelligence for agents</p>
        <h1>Know what changed. Keep the proof.</h1>
        <p className="lede">
          Argus collects public signals, normalizes them into revisioned records, and gives your agents deterministic answers with source links.
        </p>
        <div className="hero-actions">
          <a className="button primary" href="/docs/getting-started">Get Started</a>
          <a className="button" href="/docs">Read the Docs</a>
        </div>
        <section className="install-box" aria-label="Install Argus">
          <code>{installCommand}</code>
          <CopyCommand command={installCommand} />
          <code>argus onboard</code>
        </section>
      </section>

      <DataTrinity />
      <Pipeline />

      <section className="agent-callout">
        <p className="eyebrow">For coding agents</p>
        <h2>Stable docs, a portable setup skill, no hidden state.</h2>
        <a className="button primary" href="/skill">Open Agent Skill</a>
      </section>

      <footer>
        <span>Argus</span>
        <div className="footer-links">
          <a href="/docs">Docs</a>
          <a href="https://github.com/GPSxtreme/argus">Source</a>
          <a href="https://github.com/GPSxtreme/argus/blob/main/LICENSE">License</a>
          <a href="https://github.com/GPSxtreme/argus/releases/tag/v0.1.2">v0.1.2</a>
        </div>
      </footer>
    </main>
  );
}
