// The effects' symbols: Material Design Icons as 24 x 24 path data (@mdi/js, Apache-2.0).
import {
  mdiAccountGroup, mdiAnchor, mdiArrowLeft, mdiArrowLeftRight, mdiArrowRight, mdiArrowSplitVertical, mdiAutorenew, mdiBlur,
  mdiBrightness6, mdiCampfire, mdiCheckerboard, mdiCircle, mdiCircleExpand, mdiCircleHalfFull, mdiCircleOutline, mdiCircleSlice8,
  mdiCreation, mdiCubeOutline, mdiDotsCircle, mdiDotsGrid, mdiEqualizer, mdiFire, mdiFirework, mdiFlare, mdiFlash, mdiFlashAlert,
  mdiFlashOutline, mdiFlipHorizontal, mdiGauge, mdiGradientHorizontal, mdiLedStrip, mdiLightbulbGroup, mdiLightningBolt, mdiLooks,
  mdiMeteor, mdiMusicNote, mdiPlay, mdiPlaylistMusic, mdiRadar, mdiRayStartArrow, mdiRotate3dVariant, mdiRotateRight, mdiRunFast,
  mdiShape, mdiShimmer, mdiSineWave, mdiSnowflake, mdiStarFourPoints, mdiStarShooting, mdiSwapHorizontal, mdiTallyMark4, mdiTarget,
  mdiTransferUp, mdiTrendingUp, mdiVectorPolyline, mdiViewColumn, mdiViewGrid, mdiViewParallel, mdiViewSplitVertical, mdiViewWeek,
  mdiVolumeHigh, mdiWaveform, mdiWaves, mdiWeatherPouring, mdiWeatherWindy,
} from '@mdi/js';

/** The symbol of an effect that has its own, by its id. */
export const EFFECT_ICONS = Object.freeze({
  // The party looks.
  'position-chase': mdiRunFast, 'radial-pulse': mdiRadar, 'spatial-wash': mdiBlur, 'bounce-scan': mdiSwapHorizontal,
  streak: mdiRayStartArrow, starlight: mdiStarFourPoints, breathe: mdiWeatherWindy, 'volume-gate': mdiVolumeHigh,
  confetti: mdiShimmer, 'anchor-fill': mdiAnchor, halves: mdiCircleHalfFull, flip: mdiFlipHorizontal, 'room-wave': mdiWaves,
  'ring-strobe': mdiCircleOutline, 'ring-backlit': mdiCircleSlice8, fireworks: mdiFirework, flashes: mdiFlashOutline,
  swirl: mdiRotate3dVariant, 'party.fire': mdiFire, 'party.ice': mdiSnowflake,
  // The classic patterns.
  solid: mdiCircle, chase: mdiArrowRight, 'chase-rev': mdiArrowLeft, 'ping-pong': mdiArrowLeftRight, strobe: mdiFlash,
  fade: mdiBrightness6, 'color-cycle': mdiAutorenew, rainbow: mdiLooks, twinkle: mdiCreation, split: mdiArrowSplitVertical,
  sparkle: mdiStarShooting, wave: mdiSineWave, 'stack-up': mdiTransferUp, 'random-flash': mdiFlashAlert, runner: mdiPlay,
  pairs: mdiDotsGrid, hit: mdiTarget, 'alt-halves': mdiViewSplitVertical, 'split-3': mdiViewColumn, 'chase-3': mdiRotateRight,
  'alt-thirds': mdiViewWeek, 'split-4': mdiViewGrid, 'chase-4': mdiDotsCircle, 'alt-quarters': mdiCheckerboard,
  'pairs-4': mdiTallyMark4, sections: mdiViewParallel, ensemble: mdiAccountGroup, ribbon: mdiVectorPolyline,
  gradient: mdiGradientHorizontal, comet: mdiMeteor, burst: mdiCircleExpand, plasma: mdiWaveform, meter: mdiGauge,
  drums: mdiMusicNote, stems: mdiPlaylistMusic, rise: mdiTrendingUp, impact: mdiFlare, bars: mdiEqualizer, fire: mdiCampfire,
  rain: mdiWeatherPouring,
});

// An effect without its own symbol takes one from what it is: the first of these tags it carries.
const TAG_ICONS = [['energy', mdiLightningBolt], ['room', mdiCubeOutline], ['bars', mdiLedStrip], ['rig', mdiLightbulbGroup]];
export const DEFAULT_ICON = mdiShape;

/** The path of an effect's symbol: its own, else its kind's, else the common shape. */
export const effectIcon = (id, tags = []) => EFFECT_ICONS[id] || TAG_ICONS.find(([tag]) => tags.includes(tag))?.[1] || DEFAULT_ICON;
