const pinnedImageReferencePattern = /^(?=.{1,255}$)(?:(?:localhost(?::[0-9]{1,5})?|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::[0-9]{1,5})?|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?:[0-9]{1,5})\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)@sha256:[a-f0-9]{64}$/;

/** Accepts credential-free OCI references pinned to a SHA-256 manifest digest. */
export const isPinnedImageReference = (value: string): boolean => {
  if (!pinnedImageReferencePattern.test(value)) return false;
  const registry = value.slice(0, value.indexOf("/"));
  const separator = registry.lastIndexOf(":");
  if (separator === -1) return true;
  const port = registry.slice(separator + 1);
  return /^[1-9]\d{0,4}$/.test(port) && Number(port) <= 65_535;
};
