import { describe, expect, it } from 'vitest';
import { OUTPUT_FORMATS, resolveOutPlan } from '../src/output/plan.js';

describe('output plan', () => {
  it('defines the public formats once', () => {
    expect(OUTPUT_FORMATS).toEqual(['json', 'ndjson', 'table', 'csv']);
  });

  it.each([
    ['result.json', 'json'],
    ['result.ndjson', 'ndjson'],
    ['result.csv', 'csv'],
  ] as const)('recognizes %s as %s', (filePath, format) => {
    expect(resolveOutPlan(filePath, 'json')).toMatchObject({
      path: filePath,
      format,
      recognizedExtension: true,
      streamable: format !== 'table',
    });
  });

  it('uses the fallback for unknown and missing extensions', () => {
    expect(resolveOutPlan('result.xlsx', 'csv')).toMatchObject({
      format: 'csv', extension: '.xlsx', recognizedExtension: false, streamable: true,
    });
    expect(resolveOutPlan('result.txt', 'table')).toMatchObject({
      format: 'table', extension: '.txt', recognizedExtension: false, streamable: false,
    });
  });
});
