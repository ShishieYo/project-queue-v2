// queue-core.js
// All read/write logic for the queue lives here so the kiosk, staff panel,
// and display board share one implementation. Import what you need.

import { db } from "./firebase-config.js";

// Every onSnapshot() below reports failures here instead of failing silently.
// Set window.__queueCoreOnError from the page (e.g. to show a toast) to see
// these live instead of only in the browser console. A missing composite
// index is the most common cause — the error message includes a direct link
// to create it.
function reportListenerError(err) {
  console.error('[queue-core] Firestore listener error:', err);
  try {
    if (typeof window !== 'undefined' && typeof window.__queueCoreOnError === 'function') {
      window.__queueCoreOnError(err);
    }
  } catch (e) { /* never let the error handler itself throw */ }
}

import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc,
  query, where, orderBy, limit, onSnapshot, runTransaction, serverTimestamp, increment, Timestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

// Service list is static, same as your kiosk's original hardcoded SERVICE_LIST —
// no Firestore round-trip needed just to know the services.
export const SERVICES = [
  { code: 'C',   name: 'Certification' },
  { code: 'A',   name: 'Authentication' },
  { code: 'EA',  name: 'Exam Application' },
  { code: 'R',   name: 'Renewal' },
  { code: 'IR',  name: 'Initial Registration' },
  { code: 'D',   name: 'Duplicate ID' },
  { code: 'COR', name: 'Certificate of Registration' },
  { code: 'SV',  name: 'Stateboard Verification' },
  { code: 'RES', name: 'Real Estate Salesperson' },
  { code: 'MED', name: 'Medical Representative' },
  { code: 'RDA', name: 'Accreditation' }
];

// Standard reasons a client can be marked priority (RA 10754 / Magna Carta
// categories). Optional context stored alongside the priority flag.
export const PRIORITY_REASONS = ['Senior Citizen', 'PWD', 'Pregnant Woman', 'Solo Parent', 'Other'];
const CODE_BY_NAME = Object.fromEntries(SERVICES.map(s => [s.name, s.code]));

// ================= Manila-timezone date helpers =================
// Every "which calendar day is this?" decision in this file goes through here.
// Asia/Manila is a fixed UTC+8 offset (no DST), so this is safe year-round.
// This matters because `new Date().toISOString()` is always UTC — using it
// directly to compute "today" mislabels any transaction that happens between
// 12:00am–7:59am Manila time as belonging to the PREVIOUS calendar day.
export function getManilaDateString(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date || new Date());
}
export function getManilaYesterdayString() {
  return getManilaDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));
}
function manilaDayBounds(dateStr) {
  return {
    start: new Date(`${dateStr}T00:00:00+08:00`),
    end: new Date(`${dateStr}T23:59:59.999+08:00`)
  };
}

// ================= Cycle (date-based, auto-rolls at midnight Asia/Manila) =================
// The "cycle" identifies the current queue day. It's built from today's date
// in Asia/Manila time + a manual "bump" number (default 1). Every ticket,
// once written, is tagged with the cycle that was active at creation time.
// Because the date component changes automatically at midnight, no server or
// scheduled job is needed — the next ticket generated after midnight simply
// gets a new cycle, so numbering restarts and yesterday's waiting tickets stop
// matching "today" in every query. Clicking Reset still works mid-day too —
// it just bumps the number, which changes the cycle immediately without
// waiting for the date to roll over.
async function getBumpNumber() {
  const snap = await getDoc(doc(db, 'systemState', 'current'));
  return snap.exists() ? (snap.data().activeCycle || 1) : 1;
}
async function getActiveCycle() {
  const bump = await getBumpNumber();
  return `${getManilaDateString()}_${bump}`;
}
export function listenSystemState(cb) {
  return onSnapshot(doc(db, 'systemState', 'current'), snap => {
    cb(snap.exists() ? snap.data() : { activeCycle: 1 });
  }, reportListenerError);
}

// Self-heal: if a counter still shows "Now Serving" a ticket from a previous
// cycle (e.g. nobody touched the panel between closing time and the next
// morning), idle it out. Safe to call anytime — it's a no-op when nothing's stale.
export async function cleanupStaleCounters() {
  const cycle = await getActiveCycle();
  const counters = await getDocs(collection(db, 'counters'));
  for (const c of counters.docs) {
    const data = c.data();
    if (data.status !== 'Now Serving' || !data.ticketId) continue;
    try {
      const ticketSnap = await getDoc(doc(db, 'queue', data.ticketId));
      const ticketCycle = ticketSnap.exists() ? ticketSnap.data().cycle : null;
      if (ticketCycle !== cycle) {
        await updateDoc(c.ref, { status: 'Idle', ticket: '', service: '', transactionType: '', priority: false, priorityReason: '', ticketId: '', recallCount: 0, updatedAt: serverTimestamp() });
      }
    } catch (e) { /* best-effort — skip on error */ }
  }
}

