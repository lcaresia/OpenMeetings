/**
 * `${VAR}` / `${VAR:-fallback}` expansion.
 *
 * The reference config writes `apiKey: ${GROQ_API_KEY}` inside YAML flow maps, where `{` and `}`
 * are not valid in a plain scalar. So references are masked with an alphanumeric token before
 * the YAML parse and resolved afterwards, on the parsed tree. That also keeps secrets with
 * YAML-special characters from breaking the parse.
 */
const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const TOKEN = /__OMENV_(\d+)__/g;
const WHOLE_TOKEN = /^__OMENV_(\d+)__$/;

export type EnvRef = { name: string; fallback?: string };

export function maskEnvRefs(text: string): { masked: string; refs: EnvRef[] } {
  const refs: EnvRef[] = [];
  const masked = text.replace(REF, (_m, name: string, fallback?: string) => {
    refs.push(fallback === undefined ? { name } : { name, fallback });
    return `__OMENV_${refs.length - 1}__`;
  });
  return { masked, refs };
}

/**
 * Replaces tokens in every string of a parsed tree. A value that is exactly one unresolved
 * reference becomes `undefined` (so optional fields stay optional); the variable name is
 * recorded in `missing` either way.
 */
export function resolveEnvRefs(
  value: unknown,
  refs: EnvRef[],
  env: Record<string, string | undefined>,
  missing: Set<string>,
): unknown {
  const lookup = (index: number): string | undefined => {
    const ref = refs[index];
    if (!ref) return undefined;
    const found = env[ref.name];
    if (found !== undefined && found !== "") return found;
    if (ref.fallback !== undefined) return ref.fallback;
    missing.add(ref.name);
    return undefined;
  };

  if (typeof value === "string") {
    const whole = WHOLE_TOKEN.exec(value);
    if (whole) return lookup(Number(whole[1]));
    return value.replace(TOKEN, (_m, index: string) => lookup(Number(index)) ?? "");
  }
  if (Array.isArray(value)) return value.map((item) => resolveEnvRefs(item, refs, env, missing));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const resolved = resolveEnvRefs(item, refs, env, missing);
      if (resolved !== undefined) out[key] = resolved;
    }
    return out;
  }
  return value;
}
