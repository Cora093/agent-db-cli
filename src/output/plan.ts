import path from 'node:path';

export const OUTPUT_FORMATS = ['json', 'ndjson', 'table', 'csv'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
export type StreamFileFormat = Exclude<OutputFormat, 'table'>;

const FORMAT_BY_EXTENSION: Readonly<Record<string, OutputFormat>> = {
  '.json': 'json',
  '.ndjson': 'ndjson',
  '.csv': 'csv',
};

export interface OutPlan {
  path: string;
  format: OutputFormat;
  extension: string;
  recognizedExtension: boolean;
  streamable: boolean;
}

export function resolveOutPlan(filePath: string, fallbackFormat: OutputFormat): OutPlan {
  const extension = path.extname(filePath).toLowerCase();
  const recognizedFormat = FORMAT_BY_EXTENSION[extension];
  const format = recognizedFormat ?? fallbackFormat;
  return {
    path: filePath,
    format,
    extension,
    recognizedExtension: recognizedFormat !== undefined,
    streamable: format !== 'table',
  };
}
