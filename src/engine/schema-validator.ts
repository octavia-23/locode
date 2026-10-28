import { ToolDefinition, ToolParameters, ToolParameterProperty } from '../types.js';
import { ToolValidationResult } from './types.js';

export class ToolSchemaValidator {
  /**
   * Validates tool invocation arguments against the tool's JSON schema definition.
   */
  static validate(tool: ToolDefinition, rawArgs: any): ToolValidationResult {
    const errors: string[] = [];

    if (rawArgs === null || rawArgs === undefined || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
      return {
        valid: false,
        errors: [`Tool "${tool.name}" arguments must be a JSON object, got ${Array.isArray(rawArgs) ? 'array' : typeof rawArgs}.`]
      };
    }

    const schema: ToolParameters = tool.parameters;
    const required = schema.required || [];
    const properties = schema.properties || {};

    // 1. Required property checks
    for (const reqField of required) {
      if (!(reqField in rawArgs) || rawArgs[reqField] === undefined || rawArgs[reqField] === null) {
        errors.push(`Missing required parameter "${reqField}" for tool "${tool.name}".`);
      }
    }

    // 2. Type and enum checks on provided properties
    for (const [key, value] of Object.entries(rawArgs)) {
      if (value === undefined || value === null) {
        continue;
      }

      const propSchema: ToolParameterProperty | undefined = properties[key];
      if (!propSchema) {
        // Unknown argument: allowed unless strict schema requires no extra properties,
        // but not fatal to maintain model compatibility
        continue;
      }

      const expectedType = propSchema.type?.toLowerCase();

      switch (expectedType) {
        case 'string':
          if (typeof value !== 'string') {
            errors.push(`Parameter "${key}" must be a string, got ${typeof value}.`);
          }
          break;
        case 'number':
        case 'integer':
          if (typeof value !== 'number' || isNaN(value)) {
            // Check if string can be coerced cleanly
            if (typeof value === 'string' && !isNaN(Number(value)) && value.trim() !== '') {
              // Valid numeric string, allow coercion in dispatcher
            } else {
              errors.push(`Parameter "${key}" must be a number, got ${typeof value}.`);
            }
          }
          break;
        case 'boolean':
          if (typeof value !== 'boolean') {
            if (value === 'true' || value === 'false') {
              // Valid boolean string
            } else {
              errors.push(`Parameter "${key}" must be a boolean, got ${typeof value}.`);
            }
          }
          break;
        case 'array':
          if (!Array.isArray(value)) {
            errors.push(`Parameter "${key}" must be an array, got ${typeof value}.`);
          }
          break;
        case 'object':
          if (typeof value !== 'object' || Array.isArray(value)) {
            errors.push(`Parameter "${key}" must be an object, got ${Array.isArray(value) ? 'array' : typeof value}.`);
          }
          break;
      }

      // Enum check
      if (propSchema.enum && Array.isArray(propSchema.enum) && propSchema.enum.length > 0) {
        if (!propSchema.enum.includes(String(value))) {
          errors.push(`Parameter "${key}" has invalid value "${String(value)}". Allowed values: ${propSchema.enum.join(', ')}.`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}
