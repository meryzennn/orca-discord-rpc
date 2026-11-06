/** True for a plain JSON-style object; arrays and null are not records. Field values stay `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
