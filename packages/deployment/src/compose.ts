export interface ComposeInput {
  version: string;
  storage: "sqlite" | "postgres";
  searxng: boolean;
}

const argusService = `  argus:
    image: ghcr.io/gpsxtreme/argus:\${ARGUS_VERSION}
    env_file: [secrets.env]
    environment:
      ARGUS_CONFIG: /app/argus.yaml
      ARGUS_ROLE: all
    volumes:
      - ./argus.yaml:/app/argus.yaml:ro
      - argus-data:/app/data
    ports:
      - "\${ARGUS_API_PORT}:8788"
    networks: [argus-private]
    restart: unless-stopped
`;

const postgresService = `  postgres:
    image: \${POSTGRES_IMAGE}
    env_file: [secrets.env]
    environment:
      POSTGRES_DB: argus
      POSTGRES_USER: argus
    volumes:
      - postgres-data:/var/lib/postgresql/data
    networks: [argus-private]
    restart: unless-stopped
`;

const searxngService = `  searxng:
    image: \${SEARXNG_IMAGE}
    volumes:
      - ./searxng/settings.yml:/etc/searxng/settings.yml:ro
    networks: [argus-private]
    restart: unless-stopped
`;

/** Renders only Compose interpolation variables; image values are supplied from a verified manifest. */
export const renderCompose = ({ storage, searxng }: ComposeInput): string => {
  const services = [argusService];
  if (storage === "postgres") services.push(postgresService);
  if (searxng) services.push(searxngService);
  const volumes = ["  argus-data:"];
  if (storage === "postgres") volumes.push("  postgres-data:");

  return `name: argus
services:
${services.join("")}networks:
  argus-private:
    internal: true
volumes:
${volumes.join("\n")}
`;
};
