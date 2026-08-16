/**
 * Minimální validátor JSON Schema — jen podmnožina, kterou tool layer opravdu potřebuje:
 * type, properties, required, enum, default, minimum/maximum, minLength/maxLength.
 *
 * Záměrně bez závislosti: `inputSchema` každého nástroje jde zároveň beze změny poslat
 * modelu jako `input_schema`, takže existuje jediný zdroj pravdy o tvaru vstupu.
 */

const TYPE_CHECKS = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  array: Array.isArray,
  null: (v) => v === null,
};

/**
 * @returns {{ok:true, value:object} | {ok:false, errors:string[]}}
 */
export function validate(schema, input) {
  const errors = [];
  const value = coerceObject(schema, input ?? {}, "", errors);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

function coerceObject(schema, input, path, errors) {
  if (!TYPE_CHECKS.object(input)) {
    errors.push(`${path || "vstup"} musí být objekt`);
    return {};
  }

  const props = schema.properties ?? {};
  const out = {};

  for (const key of schema.required ?? []) {
    if (input[key] === undefined) errors.push(`chybí povinné pole "${joinPath(path, key)}"`);
  }

  for (const [key, propSchema] of Object.entries(props)) {
    const at = joinPath(path, key);
    let v = input[key];

    if (v === undefined) {
      if (propSchema.default !== undefined) out[key] = propSchema.default;
      continue;
    }
    v = checkValue(propSchema, v, at, errors);
    out[key] = v;
  }

  // Neznámé klíče se zahazují, ne odmítají — model občas přidá pole navíc
  // a nemá smysl kvůli tomu celé volání shodit.
  return out;
}

function checkValue(schema, v, path, errors) {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];

  if (types.length && !types.some((t) => TYPE_CHECKS[t]?.(v))) {
    errors.push(`"${path}" má být ${types.join(" | ")}, přišlo ${Array.isArray(v) ? "array" : typeof v}`);
    return v;
  }
  if (schema.enum && !schema.enum.includes(v)) {
    errors.push(`"${path}" musí být jedna z hodnot: ${schema.enum.join(", ")}`);
  }
  if (typeof v === "string") {
    if (schema.minLength != null && v.length < schema.minLength) errors.push(`"${path}" je příliš krátké`);
    if (schema.maxLength != null && v.length > schema.maxLength) errors.push(`"${path}" je příliš dlouhé`);
  }
  if (typeof v === "number") {
    if (schema.minimum != null && v < schema.minimum) errors.push(`"${path}" musí být ≥ ${schema.minimum}`);
    if (schema.maximum != null && v > schema.maximum) errors.push(`"${path}" musí být ≤ ${schema.maximum}`);
  }
  if (types.includes("object") && schema.properties) {
    return coerceObject(schema, v, path, errors);
  }
  if (types.includes("array") && schema.items) {
    return v.map((item, i) => checkValue(schema.items, item, `${path}[${i}]`, errors));
  }
  return v;
}

function joinPath(path, key) {
  return path ? `${path}.${key}` : key;
}
