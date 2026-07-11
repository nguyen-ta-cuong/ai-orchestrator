function schema(type: string, properties: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, ...properties };
}

export function StringEnum(values: readonly string[]): Record<string, unknown> {
  return schema("string", { enum: [...values] });
}

export const Type = {
  Object(properties: Record<string, unknown>, options: Record<string, unknown> = {}) {
    return schema("object", { properties, ...options });
  },
  String(options: Record<string, unknown> = {}) {
    return schema("string", options);
  },
  Array(itemSchema: unknown, options: Record<string, unknown> = {}) {
    return schema("array", { items: itemSchema, ...options });
  },
  Optional(itemSchema: unknown) {
    return { ...itemSchema as Record<string, unknown>, optional: true };
  },
};
