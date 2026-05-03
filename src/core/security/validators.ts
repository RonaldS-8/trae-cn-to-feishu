export function sanitizeInput(text: string): string {
  let sanitized = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  sanitized = sanitized.slice(0, 50000);
  return sanitized;
}

export function isDangerousInput(text: string): boolean {
  return /\.\.[\\/]/.test(text) || /[<>|&;`$]/.test(text.slice(0, 50));
}
