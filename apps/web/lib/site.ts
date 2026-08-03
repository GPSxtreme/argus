export const site = {
  name: "Argus",
  description: "A self-hosted data layer for AI agents.",
  url: "https://argus.gpsxtre.me",
  repository: "https://github.com/GPSxtreme/argus",
} as const;

export const absoluteUrl = (path = "/") => new URL(path, site.url).toString();
