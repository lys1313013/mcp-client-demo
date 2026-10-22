import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { JsonObject } from "./types.js";

const options = {
  allErrors: true,
  strict: false,
  validateFormats: false,
  ownProperties: true,
};
const draft7 = new Ajv(options);
const draft2020 = new Ajv2020(options);

export function validateArguments(
  schema: JsonObject,
  value: unknown,
): string[] {
  try {
    const validator = (
      String(schema.$schema ?? "").includes("draft-07") ? draft7 : draft2020
    ).compile(schema);
    if (validator(value)) return [];
    return (validator.errors ?? []).map((error) => {
      const field = error.instancePath || "/";
      if (error.keyword === "required")
        return `${field} 缺少必填字段 ${error.params.missingProperty}`;
      if (error.keyword === "additionalProperties")
        return `${field} 不允许字段 ${error.params.additionalProperty}`;
      return `${field} ${error.message}`;
    });
  } catch {
    return ["工具的 JSON Schema 无法校验，请检查服务端 Schema。"];
  }
}
