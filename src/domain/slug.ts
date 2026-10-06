export const MAX_SLUG_LENGTH = 40

/**
 * Turns a name into lowercase words joined by single dashes, at most 40 characters long,
 * so it can be part of a file or folder name; it is empty when no letter or digit remains.
 */
export function slug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')
}
