/**
 * Guided-tour engine: a deterministic, scripted walkthrough of every tab.
 *
 * Unlike the Jarvis "tour" (model-driven, best-effort), this engine plays a
 * fixed script (steps.ts) so a brand-new user gets the same complete,
 * correctly-ordered walkthrough every time. The TourOverlay component renders
 * the state held here; the engine itself is pure state + transitions so it can
 * be driven from Settings, the welcome wizard, or tests.
 *
 * Role-aware: tabs whose `capability` the signed-in principal does not hold are
 * filtered out up front, so a viewer is never walked into an access-denied
 * page. Progress persists to localStorage so an interrupted tour can resume.
 */

import { signal } from '@preact/signals';
import { hasCapability } from '../auth';
import { TOUR_TABS, type TourStep, type TourTab } from './steps';

export interface TourState {
  /** The capability-filtered tab list this run walks through. */
  tabs: TourTab[];
  tabIdx: number;
  stepIdx: number;
  /** Single-tab mode (launched for one tab from Settings): finish at tab end. */
  single: boolean;
}

export const tourState = signal<TourState | null>(null);

const PROGRESS_KEY = 'cce_tour_progress';

/** Tabs the current principal can actually visit, in sidebar order. */
export function visibleTourTabs(): TourTab[] {
  return TOUR_TABS.filter((t) => !t.capability || hasCapability(t.capability));
}

export interface SavedTourProgress {
  route: string;
  label: string;
}

/** Where an earlier, unfinished full tour left off (null when none). */
export function savedTourProgress(): SavedTourProgress | null {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { route?: string };
    if (!parsed.route) return null;
    const tab = visibleTourTabs().find((t) => t.route === parsed.route);
    return tab ? { route: tab.route, label: tab.label } : null;
  } catch {
    return null;
  }
}

function persistProgress(st: TourState): void {
  if (st.single) return; // single-tab tours don't move the full-tour bookmark
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ route: st.tabs[st.tabIdx].route }));
  } catch {
    /* storage unavailable — tour still works, just won't resume */
  }
}

function clearProgress(): void {
  try {
    localStorage.removeItem(PROGRESS_KEY);
  } catch {
    /* ignore */
  }
}

export interface StartTourOptions {
  /** Start from (and in `single` mode, only cover) this tab route. */
  route?: string;
  /** Tour just this one tab, then finish. */
  single?: boolean;
  /** Resume the saved full-tour position when one exists. */
  resume?: boolean;
}

export function startTour(opts: StartTourOptions = {}): boolean {
  const all = visibleTourTabs();
  if (all.length === 0) return false;
  let tabs = all;
  let tabIdx = 0;
  if (opts.single && opts.route) {
    const tab = all.find((t) => t.route === opts.route);
    if (!tab) return false;
    tabs = [tab];
  } else if (opts.resume) {
    const saved = savedTourProgress();
    if (saved) tabIdx = Math.max(0, all.findIndex((t) => t.route === saved.route));
  } else if (opts.route) {
    const idx = all.findIndex((t) => t.route === opts.route);
    if (idx >= 0) tabIdx = idx;
  }
  const st: TourState = { tabs, tabIdx, stepIdx: 0, single: !!opts.single };
  tourState.value = st;
  persistProgress(st);
  return true;
}

/** Exit the tour. Completing clears the resume bookmark; quitting keeps it. */
export function endTour(completed: boolean): void {
  const st = tourState.value;
  tourState.value = null;
  if (completed || (st && !st.single)) {
    // A finished tour clears the bookmark. An aborted full tour keeps it so
    // Settings can offer "Resume where you left off" — except when the user
    // quit on the very first tab, which reads as "not interested".
    if (completed || (st && st.tabIdx === 0)) clearProgress();
  }
}

export function currentTab(st: TourState): TourTab {
  return st.tabs[st.tabIdx];
}

export function currentStep(st: TourState): TourStep {
  return currentTab(st).steps[st.stepIdx];
}

/** Advance one step; rolls into the next tab; finishes at the very end. */
export function nextStep(): void {
  const st = tourState.value;
  if (!st) return;
  const tab = currentTab(st);
  if (st.stepIdx + 1 < tab.steps.length) {
    tourState.value = { ...st, stepIdx: st.stepIdx + 1 };
    return;
  }
  advanceTab(st);
}

/** Jump past the rest of the current tab. */
export function skipTab(): void {
  const st = tourState.value;
  if (!st) return;
  advanceTab(st);
}

function advanceTab(st: TourState): void {
  if (st.tabIdx + 1 >= st.tabs.length) {
    endTour(true);
    return;
  }
  const next: TourState = { ...st, tabIdx: st.tabIdx + 1, stepIdx: 0 };
  tourState.value = next;
  persistProgress(next);
}

/** Step back one; rolls into the previous tab's last step. */
export function prevStep(): void {
  const st = tourState.value;
  if (!st) return;
  if (st.stepIdx > 0) {
    tourState.value = { ...st, stepIdx: st.stepIdx - 1 };
    return;
  }
  if (st.tabIdx > 0) {
    const prevTab = st.tabs[st.tabIdx - 1];
    const back: TourState = { ...st, tabIdx: st.tabIdx - 1, stepIdx: prevTab.steps.length - 1 };
    tourState.value = back;
    persistProgress(back);
  }
}

/**
 * The step the user is on, counted across the whole run (for "Step 12 of 80").
 * Optional steps that were auto-skipped still count — the denominator is the
 * script length, which is stable and honest enough for a progress bar.
 */
export function tourProgress(st: TourState): { done: number; total: number } {
  let done = 0;
  let total = 0;
  st.tabs.forEach((tab, i) => {
    if (i < st.tabIdx) done += tab.steps.length;
    total += tab.steps.length;
  });
  done += st.stepIdx + 1;
  return { done, total };
}
