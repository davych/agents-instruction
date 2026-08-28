export function parsePositiveIntegerSetting(
  value: string | undefined,
  variableName: string,
): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!/^[1-9][0-9]*$/u.test(normalized)) {
    throw new Error(`${variableName} 必须是正整数`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${variableName} 超出安全整数范围`);
  }
  return parsed;
}
