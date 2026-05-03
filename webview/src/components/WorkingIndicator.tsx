import React, { useEffect, useState } from 'react';
import styles from './WorkingIndicator.module.css';

const VERBS = [
  'Envisioning', 'Pondering', 'Cogitating', 'Reflecting', 'Mulling',
  'Considering', 'Analyzing', 'Examining', 'Exploring', 'Reasoning',
  'Thinking', 'Processing', 'Brewing', 'Brainstorming', 'Conjuring',
  'Contemplating', 'Deliberating', 'Musing', 'Ruminating', 'Synthesizing',
  'Formulating', 'Crafting', 'Composing', 'Devising', 'Imagining',
  'Hatching', 'Percolating', 'Simmering', 'Distilling', 'Refining',
  'Tinkering', 'Forging', 'Sculpting', 'Building', 'Constructing',
  'Weaving', 'Searching', 'Surveying', 'Mapping', 'Decoding',
  'Deciphering', 'Solving', 'Puzzling', 'Wondering', 'Speculating',
  'Hypothesizing', 'Theorizing', 'Calculating', 'Computing', 'Estimating',
  'Weighing', 'Juggling', 'Pulsing', 'Humming', 'Bustling',
  'Scrambling', 'Hustling', 'Surging', 'Soaring', 'Climbing',
  'Generating', 'Producing', 'Cultivating', 'Tending', 'Plotting',
  'Charting', 'Scouting', 'Foraging', 'Marinating', 'Stewing',
];

function pickVerb(prev?: string): string {
  if (VERBS.length <= 1) return VERBS[0];
  let v = prev;
  while (v === prev) v = VERBS[Math.floor(Math.random() * VERBS.length)];
  return v!;
}

export function WorkingIndicator() {
  const [verb, setVerb] = useState<string>(() => pickVerb());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const verbId = setInterval(() => setVerb(prev => pickVerb(prev)), 3500);
    const dotsId = setInterval(() => setTick(t => t + 1), 400);
    return () => { clearInterval(verbId); clearInterval(dotsId); };
  }, []);

  const dotCount = (tick % 3) + 1;
  const dots = '.'.repeat(dotCount);

  return (
    <div className={styles.working} aria-live="polite">
      <span className={styles.asterisk}>✻</span>
      <span className={styles.verb}>{verb}</span>
      <span className={styles.dots}>{dots}</span>
    </div>
  );
}
