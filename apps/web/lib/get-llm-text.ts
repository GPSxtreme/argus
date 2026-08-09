import type { source } from "./source";

type DocumentationPage = ReturnType<typeof source.getPages>[number];

export async function getLLMText(page: DocumentationPage): Promise<string> {
  const body = await page.data.getText("processed");
  return `# ${page.data.title}\n\n${body.trim()}`;
}
