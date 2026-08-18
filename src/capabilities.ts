import { DEFAULT_LIMIT, DEFAULT_TIMEOUT_S, MAX_LIMIT, MAX_TIMEOUT_S } from './commands/common.js';
import { OUTPUT_FORMATS } from './output/plan.js';
import { DRIVER_NAMES, getDriverDescriptor } from './dialects/descriptors.js';
import { versioned } from './output/contract.js';


export function getCapabilities(): object {
  return versioned({
    commands: ['list', 'namespaces', 'tables', 'schema', 'query', 'capabilities'],
    statements: {
      keywords: ['select', 'with', 'show', 'explain', 'describe'],
      aliases: { desc: 'describe' },
    },
    limits: { defaultRows: DEFAULT_LIMIT, maxRows: MAX_LIMIT },
    timeouts: { defaultSeconds: DEFAULT_TIMEOUT_S, maxSeconds: MAX_TIMEOUT_S },
    output: {
      formats: OUTPUT_FORMATS,
      defaultFormat: 'json',
      stdoutDataOnly: true,
      diagnostics: 'stderr',
      duplicateColumnKeys: 'first label unchanged; later occurrences append #2, #3, ...',
    },
    drivers: DRIVER_NAMES.map((driver) => {
      const descriptor = getDriverDescriptor(driver);
      return {
        driver,
        protocol: descriptor.protocol,
        defaultPort: descriptor.connection.defaultPort,
        introspection: descriptor.introspection,
        readOnlyTransaction: descriptor.execution.readOnlyTransaction.strength,
        timeoutUnit: descriptor.execution.timeout.unit,
        cancellation: 'connection-close',
        rowLimit: descriptor.limit,
      };
    }),
  });
}
