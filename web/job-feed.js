import {request} from './api.js';

/* The download queue, asked for as what changed since the last answer
   (reruns/job_changes.py), so a running playlist does not resend a row per
   video every second for one progress bar moving. The merged list has the
   same shape /api/jobs always had, so nothing that reads it needs to know. */

/** Applies one `?since=` answer to the jobs known so far, by id. */
export function mergeJobChanges(known, answer) {
  const before = answer.full ? new Map() : new Map(known.map(job => [job.id, job]));
  const byId = new Map(answer.jobs.map(job => [job.id, job]));
  return answer.order.map(id => {
    const change = byId.get(id);
    const old = before.get(id);
    if (!change || change.unchanged) return old;
    if (!('itemIds' in change)) {
      // Only some of its videos moved; the job's own fields and order stand.
      const fresh = new Map(change.items.map(item => [String(item.id), item]));
      return {...old, items: (old?.items || []).map(item => fresh.get(String(item.id)) || item)};
    }
    const {itemIds, items: changedItems, ...fields} = change;
    const fresh = new Map(changedItems.map(item => [String(item.id), item]));
    const held = new Map((old?.items || []).map(item => [String(item.id), item]));
    return {...fields, items: itemIds.map(itemId => fresh.get(itemId) || held.get(itemId)).filter(Boolean)};
  }).filter(Boolean);
}

export function createJobFeed(fetchJson = request) {
  let since = '';
  let jobs = [];
  // A poll brought forward by an action can meet one already on its way;
  // two answers to the same token applied out of order would step back.
  let inFlight = null;
  async function ask() {
    try {
      const answer = await fetchJson(`/api/jobs?since=${encodeURIComponent(since)}`);
      jobs = mergeJobChanges(jobs, answer);
      since = answer.since;
      return jobs;
    } finally {
      inFlight = null;
    }
  }
  return {
    read() {
      inFlight ||= ask();
      return inFlight;
    },
  };
}
