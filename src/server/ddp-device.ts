import { profileSchema, validate } from './validation.ts';
import type { ProfileInput } from './validation.ts';
import type { ProfileCell } from '../types/rig.ts';

/**
 * A DDP receiver that is not a WLED, described by hand because it has no API
 * to ask: RGB pixels in rows from the top left, the order DDP sends them in.
 * A single row or column is a strip; anything wider is a panel.
 */
export interface DdpDevice {
  host: string;
  label: string;
  columns: number;
  rows: number;
}

function ddpDeviceProfileId(host: string): string {
  return `ddp-${host.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 128);
}

function ddpDeviceProfile({ host, label, columns, rows }: DdpDevice, id = ddpDeviceProfileId(host)): ProfileInput {
  const pixels = columns * rows;
  const panel = columns > 1 && rows > 1;
  const cells = Array.from({ length: pixels }, (_, c): ProfileCell => ({ channelMap: { red: c * 3, green: c * 3 + 1, blue: c * 3 + 2 } }));
  return validate(profileSchema, {
    id,
    name: label.slice(0, 128),
    manufacturer: 'DDP',
    modeName: `${pixels} pixels, RGB${panel ? `, ${columns} × ${rows}` : ''}`,
    channelCount: pixels * 3,
    channelMap: {},
    cells,
    ...(panel ? { grid: { columns, rows } } : {}),
  }, 'DDP device profile');
}

export {
  ddpDeviceProfile,
  ddpDeviceProfileId,
};
