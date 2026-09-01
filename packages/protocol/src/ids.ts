/**
 * Session ID / task ID generation (docs/IMPLEMENTATION_PLAN.md Phase 1).
 *
 * ULIDs are lexicographically sortable by creation time and URL-safe, which
 * keeps `redpen list` output naturally ordered without a separate sort key.
 */
import { ulid } from 'ulid';

export function generateSessionId(): string {
  return `rps_${ulid()}`;
}

export function generateTaskId(): string {
  return `rpt_${ulid()}`;
}

export function generateFrameId(): string {
  return `frm_${ulid()}`;
}

export function generateGroupId(): string {
  return `grp_${ulid()}`;
}

export function generateMarkId(): string {
  return `mrk_${ulid()}`;
}

export function generateTargetId(): string {
  return `tgt_${ulid()}`;
}

export function generateReferenceId(): string {
  return `ref_${ulid()}`;
}

const ID_PREFIX_PATTERN = /^(rps|rpt|frm|grp|mrk|tgt|ref)_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isValidRedpenId(id: string): boolean {
  return ID_PREFIX_PATTERN.test(id);
}
