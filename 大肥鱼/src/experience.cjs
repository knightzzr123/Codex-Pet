const BUBBLE_SECONDS = Object.freeze([5, 8, 15, 0]);

function experienceFromPreferences(saved = {}) {
  return {
    bubbleSeconds: BUBBLE_SECONDS.includes(saved.bubbleSeconds) ? saved.bubbleSeconds : 8,
    advanceOnPetTap: saved.advanceOnPetTap === true,
    mirrorOnLeft: saved.mirrorOnLeft !== false,
    reducedMotion: saved.reducedMotion === true
  };
}

module.exports = { BUBBLE_SECONDS, experienceFromPreferences };