// ================= Generate a ticket (kiosk) =================
// isPriority/priorityReason: the client's actual service is still `serviceName`
// (e.g. "Renewal") — priority is a flag on top of it, not a separate service.
// queueRank drives ordering in callNext: 0=priority, 1=transferred, 2=normal.
export async function addQueueTicket(serviceName, isPriority, priorityReason) {
  const code = CODE_BY_NAME[serviceName];
  if (!code) throw new Error('Invalid service.');
  const cycle = await getActiveCycle();
  const counterRef = doc(db, 'serviceCounters', `${code}_${cycle}`);
  return await runTransaction(db, async (tx) => {
    const snap = await tx.get(counterRef);
    const next = (snap.exists() ? (snap.data().lastNumber || 0) : 0) + 1;
    tx.set(counterRef, { lastNumber: next }, { merge: true });
    const ticket = `${code}-${String(next).padStart(3, '0')}`;
    const queueRef = doc(collection(db, 'queue'));
    tx.set(queueRef, {
      ticket, service: serviceName, transactionType: '',
      priority: !!isPriority, priorityReason: isPriority ? (priorityReason || '') : '',
      status: 'Waiting', counter: '', cycle, transferred: false,
      queueRank: isPriority ? 0 : 2,
      createdAt: serverTimestamp()
    });
    return { ticket, service: serviceName, priority: !!isPriority, priorityReason: isPriority ? (priorityReason || '') : '' };
  });
}

// ================= Call next (staff) =================
// Ordering within any service's queue: priority tickets first (queueRank 0),
// then transferred T-XXX tickets (queueRank 1), then everyone else (queueRank 2).
// Staff never need to separately select "Priority Transaction" — calling next
// for e.g. "Renewal" automatically serves a priority Renewal client first,
// since the priority flag lives on the real service now, not a fake one.
export async function callNext(counterId, serviceFilter) {
  const cycle = await getActiveCycle();
  const clauses = [collection(db, 'queue'), where('status', '==', 'Waiting'), where('cycle', '==', cycle)];
  if (serviceFilter) clauses.push(where('service', '==', serviceFilter));
  clauses.push(orderBy('queueRank', 'asc'), orderBy('createdAt', 'asc'), limit(15));
  const snap = await getDocs(query(...clauses));

  for (const candidate of snap.docs) {
    try {
      return await runTransaction(db, async (tx) => {
        const fresh = await tx.get(candidate.ref);
        if (!fresh.exists() || fresh.data().status !== 'Waiting') throw new Error('taken');
        const data = fresh.data();
        tx.update(candidate.ref, { status: 'Now Serving', counter: counterId, calledAt: serverTimestamp() });
        tx.set(doc(db, 'counters', counterId), {
          status: 'Now Serving', ticket: data.ticket, service: data.service,
          transactionType: data.transactionType || '', priority: !!data.priority, priorityReason: data.priorityReason || '', ticketId: candidate.id,
          recallCount: 0, updatedAt: serverTimestamp()
        }, { merge: true });
        return {
          ticket: data.ticket, service: data.service, transactionType: data.transactionType || '',
          priority: !!data.priority, priorityReason: data.priorityReason || '', transferred: !!data.transferred,
          counter: counterId
        };
      });
    } catch (e) { /* another counter grabbed it first — try the next candidate */ }
  }
  throw new Error(serviceFilter ? `No clients waiting for ${serviceFilter}.` : 'No clients waiting.');
}

// ================= Recall previous (staff) =================
export async function recallPrevious(counterId) {
  const counterSnap = await getDoc(doc(db, 'counters', counterId));
  if (!counterSnap.exists() || !counterSnap.data().ticketId) throw new Error(`No previous transaction ${counterId}.`);
  const c = counterSnap.data();
  await updateDoc(doc(db, 'queue', c.ticketId), { calledAt: serverTimestamp() });
  await updateDoc(doc(db, 'counters', counterId), { recallCount: increment(1), updatedAt: serverTimestamp() });
  return { ticket: c.ticket, service: c.service, transactionType: c.transactionType || '', counter: counterId };
}

