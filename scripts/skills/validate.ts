import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const forbiddenPatterns = [
  /CLOUDFLARE_API_TOKEN\s*=/u,
  /OPENROUTER_API_KEY\s*=/u,
  /docker\s+compose\s+down\s+-v/u,
  /docker\s+volume\s+rm/u,
  /rm\s+-rf\s+\/opt\/argus/u,
  /wrangler\s+delete/u,
  /cat\s+\/opt\/argus\/secrets\.env/u,
];

const isWithin = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
};

const collectFiles = async (root: string, path = root): Promise<string[]> => {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new Error(`Symlink is not allowed: ${path}`);
  if (!metadata.isDirectory()) return [path];

  const files: string[] = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    files.push(...(await collectFiles(root, resolve(path, entry.name))));
  }
  return files;
};

const localLinks = (source: string): string[] =>
  [...source.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((link) => link !== "" && !link.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/iu.test(link));

const validate = async (input: string): Promise<void> => {
  const root = await realpath(resolve(input));
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory()) throw new Error(`Skill root is not a directory: ${root}`);

  const files = await collectFiles(root);
  const skill = resolve(root, "SKILL.md");
  if (!files.includes(skill)) throw new Error("SKILL.md is required.");

  for (const file of files) {
    const resolvedFile = await realpath(file);
    if (!isWithin(root, resolvedFile)) throw new Error(`Out-of-root file: ${file}`);
    const source = await readFile(file, "utf8");
    if (forbiddenPatterns.some((pattern) => pattern.test(source))) {
      throw new Error(`Forbidden safety pattern in: ${file}`);
    }
    for (const link of localLinks(source)) {
      const location = link.split("#", 1)[0] ?? "";
      const target = resolve(resolve(file, ".."), location);
      if (!isWithin(root, target)) throw new Error(`Out-of-root link in ${file}: ${link}`);
      const targetMetadata = await lstat(target).catch(() => undefined);
      if (!targetMetadata) throw new Error(`Broken local link in ${file}: ${link}`);
      if (targetMetadata.isSymbolicLink()) throw new Error(`Symlink link target in ${file}: ${link}`);
    }
  }

  const source = await readFile(skill, "utf8");
  const frontmatter = /^---\n([\s\S]+?)\n---\n/u.exec(source)?.[1];
  if (!frontmatter) throw new Error("SKILL.md must begin with YAML frontmatter.");
  const fields = new Map(
    frontmatter.split("\n").flatMap((line) => {
      const separator = line.indexOf(":");
      return separator > 0 ? [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()]] : [];
    }),
  );
  for (const required of ["name", "description"]) {
    if (!fields.get(required)) throw new Error(`SKILL.md frontmatter requires ${required}.`);
  }
};

const input = process.argv[2];
if (!input) throw new Error("Usage: pnpm tsx scripts/skills/validate.ts <skill-root>");
void validate(input)
  .then(() => console.log(`Validated ${input}`))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
