// The sequence's beat ruler and clips: plain drawing on a 2D context in CSS pixels, shared by the Sequence
// view's ruler and its lane rows; the caller sizes the canvas and sets the transform.

const beatX = (beat, fromBeat, toBeat, width) => ((beat - fromBeat) / (toBeat - fromBeat || 1)) * width;

/** A tick on every beat, a taller one with its bar number (from 1) on each downbeat. */
export function drawRuler(ctx, { fromBeat = 0, toBeat, beatsPerBar = 4, width, height }) {
  ctx.fillStyle = '#151724';
  ctx.fillRect(0, 0, width, height);
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 1;
  for (let beat = Math.ceil(fromBeat); beat <= toBeat; beat++) {
    const x = Math.round(beatX(beat, fromBeat, toBeat, width)) + 0.5;
    const downbeat = beat % beatsPerBar === 0;
    ctx.strokeStyle = downbeat ? '#9aa2b8' : 'rgba(154, 162, 184, .45)';
    ctx.beginPath();
    ctx.moveTo(x, downbeat ? 0 : height * 0.6);
    ctx.lineTo(x, height);
    ctx.stroke();
    if (downbeat) {
      ctx.fillStyle = '#eceef6';
      ctx.fillText(String(beat / beatsPerBar + 1), x + 3, 2);
    }
  }
}

/** Each clip as a block in its lane's row; a muted clip is drawn faint. */
export function drawClips(ctx, clips, { laneIds, fromBeat = 0, toBeat, width, rowHeight, top = 0, colourOf = () => '#5aa2ff' }) {
  for (const clip of clips) {
    const row = laneIds.indexOf(clip.laneId);
    if (row < 0) continue;
    const x = beatX(clip.startBeat, fromBeat, toBeat, width);
    const w = beatX(clip.startBeat + clip.lengthBeats, fromBeat, toBeat, width) - x;
    ctx.globalAlpha = clip.mute ? 0.35 : 1;
    ctx.fillStyle = colourOf(clip);
    ctx.fillRect(x, top + row * rowHeight + 2, w, rowHeight - 4);
  }
  ctx.globalAlpha = 1;
}
