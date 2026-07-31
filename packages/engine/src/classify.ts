import type { SourceItem } from "@argus/contracts";

export const classify = (item: SourceItem, keywords: string[]): string[] => {
  const searchable = `${item.title ?? ""}\n${item.text}`.toLocaleLowerCase();
  return keywords.filter((keyword) =>
    searchable.includes(keyword.toLocaleLowerCase()),
  );
};
