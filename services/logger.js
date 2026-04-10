// Production-safe logger — silences console.log in release builds
// Usage: import { log, warn, error } from '../services/logger';

const isDev = typeof __DEV__ !== 'undefined' ? __DEV__ : false;

export const log = isDev ? console.log.bind(console) : () => {};
export const warn = isDev ? console.warn.bind(console) : () => {};
export const error = isDev ? console.error.bind(console) : () => {};

export default { log, warn, error };