// ================= Transfer client (staff) =================
// Marks the counter's current ticket Done (same accounting as Mark Done), then
// issues a new T-XXX ticket for a different service, tagged transferred: true
// so callNext serves it ahead of regular waiting tickets for that service.
export async function transferClient(counterId, targetService) {
  const counterRef = doc(db, 'counters', counterId);
  const counterSnap = await getDoc(counterRef);
  if (!counterSnap.exists() || !counterSnap.data().ticketId) throw new Error('No active ticket to transfer.');
  const c = counterSnap.data();
  const cycle = await getActiveCycle();

  await updateDoc(doc(db, 'queue', c.ticketId), { status: 'Done', doneAt: serverTimestamp() });
  await setDoc(doc(db, 'dailySummary', getManilaDateString()), {
    perCounter: { [counterId]: increment(1) },
    perService: { [c.service]: increment(1) }
  }, { merge: true });

  const counterKeyRef = doc(db, 'serviceCounters', `T_${cycle}`);
  const newTicket = await runTransaction(db, async (tx) => {
    const snap = await tx.get(counterKeyRef);
    const next = (snap.exists() ? (snap.data().lastNumber || 0) : 0) + 1;
    tx.set(counterKeyRef, { lastNumber: next }, { merge: true });
    const ticket = `T-${String(next).padStart(3, '0')}`;
    const queueRef = doc(collection(db, 'queue'));
    tx.set(queueRef, {
      ticket, service: targetService, transactionType: '', priority: false, priorityReason: '',
      status: 'Waiting', counter: '', cycle, transferred: true, transferredFrom: counterId, queueRank: 1,
      createdAt: serverTimestamp()
    });
    return ticket;
  });

  await setDoc(counterRef, {
    status: 'Idle', ticket: '', service: '', transactionType: '', priority: false, priorityReason: '', ticketId: '', recallCount: 0, updatedAt: serverTimestamp()
  }, { merge: true });

  return { newTicket, targetService, fromCounter: counterId };
}

// ================= Mark done (staff) =================
export async function markDone(counterId) {
  const counterRef = doc(db, 'counters', counterId);
  const counterSnap = await getDoc(counterRef);
  if (!counterSnap.exists()) throw new Error('Counter not found.');
  const c = counterSnap.data();
  let message = 'No ticket marked as done.';
  if (c.ticketId) {
    await updateDoc(doc(db, 'queue', c.ticketId), { status: 'Done', doneAt: serverTimestamp() });
    await setDoc(doc(db, 'dailySummary', getManilaDateString()), {
      perCounter: { [counterId]: increment(1) },
      perService: { [c.service]: increment(1) }
    }, { merge: true });
    message = `${c.ticket} marked as done.`;
  }
  await setDoc(counterRef, {
    status: 'Idle', ticket: '', service: '', transactionType: '', priority: false, priorityReason: '', ticketId: '', recallCount: 0, updatedAt: serverTimestamp()
  }, { merge: true });
  return { message };
}

// ================= PIN verification (used by reset / add counter / delete counter) =================
async function verifyPin(pin, actor, collectionName, extra = {}, forceId = null) {
  const reqId = forceId || doc(collection(db, collectionName)).id; // local id, no write yet
  try {
    await setDoc(doc(db, collectionName, reqId), { pin, actor: actor || 'Unknown', requestedAt: serverTimestamp(), ...extra });
  } catch (e) {
    throw new Error('Invalid admin PIN.');
  }
  return reqId;
}

// ================= Reset queue (admin) =================
export async function resetQueueSystem(pin, actor) {
  const reqId = await verifyPin(pin, actor, 'resetRequests');
  const bump = await getBumpNumber();
  await updateDoc(doc(db, 'systemState', 'current'), {
    activeCycle: bump + 1, lastRequestId: reqId, resetBy: actor || 'Unknown', resetAt: serverTimestamp()
  });
  const counters = await getDocs(collection(db, 'counters'));
  await Promise.all(counters.docs.map(c => updateDoc(c.ref, {
    status: 'Idle', ticket: '', service: '', transactionType: '', priority: false, priorityReason: '', ticketId: '', recallCount: 0, updatedAt: serverTimestamp()
  })));
  await addDoc(collection(db, 'adminLogs'), { action: 'Manual Reset', actor: actor || 'Unknown', details: '', timestamp: serverTimestamp() });
}

// ================= Add counter (admin) =================
export async function addCounter(counterId, pin, actor) {
  const existing = await getDoc(doc(db, 'counters', counterId));
  if (existing.exists()) throw new Error('Counter already exists.');
  const reqId = await verifyPin(pin, actor, 'counterRequests', { counterId });
  await setDoc(doc(db, 'counters', counterId), {
    status: 'Idle', ticket: '', service: '', transactionType: '', priority: false, priorityReason: '', ticketId: '', recallCount: 0,
    requestId: reqId, updatedAt: serverTimestamp()
  });
  await addDoc(collection(db, 'adminLogs'), { action: 'Add Counter', actor: actor || 'Unknown', details: counterId, timestamp: serverTimestamp() });
}

