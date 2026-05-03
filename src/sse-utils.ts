export function sseEvent(type: string, data: string): string {
  return `event: ${type}\ndata: ${data}\n\n`;
}
