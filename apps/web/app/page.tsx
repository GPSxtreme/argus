import { CopyButton } from "../components/copy-button";
import { FlowDiagram } from "../components/flow-diagram";
import { LiveLog } from "../components/live-log";
import { QueryTheater } from "../components/query-theater";
import { ThemeToggle } from "../components/theme-toggle";
import { stableReleaseTag, stableReleaseUrl } from "../lib/release";

const installCommand = "curl -fsSL https://argus.gpsxtre.me/install.sh | sh";

export default function Home() {
  return (
    <main className="landing">
      <nav className="site-nav" aria-label="Main navigation">
        <a href="/" className="wordmark">ARGUS</a>
        <div className="nav-links">
          <a href="/docs">Docs</a>
          <a href="/skill">Agent Skill</a>
          <ThemeToggle />
        </div>
      </nav>

      <section className="hero hero-split">
        <div>
          <p className="eyebrow">Self-hosted intelligence for agents</p>
          <h1>Know what changed. Keep the proof.</h1>
          <p className="lede">
            Argus collects public signals, normalizes them into revisioned records, and gives your agents deterministic answers with source links.
          </p>
          <div className="hero-actions">
            <a className="button primary" href="/docs/quick-start">Get Started</a>
            <a className="button" href="/docs">Read the Docs</a>
          </div>
        </div>
        <LiveLog />
      </section>

      <section className="install-box term" aria-label="Install Argus">
        <div className="term-bar">
          <span className="term-dot" /><span className="term-dot" /><span className="term-dot" />
          <span>install</span>
        </div>
        <div className="term-body">
          <div className="install-line">
            <code><span className="t-accent">$</span> {installCommand}</code>
            <CopyButton text={installCommand} />
          </div>
          <code><span className="t-accent">$</span> argus onboard</code>
          <p className="install-note">
            The installer downloads the signed release from the public repository and verifies the manifest signature before touching your system.
          </p>
        </div>
      </section>

      <FlowDiagram />

      <QueryTheater />

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
          <a href={stableReleaseUrl}>{stableReleaseTag}</a>
        </div>
      </footer>
    </main>
  );
}
