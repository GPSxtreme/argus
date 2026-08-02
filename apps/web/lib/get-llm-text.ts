import type { source } from "./source";

type DocumentationPage = ReturnType<typeof source.getPages>[number];

export function getLLMText(page: DocumentationPage): Promise<string> {
  return page.data.getText("processed");
}
