import type { DocumentField } from "./blocks";
import type { DocumentValues } from "./validate";

// What the preview fills the declared fields with when the caller supplies nothing. The point of a
// preview is to show the LAYOUT, so the values only have to be shaped right and long enough that a
// column shows its real width — a table previewed with one 3-character description looks nothing
// like the same table with a service name in it.
//
// Deterministic given `now`, which is passed rather than read, so a test asserts bytes instead of
// asserting around today's date.
export function sampleValues(
  fields: DocumentField[],
  now: Date = new Date(),
): DocumentValues {
  const values: DocumentValues = {};
  for (const field of fields) {
    switch (field.type) {
      case "text":
        values[field.name] = field.description || field.label;
        break;
      case "number":
        values[field.name] = 3;
        break;
      case "currency":
        values[field.name] = 1250;
        break;
      case "date":
        values[field.name] = now.toISOString().slice(0, 10);
        break;
      case "lineItems":
        values[field.name] = [
          { description: `${field.label} 1`, quantity: 2, unitPrice: 450 },
          { description: `${field.label} 2`, quantity: 1, unitPrice: 1299.9 },
        ];
        break;
    }
  }
  return values;
}
