import { describe, expect, it } from "vitest";
import {
  ARGUS_FXEMBED_WORKER_NAME,
  CloudflareWorkersApiClient,
  type FxEmbedBundle,
  reconcileFxEmbed,
} from "../src/index.js";

const enabled = process.env.ARGUS_FXEMBED_LIVE === "1";

describe.skipIf(!enabled)("managed FxEmbed live smoke", () => {
  it("deploys to an explicitly acknowledged dedicated account and is a no-op on rerun", async () => {
    if (process.env.ARGUS_FXEMBED_LIVE_DEDICATED_ACCOUNT !== "1") {
      throw new Error(
        "Set ARGUS_FXEMBED_LIVE_DEDICATED_ACCOUNT=1 only for a dedicated test account.",
      );
    }
    const accountId = process.env.ARGUS_FXEMBED_LIVE_ACCOUNT_ID;
    const token = process.env.ARGUS_FXEMBED_LIVE_API_TOKEN;
    if (!accountId || !token) {
      throw new Error("Dedicated FxEmbed live test credentials are required.");
    }
    const script = new TextEncoder().encode(
      "export default { async fetch() { return new Response('argus-fxembed-live'); } };",
    );
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", script),
    );
    const bundle: FxEmbedBundle = {
      script,
      sha256: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      compatibilityDate: "2026-07-31",
    };
    const client = new CloudflareWorkersApiClient({ token });

    const first = await reconcileFxEmbed({
      accountId,
      workerName: ARGUS_FXEMBED_WORKER_NAME,
      token,
      bundle,
      client,
    });
    const second = await reconcileFxEmbed({
      accountId,
      workerName: ARGUS_FXEMBED_WORKER_NAME,
      token,
      bundle,
      client,
    });

    expect(first.bundleHash).toBe(bundle.sha256);
    expect(second).toEqual({ ...first, changed: false });
  });
});
