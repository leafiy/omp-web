/** MCP elicitation form fields (a flat JSON Schema object of primitive properties). */
export type ElicitationField =
  | { key: string; title: string; description?: string; required: boolean; kind: "string"; format?: string; minLength?: number; maxLength?: number }
  | { key: string; title: string; description?: string; required: boolean; kind: "number" | "integer"; minimum?: number; maximum?: number }
  | { key: string; title: string; description?: string; required: boolean; kind: "boolean" }
  | { key: string; title: string; description?: string; required: boolean; kind: "enum"; options: { value: string; label: string }[] }
  | { key: string; title: string; description?: string; required: boolean; kind: "multi"; options: { value: string; label: string }[]; minItems?: number; maxItems?: number };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function str(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function num(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }

function enumOptions(schema: Record<string, unknown>): { value: string; label: string }[] | undefined {
  if (Array.isArray(schema.enum) && schema.enum.every((item) => typeof item === "string")) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return (schema.enum as string[]).map((value, index) => ({ value, label: typeof names[index] === "string" && names[index] ? names[index] as string : value }));
  }
  const choices = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  if (choices?.length && choices.every((item) => typeof record(item).const === "string")) {
    return choices.map((item) => {
      const choice = record(item);
      return { value: choice.const as string, label: str(choice.title) ?? choice.const as string };
    });
  }
  return undefined;
}

/** Unique labels: the dialog answers by label, so duplicates are disambiguated. */
function uniqueLabels(options: { value: string; label: string }[]): { value: string; label: string }[] {
  const seen = new Map<string, number>();
  return options.map((option) => {
    const n = (seen.get(option.label) ?? 0) + 1;
    seen.set(option.label, n);
    return n === 1 ? option : { ...option, label: `${option.label} (${option.value})` };
  });
}

/** Returns undefined when the schema is not a form the web can render faithfully. */
export function elicitationFields(schema: unknown): ElicitationField[] | undefined {
  const root = record(schema);
  if (root.type !== undefined && root.type !== "object") return undefined;
  const properties = record(root.properties);
  const required = new Set(Array.isArray(root.required) ? root.required.filter((item): item is string => typeof item === "string") : []);
  const fields: ElicitationField[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    const property = record(raw);
    const base = { key, title: str(property.title) ?? key, ...(str(property.description) ? { description: str(property.description) } : {}), required: required.has(key) };
    const options = enumOptions(property);
    if (options) { fields.push({ ...base, kind: "enum", options: uniqueLabels(options) }); continue; }
    if (property.type === "array") {
      const items = enumOptions(record(property.items));
      if (!items) return undefined;
      fields.push({ ...base, kind: "multi", options: uniqueLabels(items), ...(num(property.minItems) !== undefined ? { minItems: num(property.minItems) } : {}), ...(num(property.maxItems) !== undefined ? { maxItems: num(property.maxItems) } : {}) });
      continue;
    }
    const type = property.type;
    if (type === "boolean") { fields.push({ ...base, kind: "boolean" }); continue; }
    if (type === "number" || type === "integer") {
      fields.push({ ...base, kind: type, ...(num(property.minimum) !== undefined ? { minimum: num(property.minimum) } : {}), ...(num(property.maximum) !== undefined ? { maximum: num(property.maximum) } : {}) });
      continue;
    }
    if (type === "string" || type === undefined) {
      fields.push({ ...base, kind: "string", ...(str(property.format) ? { format: str(property.format) } : {}), ...(num(property.minLength) !== undefined ? { minLength: num(property.minLength) } : {}), ...(num(property.maxLength) !== undefined ? { maxLength: num(property.maxLength) } : {}) });
      continue;
    }
    return undefined;
  }
  return fields;
}

/** Parse a free-text answer for one field. Throws a user-facing message when invalid. */
export function parseElicitationAnswer(field: ElicitationField, answer: string): unknown {
  const value = answer.trim();
  switch (field.kind) {
    case "number":
    case "integer": {
      const parsed = Number(value);
      if (!value || !Number.isFinite(parsed)) throw new Error("Enter a number");
      if (field.kind === "integer" && !Number.isInteger(parsed)) throw new Error("Enter a whole number");
      if (field.minimum !== undefined && parsed < field.minimum) throw new Error(`Must be at least ${field.minimum}`);
      if (field.maximum !== undefined && parsed > field.maximum) throw new Error(`Must be at most ${field.maximum}`);
      return parsed;
    }
    case "multi": {
      const parts = value.split(/[,\n]/).map((part) => part.trim()).filter(Boolean);
      const picked = parts.map((part) => field.options.find((option) => option.label === part || option.value === part));
      if (picked.some((option) => !option)) throw new Error(`Choose from: ${field.options.map((option) => option.label).join(", ")}`);
      const values = [...new Set(picked.map((option) => option!.value))];
      if (field.minItems !== undefined && values.length < field.minItems) throw new Error(`Choose at least ${field.minItems}`);
      if (field.maxItems !== undefined && values.length > field.maxItems) throw new Error(`Choose at most ${field.maxItems}`);
      return values;
    }
    case "string": {
      if (field.minLength !== undefined && value.length < field.minLength) throw new Error(`Enter at least ${field.minLength} characters`);
      if (field.maxLength !== undefined && value.length > field.maxLength) throw new Error(`Enter at most ${field.maxLength} characters`);
      if (field.format === "email" && !/^[^\s@]+@[^\s@]+$/.test(value)) throw new Error("Enter an email address");
      if ((field.format === "uri" || field.format === "url") && !/^[a-z][a-z0-9+.-]*:\S+$/i.test(value)) throw new Error("Enter a URL");
      return value;
    }
    default:
      return value;
  }
}

/** Only web links are shown for URL-mode elicitations; other schemes are declined. */
export function safeElicitationUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : undefined;
  } catch { return undefined; }
}
