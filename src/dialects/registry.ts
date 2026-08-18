import type { DriverName } from '../types.js';
import type { Dialect } from './types.js';
import { getDriverDescriptor } from './descriptors.js';

export function getDialect(driver: DriverName): Dialect {
  return getDriverDescriptor(driver).createDialect();
}
