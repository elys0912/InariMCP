import { z } from 'zod';
import { BROWSER_ACTIONS } from './action-names.js';

// The names themselves are in action-names.ts (no zod, for the Extension).
// index.ts exports that module directly: a re-export through this file would
// pull zod into a bundle that only uses the names.

/** Zod schema that validates a string as a known browser action */
export const BrowserActionSchema = z.enum(BROWSER_ACTIONS);
