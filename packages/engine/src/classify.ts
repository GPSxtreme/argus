import type { SourceItem } from "@argus/contracts";

export const classify = (item: SourceItem, keywords: string[]): string[] => {
  const searchable = `${item.title ?? ""}\n${item.text}`.toLowerCase();
  return keywords.filter((keyword) =>
    searchable.includes(keyword.toLowerCase()),
  );
};