// ================= Delete counter (admin) =================
// PIN verification writes to counterDeleteRequests/{counterId} — keyed by the
// counterId itself (not a random id) so the Firestore delete rule for
// counters/{counterId} can check for its existence using only the path
// parameter, since delete operations don't carry a request.resource payload.
// Requires firestore.rules to include the counterDeleteRequests collection
// and the counters delete rule — see the rules file.
export async function deleteCounter(counterId, pin, actor) {
  const ref = doc(db, 'counters', counterId);
  const existing = await getDoc(ref);
  if (!existing.exists()) throw new Error('Counter does not exist.');
  if (existing.data().status === 'Now Serving') throw new Error('Cannot delete a counter that is currently serving a client — mark it done first.');
  await verifyPin(pin, actor, 'counterDeleteRequests', { counterId }, counterId);
  await deleteDoc(ref);
  await addDoc(collection(db, 'adminLogs'), { action: 'Delete Counter', actor: actor || 'Unknown', details: counterId, timestamp: serverTimestamp() });
}

// ================= Live listeners (replace all 2-second polling) =================
export function listenCounters(cb) {
  return onSnapshot(collection(db, 'counters'), snap => {
    const list = snap.docs.map(d => ({ counterId: d.id, ...d.data() }));
    list.sort((a, b) => a.counterId.localeCompare(b.counterId));
    cb(list);
  }, reportListenerError);
}
export function listenCounter(counterId, cb) {
  return onSnapshot(doc(db, 'counters', counterId), snap => {
    cb(snap.exists() ? { counterId, ...snap.data() } : null);
  }, reportListenerError);
}

// Live waiting-ticket counts per service (drives the summary cards)
export async function listenWaitingSummary(cb) {
  const cycle = await getActiveCycle();
  const q = query(collection(db, 'queue'), where('status', '==', 'Waiting'), where('cycle', '==', cycle));
  return onSnapshot(q, snap => {
    const counts = {};
    SERVICES.forEach(s => counts[s.name] = 0);
    snap.forEach(d => { const s = d.data().service; counts[s] = (counts[s] || 0) + 1; });
    cb(counts);
  }, reportListenerError);
}

// Live list of waiting tickets for one service (drives "Priority Watch")
export async function listenWaitingQueue(serviceFilter, cb) {
  const cycle = await getActiveCycle();
  const clauses = [collection(db, 'queue'), where('status', '==', 'Waiting'), where('cycle', '==', cycle)];
  if (serviceFilter) clauses.push(where('service', '==', serviceFilter));
  clauses.push(orderBy('createdAt', 'asc'));
  return onSnapshot(query(...clauses), snap => {
    cb(snap.docs.map(d => ({
      ticket: d.data().ticket,
      service: d.data().service,
      transactionType: d.data().transactionType || '',
      priority: !!d.data().priority,
      priorityReason: d.data().priorityReason || '',
      timestamp: d.data().createdAt ? d.data().createdAt.toDate().toISOString() : ''
    })));
  }, reportListenerError);
}

// ================= Reports: completed tickets across a date range =================
// startDateStr/endDateStr: 'YYYY-MM-DD' strings (Asia/Manila calendar days),
// e.g. straight from an <input type="date">. Using strings instead of JS Date
// objects here avoids any ambiguity from the browser's own local timezone —
// the range is always computed as Manila midnight-to-midnight regardless of
// what timezone the staff computer itself is set to.
export async function getCompletedTicketsInRange(startDateStr, endDateStr) {
  const { start } = manilaDayBounds(startDateStr);
  const { end } = manilaDayBounds(endDateStr);
  const q = query(
    collection(db, 'queue'),
    where('doneAt', '>=', Timestamp.fromDate(start)),
    where('doneAt', '<=', Timestamp.fromDate(end)),
    orderBy('doneAt', 'asc')
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => {
    const v = d.data();
    return {
      ticket: v.ticket || '',
      service: v.service || '',
      transactionType: v.transactionType || '',
      priority: !!v.priority,
      priorityReason: v.priorityReason || '',
      counter: v.counter || '',
      transferred: !!v.transferred,
      createdAt: v.createdAt ? v.createdAt.toDate() : null,
      calledAt: v.calledAt ? v.calledAt.toDate() : null,
      doneAt: v.doneAt ? v.doneAt.toDate() : null
    };
  });
}

export async function getDailySummary(dateStr) {
  const d = dateStr || getManilaDateString();
  const snap = await getDoc(doc(db, 'dailySummary', d));
  if (!snap.exists()) return { date: d, perCounter: {}, perService: {} };
  const data = snap.data();
  return { date: d, perCounter: data.perCounter || {}, perService: data.perService || {} };
}

// Live version — charts redraw the instant a ticket is marked Done, no polling.
export function listenDailySummary(dateStr, cb) {
  const d = dateStr || getManilaDateString();
  return onSnapshot(doc(db, 'dailySummary', d), snap => {
    const data = snap.exists() ? snap.data() : {};
    cb({ date: d, perCounter: data.perCounter || {}, perService: data.perService || {} });
  }, reportListenerError);
}
