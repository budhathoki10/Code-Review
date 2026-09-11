/**
 * Parsing for tool-call arguments, which are JSON a model wrote by hand.
 *
 * The provider does not validate them, so what arrives is whatever the model
 * typed. The one malformation that matters is an unescaped backslash: JSON
 * permits only `\" \\ \/ \b \f \n \r \t \uXXXX`, and every other escape is a
 * syntax error. A model writing a regex into a string field produces them
 * constantly — `\d`, `\b`, `\s`, `\w` are all illegal JSON — and the whole
 * tool call is then rejected over a payload whose intent is unambiguous.
 */

/** The characters JSON allows after a backslash. */
const LEGAL_ESCAPES = '"\\/bfnrtu';

/**
 * Escapes the backslashes a model left raw, leaving legal escapes alone.
 *
 * Scanning by pairs is what makes this safe: an already-escaped backslash is
 * consumed as `\\` and its second character is never re-examined, so `\\n`
 * (a literal backslash followed by n) does not become `\\\\n`, and a correctly
 * escaped `\n` newline is not turned into the two characters `\` and `n`.
 *
 * Only called after a plain parse has already failed, so a well-formed
 * payload never passes through here at all.
 */
export function repairJsonEscapes(raw: string): string {
  let out = "";
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = raw[index + 1];
    if (next !== undefined && LEGAL_ESCAPES.includes(next)) {
      out += char + next;
      index += 1;
      continue;
    }
    // A trailing lone backslash has no following character to escape; it is
    // still illegal on its own, so it is doubled like any other.
    out += "\\\\";
  }
  return out;
}

/**
 * Parses tool-call arguments, repairing illegal escapes before giving up.
 *
 * Throws the original SyntaxError, not the repaired one: if the repair also
 * fails, the payload was malformed for some other reason and the first error
 * describes it more accurately.
 */
export function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    try {
      return JSON.parse(repairJsonEscapes(raw));
    } catch {
      throw error;
    }
  }
}
