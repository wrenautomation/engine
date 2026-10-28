/**
 * Raven never picks a model: a caller hands in one `Model` from `@wrenautomation/models`, and its
 * id goes on every record raven writes. This file keeps only the prompt template fill.
 */

/** `{name}` marks filled in one pass; a `{word}` with no value stays as text. */
export const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/g, (mark, name: string) => values[name] ?? mark);
