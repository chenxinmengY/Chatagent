const fault = code => new Error(code);
export const DEFAULT_APPEARANCE = Object.freeze({ accent: '#3478e5', background: '#f5f7fb', fontSize: 15, radius: 14 });
export function validateAppearance(value) {
  if (!value || Object.keys(value).sort().join() !== Object.keys(DEFAULT_APPEARANCE).sort().join() ||
      !/^#[a-fA-F0-9]{6}$/.test(value.accent) || !/^#[a-fA-F0-9]{6}$/.test(value.background) ||
      !Number.isInteger(value.fontSize) || value.fontSize < 12 || value.fontSize > 24 || !Number.isInteger(value.radius) || value.radius < 0 || value.radius > 28) throw fault('INVALID_APPEARANCE', 400);
  return { ...value };
}
