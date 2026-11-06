import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.ts';
import { AcknowledgementTimeout } from './frame-barrier.ts';
import type { ArmOrigin } from './apply.ts';

export type Programme = 'look' | 'auto' | 'sequence';
export type ControlAction = 'select' | 'start' | 'stop' | 'freeze' | 'resume' | 'arm' | 'disarm' | 'blackout' | 'restore';
export interface ControlRequest {
  version?: unknown;
  session?: unknown;
  revision?: unknown;
  action?: unknown;
  programme?: unknown;
}
export interface ControlHooks {
  ready?: () => boolean;
  armed: () => boolean;
  blackout: () => boolean;
  arm: (on: boolean, origin?: ArmOrigin) => void;
  setBlackout: (on: boolean) => void;
  validateStart: (programme: Programme) => void;
  paused?: () => boolean;
  start: (programme: Programme) => void;
  stop: () => void;
  changed: () => void;
  frame: () => Promise<void>;
}

const PROGRAMMES = new Set<Programme>(['look', 'auto', 'sequence']);
const ACTIONS = new Set<ControlAction>(['select', 'start', 'stop', 'freeze', 'resume', 'arm', 'disarm', 'blackout', 'restore']);
const PROTECTIVE = new Set<ControlAction>(['stop', 'disarm', 'blackout']);

function refusal(message: string, code = 'requires_control_refresh'): HttpError {
  return Object.assign(new HttpError(409, message), { code });
}

export class GlobalControl {
  readonly session = randomUUID();
  revision = 0;
  appliedRevision = 0;
  programme: Programme = 'look';
  playing = false;
  frozen = false;
  heldUnavailable: string | null = null;
  fault: string | null = null;
  private hooks: ControlHooks | null = null;

  configure(hooks: ControlHooks): void { this.hooks = hooks; }

  snapshot() {
    return { version: 1, session: this.session, revision: this.revision, appliedRevision: this.appliedRevision,
      programme: this.programme, playing: this.playing, frozen: this.frozen,
      ready: this.hooks?.ready?.() ?? true,
      paused: this.hooks?.paused?.() ?? false,
      heldUnavailable: this.heldUnavailable,
      armed: this.hooks?.armed() ?? false, blackout: this.hooks?.blackout() ?? false,
      pending: this.appliedRevision < this.revision && !this.fault, fault: this.fault };
  }

  validate(request: ControlRequest): ControlAction {
    if (!ACTIONS.has(request.action as ControlAction)) throw new HttpError(400, 'Unknown control action');
    const action = request.action as ControlAction;
    if (!PROTECTIVE.has(action) && (request.version !== 1 || request.session !== this.session || request.revision !== this.revision)) {
      throw refusal('Controls changed or this client needs updating. Refresh the controls and take the action again.');
    }
    return action;
  }

  async execute(request: ControlRequest, origin?: ArmOrigin) {
    const action = this.validate(request), hooks = this.hooks;
    if (!hooks) throw new HttpError(503, 'Controls are not ready');
    if (!PROTECTIVE.has(action) && hooks.ready?.() === false) {
      throw new HttpError(503, 'The renderer is starting. Wait for it to be ready and take the action again.');
    }
    const programme = request.programme === undefined ? this.programme : request.programme as Programme;
    if (!PROGRAMMES.has(programme)) throw new HttpError(400, 'Unknown programme');
    if ((action === 'select' || action === 'start') && this.playing && programme !== this.programme) {
      throw refusal('Stop the current programme before choosing another one.', 'programme_running');
    }
    if (action === 'start') hooks.validateStart(programme);
    const revision = ++this.revision;
    this.fault = null;
    try {
      switch (action) {
        case 'select': this.programme = programme; break;
        case 'start':
          if (!this.playing || hooks.paused?.()) hooks.start(programme);
          this.programme = programme; this.playing = true; break;
        case 'stop': this.playing = false; hooks.stop(); break;
        case 'freeze': this.frozen = true; break;
        case 'resume': this.frozen = false; this.heldUnavailable = null; break;
        case 'arm': hooks.arm(true, origin); break;
        case 'disarm': hooks.arm(false, origin); break;
        case 'blackout': hooks.setBlackout(true); break;
        case 'restore': hooks.setBlackout(false); break;
      }
      hooks.changed();
      await hooks.frame();
      this.appliedRevision = Math.max(this.appliedRevision, revision);
      if (this.revision !== revision) throw refusal('A newer control action replaced this request.', 'control_superseded');
      hooks.changed();
      return this.snapshot();
    } catch (error) {
      if (this.revision === revision) {
        this.fault = error instanceof Error ? error.message : 'Control could not be applied';
        hooks.changed();
        if (error instanceof AcknowledgementTimeout) this.clearWhenApplied(revision, error.applied);
      }
      throw error;
    }
  }

  // The change was made before the wait ran out: an acknowledgement that arrives late applies it after all.
  private clearWhenApplied(revision: number, applied: Promise<void>): void {
    applied.then(() => {
      this.appliedRevision = Math.max(this.appliedRevision, revision);
      if (this.revision !== revision || this.fault === null) return;
      this.fault = null;
      console.warn(`[control] the renderer acknowledged revision ${revision} late; its fault is cleared`);
      this.hooks?.changed();
    }, () => { /* the renderer was lost first: the fault stands */ });
  }

  current(revision: number): boolean { return this.revision === revision; }

  rendererLost(): void {
    if (!this.frozen) return;
    this.heldUnavailable = 'The renderer restarted. The frozen picture is unavailable and stays dark until Resume.';
    this.hooks?.changed();
  }

  requirePads(): void {
    if (this.frozen) throw refusal('The picture is frozen. Resume it before launching a pad.', 'picture_frozen');
  }
}

export const control = new GlobalControl();

export function requireExplicitTransport(): never {
  throw refusal('Use explicit programme Start/Stop or picture Freeze/Resume controls. Refresh or update this client.', 'requires_explicit_transport');
}

export function checkLegacyControlPatch(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const data = raw as Record<string, unknown>;
  if (data.running !== undefined) requireExplicitTransport();
  if (data.masterBlackout === false) throw refusal('Use the explicit Restore control with the current session and revision.');
  if (data.masterBlackout === true && Object.keys(data).length !== 1) {
    throw new HttpError(400, 'Send Blackout separately from content edits.');
  }
}
