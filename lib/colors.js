// Device color palette and stable per-device color assignment.
// The mapping lives on the server so every client renders the same device
// in the same color (a client-side map would race across tabs).

const DEVICE_COLORS = [
  '#e3f2fd', // blue
  '#e8f5e9', // green
  '#fff3e0', // orange
  '#fce4ec', // pink
  '#f3e5f5', // purple
  '#e0f7fa', // cyan
  '#fffde7', // yellow
  '#efebe9'  // brown-grey
];

const deviceColorMap = new Map();
let colorIndex = 0;

// Stable color for a device: reuse if already assigned, otherwise take the next slot
function colorForDevice(device) {
  if (deviceColorMap.has(device)) return deviceColorMap.get(device);
  const color = DEVICE_COLORS[colorIndex % DEVICE_COLORS.length];
  deviceColorMap.set(device, color);
  colorIndex++;
  return color;
}

module.exports = { DEVICE_COLORS, colorForDevice };
