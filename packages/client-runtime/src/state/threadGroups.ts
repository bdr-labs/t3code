const GROUP_TAG_PREFIX = "group:";

/** The thread's group: the first `group:` tag with a name, spelled exactly. */
export function threadGroupOf(tags: readonly string[] | undefined): string | null {
  for (const tag of tags ?? []) {
    if (tag.startsWith(GROUP_TAG_PREFIX) && tag.length > GROUP_TAG_PREFIX.length) {
      return tag.slice(GROUP_TAG_PREFIX.length);
    }
  }
  return null;
}
