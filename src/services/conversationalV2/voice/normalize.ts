export function normalizeVoiceTextV2(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function sameNormalizedVoiceTextV2(left: string, right: string): boolean {
  return normalizeVoiceTextV2(left) === normalizeVoiceTextV2(right);
}
