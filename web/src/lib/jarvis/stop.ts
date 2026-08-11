/**
 * One "stop whatever Jarvis is doing" entry point.
 *
 * The scripted walkthrough, the text-path narration and the live voice session
 * are three independent runners. Before this, only the /jarvis hero orb knew how
 * to pick the right one — so a tour started there and then left behind (click any
 * other tab) kept navigating the dashboard out from under you, with the spotlight
 * dimming the page and no control that could stop it. Anything offering the user
 * a way out (the widget's X, the widget orb, Escape) calls this instead of
 * guessing which runner is live.
 *
 * Every step is idempotent, so calling it when Jarvis is already idle is a no-op.
 */

import { jarvisCaption, jarvisHighlight, jarvisNavChip } from './tools';
import { isNarrating, stopJarvisNarration } from './textClient';
import { isWalkthroughRunning, stopDemoWalkthrough } from './walkthrough';
import { getVoiceClient } from './voiceClient';

/** True when something is actively running (so a click can mean "stop"). */
export function isJarvisBusy(): boolean {
  return isWalkthroughRunning() || isNarrating();
}

export function stopJarvis(): void {
  if (isWalkthroughRunning()) stopDemoWalkthrough();
  if (isNarrating()) stopJarvisNarration();
  getVoiceClient().disconnect();
  // Clear the HUD too: the spotlight's 9999px box-shadow dims the whole page, so
  // leaving it up after a stop still reads as "I can't click anything".
  jarvisHighlight.value = null;
  jarvisCaption.value = '';
  jarvisNavChip.value = null;
}
