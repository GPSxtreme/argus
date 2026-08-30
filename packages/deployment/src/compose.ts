export interface ComposeInput {
  version: string;
  storage: "sqlite" | "postgres";
  searxng: boolean;
  fxembed?: boolean;
}

const argusService = `  argus:
    image: \${ARGUS_IMAGE}
    env_file:
      - path: secrets.env
        format: raw
    environment:
      ARGUS_CONFIG: /app/argus.yaml
      ARGUS_ROLE: all
    volumes:
      - ./argus.yaml:/app/argus.yaml:ro
      - argus-data:/app/data
    ports:
      - "\${ARGUS_API_PORT}:\${ARGUS_API_PORT}"
    networks: [argus-private, argus-egress]
    restart: unless-stopped
`;

const postgresService = `  postgres:
    image: \${POSTGRES_IMAGE}
    env_file:
      - path: secrets.env
        format: raw
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
    env_file:
      - path: searxng/secrets.env
        format: raw
    volumes:
      - ./searxng/settings.yml:/etc/searxng/settings.yml:ro
    networks: [argus-private, argus-egress]
    restart: unless-stopped
`;

const fxembedService = `  fxembed:
    image: \${FXEMBED_IMAGE}
    environment:
      NODE_ENV: production
      WRANGLER_SEND_METRICS: "false"
    networks: [argus-private, argus-egress]
    restart: unless-stopped
`;

/** Renders only Compose interpolation variables; image values are supplied from a verified manifest. */
export const renderCompose = ({ storage, searxng, fxembed = false }: ComposeInput): string => {
  const services = [argusService];
  if (storage === "postgres") services.push(postgresService);
  if (searxng) services.push(searxngService);
  if (fxembed) services.push(fxembedService);
  const volumes = ["  argus-data:"];
  if (storage === "postgres") volumes.push("  postgres-data:");

  return `name: argus
services:
${services.join("")}networks:
  argus-private:
    internal: true
  argus-egress: {}
volumes:
${volumes.join("\n")}
`;
};
