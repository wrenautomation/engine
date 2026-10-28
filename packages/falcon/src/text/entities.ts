import { decodeHTML } from "entities";

/** HTML character references to text (the WHATWG table); a no-break space becomes a space. */
export const decodeHtml = (s: string): string =>
  s.includes("&") ? decodeHTML(s).replaceAll(" ", " ") : s;
