import type { AgentRequest, ChangeRead, RequestPhase } from '@/bridge';

const DENIED: Record<Extract<RequestPhase, { kind: 'denied' }>['reason'], string> = {
  user: 'Denied',
  expired: 'Expired',
  agentRevoked: 'Agent disconnected',
};

/** One line for History: what the request got or did. */
export function requestOutcome({ phase, writes }: AgentRequest) {
  switch (phase.kind) {
    case 'received':
      return 'Running…';
    case 'shared':
      return phase.titles.length ? `Read ${phase.titles.join(', ')}` : 'Read nothing';
    case 'note':
      switch (phase.result.kind) {
        case 'notes':
          return `Read ${plural(phase.result.titles.length, 'note')}`;
        case 'folders':
          return `Read ${plural(phase.result.count, 'folder name')}`;
        case 'note':
          return writes ? 'Done' : 'Read the note';
        case 'conflict':
          return `Not saved: the note changed (now version ${phase.result.currentVersion})`;
      }
      break;
    case 'nothingFound':
      return 'Nothing matched';
    case 'denied':
      return DENIED[phase.reason];
    case 'failed':
      return `Could not run · ${phase.reason}`;
  }
}

export function readOutcome({ outcome }: ChangeRead) {
  if (outcome.kind === 'rateLimited') return 'Asked for changes too often. Puffer declined.';
  const shown = outcome.shown ? `Read ${plural(outcome.shown, 'change')}` : 'Checked for changes, nothing new';
  const away = outcome.kind === 'servedFromPage' ? ' while Puffer was closed' : '';
  return `${shown}${away}`;
}

export function megabytes(bytes: number) {
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

export function ago(ms: number, now = Date.now()) {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ms).toLocaleDateString();
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
