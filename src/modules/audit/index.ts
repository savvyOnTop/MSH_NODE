// Public interface of the audit module. audit.record() is the ONLY write path
// to audit_log anywhere in the codebase (CLAUDE.md module map).
import { insertAuditRow, type AuditRecordInput } from './repository.js';

export { auditRoutes } from './routes.js';
export type { AuditRecordInput };

export const audit = {
  record: (input: AuditRecordInput): Promise<void> => insertAuditRow(input),
};
